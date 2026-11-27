/**
 * Loads the performance book for the `performanceBook` query and pools it with
 * performance.ts. Reads go through the shared helpers only (links, valuesFor,
 * loadEntities, compliance.walk_relationship), with the caller's As Of and
 * Knowledge dates: links in force on the As Of date, values on each window's
 * dates, as known at the Knowledge date.
 *
 * What is measured:
 *   - Gross: every position of the given funds that has a cash flow or sits on a
 *     deal tranche. A position with neither has no money put in to measure
 *     against; it is counted in `unmeasuredPositions`.
 *   - Net: every capital account statement of the given funds.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asOfDate, knowledgeInstant, links, loadEntities, numeric, read, text, valuesFor, type Def, type Rel, type ValueRow } from './fund-surface';
import {
  groupBook, filtersPositionsOnly, standardWindows,
  type BookAccount, type BookFilter, type BookPosition, type Flow, type Group, type Statement, type Window,
} from './performance';

const REL = {
  fundParent: 'FUND_PARENT',
  positionFund: 'POSITION_FUND',
  positionCashflow: 'POSITION_CASHFLOW',
  positionTranche: 'POSITION_TRANCHE',
  trancheDeal: 'TRANCHE_DEAL',
  positionSecurity: ['POSITION_SECURITY', 'SECURITY_POSITION'],
  securityIssuer: ['ISSUER_SECURITY', 'SECURITY_ISSUER'],
  accountFund: 'CAPACCT_FUND',
  accountInvestor: 'CAPACCT_INVESTOR',
} as const;

export const ATTR = {
  flowAmount: 'CASHFLOW_INVESTOR_AMOUNT',
  flowDate: 'CASHFLOW_DATE',
  flowType: 'CASHFLOW_TYPE',
  marketValue: 'MARKET_VALUE',
  issuerSector: 'SECTOR',
  dealSector: 'DEAL_SECTOR',
  fundVintage: 'FUND_VINTAGE',
  fundStrategy: 'FUND_STRATEGY',
  fundNetIrr: 'FUND_NET_IRR',
  fundGrossIrr: 'FUND_GROSS_IRR',
  fundNav: 'NAV',
  investorType: 'INVESTOR_TYPE',
  periodEnd: 'CAPACCT_PERIOD_END',
  contributions: 'CAPACCT_CONTRIBUTIONS',
  distributions: 'CAPACCT_DISTRIBUTIONS',
  closing: 'CAPACCT_CLOSING',
  commitment: 'CAPACCT_COMMITMENT',
  contributedItd: 'CAPACCT_CONTRIBUTED_ITD',
  distributedItd: 'CAPACCT_DISTRIBUTED_ITD',
  unfunded: 'CAPACCT_UNFUNDED',
} as const;

export interface WindowInput {
  key: string;
  label?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface PerformanceBookResult {
  asOfDate: string;
  knowledgeDate: string;
  windows: Array<{ key: string; label: string; startDate: string | null; endDate: string; netExcluded: boolean; total: LabelledGroup; groups: LabelledGroup[] }>;
  funds: Array<{ id: string; code: string; name: string; familyId: string; isFamily: boolean; vintage: string | null; strategy: string | null; reportedNetIrr: number | null; reportedGrossIrr: number | null; nav: number | null }>;
  positions: Array<{ id: string; name: string; fundId: string; dealId: string | null; trancheId: string | null; securityId: string | null; issuerId: string | null; issuerName: string | null; sector: string | null; sectorFrom: 'ISSUER' | 'DEAL' | null; flows: Array<Flow & { id: string; type: string | null }>; marks: Array<{ date: string; value: number | null }> }>;
  deals: Array<{ id: string; name: string; sector: string | null }>;
  investors: Array<{ id: string; name: string; type: string | null }>;
  accounts: Array<{ id: string; investorId: string; fundId: string; statements: Array<Statement & { recordName: string }> }>;
  sectors: string[];
  unmeasuredPositions: number;
}

export type LabelledGroup = Group & { label: string };

const day = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** Windows to solve. With none given, inception, last twelve months, year and quarter to date. Ends never pass the As Of date. */
export function resolveWindows(input: WindowInput[] | null | undefined, asOf: string): Window[] {
  if (!input || !input.length) return standardWindows(asOf);
  return input.map((w) => {
    const end = day(w.endDate) && day(w.endDate)! < asOf ? day(w.endDate)! : asOf;
    const start = day(w.startDate);
    return { key: w.key, label: w.label || w.key, start: start && start < end ? start : null, end };
  });
}

