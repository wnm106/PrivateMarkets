/**
 * A filed report (a 10-Q, a 10-K, an annual report) onto a fund's NAV statement.
 *
 * Load data stores the report as tables, one per statement and schedule
 * (financial-report.ts). This reads them back, maps them onto the NAV chart and
 * the fund's positions (nav-report-map.ts), and loads them through the same
 * loader as any file: the statement as of the period end and the comparative
 * date, the flows for the span between them, the date it compares with and the
 * report's checks of itself on the statement, and one position per investment
 * in the schedule, dated with the schedule. Everything is the administrator's
 * figure (FUND_ADMIN) and the whole load is one batch, so it can be reverted.
 *
 * The fund is the one the run was given, or else the fund whose name or alias
 * is the reporting entity's name, exactly. It is never guessed: no match, or
 * more than one, is a hold for a person. So are a report that does not add up,
 * a line with nowhere to go, a trial load that refuses records, and a report
 * that would change figures already on file. A held report loads only once a
 * person has confirmed it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractPdfFragments,
  readFinancialReport,
  reportFromTables,
  reportTables,
  REPORT_SCHEDULE_TABLE,
  REPORT_TABLE,
  type FinancialReport,
} from '@tapestrai/graphql/src/lib/import-intake';
import { chartFromAttributes, planNavReport, type NavReportPlan } from '@tapestrai/graphql/src/lib/nav-report-map';
import { assertLocalSupabase, executeParsedFeed, localSupabase, type LoadRecorder } from './feed-loader';
import { finishDirectBatch, openDirectBatch, resultDigest, writeJournal, type JournalEntry } from './load-batch-store';
import type { CellLocation, FeedLoadResult, FeedMap, PageSize, ParsedTable } from './types';

export const ADMIN_SOURCE = 'FUND_ADMIN';
const STATEMENT_DOMAIN = 'NAV_STATEMENT';

interface StoredTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  locations?: (CellLocation | null)[][];
  pages?: PageSize[];
}

interface InstanceRow {
  id: string;
  file_name: string;
  status: string;
  tables: StoredTable[] | null;
  source_base64: string | null;
  intake_method: string | null;
  runs: unknown[] | null;
}

interface FundRow {
  id: string;
  entity_code: string;
  entity_name: string;
}

function db(client?: SupabaseClient): SupabaseClient {
  const found = client || localSupabase();
  assertLocalSupabase(found);
  return found;
}

async function instanceOf(database: SupabaseClient, id: string, clientId: string): Promise<InstanceRow> {
  const row = await database
    .schema('entity_instances')
    .from('import_instances')
    .select('id, file_name, status, tables, source_base64, intake_method, runs')
    .eq('id', id)
    .eq('client_id', clientId)
    .single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'That file is not stored for this client.');
  return row.data as InstanceRow;
}

/**
 * The report in a stored file. A file stored before the report reader existed
 * is read again from its bytes, and its tables are saved so Load data shows them.
 */
