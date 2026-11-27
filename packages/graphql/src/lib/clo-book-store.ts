/**
 * Loads the CLO book for `cloBook`, `cloDrift` and `cloOpportunities` (see clo-book.ts for what
 * is worked out here and what comes from the compliance engine).
 *
 * Reads go through the shared helpers only (links, values, loadEntities, walk_relationship),
 * with the caller's As Of and Knowledge dates. Tests come from the compliance engine
 * (ComplianceEngine.proformaSnapshot and evaluateProforma), scored at the same dates, so the
 * surface, the assistant and the compliance screens read one result.
 *
 * A fund is a CLO when it has a CLO transaction record (FUND_CLO_TRANSACTION), the same test
 * the CLO rule library scopes its rules by.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asOfDate, knowledgeInstant, loadEntities, numeric, read, text, type Def, type ValueRow } from './fund-surface';
import { defsFor, inChunks, neighbours, values } from './performance-store';
import { ComplianceEngine } from './compliance-engine';
import {
  dealPhase, expectedInterest, isBreach, isWarning, periodsPerYear, quarterEnds, rankOpportunities, runWaterfall,
  scoreOpportunity, summariseDiversity, tagRule, toTests, yearsBetween,
  type DiversityIndustry, type DiversityResult, type EngineLine, type Metric, type OpportunityScore,
  type ProformaLineLite, type RuleShape, type Test, type WaterfallResult,
} from './clo-book';

const REL = {
  transaction: ['FUND_CLO_TRANSACTION'],
  note: ['FUND_CLO_NOTE_CLASS'],
  account: ['FUND_CLO_ACCOUNT'],
  positionFund: ['POSITION_FUND'],
  positionSecurity: ['POSITION_SECURITY', 'SECURITY_POSITION'],
  securityIssuer: ['SECURITY_ISSUER', 'ISSUER_SECURITY'],
} as const;

/** Attributes read off each record. The CLO_TRANSACTION, CLO_NOTE_CLASS and CLO_ACCOUNT attributes are read in full from the register. */
export const ATTR = {
  position: {
    par: 'FUNDED_PAR_AMOUNT', price: 'FAIR_MARKET_PRICE', marketValue: 'MARKET_VALUE', expectedInterest: 'CLO_EXPECTED_INTEREST',
    discount: 'CLO_IS_DISCOUNT_OBLIGATION', carryValue: 'CLO_DEFAULT_CARRY_VALUE', hypothetical: 'POSITION_IS_HYPOTHETICAL',
    acquired: 'CLO_ACQUISITION_DATE', creditRisk: 'CLO_IS_CREDIT_RISK',
  },
  security: {
    loanType: 'CLO_LOAN_TYPE', lien: 'LIEN_PRIORITY', covLite: 'IS_COV_LITE', fixedRate: 'IS_FIXED_RATE', defaulted: 'IS_DEFAULTED',
    spread: 'SPREAD_BPS', maturity: 'MATURITY_DATE', moodys: 'CLO_MOODYS_FACILITY_RATING', sp: 'CLO_SP_FACILITY_RATING',
    factor: 'CLO_MOODYS_RATING_FACTOR', ccc: 'CLO_IS_CCC', recovery: 'CLO_MOODYS_RECOVERY_RATE', outlook: 'CLO_RATING_OUTLOOK',
    currency: 'DENOMINATION_CURRENCY', marketStatus: 'CLO_MARKET_STATUS', offerPrice: 'CLO_OFFER_PRICE', offerSize: 'CLO_OFFER_SIZE',
  },
  issuer: { industry: 'MOODYS_INDUSTRY_CODE', obligorGroup: 'OBLIGOR_GROUP_ID', country: 'COUNTRY_OF_DOMICILE' },
  fund: { currency: 'NAV_CURRENCY' },
} as const;

const CLO_DOMAINS = ['CLO_TRANSACTION', 'CLO_NOTE_CLASS', 'CLO_ACCOUNT'] as const;

export interface Term { code: string; name: string; section: string; order: number; dataType: string; value: string | null; numeric: number | null }

export interface Note {
  id: string; name: string; cls: string; rank: number; deferrable: boolean; residual: boolean;
  originalPar: number | null; par: number; deferredInterest: number; interestDue: number; spreadBps: number | null;
  couponPct: number | null; ocTrigger: number | null; icTrigger: number | null;
  ratingSp: string | null; ratingMoodys: string | null; ratingFitch: string | null;
  sharePct: number | null; attachmentPct: number | null; detachmentPct: number | null;
  oc: Test | null; ic: Test | null;
}

export interface Account { id: string; name: string; type: string | null; currency: string | null; balance: number; uninvested: number }

export interface Holding {
  positionId: string; securityId: string | null; issuerId: string | null;
  name: string; issuer: string; industry: string | null; obligorGroup: string | null; country: string | null;
  par: number; price: number | null; marketValue: number | null; expectedInterest: number | null;
  loanType: string | null; lien: string | null; covLite: boolean; fixedRate: boolean; defaulted: boolean; discount: boolean;
  spreadBps: number | null; maturity: string | null; lifeYears: number | null; ratingMoodys: string | null; ratingSp: string | null;
  factor: number | null; ccc: boolean; recovery: number | null; outlook: string | null; currency: string | null; acquired: string | null;
  carryValue: number | null; sharePct: number | null;
}

export interface Kpi { metric: Metric; label: string; rank: number | null; value: number | null; limit: number | null; direction: 'MAX' | 'MIN'; status: string; cushion: number | null; cushionPct: number | null; ruleCode: string | null; ruleName: string | null }