async function defsFor(supabase: SupabaseClient, codes: string[]): Promise<Map<string, Def>> {
  const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', codes);
  if (error) throw new Error(error.message);
  const defs = new Map<string, Def>();
  for (const row of data || []) defs.set(row.attribute_code, { id: row.id, code: row.attribute_code });
  return defs;
}

/** Run in groups so a large id list is read in parallel without flooding the API. */
async function inChunks<T>(ids: string[], size: number, run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const out: T[] = [];
  for (let i = 0; i < chunks.length; i += 6) {
    const done = await Promise.all(chunks.slice(i, i + 6).map(run));
    for (const rows of done) out.push(...rows);
  }
  return out;
}

const PAGE = 1000;

/** Ids one hop along a relationship from many records, through compliance.walk_relationship. */
async function walk(supabase: SupabaseClient, ids: string[], code: string, direction: 'UP' | 'DOWN', asOf: string, knowledge: string): Promise<string[]> {
  // The ids travel in the request body; a few thousand at a time keeps each request small.
  const found = await inChunks(ids, 3000, (chunk) => walkPages(supabase, chunk, code, direction, asOf, knowledge));
  return [...new Set(found)];
}

async function walkPages(supabase: SupabaseClient, ids: string[], code: string, direction: 'UP' | 'DOWN', asOf: string, knowledge: string): Promise<string[]> {
  if (!ids.length) return [];
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE * 4) {
    const pages = await Promise.all([0, 1, 2, 3].map(async (n) => {
      const start = from + n * PAGE;
      const { data, error } = await supabase.schema('compliance').rpc('walk_relationship', {
        p_start_ids: ids, p_relationship_code: code, p_direction: direction, p_recursive: false, p_as_of_date: asOf, p_knowledge_date: knowledge,
      }).order('entity_id').range(start, start + PAGE - 1);
      if (error) throw new Error(error.message);
      return (data || []) as Array<{ entity_id: string }>;
    }));
    for (const page of pages) for (const row of page) out.add(row.entity_id);
    if (pages.some((page) => page.length < PAGE)) break;
  }
  return [...out];
}

/** Both ends of a relationship code, from the records given: the other record for each. */
async function neighbours(supabase: SupabaseClient, codes: readonly string[], ids: string[], asOf: string, knowledge: string): Promise<Array<{ from: string; to: string }>> {
  const mine = new Set(ids);
  const rows: Rel[] = [];
  for (const code of codes) {
    const [asParent, asChild] = await Promise.all([
      inChunks(ids, 500, (chunk) => links(supabase, code, 'parent_entity_id', chunk, asOf, knowledge)),
      inChunks(ids, 500, (chunk) => links(supabase, code, 'child_entity_id', chunk, asOf, knowledge)),
    ]);
    rows.push(...asParent, ...asChild);
  }
  const out: Array<{ from: string; to: string }> = [];
  for (const row of rows) {
    if (mine.has(row.parent_entity_id) && !mine.has(row.child_entity_id)) out.push({ from: row.parent_entity_id, to: row.child_entity_id });
    else if (mine.has(row.child_entity_id) && !mine.has(row.parent_entity_id)) out.push({ from: row.child_entity_id, to: row.parent_entity_id });
  }
  return out;
}

async function values(supabase: SupabaseClient, ids: string[], defs: Map<string, Def>, asOf: string, knowledge: string): Promise<Map<string, ValueRow>> {
  const out = new Map<string, ValueRow>();
  const maps = await inChunks(ids, 200, async (chunk) => [await valuesFor(supabase, chunk, defs, asOf, knowledge)]);
  for (const map of maps) for (const [k, v] of map) out.set(k, v);
  return out;
}

const firstOf = (pairs: Array<{ from: string; to: string }>) => {
  const map = new Map<string, string>();
  for (const pair of pairs) if (!map.has(pair.from)) map.set(pair.from, pair.to);
  return map;
};