export async function reportOfFile(database: SupabaseClient, instance: InstanceRow, clientId: string, save = false): Promise<FinancialReport> {
  const stored = Array.isArray(instance.tables) ? instance.tables : [];
  const fromTables = stored.length ? reportFromTables(stored) : null;
  if (fromTables) return fromTables;
  if (!instance.source_base64) throw new Error(`${instance.file_name} has no stored bytes to read again.`);
  const bytes = Buffer.from(instance.source_base64, 'base64');
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${instance.file_name} is not a PDF, so it cannot be read as a filed report.`);
  const pages = await extractPdfFragments(new Uint8Array(bytes));
  const report = readFinancialReport(pages);
  if (!report) {
    throw new Error(`${instance.file_name} was not read as a financial report: no balance sheet and second primary statement were found by their titles. A scan needs a text layer first.`);
  }
  if (!save) return report;
  const tables = reportTables(report, pages.map((page) => ({ page: page.page, width: page.width, height: page.height })));
  const selected = tables.find((table) => table.id.startsWith(REPORT_SCHEDULE_TABLE)) ?? tables[0];
  const saved = await database.schema('entity_instances').from('import_instances').update({
    tables,
    table_id: selected.id,
    headers: selected.headers,
    parsed_rows: selected.rows,
    row_count: selected.rows.length,
    intake_method: 'financial_report',
  }).eq('id', instance.id).eq('client_id', clientId);
  if (saved.error) throw new Error(saved.error.message);
  return report;
}

export interface FundChoice {
  id: string;
  code: string;
  name: string;
}

export interface FundResolution {
  fund: FundRow | null;
  /** How the fund was found: given to the run or chosen by a person, the run's selection, or the report's own name. */
  matchedBy: 'chosen' | 'selection' | 'report' | null;
  note: string;
  /** The client's funds, closest to the report's name first, for a person to choose from. */
  choices: FundChoice[];
}

/** A name as it is compared: lower case, "&" as "and", no punctuation. */
export function comparableName(text: string): string {
  return text.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function overlap(left: string, right: string): number {
  const a = new Set(comparableName(left).split(' ').filter(Boolean));
  const b = new Set(comparableName(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/**
 * The fund a report is for. A fund given to the run wins, then the run's
 * selection, then a fund whose name or alias is the report's entity name.
 * Never a near match: those are offered as choices.
 */
export async function resolveFund(
  database: SupabaseClient,
  clientId: string,
  input: { fundId?: string | null; entityIds?: string[] | null },
  report: FinancialReport,
): Promise<FundResolution> {
  const { data, error } = await database
    .schema('entity_instances')
    .from('master_entities')
    .select('id, entity_code, entity_name')
    .eq('client_id', clientId)
    .eq('domain_code', 'FUND')
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  const funds = (data || []) as FundRow[];
  const name = report.entityName || '';
  const choices = [...funds]
    .sort((left, right) => overlap(right.entity_name, name) - overlap(left.entity_name, name) || left.entity_name.localeCompare(right.entity_name))
    .slice(0, 25)
    .map((fund) => ({ id: fund.id, code: fund.entity_code, name: fund.entity_name }));
  const given = String(input.fundId || '').trim();
  if (given) {
    return { fund: await fundOf(database, clientId, given), matchedBy: 'chosen', note: 'The fund was given to the run.', choices };
  }
  const selected = (input.entityIds || []).map((id) => funds.find((fund) => fund.id === id)).find(Boolean);
  if (selected) return { fund: selected, matchedBy: 'selection', note: 'The fund the run was started on.', choices };
  if (!name) return { fund: null, matchedBy: null, note: 'The report does not name the entity it is for, so a person chooses the fund.', choices };
  const wanted = comparableName(name);
  const aliases = funds.length
    ? await database.schema('entity_instances').from('entity_aliases').select('entity_id, alias_label').eq('is_active', true).in('entity_id', funds.map((fund) => fund.id))
    : { data: [], error: null };
  if (aliases.error) throw new Error(aliases.error.message);
  const byAlias = new Set((aliases.data || []).filter((row) => comparableName(String(row.alias_label || '')) === wanted).map((row) => row.entity_id as string));
  const matches = funds.filter((fund) => comparableName(fund.entity_name) === wanted || byAlias.has(fund.id));
  if (matches.length === 1) return { fund: matches[0], matchedBy: 'report', note: `The report is for ${name}, which is ${matches[0].entity_name} (${matches[0].entity_code}).`, choices };
  if (matches.length > 1) {
    return { fund: null, matchedBy: null, note: `${matches.length} funds are named ${name}: ${matches.map((fund) => fund.entity_code).join(', ')}. A person chooses which.`, choices: [...matches.map((fund) => ({ id: fund.id, code: fund.entity_code, name: fund.entity_name })), ...choices.filter((choice) => !matches.some((fund) => fund.id === choice.id))] };
  }
  return { fund: null, matchedBy: null, note: `No fund is named ${name}. A person chooses the fund, or adds the name as an alias of it so the next report finds it.`, choices };
}

async function fundOf(database: SupabaseClient, clientId: string, ref: string): Promise<FundRow> {
  const value = ref.trim();
  if (!value) throw new Error('Choose the fund the report is for.');
  const lookup = /^[0-9a-f-]{36}$/i.test(value) ? 'id' : 'entity_code';
  const { data, error } = await database
    .schema('entity_instances')
    .from('master_entities')
    .select('id, entity_code, entity_name, domain_code, client_id')
    .eq(lookup, value)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.domain_code !== 'FUND') throw new Error(`${value} is not a fund of this client.`);
  return data as FundRow;
}

/** The fund's NAV statement record, or the code and name a new one gets. */
async function statementOf(database: SupabaseClient, fund: FundRow): Promise<{ code: string; name: string; exists: boolean }> {
  const rels = await database
    .schema('entity_instances')
    .from('entity_relationships')
    .select('parent_entity_id')
    .eq('relationship_code', 'STATEMENT_FUND')
    .eq('child_entity_id', fund.id);
  if (rels.error) throw new Error(rels.error.message);
  const ids = (rels.data || []).map((row) => row.parent_entity_id as string);
  if (ids.length) {
    const found = await database
      .schema('entity_instances')
      .from('master_entities')
      .select('entity_code, entity_name, domain_code, is_active')
      .in('id', ids);
    if (found.error) throw new Error(found.error.message);
    const statement = (found.data || []).find((row) => row.domain_code === STATEMENT_DOMAIN && row.is_active !== false);
    if (statement) return { code: statement.entity_code, name: statement.entity_name, exists: true };
  }
  return { code: `${fund.entity_code}-STMT`, name: `${fund.entity_name} NAV statement`, exists: false };
}

async function chartOf(database: SupabaseClient) {
  const { data, error } = await database
    .schema('metadata_register')
    .from('attribute_register')
    .select('attribute_code, attribute_name, display_group, validation_rules')
    .eq('domain_code', STATEMENT_DOMAIN);
  if (error) throw new Error(error.message);
  const chart = chartFromAttributes(data || []);
  if (!chart.some((line) => line.rules.length > 0)) {
    throw new Error('The NAV chart has no report wording on it yet. Apply supabase/migrations/20261122100000_nav_report_chart.sql.');
  }
  return chart;
}

/* ----------------------------------------------------------------- tables */

const COL = {
  statementCode: 'Statement code',
  statementName: 'Statement name',
  fund: 'Fund code',
  asOf: 'As of',
  periodEnd: 'Period end',
  comparative: 'Comparative date',
  received: 'Received',
  label: 'Period label',
  checks: 'Report checks',
  notes: 'Notes included',
  positionCode: 'Position code',
  positionName: 'Position name',
  assetClass: 'Asset class',
  par: 'Par amount',
  cost: 'Cost',
  fairValue: 'Fair value',
  coupon: 'Coupon',
  currency: 'Currency',
  snapshot: 'Schedule date',
} as const;

/** The checks kept on the statement: every one that does not tie, and the headline totals. */
export function sourceChecksJson(report: FinancialReport): string {
  const headline = /(:balance$|:total:fv$|^class:sum:)/;
  const kept = report.checks.filter((check) => check.result !== 'Ties' || headline.test(check.id));
  return JSON.stringify({
    total: report.checks.length,
    ties: report.checks.filter((check) => check.result === 'Ties').length,
    checks: kept.slice(0, 60).map((check) => ({
      label: check.label, where: check.where, reported: check.reported, computed: check.computed, difference: check.difference, result: check.result,
    })),
  });
}

function periodLabel(report: FinancialReport, plan: NavReportPlan): string {
  const form = report.form ? `${report.form} ` : '';
  return `${form}${plan.months ? `${plan.months} months ` : ''}to ${plan.periodEnd}${report.entityName ? `, ${report.entityName}` : ''}`.slice(0, 200);
}

function statementTable(plan: NavReportPlan, report: FinancialReport, statement: { code: string; name: string }, fund: FundRow, receivedDate: string, pages: PageSize[]): { table: ParsedTable; map: FeedMap } {
  const codes = [...new Set(plan.rows.flatMap((row) => row.values.map((value) => value.code)))];
  const headers = [COL.statementCode, COL.statementName, COL.fund, COL.asOf, COL.periodEnd, COL.comparative, COL.received, COL.label, COL.checks, COL.notes, ...codes];
  const rows: Record<string, string>[] = [];
  const locations: (CellLocation | null)[][] = [];
  for (const planned of plan.rows) {
    const current = planned.asOf === plan.periodEnd;
    const byCode = new Map(planned.values.map((value) => [value.code, value]));
    rows.push({
      [COL.statementCode]: statement.code,
      [COL.statementName]: statement.name,
      [COL.fund]: fund.entity_code,
      [COL.asOf]: planned.asOf,
      [COL.periodEnd]: planned.asOf,
      [COL.comparative]: current && plan.comparativeDate ? plan.comparativeDate : '',
      [COL.received]: current ? receivedDate : '',
      [COL.label]: current ? periodLabel(report, plan) : '',
      [COL.checks]: current ? sourceChecksJson(report) : '',
      [COL.notes]: current && report.notes ? 'true' : '',
      ...Object.fromEntries(codes.map((code) => [code, byCode.has(code) ? String(byCode.get(code)!.value) : ''])),
    });
    locations.push(headers.map((header) => {
      const cell = byCode.get(header)?.cell;
      return cell ? { ...cell, precision: 'cell' as const } : null;
    }));
  }
  const map: FeedMap = {
    mapCode: 'NAV_REPORT_STATEMENT',
    sourceCode: ADMIN_SOURCE,
    name: 'Filed report: NAV statement',
    description: 'The primary statements of a filed report on the NAV chart, as the report reader and the NAV report mapper read them.',
    asOfHintColumn: COL.asOf,
    domains: [{
      domainCode: STATEMENT_DOMAIN,
      templateCode: 'NAV_STATEMENT_STANDARD',
      identityColumn: COL.statementCode,
      nameColumn: COL.statementName,
      attributes: [
        { column: COL.periodEnd, attributeCode: 'STATEMENT_PERIOD_END' },
        { column: COL.comparative, attributeCode: 'STATEMENT_COMPARATIVE_DATE' },
        { column: COL.received, attributeCode: 'STATEMENT_RECEIVED_DATE' },
        { column: COL.label, attributeCode: 'STATEMENT_PERIOD_LABEL' },
        { column: COL.checks, attributeCode: 'STATEMENT_SOURCE_CHECKS' },
        { column: COL.notes, attributeCode: 'STATEMENT_NOTES_INCLUDED' },
        ...codes.map((code) => ({ column: code, attributeCode: code })),
      ],
      parents: [{ column: COL.fund, parentDomainCode: 'FUND', existing: true }],
    }],
  };
  return { table: { headers, rows, locations, pages }, map };
}

function positionTable(plan: NavReportPlan, fund: FundRow, pages: PageSize[]): { table: ParsedTable; map: FeedMap } {
  const headers = [COL.positionCode, COL.positionName, COL.fund, COL.assetClass, COL.par, COL.cost, COL.fairValue, COL.coupon, COL.currency, COL.snapshot];
  const text = (value: number | null) => (value == null ? '' : String(value));
  const rows = plan.positions.map((position) => ({
    [COL.positionCode]: position.code,
    [COL.positionName]: position.name,
    [COL.fund]: fund.entity_code,
    [COL.assetClass]: position.assetClass,
    [COL.par]: text(position.par),
    [COL.cost]: text(position.cost),
    [COL.fairValue]: text(position.fairValue),
    [COL.coupon]: position.coupon,
    [COL.currency]: position.currency,
    [COL.snapshot]: plan.periodEnd,
  }));
  const cell = (value: { page: number; x: number; y: number; w: number; h: number } | null) => (value ? { ...value, precision: 'cell' as const } : null);
  const locations = plan.positions.map((position) => [
    null, cell(position.cells.company), null, null, cell(position.cells.par), cell(position.cells.cost), cell(position.cells.fairValue), null, null, null,
  ]);
  const map: FeedMap = {
    mapCode: 'NAV_REPORT_POSITIONS',
    sourceCode: ADMIN_SOURCE,
    name: 'Filed report: schedule of investments',
    description: 'One position per investment in a filed schedule of investments, dated with the schedule.',
    domains: [{
      domainCode: 'POSITION',
      templateCode: 'POSITION_STANDARD',
      identityColumn: COL.positionCode,
      nameColumn: COL.positionName,
      attributes: [
        { column: COL.assetClass, attributeCode: 'POSITION_TYPE' },
        { column: COL.par, attributeCode: 'FUNDED_PAR_AMOUNT' },
        { column: COL.cost, attributeCode: 'COST_BASIS' },
        { column: COL.fairValue, attributeCode: 'MARKET_VALUE' },
        { column: COL.coupon, attributeCode: 'POSITION_COUPON' },
        { column: COL.currency, attributeCode: 'POSITION_CURRENCY' },
        { column: COL.snapshot, attributeCode: 'METRIC_DATE' },
      ],
      parents: [{ column: COL.fund, parentDomainCode: 'FUND', existing: true }],
    }],
  };
  return { table: { headers, rows, locations, pages }, map };
}

/* ------------------------------------------------------------------- read */

export interface NavReportInput {
  /** The fund, when the run was given one or a person chose it. */
  fundId?: string | null;
  /** The run's selection. The first fund among them is the fund. */
  entityIds?: string[] | null;
  periodEnd?: string | null;
  /** The date the report arrived. Defaults to today. */
  receivedDate?: string | null;
  /** Read only: also run the load without writing, and say what it would do. */
  trial?: boolean;
}

const round = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100);

/** A flagged value the loader keeps as it was typed: off its list, or naming no record. */
const STORED_AS_TYPED = /Stored as (typed|given)\.$/;

function digestLoad(result: FeedLoadResult) {
  const rejects = result.rejects || [];
  const typed = rejects.filter((reject) => STORED_AS_TYPED.test(reject.message));
  return {
    dryRun: result.dryRun === true,
    rowCount: result.rowCount,
    records: result.domains.map((domain) => ({ domainCode: domain.domainCode, distinct: domain.distinctEntities, created: domain.created, matched: domain.matched, failed: domain.failed, errors: domain.errors.slice(0, 5) })),
    values: result.attributes,
    links: result.relationships,
    resolutions: result.resolutions.length,
    rejectCount: result.rejectCount ?? rejects.length,
    storedAsTyped: typed.length,
    typedExamples: [...new Set(typed.map((reject) => `${reject.attributeCode} "${reject.value}"`))].slice(0, 3),
    rejects: rejects.slice(0, 15),
    warnings: result.warnings.slice(0, 10),
    errors: result.errors.slice(0, 10),
  };
}

async function prepare(database: SupabaseClient, instanceId: string, clientId: string, input: NavReportInput, save = false) {
  const instance = await instanceOf(database, instanceId, clientId);
  const report = await reportOfFile(database, instance, clientId, save);
  const resolution = await resolveFund(database, clientId, input, report);
  const chart = await chartOf(database);
  const plan = planNavReport(report, chart, { fundCode: resolution.fund?.entity_code || 'FUND', periodEnd: input.periodEnd || null });
  const statement = resolution.fund ? await statementOf(database, resolution.fund) : null;
  const stored = Array.isArray(instance.tables) ? instance.tables : [];
  const pages = stored.find((table) => Array.isArray(table.pages) && table.pages.length)?.pages ?? [];
  const allPages = [...new Map(stored.flatMap((table) => table.pages || []).map((page) => [page.page, page])).values()];
  return { instance, report, resolution, plan, statement, pages: allPages.length ? allPages : pages };
}

/** Lines left out because nothing on the chart takes their wording, with a figure in a column that loads. */
function unplacedLines(plan: NavReportPlan): string[] {
  const out: string[] = [];
  for (const statement of plan.statements) {
    const columns = [statement.periodColumn, statement.comparativeColumn].filter((column): column is number => column != null);
    for (const entry of statement.unmapped) {
      if (!/^No line on the NAV chart/.test(entry.reason)) continue;
      if (columns.some((column) => (entry.values[column] ?? 0) !== 0)) out.push(`${statement.title}: ${entry.section ? `${entry.section}: ` : ''}${entry.label}`);
    }
  }
  return out;
}

/**
 * Why a report needs a person before it loads. Empty when it can load on its own.
 * Each says what a person has to look at.
 */
export function holdsFor(
  plan: NavReportPlan,
  resolution: FundResolution,
  reportChecks: Array<{ label: string; result: string }>,
  trial: { statement: ReturnType<typeof digestLoad>; positions: ReturnType<typeof digestLoad> | null } | null,
): string[] {
  const holds: string[] = [];
  if (!resolution.fund) holds.push(resolution.note);
  holds.push(...plan.problems);
  if (!plan.rows.length || !plan.rows[0].values.length) holds.push('Nothing in the report maps onto the NAV statement at its period end.');
  const broken = reportChecks.filter((check) => check.result === 'Break');
  if (broken.length) holds.push(`${broken.length} of the report's own subtotals or totals do not add up (${broken.slice(0, 3).map((check) => check.label).join('; ')}${broken.length > 3 ? '; …' : ''}). Check that the report was read right before it loads.`);
  const unplaced = unplacedLines(plan);
  if (unplaced.length) holds.push(`${unplaced.length} line${unplaced.length === 1 ? ' has' : 's have'} no place on the NAV statement: ${unplaced.slice(0, 3).join('; ')}${unplaced.length > 3 ? '; …' : ''}.`);
  for (const [what, load] of [['NAV statement', trial?.statement], ['Positions', trial?.positions]] as const) {
    if (!load) continue;
    const typed = load.storedAsTyped ?? 0;
    const refused = load.records.reduce((total, record) => total + record.failed, 0) + load.rejectCount - typed;
    if (refused) holds.push(`${what}: the trial load refuses ${refused} record${refused === 1 ? '' : 's'} or value${refused === 1 ? '' : 's'}.`);
    if (typed) holds.push(`${what}: ${typed} value${typed === 1 ? ' is' : 's are'} not on ${typed === 1 ? 'its list' : 'their lists'} or name${typed === 1 ? 's' : ''} no record, so ${typed === 1 ? 'it' : 'they'} would be stored as typed (${(load.typedExamples ?? []).join(', ')}). Add the wording as a synonym on the list, or correct it, before the report loads.`);
    if (load.resolutions) holds.push(`${what}: ${load.resolutions} record${load.resolutions === 1 ? ' matches' : 's match'} more than one stored record.`);
    if (load.values.updated) holds.push(`${what}: the report changes ${load.values.updated} figure${load.values.updated === 1 ? '' : 's'} already on file for this period, so it restates them.`);
  }
  return holds;
}