export interface Vehicle {
  id: string; code: string; name: string; currency: string | null;
  transactionId: string | null; transactionName: string | null;
  phase: string | null; manager: string | null; trustee: string | null;
  reinvestmentEnd: string | null; nonCallEnd: string | null; maturity: string | null; nextPayment: string | null;
  yearsToReinvestmentEnd: number | null; benchmarkPct: number | null; periodsPerYear: number;
  terms: Term[];
  notes: Note[];
  accounts: Account[];
  holdings: Holding[];
  hypotheticalPositions: number;
  collateral: {
    par: number; performingPar: number; defaultedPar: number; marketValue: number; weightedPrice: number | null; count: number; obligors: number;
    cccPar: number; cccPct: number | null; covLitePct: number | null; secondLienPct: number | null; fixedRatePct: number | null;
    largestObligorPct: number | null; interestProceeds: number; principalCash: number; notesPar: number; ratedNotesPar: number; equityPar: number;
  };
  tests: Test[];
  kpis: Kpi[];
  diversity: DiversityResult & { limit: number | null; status: string };
  waterfall: WaterfallResult;
  summary: { tests: number; breaches: number; warnings: number; noData: number; passing: number; tightest: { label: string; cushionPct: number } | null };
  errors: string[];
}

export interface CloBook {
  asOfDate: string;
  knowledgeDate: string;
  vehicles: Vehicle[];
  totals: { vehicles: number; collateralPar: number; notesPar: number; breaches: number; warnings: number };
  errors: string[];
}

interface Register { id: string; code: string; name: string; section: string; order: number; dataType: string; domain: string }

const day = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const truthy = (row: ValueRow | undefined) => /^(true|t|1|yes)$/i.test(text(row));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function register(supabase: SupabaseClient): Promise<Register[]> {
  const { data, error } = await supabase.from('attribute_register')
    .select('id, attribute_code, attribute_name, display_section, display_group, data_type, domain_code')
    .in('domain_code', CLO_DOMAINS as unknown as string[]);
  if (error) throw new Error(error.message);
  return (data || []).map((r: any) => ({ id: r.id, code: r.attribute_code, name: r.attribute_name, section: r.display_section || 'General', order: Number(r.display_group) || 0, dataType: r.data_type, domain: r.domain_code }));
}

/**
 * The industry rows behind one diversity test's score for one fund, from the engine's own
 * interpreter (compliance.clo_diversity_breakdown reads the rule's DIVERSITY line).
 */
async function diversityRows(supabase: SupabaseClient, ruleCode: string, fundId: string, asOf: string, knowledge: string): Promise<DiversityIndustry[]> {
  const { data, error } = await supabase.schema('compliance').rpc('clo_diversity_breakdown', {
    p_rule_code: ruleCode, p_anchor_id: fundId, p_as_of_date: asOf, p_knowledge_date: knowledge,
  });
  if (error) throw new Error(error.message);
  return ((data || []) as any[]).map((r) => ({
    industry: r.industry ?? null, obligors: Number(r.obligors) || 0, par: Number(r.par) || 0, units: Number(r.units) || 0, score: Number(r.score) || 0,
  }));
}

/** The rule data that says what each scored rule measures: its lines and their conditions. */
export async function ruleShapes(supabase: SupabaseClient, ruleCodes: string[], asOf: string): Promise<Map<string, RuleShape>> {
  const out = new Map<string, RuleShape>();
  const codes = [...new Set(ruleCodes)];
  if (!codes.length) return out;
  const cx = supabase.schema('compliance');
  // The active fund rules the caller can see, matched to the lines the engine returned.
  const wanted = new Set(codes);
  const { data: rules, error } = await cx.from('rules').select('id, rule_code, rule_name, rule_category, client_id')
    .eq('anchor_domain_code', 'FUND').eq('is_active', true);
  if (error) throw new Error(error.message);
  const ruleRows = ((rules || []) as any[]).filter((r) => wanted.has(r.rule_code))
    .sort((a, b) => (a.client_id ? 1 : 0) - (b.client_id ? 1 : 0));
  const ruleIds = ruleRows.map((r) => r.id);
  if (!ruleIds.length) return out;
  const { data: versions, error: vError } = await cx.from('rule_versions')
    .select('id, rule_id, version_number, valid_from, valid_to, metadata, is_active').in('rule_id', ruleIds).eq('is_active', true);
  if (vError) throw new Error(vError.message);
  const versionOf = new Map<string, any>();
  for (const v of (versions || []) as any[]) {
    if (day(v.valid_from) && day(v.valid_from)! > asOf) continue;
    if (day(v.valid_to) && day(v.valid_to)! < asOf) continue;
    const held = versionOf.get(v.rule_id);
    if (!held || Number(v.version_number) > Number(held.version_number)) versionOf.set(v.rule_id, v);
  }
  const versionIds = [...versionOf.values()].map((v) => v.id);
  const { data: lines, error: lError } = versionIds.length
    ? await cx.from('rule_measure_lines').select('id, rule_version_id, side, kind, attribute_code, weight_attribute_code, label').in('rule_version_id', versionIds)
    : { data: [], error: null };
  if (lError) throw new Error(lError.message);
  const lineIds = ((lines || []) as any[]).map((l) => l.id);
  const { data: conds, error: cError } = lineIds.length
    ? await cx.from('rule_conditions').select('measure_line_id, attribute_code, operator, value').in('measure_line_id', lineIds)
    : { data: [], error: null };
  if (cError) throw new Error(cError.message);
  const condsOf = new Map<string, Array<{ attributeCode: string; operator: string; value: string | null }>>();
  for (const c of (conds || []) as any[]) {
    const list = condsOf.get(c.measure_line_id) || [];
    list.push({ attributeCode: c.attribute_code, operator: c.operator, value: c.value });
    condsOf.set(c.measure_line_id, list);
  }
  for (const rule of ruleRows) {
    if (out.has(rule.rule_code)) continue;
    const version = versionOf.get(rule.id);
    const own = ((lines || []) as any[]).filter((l) => version && l.rule_version_id === version.id);
    out.set(rule.rule_code, {
      ruleCode: rule.rule_code,
      ruleName: rule.rule_name,
      category: rule.rule_category,
      limitTermAttribute: version?.metadata?.limit_term?.attribute ?? null,
      lines: own.map((l) => ({ side: l.side, kind: l.kind, attributeCode: l.attribute_code, weightAttributeCode: l.weight_attribute_code, label: l.label, conditions: condsOf.get(l.id) || [] })),
    });
  }
  return out;
}