export async function loadPerformanceBook(
  supabase: SupabaseClient,
  args: { fundIds: string[]; windows?: WindowInput[] | null; filter?: BookFilter | null; asOfDate?: string | null; knowledgeDate?: string | null },
): Promise<PerformanceBookResult> {
  const asOf = asOfDate(args.asOfDate);
  const knowledge = knowledgeInstant(args.knowledgeDate);
  const windows = resolveWindows(args.windows, asOf);
  const fundIds = [...new Set(args.fundIds)].filter(Boolean);
  const fundSet = new Set(fundIds);
  const tie = [asOf, knowledge] as const;

  // Families: a vehicle's parent fund. A fund with no parent is its own family.
  const parentRows = await inChunks(fundIds, 500, (chunk) => links(supabase, REL.fundParent, 'child_entity_id', chunk, ...tie));
  const parentOf = new Map<string, string>();
  for (const row of parentRows) if (!parentOf.has(row.child_entity_id)) parentOf.set(row.child_entity_id, row.parent_entity_id);
  const familyOf = (fundId: string) => parentOf.get(fundId) ?? fundId;

  // Positions of the funds (both link directions are in use), then the measured ones.
  const [up, down] = await Promise.all([
    walk(supabase, fundIds, REL.positionFund, 'UP', ...tie),
    walk(supabase, fundIds, REL.positionFund, 'DOWN', ...tie),
  ]);
  const allPositions = [...new Set([...up, ...down])].filter((id) => !fundSet.has(id));
  const [cashflowIds, trancheIds] = await Promise.all([
    walk(supabase, allPositions, REL.positionCashflow, 'DOWN', ...tie),
    walk(supabase, allPositions, REL.positionTranche, 'DOWN', ...tie),
  ]);
  const positionSet = new Set(allPositions);
  const [flowRows, trancheRows, dealRows] = await Promise.all([
    inChunks(cashflowIds, 500, (chunk) => links(supabase, REL.positionCashflow, 'child_entity_id', chunk, ...tie)),
    inChunks(trancheIds, 500, (chunk) => links(supabase, REL.positionTranche, 'child_entity_id', chunk, ...tie)),
    inChunks(trancheIds, 500, (chunk) => links(supabase, REL.trancheDeal, 'parent_entity_id', chunk, ...tie)),
  ]);
  const flowsOf = new Map<string, string[]>();
  for (const row of flowRows) {
    if (!positionSet.has(row.parent_entity_id)) continue;
    flowsOf.set(row.parent_entity_id, [...(flowsOf.get(row.parent_entity_id) || []), row.child_entity_id]);
  }
  const trancheOf = new Map<string, string>();
  for (const row of trancheRows) if (positionSet.has(row.parent_entity_id) && !trancheOf.has(row.parent_entity_id)) trancheOf.set(row.parent_entity_id, row.child_entity_id);
  const dealOfTranche = new Map<string, string>();
  for (const row of dealRows) if (!dealOfTranche.has(row.parent_entity_id)) dealOfTranche.set(row.parent_entity_id, row.child_entity_id);
  const measured = allPositions.filter((id) => flowsOf.has(id) || trancheOf.has(id));

  // Each measured position's fund, security, issuer.
  const fundPairs = (await neighbours(supabase, [REL.positionFund], measured, ...tie)).filter((pair) => fundSet.has(pair.to));
  const fundOf = firstOf(fundPairs);
  const securityOf = firstOf(await neighbours(supabase, REL.positionSecurity, measured, ...tie));
  const securityIds = [...new Set(securityOf.values())];
  const issuerOf = firstOf(await neighbours(supabase, REL.securityIssuer, securityIds, ...tie));

  // Capital accounts: one record per investor, fund and quarter.
  const accountRows = await inChunks(fundIds, 500, (chunk) => links(supabase, REL.accountFund, 'child_entity_id', chunk, ...tie));
  const accountFund = new Map(accountRows.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const accountRecords = [...accountFund.keys()];
  const investorRows = await inChunks(accountRecords, 500, (chunk) => links(supabase, REL.accountInvestor, 'parent_entity_id', chunk, ...tie));
  const investorOf = new Map(investorRows.map((row) => [row.parent_entity_id, row.child_entity_id]));

  const defs = await defsFor(supabase, Object.values(ATTR));
  const pick = (...codes: string[]) => new Map(codes.map((code) => [code, defs.get(code)]).filter((entry): entry is [string, Def] => Boolean(entry[1])));
  const issuerIds = [...new Set(issuerOf.values())];
  const dealIds = [...new Set([...trancheOf.values()].map((t) => dealOfTranche.get(t)).filter((id): id is string => Boolean(id)))];
  const investorIds = [...new Set(investorOf.values())];
  const ends = [...new Set(windows.map((w) => w.end))];
  const markDates = [...new Set(windows.flatMap((w) => (w.start ? [w.start, w.end] : [w.end])))].sort();
  const lastEnd = ends.reduce((a, b) => (a > b ? a : b));

  const flowDefs = pick(ATTR.flowAmount, ATTR.flowDate, ATTR.flowType);
  const flowValues = new Map<string, Map<string, ValueRow>>();
  const marks = new Map<string, Map<string, ValueRow>>();
  await Promise.all([
    ...ends.map(async (end) => flowValues.set(end, await values(supabase, cashflowIds, flowDefs, end, knowledge))),
    ...markDates.map(async (date) => marks.set(date, await values(supabase, measured, pick(ATTR.marketValue), date, knowledge))),
  ]);
  const relevantFunds = new Set<string>([...fundOf.values(), ...accountFund.values()]);
  for (const id of [...relevantFunds]) relevantFunds.add(familyOf(id));
  const [issuerValues, dealValues, fundValues, investorValues, accountValues] = await Promise.all([
    values(supabase, issuerIds, pick(ATTR.issuerSector), asOf, knowledge),
    values(supabase, dealIds, pick(ATTR.dealSector), asOf, knowledge),
    values(supabase, [...relevantFunds], pick(ATTR.fundVintage, ATTR.fundStrategy, ATTR.fundNetIrr, ATTR.fundGrossIrr, ATTR.fundNav), asOf, knowledge),
    values(supabase, investorIds, pick(ATTR.investorType), asOf, knowledge),
    values(supabase, accountRecords, pick(ATTR.periodEnd, ATTR.contributions, ATTR.distributions, ATTR.closing, ATTR.commitment, ATTR.contributedItd, ATTR.distributedItd, ATTR.unfunded), lastEnd, knowledge),
  ]);
  const names = new Map((await inChunks([...measured, ...dealIds, ...issuerIds, ...investorIds, ...accountRecords, ...relevantFunds, ...securityIds], 500, (chunk) => loadEntities(supabase, chunk))).map((row) => [row.id, row]));
  const nameOf = (id: string | null | undefined) => (id ? names.get(id)?.entity_name || names.get(id)?.entity_code || id : '');

  const val = (map: Map<string, ValueRow> | undefined, id: string, code: string) => (map ? read(map, id, defs.get(code)) : undefined);
  const textOrNull = (row: ValueRow | undefined) => text(row) || null;

  // The book: positions with their flows and marks.
  const positions: BookPosition[] = [];
  const outPositions: PerformanceBookResult['positions'] = [];
  const latestFlows = flowValues.get(lastEnd)!;
  for (const id of measured) {
    const fundId = fundOf.get(id);
    if (!fundId) continue;
    const trancheId = trancheOf.get(id) ?? null;
    const dealId = trancheId ? dealOfTranche.get(trancheId) ?? null : null;
    const securityId = securityOf.get(id) ?? null;
    const issuerId = securityId ? issuerOf.get(securityId) ?? null : null;
    const issuerSector = issuerId ? textOrNull(val(issuerValues, issuerId, ATTR.issuerSector)) : null;
    const dealSector = dealId ? textOrNull(val(dealValues, dealId, ATTR.dealSector)) : null;
    const sector = issuerSector ?? dealSector;
    const flows = (flowsOf.get(id) || []).map((flowId) => ({
      id: flowId,
      date: (textOrNull(val(latestFlows, flowId, ATTR.flowDate)) || '').slice(0, 10),
      amount: numeric(val(latestFlows, flowId, ATTR.flowAmount)) ?? 0,
      type: textOrNull(val(latestFlows, flowId, ATTR.flowType)),
    })).filter((flow) => flow.date && flow.amount).sort((a, b) => (a.date < b.date ? -1 : 1));
    const markValues: Record<string, number | null> = {};
    for (const date of markDates) markValues[date] = numeric(val(marks.get(date), id, ATTR.marketValue)) ?? null;
    positions.push({ id, fundId, dealId, sector, flows, values: markValues });
    outPositions.push({
      id, name: nameOf(id), fundId, dealId, trancheId, securityId, issuerId, issuerName: issuerId ? nameOf(issuerId) : null,
      sector, sectorFrom: issuerSector ? 'ISSUER' : dealSector ? 'DEAL' : null,
      flows, marks: markDates.map((date) => ({ date, value: markValues[date] })),
    });
  }
  // A window ending earlier than the latest reads its flows as known on its own end date.
  const positionsFor = (end: string): BookPosition[] => {
    const byEnd = flowValues.get(end);
    if (!byEnd || byEnd === latestFlows) return positions;
    return positions.map((p) => ({
      ...p,
      flows: (flowsOf.get(p.id) || []).map((flowId) => ({
        date: (textOrNull(val(byEnd, flowId, ATTR.flowDate)) || '').slice(0, 10),
        amount: numeric(val(byEnd, flowId, ATTR.flowAmount)) ?? 0,
      })).filter((flow) => flow.date && flow.amount),
    }));
  };

  // Capital accounts grouped into investor-and-fund series.
  const series = new Map<string, BookAccount & { statements: Array<Statement & { recordName: string }> }>();
  for (const record of accountRecords) {
    const fundId = accountFund.get(record)!;
    const investorId = investorOf.get(record);
    const periodEnd = (textOrNull(val(accountValues, record, ATTR.periodEnd)) || '').slice(0, 10);
    if (!investorId || !periodEnd) continue;
    const key = `${investorId}|${fundId}`;
    const account = series.get(key) || { id: key, investorId, fundId, statements: [] };
    const n = (code: string) => numeric(val(accountValues, record, code));
    account.statements.push({
      recordId: record, recordName: nameOf(record), periodEnd,
      contributions: n(ATTR.contributions) ?? 0, distributions: n(ATTR.distributions) ?? 0, closing: n(ATTR.closing) ?? 0,
      commitment: n(ATTR.commitment), contributedItd: n(ATTR.contributedItd), distributedItd: n(ATTR.distributedItd), unfunded: n(ATTR.unfunded),
    });
    series.set(key, account);
  }
  for (const account of series.values()) account.statements.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  const accounts = [...series.values()];

  const labelOf = (g: Group): string => {
    switch (g.dimension) {
      case 'TOTAL': return 'Firm total';
      case 'SECTOR': return g.key;
      case 'DEAL_FUND': case 'INVESTOR_FUND': return nameOf(g.entityId);
      default: return nameOf(g.entityId);
    }
  };
  const label = (g: Group): LabelledGroup => ({ ...g, label: labelOf(g) });
  const netExcluded = filtersPositionsOnly(args.filter);
  const solved = windows.map((window) => {
    const { total, groups } = groupBook({ positions: positionsFor(window.end), accounts, familyOf, window, filter: args.filter });
    return { key: window.key, label: window.label, startDate: window.start, endDate: window.end, netExcluded, total: label(total), groups: groups.map(label) };
  });

  const funds = [...relevantFunds].map((id) => ({
    id,
    code: names.get(id)?.entity_code || '',
    name: nameOf(id),
    familyId: familyOf(id),
    isFamily: [...parentOf.values()].includes(id),
    vintage: textOrNull(val(fundValues, id, ATTR.fundVintage)),
    strategy: textOrNull(val(fundValues, id, ATTR.fundStrategy)),
    reportedNetIrr: numeric(val(fundValues, id, ATTR.fundNetIrr)),
    reportedGrossIrr: numeric(val(fundValues, id, ATTR.fundGrossIrr)),
    nav: numeric(val(fundValues, id, ATTR.fundNav)),
  }));

  return {
    asOfDate: asOf,
    knowledgeDate: knowledge,
    windows: solved,
    funds,
    positions: outPositions,
    deals: dealIds.map((id) => ({ id, name: nameOf(id), sector: textOrNull(val(dealValues, id, ATTR.dealSector)) })),
    investors: investorIds.map((id) => ({ id, name: nameOf(id), type: textOrNull(val(investorValues, id, ATTR.investorType)) })),
    accounts,
    sectors: [...new Set(positions.map((p) => p.sector || 'Unclassified'))].sort(),
    unmeasuredPositions: allPositions.length - measured.length,
  };
}