/**
 * What a filed report holds and what loading it onto the fund would write:
 * each statement's lines on the NAV chart with both dates, the lines left out
 * and why, the schedule, and the report's own checks. Writes nothing.
 */
export async function readNavReport(instanceId: string, clientId: string, input: NavReportInput, client?: SupabaseClient) {
  const database = db(client);
  const { instance, report, resolution, plan, statement, pages } = await prepare(database, instanceId, clientId, input);
  const fund = resolution.fund;
  const schedule = report.schedules.find((item) => item.date === plan.periodEnd) ?? null;
  const investments = schedule ? schedule.rows.filter((row) => row.kind === 'investment') : [];
  const classes = [...new Set(investments.map((row) => row.assetClass))].map((name) => {
    const members = investments.filter((row) => row.assetClass === name);
    return { name, investments: members.length, fairValue: round(members.reduce((total, row) => total + (row.fairValue ?? 0), 0)), cost: round(members.reduce((total, row) => total + (row.cost ?? 0), 0)) };
  });
  const out = {
    instanceId: instance.id,
    fileName: instance.file_name,
    fileStatus: instance.status,
    fund: fund ? { id: fund.id, code: fund.entity_code, name: fund.entity_name, matchedBy: resolution.matchedBy } : null,
    fundNote: resolution.note,
    fundChoices: resolution.choices,
    statement: statement ? { code: statement.code, name: statement.name, exists: statement.exists } : null,
    report: {
      entityName: report.entityName,
      form: report.form,
      periodEnd: plan.periodEnd,
      comparativeDate: plan.comparativeDate,
      months: plan.months,
      statements: plan.statements.map((item) => ({
        kind: item.kind,
        title: item.title,
        tableId: REPORT_TABLE[item.kind],
        periodColumn: item.periodColumn == null ? null : item.columns[item.periodColumn]?.label ?? null,
        comparativeColumn: item.comparativeColumn == null ? null : item.columns[item.comparativeColumn]?.label ?? null,
        lines: item.lines.map((line) => ({
          code: line.code,
          name: line.name,
          unit: line.unit,
          period: item.periodColumn == null ? null : round(line.values[item.periodColumn]),
          comparative: item.comparativeColumn == null ? null : round(line.values[item.comparativeColumn]),
          from: line.from.map((source) => (source.section ? `${source.section}: ${source.label}` : source.label)),
          rows: line.from.map((source) => source.index),
          detail: line.detail.length,
          note: line.note,
        })),
        unmapped: item.unmapped.map((entry) => ({ ...entry, row: entry.index })),
      })),
      schedules: report.schedules.map((item) => ({
        date: item.date,
        pages: item.pages,
        investments: item.rows.filter((row) => row.kind === 'investment').length,
        loaded: item.date === plan.periodEnd,
      })),
      schedule: schedule ? { date: schedule.date, tableId: `${REPORT_SCHEDULE_TABLE}-${schedule.date}`, investments: investments.length, classes } : null,
    },
    checks: {
      total: report.checks.length,
      ties: report.checks.filter((check) => check.result === 'Ties').length,
      notTied: report.checks.filter((check) => check.result !== 'Ties').slice(0, 40).map((check) => ({
        label: check.label, where: check.where, reported: round(check.reported), computed: round(check.computed), difference: round(check.difference), result: check.result,
      })),
    },
    willLoad: {
      statementValues: plan.rows.map((row) => ({ asOf: row.asOf, values: row.values.length })),
      positions: plan.positions.length,
      source: ADMIN_SOURCE,
    },
    problems: plan.problems,
    ready: Boolean(fund) && plan.problems.length === 0 && plan.rows.length > 0 && plan.rows[0].values.length > 0,
    trial: null as null | { statement: ReturnType<typeof digestLoad>; positions: ReturnType<typeof digestLoad> | null },
    /** Why a person has to look before it loads. Empty when it loads on its own. */
    holds: [] as string[],
    /** True when nothing needs a person: the workflow loads it without asking. */
    autoLoad: false,
  };
  if (input.trial !== false && out.ready && fund && statement) {
    const received = input.receivedDate || new Date().toISOString().slice(0, 10);
    const first = statementTable(plan, report, statement, fund, received, pages);
    const second = plan.positions.length ? positionTable(plan, fund, pages) : null;
    const statementTrial = await executeParsedFeed(first.map, instance.file_name, first.table, plan.periodEnd, database, clientId, ADMIN_SOURCE, { dryRun: true });
    const positionTrial = second ? await executeParsedFeed(second.map, instance.file_name, second.table, plan.periodEnd, database, clientId, ADMIN_SOURCE, { dryRun: true }) : null;
    out.trial = { statement: digestLoad(statementTrial), positions: positionTrial ? digestLoad(positionTrial) : null };
  }
  out.holds = holdsFor(plan, resolution, report.checks, out.trial);
  if (input.trial === false && out.ready) out.holds.push('The trial load was not run.');
  out.autoLoad = out.ready && out.holds.length === 0;
  return out;
}