/** Run up to `limit` jobs at once, keeping order. */
async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]);
    }
  }));
  return out;
}

async function snapshot(supabase: SupabaseClient, fundId: string, asOf: string, knowledge: string, ruleCodes?: string[] | null): Promise<{ lines: EngineLine[]; error: string | null }> {
  try {
    const rows = await new ComplianceEngine(supabase).proformaSnapshot({ anchorEntityId: fundId, legs: [], asOfDate: asOf, knowledgeDate: knowledge, ruleCodes: ruleCodes ?? null });
    return { lines: rows as EngineLine[], error: null };
  } catch (error: any) {
    return { lines: [], error: error?.message || String(error) };
  }
}

interface Frame {
  funds: Array<{ id: string; code: string; name: string }>;
  txnOf: Map<string, string>;
  notesOf: Map<string, string[]>;
  accountsOf: Map<string, string[]>;
  positionsOf: Map<string, string[]>;
  securityOf: Map<string, string>;
  issuerOf: Map<string, string>;
  reg: Register[];
  regValues: Map<string, ValueRow>;
  posValues: Map<string, ValueRow>;
  secValues: Map<string, ValueRow>;
  issValues: Map<string, ValueRow>;
  fundValues: Map<string, ValueRow>;
  defs: Map<string, Def>;
  names: Map<string, { entity_code: string; entity_name: string }>;
}

const group = (pairs: Array<{ from: string; to: string }>) => {
  const map = new Map<string, string[]>();
  for (const pair of pairs) map.set(pair.from, [...(map.get(pair.from) || []), pair.to]);
  return map;
};
const first = (pairs: Array<{ from: string; to: string }>) => {
  const map = new Map<string, string>();
  for (const pair of pairs) if (!map.has(pair.from)) map.set(pair.from, pair.to);
  return map;
};

/** Every record a CLO is drawn from, as of one date. */
async function loadFrame(supabase: SupabaseClient, fundIds: string[], asOf: string, knowledge: string): Promise<Frame> {
  const tie = [asOf, knowledge] as const;
  const ids = [...new Set(fundIds)].filter(Boolean);
  const txnPairs = await neighbours(supabase, REL.transaction, ids, ...tie);
  const txnOf = first(txnPairs);
  const cloIds = ids.filter((id) => txnOf.has(id));
  const [notePairs, accountPairs, positionPairs] = await Promise.all([
    neighbours(supabase, REL.note, cloIds, ...tie),
    neighbours(supabase, REL.account, cloIds, ...tie),
    neighbours(supabase, REL.positionFund, cloIds, ...tie),
  ]);
  const positionsOf = group(positionPairs);
  const positionIds = [...new Set(positionPairs.map((p) => p.to))];
  const securityOf = first(await neighbours(supabase, REL.positionSecurity, positionIds, ...tie));
  const securityIds = [...new Set(securityOf.values())];
  const issuerOf = first(await neighbours(supabase, REL.securityIssuer, securityIds, ...tie));
  const issuerIds = [...new Set(issuerOf.values())];

  const reg = await register(supabase);
  const regDefs = new Map(reg.map((r) => [r.code, { id: r.id, code: r.code } as Def]));
  const defs = await defsFor(supabase, [
    ...Object.values(ATTR.position), ...Object.values(ATTR.security), ...Object.values(ATTR.issuer), ...Object.values(ATTR.fund),
  ]);
  const pick = (codes: readonly string[]) => new Map(codes.map((c) => [c, defs.get(c)]).filter((e): e is [string, Def] => Boolean(e[1])));
  const cloRecordIds = [...txnOf.values(), ...notePairs.map((p) => p.to), ...accountPairs.map((p) => p.to)];
  const [regValues, posValues, secValues, issValues, fundValues] = await Promise.all([
    values(supabase, cloRecordIds, regDefs, ...tie),
    values(supabase, positionIds, pick(Object.values(ATTR.position)), ...tie),
    values(supabase, securityIds, pick(Object.values(ATTR.security)), ...tie),
    values(supabase, issuerIds, pick(Object.values(ATTR.issuer)), ...tie),
    values(supabase, cloIds, pick(Object.values(ATTR.fund)), ...tie),
  ]);
  const nameRows = await inChunks([...cloIds, ...cloRecordIds, ...positionIds, ...securityIds, ...issuerIds], 500, (chunk) => loadEntities(supabase, chunk));
  const names = new Map(nameRows.map((r) => [r.id, { entity_code: r.entity_code, entity_name: r.entity_name }]));
  for (const [code, def] of regDefs) defs.set(code, def);
  return {
    funds: cloIds.map((id) => ({ id, code: names.get(id)?.entity_code || id, name: names.get(id)?.entity_name || id })),
    txnOf, notesOf: group(notePairs), accountsOf: group(accountPairs), positionsOf, securityOf, issuerOf,
    reg, regValues, posValues, secValues, issValues, fundValues, defs, names,
  };
}

/** One CLO as of the frame's date, with its tests from the engine. */
function buildVehicle(frame: Frame, fundId: string, asOf: string, lines: EngineLine[], engineError: string | null, shapes: Map<string, RuleShape>, diversityIndustries: DiversityIndustry[]): Vehicle {
  const { defs, names } = frame;
  const v = (map: Map<string, ValueRow>, id: string | null | undefined, code: string) => (id ? read(map, id, defs.get(code)) : undefined);
  const num = (map: Map<string, ValueRow>, id: string | null | undefined, code: string) => numeric(v(map, id, code));
  const str = (map: Map<string, ValueRow>, id: string | null | undefined, code: string) => text(v(map, id, code)) || null;
  const nameOf = (id: string | null | undefined) => (id ? names.get(id)?.entity_name || id : '');
  const errors: string[] = [];
  if (engineError) errors.push(`Compliance engine: ${engineError}`);

  const txnId = frame.txnOf.get(fundId) ?? null;
  const term = (code: string) => str(frame.regValues, txnId, code);
  const termNum = (code: string) => num(frame.regValues, txnId, code);
  const terms: Term[] = frame.reg.filter((r) => r.domain === 'CLO_TRANSACTION').map((r) => ({
    code: r.code, name: r.name, section: r.section, order: r.order, dataType: r.dataType,
    value: str(frame.regValues, txnId, r.code), numeric: num(frame.regValues, txnId, r.code),
  })).sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order);

  const ppy = periodsPerYear(term('CLO_PAYMENT_FREQUENCY'));
  const benchmark = termNum('CLO_BENCHMARK_RATE_PCT');
  const tests = toTests(lines, shapes);

  // Notes, most senior first.
  const rawNotes = (frame.notesOf.get(fundId) || []).map((id) => {
    const rank = num(frame.regValues, id, 'CLO_NOTE_SENIORITY_RANK') ?? 99;
    const cls = str(frame.regValues, id, 'CLO_NOTE_CLASS_CODE') || nameOf(id);
    const spread = num(frame.regValues, id, 'CLO_NOTE_SPREAD_BPS');
    const due = num(frame.regValues, id, 'CLO_NOTE_INTEREST_DUE') ?? 0;
    const residual = num(frame.regValues, id, 'CLO_NOTE_OC_TRIGGER') == null && num(frame.regValues, id, 'CLO_NOTE_IC_TRIGGER') == null && !due;
    return {
      id, name: nameOf(id), cls, rank, residual,
      deferrable: /^(true|t|1|yes)$/i.test(str(frame.regValues, id, 'CLO_NOTE_IS_DEFERRABLE') || ''),
      originalPar: num(frame.regValues, id, 'CLO_NOTE_ORIGINAL_PAR'),
      par: num(frame.regValues, id, 'CLO_NOTE_PAR_OUTSTANDING') ?? 0,
      deferredInterest: num(frame.regValues, id, 'CLO_NOTE_DEFERRED_INTEREST') ?? 0,
      interestDue: due, spreadBps: spread,
      couponPct: residual || spread == null || benchmark == null ? null : benchmark + spread / 100,
      ocTrigger: num(frame.regValues, id, 'CLO_NOTE_OC_TRIGGER'),
      icTrigger: num(frame.regValues, id, 'CLO_NOTE_IC_TRIGGER'),
      ratingSp: str(frame.regValues, id, 'CLO_NOTE_RATING_SP'),
      ratingMoodys: str(frame.regValues, id, 'CLO_NOTE_RATING_MOODYS'),
      ratingFitch: str(frame.regValues, id, 'CLO_NOTE_RATING_FITCH'),
    };
  }).sort((a, b) => a.rank - b.rank);
  const notesPar = sum(rawNotes.map((n) => n.par));
  let attach = 0;
  // Attachment is measured from the bottom: the equity takes the first loss.
  const bottomUp = [...rawNotes].reverse();
  const attachOf = new Map<string, { attachment: number; detachment: number }>();
  for (const n of bottomUp) {
    const share = notesPar ? (n.par / notesPar) * 100 : 0;
    attachOf.set(n.id, { attachment: attach, detachment: attach + share });
    attach += share;
  }
  // A coverage test covers every class ranked its rank or better; its label names the classes since the last tested rank.
  const testedRanks = [...new Set(tests.filter((t) => t.rank != null).map((t) => t.rank!))].sort((a, b) => a - b);
  const classLabel = (rank: number) => {
    const prev = testedRanks.filter((r) => r < rank).pop() ?? 0;
    const classes = rawNotes.filter((n) => n.rank > prev && n.rank <= rank && !n.residual).map((n) => n.cls);
    return `Class ${classes.length ? classes.join('/') : rank}`;
  };
  const notes: Note[] = rawNotes.map((n) => ({
    ...n,
    sharePct: notesPar ? (n.par / notesPar) * 100 : null,
    attachmentPct: attachOf.get(n.id)?.attachment ?? null,
    detachmentPct: attachOf.get(n.id)?.detachment ?? null,
    oc: tests.find((t) => t.metric === 'OC' && t.rank === n.rank && !t.group) ?? null,
    ic: tests.find((t) => t.metric === 'IC' && t.rank === n.rank && !t.group) ?? null,
  }));

  const accounts: Account[] = (frame.accountsOf.get(fundId) || []).map((id) => ({
    id, name: nameOf(id), type: str(frame.regValues, id, 'CLO_ACCT_TYPE'), currency: str(frame.regValues, id, 'CLO_ACCT_CURRENCY'),
    balance: num(frame.regValues, id, 'CLO_ACCT_BALANCE') ?? 0, uninvested: num(frame.regValues, id, 'CLO_ACCT_UNINVESTED_PROCEEDS') ?? 0,
  })).sort((a, b) => (a.type || '').localeCompare(b.type || ''));

  // Holdings. Hypothetical positions are pre-trade scenarios, not the book.
  let hypothetical = 0;
  const holdings: Holding[] = [];
  for (const pid of frame.positionsOf.get(fundId) || []) {
    if (truthy(v(frame.posValues, pid, ATTR.position.hypothetical))) { hypothetical += 1; continue; }
    const par = num(frame.posValues, pid, ATTR.position.par) ?? 0;
    if (!(par > 0)) continue;
    const sid = frame.securityOf.get(pid) ?? null;
    const iid = sid ? frame.issuerOf.get(sid) ?? null : null;
    const maturity = day(str(frame.secValues, sid, ATTR.security.maturity));
    holdings.push({
      positionId: pid, securityId: sid, issuerId: iid,
      name: sid ? nameOf(sid) : nameOf(pid), issuer: iid ? nameOf(iid) : '',
      industry: str(frame.issValues, iid, ATTR.issuer.industry), obligorGroup: str(frame.issValues, iid, ATTR.issuer.obligorGroup),
      country: str(frame.issValues, iid, ATTR.issuer.country),
      par, price: num(frame.posValues, pid, ATTR.position.price), marketValue: num(frame.posValues, pid, ATTR.position.marketValue),
      expectedInterest: num(frame.posValues, pid, ATTR.position.expectedInterest),
      loanType: str(frame.secValues, sid, ATTR.security.loanType), lien: str(frame.secValues, sid, ATTR.security.lien),
      covLite: truthy(v(frame.secValues, sid, ATTR.security.covLite)), fixedRate: truthy(v(frame.secValues, sid, ATTR.security.fixedRate)),
      defaulted: truthy(v(frame.secValues, sid, ATTR.security.defaulted)), discount: truthy(v(frame.posValues, pid, ATTR.position.discount)),
      spreadBps: num(frame.secValues, sid, ATTR.security.spread), maturity, lifeYears: maturity ? yearsBetween(asOf, maturity) : null,
      ratingMoodys: str(frame.secValues, sid, ATTR.security.moodys), ratingSp: str(frame.secValues, sid, ATTR.security.sp),
      factor: num(frame.secValues, sid, ATTR.security.factor), ccc: truthy(v(frame.secValues, sid, ATTR.security.ccc)),
      recovery: num(frame.secValues, sid, ATTR.security.recovery), outlook: str(frame.secValues, sid, ATTR.security.outlook),
      currency: str(frame.secValues, sid, ATTR.security.currency), acquired: day(str(frame.posValues, pid, ATTR.position.acquired)),
      carryValue: num(frame.posValues, pid, ATTR.position.carryValue), sharePct: null,
    });
  }
  const par = sum(holdings.map((h) => h.par));
  for (const h of holdings) h.sharePct = par ? (h.par / par) * 100 : null;
  holdings.sort((a, b) => b.par - a.par);
  const performing = holdings.filter((h) => !h.defaulted);
  const performingPar = sum(performing.map((h) => h.par));
  const pctOf = (xs: Holding[]) => (performingPar ? (sum(xs.map((h) => h.par)) / performingPar) * 100 : null);
  const obligorPar = new Map<string, number>();
  for (const h of performing) obligorPar.set(h.obligorGroup || h.issuerId || h.positionId, (obligorPar.get(h.obligorGroup || h.issuerId || h.positionId) || 0) + h.par);
  const mv = sum(holdings.map((h) => h.marketValue ?? 0));
  const principalCash = sum(accounts.filter((a) => a.type === 'PRINCIPAL').map((a) => a.balance));
  const interestProceeds = sum(performing.map((h) => h.expectedInterest ?? 0));
  const equityPar = sum(notes.filter((n) => n.residual).map((n) => n.par));

  const headline = (metric: Metric) => tests.find((t) => t.metric === metric && !t.group);
  // The diversity score is the engine's test; its industry rows come from the same interpreter.
  const divTest = headline('DIVERSITY');
  const div = summariseDiversity(diversityIndustries, divTest?.value ?? null);
  const divLimit = divTest?.limit ?? null;
  const divStatus = divTest?.status ?? 'NO_DATA';

  const LABEL: Partial<Record<Metric, string>> = { CCC: 'CCC bucket', DIVERSITY: 'Diversity' };
  const kpis: Kpi[] = [];
  for (const metric of ['WARF', 'WAS', 'WAL', 'WARR', 'CCC', 'DIVERSITY'] as Metric[]) {
    const t = headline(metric);
    kpis.push({ metric, label: LABEL[metric] ?? metric, rank: null, value: t?.value ?? null, limit: t?.limit ?? null, direction: t?.direction ?? (metric === 'DIVERSITY' ? 'MIN' : 'MAX'), status: t?.status ?? 'NO_DATA', cushion: t?.cushion ?? null, cushionPct: t?.cushionPct ?? null, ruleCode: t?.ruleCode ?? null, ruleName: t?.ruleName ?? null });
  }
  for (const t of tests.filter((x) => (x.metric === 'OC' || x.metric === 'IC') && !x.group).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (a.metric! < b.metric! ? 1 : -1))) {
    kpis.push({ metric: t.metric!, label: `${classLabel(t.rank ?? 0)} ${t.metric}`, rank: t.rank, value: t.value, limit: t.limit, direction: t.direction, status: t.status, cushion: t.cushion, cushionPct: t.cushionPct, ruleCode: t.ruleCode, ruleName: t.ruleName });
  }

  const reinvestmentEnd = day(term('CLO_REINVESTMENT_PERIOD_END'));
  const waterfall = runWaterfall({
    interestProceeds, principalProceeds: principalCash,
    seniorExpenses: termNum('CLO_SENIOR_EXPENSES') ?? 0,
    collateralPar: performingPar,
    seniorFeeBps: termNum('CLO_SENIOR_MGMT_FEE_BPS'), subFeeBps: termNum('CLO_SUB_MGMT_FEE_BPS'),
    periodsPerYear: ppy,
    reinvesting: reinvestmentEnd ? asOf <= reinvestmentEnd : false,
    notes: notes.map((n) => ({ id: n.id, name: n.name, cls: n.cls, rank: n.rank, par: n.par, interestDue: n.interestDue, deferrable: n.deferrable, residual: n.residual })),
    coverage: tests.filter((t) => (t.metric === 'OC' || t.metric === 'IC') && t.rank != null && !t.group)
      .map((t) => ({ metric: t.metric as 'OC' | 'IC', rank: t.rank!, ruleName: t.ruleName, value: t.value, limit: t.limit, numerator: t.numerator, denominator: t.denominator, status: t.status })),
  });

  const scored = tests.filter((t) => !t.error);
  const tightest = kpis.filter((k) => k.cushionPct != null).sort((a, b) => a.cushionPct! - b.cushionPct!)[0];
  const fund = frame.funds.find((f) => f.id === fundId)!;
  return {
    id: fundId, code: fund.code, name: fund.name, currency: str(frame.fundValues, fundId, ATTR.fund.currency),
    transactionId: txnId, transactionName: txnId ? nameOf(txnId) : null,
    phase: dealPhase(asOf, { closing: day(term('CLO_CLOSING_DATE')), effective: day(term('CLO_EFFECTIVE_DATE')), reinvestmentEnd, maturity: day(term('CLO_STATED_MATURITY')) }),
    manager: term('CLO_COLLATERAL_MANAGER'), trustee: term('CLO_TRUSTEE'),
    reinvestmentEnd, nonCallEnd: day(term('CLO_NON_CALL_END')), maturity: day(term('CLO_STATED_MATURITY')), nextPayment: day(term('CLO_NEXT_PAYMENT_DATE')),
    yearsToReinvestmentEnd: reinvestmentEnd ? yearsBetween(asOf, reinvestmentEnd) : null,
    benchmarkPct: benchmark, periodsPerYear: ppy,
    terms, notes, accounts, holdings, hypotheticalPositions: hypothetical,
    collateral: {
      par, performingPar, defaultedPar: par - performingPar, marketValue: mv, weightedPrice: par ? (sum(holdings.map((h) => (h.price ?? 0) * h.par)) / par) : null,
      count: holdings.length, obligors: obligorPar.size,
      cccPar: sum(performing.filter((h) => h.ccc).map((h) => h.par)), cccPct: pctOf(performing.filter((h) => h.ccc)),
      covLitePct: pctOf(performing.filter((h) => h.covLite)), secondLienPct: pctOf(performing.filter((h) => h.lien === 'SECOND_LIEN')),
      fixedRatePct: pctOf(performing.filter((h) => h.fixedRate)),
      largestObligorPct: performingPar && obligorPar.size ? (Math.max(...obligorPar.values()) / performingPar) * 100 : null,
      interestProceeds, principalCash, notesPar, ratedNotesPar: notesPar - equityPar, equityPar,
    },
    tests, kpis,
    diversity: { ...div, limit: divLimit, status: divStatus },
    waterfall,
    summary: {
      tests: scored.length,
      breaches: scored.filter((t) => isBreach(t.status)).length,
      warnings: scored.filter((t) => isWarning(t.status)).length,
      noData: scored.filter((t) => t.status === 'NO_DATA').length,
      passing: scored.filter((t) => t.status === 'PASS').length,
      tightest: tightest ? { label: tightest.label, cushionPct: tightest.cushionPct! } : null,
    },
    errors,
  };
}