/* ------------------------------------------------------------------- load */

function combined(results: FeedLoadResult[], plan: NavReportPlan, fileName: string): FeedLoadResult {
  const first = results[0];
  return {
    ...first,
    mapCode: 'NAV_REPORT',
    asOfDate: plan.periodEnd,
    fileName,
    rowCount: results.reduce((total, result) => total + result.rowCount, 0),
    domains: results.flatMap((result) => result.domains),
    relationships: {
      created: results.reduce((total, result) => total + result.relationships.created, 0),
      matched: results.reduce((total, result) => total + result.relationships.matched, 0),
      failed: results.reduce((total, result) => total + result.relationships.failed, 0),
    },
    attributes: {
      created: results.reduce((total, result) => total + result.attributes.created, 0),
      updated: results.reduce((total, result) => total + result.attributes.updated, 0),
      unchanged: results.reduce((total, result) => total + result.attributes.unchanged, 0),
    },
    warnings: results.flatMap((result) => result.warnings),
    errors: results.flatMap((result) => result.errors),
    rejects: results.flatMap((result) => result.rejects || []),
    rejectCount: results.reduce((total, result) => total + (result.rejectCount ?? result.rejects?.length ?? 0), 0),
    resolutions: results.flatMap((result) => result.resolutions),
    normalizations: results.flatMap((result) => result.normalizations),
    loadWaves: results.flatMap((result) => result.loadWaves),
  };
}