async function bookAt(supabase: SupabaseClient, fundIds: string[], asOf: string, knowledge: string, ruleCodes?: string[] | null): Promise<{ vehicles: Vehicle[] }> {
  const frame = await loadFrame(supabase, fundIds, asOf, knowledge);
  const scores = await pool(frame.funds, 4, (fund) => snapshot(supabase, fund.id, asOf, knowledge, ruleCodes));
  const shapes = await ruleShapes(supabase, scores.flatMap((s) => s.lines.map((l) => l.ruleCode)), asOf);
  // The industry rows behind each fund's diversity test, when the fund is scored on one.
  const industries = await pool(frame.funds, 4, async (fund) => {
    const i = frame.funds.indexOf(fund);
    const line = scores[i].lines.find((l) => !l.groupByValue && tagRule(shapes.get(l.ruleCode)).metric === 'DIVERSITY');
    if (!line) return [] as DiversityIndustry[];
    try { return await diversityRows(supabase, line.ruleCode, fund.id, asOf, knowledge); } catch { return [] as DiversityIndustry[]; }
  });
  const vehicles = frame.funds.map((fund, i) => buildVehicle(frame, fund.id, asOf, scores[i].lines, scores[i].error, shapes, industries[i]));
  vehicles.sort((a, b) => a.name.localeCompare(b.name));
  return { vehicles };
}

export async function loadCloBook(supabase: SupabaseClient, args: { fundIds: string[]; asOfDate?: string | null; knowledgeDate?: string | null }): Promise<CloBook> {
  const asOf = asOfDate(args.asOfDate);
  const knowledge = knowledgeInstant(args.knowledgeDate);
  const { vehicles } = await bookAt(supabase, args.fundIds, asOf, knowledge);
  return {
    asOfDate: asOf, knowledgeDate: knowledge, vehicles,
    totals: {
      vehicles: vehicles.length,
      collateralPar: sum(vehicles.map((v) => v.collateral.par)),
      notesPar: sum(vehicles.map((v) => v.collateral.notesPar)),
      breaches: sum(vehicles.map((v) => v.summary.breaches)),
      warnings: sum(vehicles.map((v) => v.summary.warnings)),
    },
    errors: vehicles.flatMap((v) => v.errors.map((e) => `${v.name}: ${e}`)),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface DriftPoint {
  date: string;
  kpis: Kpi[];
  collateralPar: number; performingPar: number; defaultedPar: number; marketValue: number; weightedPrice: number | null;
  cccPct: number | null; notesPar: number; ratedNotesPar: number; obligors: number; count: number;
  breaches: number; residualToEquity: number; diverted: number;
}

export interface CloDrift { fundId: string; asOfDate: string; knowledgeDate: string; dates: string[]; points: DriftPoint[]; errors: string[] }

/**
 * The CLO as it stood at each quarter end up to the As Of date, and at the As Of date itself.
 * Each point is the same book the other tabs draw, scored by the engine at that date, as known at
 * the Knowledge date.
 */
export async function loadCloDrift(supabase: SupabaseClient, args: { fundId: string; quarters?: number | null; asOfDate?: string | null; knowledgeDate?: string | null }): Promise<CloDrift> {
  const asOf = asOfDate(args.asOfDate);
  const knowledge = knowledgeInstant(args.knowledgeDate);
  const quarters = Math.max(2, Math.min(16, args.quarters ?? 8));
  const dates = quarterEnds(asOf, quarters);
  const errors: string[] = [];
  const points = await pool(dates, 3, async (date) => {
    const { vehicles } = await bookAt(supabase, [args.fundId], date, knowledge);
    const v = vehicles[0];
    if (!v) return null;
    errors.push(...v.errors.map((e) => `${date}: ${e}`));
    const point: DriftPoint = {
      date, kpis: v.kpis,
      collateralPar: v.collateral.par, performingPar: v.collateral.performingPar, defaultedPar: v.collateral.defaultedPar,
      marketValue: v.collateral.marketValue, weightedPrice: v.collateral.weightedPrice, cccPct: v.collateral.cccPct,
      notesPar: v.collateral.notesPar, ratedNotesPar: v.collateral.ratedNotesPar, obligors: v.collateral.obligors, count: v.collateral.count,
      breaches: v.summary.breaches, residualToEquity: v.waterfall.residualToEquity, diverted: v.waterfall.diverted,
    };
    return point;
  });
  return { fundId: args.fundId, asOfDate: asOf, knowledgeDate: knowledge, dates, points: points.filter((p): p is DriftPoint => Boolean(p)), errors };
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface Opportunity {
  securityId: string; issuerId: string | null; name: string; issuer: string; industry: string | null; newIndustry: boolean;
  ratingMoodys: string | null; ratingSp: string | null; factor: number | null; ccc: boolean; spreadBps: number | null; fixedRate: boolean;
  maturity: string | null; lifeYears: number | null; lien: string | null; covLite: boolean;
  offerPrice: number | null; offerSize: number | null; ticket: number;
  score: OpportunityScore | null;
  /** Engine lines that move, worst first. */
  moves: ProformaLineLite[];
  error: string | null;
}

export interface CloOpportunities {
  fundId: string; asOfDate: string; knowledgeDate: string;
  ticketRule: string; candidates: number; scored: number;
  baseline: { diversity: number | null; diversityLimit: number | null; averagePar: number | null };
  opportunities: Opportunity[];
  errors: string[];
}

/** Loans offered in the market (CLO_MARKET_STATUS = OFFERED) that the CLO does not hold. */
async function offeredLoans(supabase: SupabaseClient): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('entity_master').select('entity_id')
      .eq('domain_code', 'SECURITY').eq('is_active', true)
      .contains('attributes', { [ATTR.security.marketStatus]: { value: 'OFFERED' } })
      .order('entity_id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data || []) as Array<{ entity_id: string }>).map((r) => r.entity_id));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Each offered loan scored as a buy for one CLO, by the engine's pro forma (every rule the CLO is
 * enrolled in, before and after; the diversity test among them). The ticket is the
 * CLO's average holding par, rounded to $250,000, capped at the size offered.
 */
export async function loadCloOpportunities(supabase: SupabaseClient, args: { fundId: string; asOfDate?: string | null; knowledgeDate?: string | null; limit?: number | null }): Promise<CloOpportunities> {
  const asOf = asOfDate(args.asOfDate);
  const knowledge = knowledgeInstant(args.knowledgeDate);
  const tie = [asOf, knowledge] as const;
  const errors: string[] = [];
  const { vehicles } = await bookAt(supabase, [args.fundId], asOf, knowledge);
  const vehicle = vehicles[0];
  const base = { fundId: args.fundId, asOfDate: asOf, knowledgeDate: knowledge, ticketRule: 'Average holding par, rounded to $250,000, capped at the size offered' };
  if (!vehicle) return { ...base, candidates: 0, scored: 0, baseline: { diversity: null, diversityLimit: null, averagePar: null }, opportunities: [], errors: ['This fund has no CLO transaction.'] };
  const held = new Set(vehicle.holdings.map((h) => h.securityId).filter(Boolean) as string[]);
  const offered = (await offeredLoans(supabase)).filter((id) => !held.has(id));
  const candidates = offered.slice(0, Math.max(1, Math.min(60, args.limit ?? 40)));

  const defs = await defsFor(supabase, [...Object.values(ATTR.security), ...Object.values(ATTR.issuer)]);
  const pick = (codes: readonly string[]) => new Map(codes.map((c) => [c, defs.get(c)]).filter((e): e is [string, Def] => Boolean(e[1])));
  const issuerOf = first(await neighbours(supabase, REL.securityIssuer, candidates, ...tie));
  const issuerIds = [...new Set(issuerOf.values())];
  const [secValues, issValues, nameRows] = await Promise.all([
    values(supabase, candidates, pick(Object.values(ATTR.security)), ...tie),
    values(supabase, issuerIds, pick(Object.values(ATTR.issuer)), ...tie),
    inChunks([...candidates, ...issuerIds], 500, (chunk) => loadEntities(supabase, chunk)),
  ]);
  const names = new Map(nameRows.map((r) => [r.id, r.entity_name]));
  const sv = (id: string, code: string) => read(secValues, id, defs.get(code));
  const iv = (id: string | null, code: string) => (id ? read(issValues, id, defs.get(code)) : undefined);

  const avg = vehicle.collateral.count ? vehicle.collateral.par / vehicle.collateral.count : 0;
  const heldIndustries = new Set(vehicle.holdings.map((h) => h.industry).filter(Boolean));
  const shapes = await ruleShapes(supabase, vehicle.tests.map((t) => t.ruleCode), asOf);
  const classLabel = (rank: number) => vehicle.kpis.find((k) => k.rank === rank)?.label.replace(/ (OC|IC)$/, '') ?? `Rank ${rank}`;
  const engine = new ComplianceEngine(supabase);

  const opportunities = await pool(candidates, 5, async (sid): Promise<Opportunity> => {
    const iid = issuerOf.get(sid) ?? null;
    const offerSize = numeric(sv(sid, ATTR.security.offerSize));
    const offerPrice = numeric(sv(sid, ATTR.security.offerPrice));
    const ticket = Math.max(250_000, Math.min(offerSize ?? Number.POSITIVE_INFINITY, Math.round(avg / 250_000) * 250_000 || 250_000));
    const spread = numeric(sv(sid, ATTR.security.spread));
    const fixedRate = truthy(sv(sid, ATTR.security.fixedRate));
    const maturity = day(text(sv(sid, ATTR.security.maturity)));
    const industry = text(iv(iid, ATTR.issuer.industry)) || null;
    const row: Opportunity = {
      securityId: sid, issuerId: iid, name: names.get(sid) || sid, issuer: iid ? names.get(iid) || '' : '',
      industry, newIndustry: Boolean(industry && !heldIndustries.has(industry)),
      ratingMoodys: text(sv(sid, ATTR.security.moodys)) || null, ratingSp: text(sv(sid, ATTR.security.sp)) || null,
      factor: numeric(sv(sid, ATTR.security.factor)), ccc: truthy(sv(sid, ATTR.security.ccc)), spreadBps: spread, fixedRate,
      maturity, lifeYears: maturity ? yearsBetween(asOf, maturity) : null,
      lien: text(sv(sid, ATTR.security.lien)) || null, covLite: truthy(sv(sid, ATTR.security.covLite)),
      offerPrice, offerSize, ticket, score: null, moves: [], error: null,
    };
    try {
      const score = await engine.evaluateProforma({
        anchorEntityId: args.fundId, asOfDate: asOf, knowledgeDate: knowledge,
        legs: [{ securityId: sid, par: ticket, attributes: {
          FAIR_MARKET_PRICE: offerPrice ?? 100,
          CLO_EXPECTED_INTEREST: Math.round(expectedInterest(ticket, vehicle.benchmarkPct, spread, fixedRate, vehicle.periodsPerYear) * 100) / 100,
          CLO_IS_DISCOUNT_OBLIGATION: 'false', CLO_DEFAULT_CARRY_VALUE: 0, CLO_DISCOUNT_HAIRCUT: 0,
        } }],
      });
      const lines = score.lines as unknown as ProformaLineLite[];
      row.score = scoreOpportunity(lines, shapes, classLabel);
      const weight: Record<string, number> = { NEW_BREACH: 0, DETERIORATES: 1, CURED: 2, IMPROVES: 3 };
      row.moves = lines.filter((l) => l.verdict in weight).sort((a, b) => weight[a.verdict] - weight[b.verdict]).slice(0, 12);
    } catch (error: any) {
      row.error = error?.message || String(error);
      errors.push(`${row.name}: ${row.error}`);
    }
    return row;
  });

  return {
    ...base,
    candidates: offered.length,
    scored: opportunities.filter((o) => o.score).length,
    baseline: { diversity: vehicle.diversity.score, diversityLimit: vehicle.diversity.limit, averagePar: avg || null },
    opportunities: rankOpportunities(opportunities),
    errors,
  };
}