/**
 * Load a filed report onto a fund: the NAV statement at the period end and the
 * comparative date, and the schedule of investments at the period end. One
 * batch, journaled, so Load data can revert it. Loading the same report again
 * changes nothing that is already on file.
 */
export async function loadNavReport(
  instanceId: string,
  clientId: string,
  input: NavReportInput & { userId?: string | null; confirmed?: boolean },
  client?: SupabaseClient,
) {
  const database = db(client);
  const { instance, report, resolution, plan, statement: found, pages } = await prepare(database, instanceId, clientId, input, true);
  const fund = resolution.fund;
  if (!fund || !found) throw new Error(`${resolution.note} Nothing was loaded.`);
  const statement = found;
  if (input.confirmed !== true) {
    // Loading without a person is allowed only when nothing needs one: the same holds the read step reports.
    const received = input.receivedDate || new Date().toISOString().slice(0, 10);
    const first = statementTable(plan, report, statement, fund, received, pages);
    const second = plan.positions.length ? positionTable(plan, fund, pages) : null;
    const trial = {
      statement: digestLoad(await executeParsedFeed(first.map, instance.file_name, first.table, plan.periodEnd, database, clientId, ADMIN_SOURCE, { dryRun: true })),
      positions: second ? digestLoad(await executeParsedFeed(second.map, instance.file_name, second.table, plan.periodEnd, database, clientId, ADMIN_SOURCE, { dryRun: true })) : null,
    };
    const holds = holdsFor(plan, resolution, report.checks, trial);
    if (holds.length) throw new Error(`This report needs a person before it loads. ${holds.join(' ')} Nothing was loaded.`);
  }
  if (!plan.rows.length || !plan.rows[0].values.length) {
    throw new Error(`Nothing in ${instance.file_name} maps onto the NAV chart at ${plan.periodEnd || 'its period end'}. ${plan.problems.join(' ')}`.trim());
  }
  const received = input.receivedDate || new Date().toISOString().slice(0, 10);
  const first = statementTable(plan, report, statement, fund, received, pages);
  const second = plan.positions.length ? positionTable(plan, fund, pages) : null;

  const batchId = await openDirectBatch(database, {
    clientId,
    importInstanceId: instance.id,
    fileName: instance.file_name,
    mapCode: 'NAV_REPORT',
    sourceCode: ADMIN_SOURCE,
    asOfDate: plan.periodEnd,
    userId: input.userId ?? null,
  });
  const journal: JournalEntry[] = [];
  const recorder: LoadRecorder | undefined = batchId ? { journal: (entry) => { journal.push(entry); } } : undefined;
  const startedAt = new Date().toISOString();
  const results: FeedLoadResult[] = [];
  try {
    try {
      results.push(await executeParsedFeed(first.map, instance.file_name, first.table, plan.periodEnd, database, clientId, ADMIN_SOURCE, {
        provenance: { instanceId: instance.id, tableId: 'nav-report-statement' },
        recorder,
        batchId: batchId || undefined,
      }));
      if (second) {
        results.push(await executeParsedFeed(second.map, instance.file_name, second.table, plan.periodEnd, database, clientId, ADMIN_SOURCE, {
          provenance: { instanceId: instance.id, tableId: 'nav-report-positions' },
          recorder,
          batchId: batchId || undefined,
        }));
      }
    } finally {
      if (batchId && journal.length) await writeJournal(database, batchId, journal);
    }
  } catch (error) {
    if (batchId) await finishDirectBatch(database, batchId, { status: 'FAILED', result: null, errorMessage: error instanceof Error ? error.message : 'The load failed.' });
    throw error;
  }
  const result = combined(results, plan, instance.file_name);
  const needsResolution = result.resolutions.length > 0;
  const failed = needsResolution || result.domains.some((domain) => domain.failed > 0) || result.errors.length > 0;
  if (batchId) await finishDirectBatch(database, batchId, { status: failed ? 'FAILED' : 'PROMOTED', result, errorMessage: failed ? (result.errors.slice(0, 3).join(' ') || `${result.resolutions.length} records match more than one stored record.`) : null });

  const runs = Array.isArray(instance.runs) ? instance.runs : [];
  const summary = resultDigest(result);
  runs.push({
    startedAt,
    completedAt: new Date().toISOString(),
    asOfDate: plan.periodEnd,
    status: failed ? 'FAILED' : 'SUCCEEDED',
    created: result.domains.reduce((total, domain) => total + domain.created, 0),
    matched: result.domains.reduce((total, domain) => total + domain.matched, 0),
    failed: result.domains.reduce((total, domain) => total + domain.failed, 0),
  });
  const saved = await database.schema('entity_instances').from('import_instances').update({
    status: failed ? 'FAILED' : 'SUCCEEDED',
    completed_at: new Date().toISOString(),
    as_of_date: plan.periodEnd,
    source_code: ADMIN_SOURCE,
    map_code: 'NAV_REPORT',
    result,
    runs,
    error_message: failed ? (result.errors.slice(0, 3).join(' ') || 'Some records were refused. Open the batch to see which.') : null,
  }).eq('id', instance.id).eq('client_id', clientId);
  if (saved.error) throw new Error(saved.error.message);

  return {
    instanceId: instance.id,
    fileName: instance.file_name,
    fund: { id: fund.id, code: fund.entity_code, name: fund.entity_name, matchedBy: resolution.matchedBy },
    confirmedBy: input.confirmed === true ? 'a person' : 'nobody: nothing needed a person',
    statement: { code: statement.code, name: statement.name, created: !statement.exists },
    periodEnd: plan.periodEnd,
    comparativeDate: plan.comparativeDate,
    months: plan.months,
    batchId,
    status: failed ? 'FAILED' : 'SUCCEEDED',
    statementLoad: digestLoad(results[0]),
    positionLoad: results[1] ? digestLoad(results[1]) : null,
    summary,
    reportChecks: { total: report.checks.length, ties: report.checks.filter((check) => check.result === 'Ties').length },
    problems: plan.problems,
  };
}
