/**
 * Reads the OCIO records through the public GraphQL schema, with the user's As Of and
 * Knowledge dates. Which records belong to the surface is decided from data: a fund is an
 * OCIO client or sleeve when it carries a target percent basis, a commitment when it is a
 * position of one of those funds, and a pipeline deal when its tranche's investment is
 * classified.
 *
 * Targets are records, not a document. Each fund has one allocation target record per
 * hierarchy and level, linked to it, and each minimum, target and maximum is its own
 * attribute on that record, with its own sources and history. A save writes only the
 * values that changed.
 */
import type { SurfaceHost } from '@tapestrai/surface-sdk';
import type { Band, Commitment, Deal, DealTranche, Fund, FundingPlan, Lens, OcioData, SecurityFacts, StageDef, TargetScope, Taxonomy, TaxValue } from './types';
import { LENSES, emptyMatrix, targetKey } from './types';

export const ATTR = {
  programUsd: 'FUND_TOTAL_COMMITMENTS',
  programN: 'OCIO_TARGET_INVESTMENT_COUNT',
  annual: 'OCIO_ANNUAL_DEPLOYMENT_TARGET',
  basis: 'OCIO_TARGET_PERCENT_BASIS',
  start: 'INCEPTION_DATE',
  end: 'FUND_INVESTMENT_PERIOD_END',
  currency: 'FUND_BASE_CURRENCY',
  eligible: 'FUND_IS_ALLOCATION_ELIGIBLE',
  amount: 'OCIO_COMMITMENT_AMOUNT',
  tradeDate: 'TRADE_DATE',
  allocationYear: 'OCIO_ALLOCATION_YEAR',
  fundSize: 'OCIO_UNDERLYING_FUND_SIZE',
  manager: 'SECURITY_ISSUER_NAME',
  asset: 'SECURITY_LABEL',
  dealStage: 'DEAL_STAGE',
  dealClose: 'DEAL_TARGET_CLOSE_DATE',
  dealSize: 'DEAL_VALUE',
  trancheHold: 'TRANCHE_HOLD_AMOUNT',
  planAmount: 'OCIO_ALLOCATION_AMOUNT',
  planRatio: 'OCIO_SHARING_RATIO',
  planStatus: 'FUNDING_STATUS',
} as const;

/** The allocation target record: one per fund, hierarchy and level. */
export const TARGET = {
  domain: 'OCIO_TARGET',
  template: 'OCIO_TARGET_STANDARD',
  hierarchy: 'OCIO_TARGET_HIERARCHY',
  level: 'OCIO_TARGET_LEVEL',
} as const;

/** Each value of a target is its own attribute. */
export const TARGET_ATTR: Record<keyof Band, { code: string; name: string }> = {
  usdMin: { code: 'OCIO_TARGET_USD_MIN', name: 'Target dollars, minimum' },
  usd: { code: 'OCIO_TARGET_USD', name: 'Target dollars' },
  usdMax: { code: 'OCIO_TARGET_USD_MAX', name: 'Target dollars, maximum' },
  nMin: { code: 'OCIO_TARGET_COUNT_MIN', name: 'Target investments, minimum' },
  n: { code: 'OCIO_TARGET_COUNT', name: 'Target investments' },
  nMax: { code: 'OCIO_TARGET_COUNT_MAX', name: 'Target investments, maximum' },
  pctMin: { code: 'OCIO_TARGET_PCT_MIN', name: 'Target percent, minimum' },
  pct: { code: 'OCIO_TARGET_PCT', name: 'Target percent' },
  pctMax: { code: 'OCIO_TARGET_PCT_MAX', name: 'Target percent, maximum' },
};
export const BAND_FIELDS = Object.keys(TARGET_ATTR) as Array<keyof Band>;

/** The hierarchy value stored on a target record, and the scope it is in the surface. */
const SCOPE_CODE: Record<TargetScope, string> = { program: 'PROGRAM', strategy: 'STRATEGY', region: 'REGION', structure: 'STRUCTURE', year: 'YEAR' };
const CODE_SCOPE = Object.fromEntries(Object.entries(SCOPE_CODE).map(([scope, code]) => [code, scope])) as Record<string, TargetScope>;
const PROGRAM_LEVEL = 'TOTAL';

export const REL = {
  parent: 'FUND_PARENT',
  targetFund: 'OCIO_TARGET_FUND',
  positionFund: 'POSITION_FUND',
  positionSecurity: 'POSITION_SECURITY',
  trancheDeal: 'TRANCHE_DEAL',
  trancheSecurity: 'TRANCHE_SECURITY',
  planDeal: 'FUNDING_DEAL',
  planFund: 'FUNDING_FUND',
} as const;

/** The Harbor Lite tree lists the classification attributes draw from. */
const LIST = { strategy: 'OCIO_STRATEGY_TREE', structure: 'OCIO_STRUCTURE_TREE', region: 'OCIO_REGION', stage: 'DEAL_STAGE' } as const;

interface RelRow { parentEntityId?: string | null; childEntityId?: string | null; relationshipCode: string }
interface Row {
  id: string;
  entityCode: string;
  entityName: string;
  templateCode?: string | null;
  attributes: Record<string, unknown>;
  parentRelationships?: RelRow[];
  childRelationships?: RelRow[];
}
interface ListRow { values: Array<{ valueCode: string; valueLabel: string; parentValueCode: string | null; level: number | null; displayOrder: number; isActive: boolean }> }
type Edges = { edges: Array<{ node: Row }> };

const ENTITY_FIELDS = 'id entityCode entityName attributes';
const page = (alias: string, domain: string, rel: 'parent' | 'child' | null, first: number) => `
  ${alias}: entities(filter: { domainCode: "${domain}", isActive: true }, pagination: { first: ${first} }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
    edges { node { ${ENTITY_FIELDS} ${domain === 'FUND' ? 'templateCode' : ''} ${rel === 'parent' ? 'parentRelationships { parentEntityId relationshipCode }' : rel === 'child' ? 'childRelationships { childEntityId relationshipCode }' : ''} } }
  }`;
const list = (alias: string, code: string) => `
  ${alias}: referenceList(listCode: "${code}") { values { valueCode valueLabel parentValueCode level displayOrder isActive } }`;

/**
 * The records are read in three requests, one after another: the programs with their targets
 * and lists, then the book, then the pipeline. Each record type is its own statement on the
 * database, and asking for all of them at once makes them compete until one runs out of time.
 */
const HEAD = 'query OcioRecords($asOfDate: Date, $knowledgeDate: DateTime)';
export const OCIO_QUERIES = [
  `${HEAD} {
  ${page('funds', 'FUND', 'parent', 1000)}
  ${page('targets', TARGET.domain, 'child', 5000)}
  ${list('strategyList', LIST.strategy)}
  ${list('structureList', LIST.structure)}
  ${list('regionList', LIST.region)}
  ${list('stageList', LIST.stage)}
}`,
  `${HEAD} {
  ${page('positions', 'POSITION', 'child', 5000)}
  ${page('securities', 'SECURITY', null, 5000)}
}`,
  `${HEAD} {
  ${page('deals', 'DEAL', null, 1000)}
  ${page('tranches', 'DEAL_TRANCHE', 'child', 2000)}
  ${page('plans', 'DEAL_FUNDING_PLAN', 'child', 2000)}
}`,
];

interface QueryShape {
  funds: Edges;
  positions: Edges;
  securities: Edges;
  deals: Edges;
  tranches: Edges;
  plans: Edges;
  targets: Edges;
  strategyList: ListRow | null;
  structureList: ListRow | null;
  regionList: ListRow | null;
  stageList: ListRow | null;
}

/**
 * The Knowledge date as the API reads it. A bare day means what was known by the end of
 * that day; today (or later) means now. A datetime passes through.
 */
export function knowledgeArg(knowledgeDate: string | null | undefined): string | null {
  const text = (knowledgeDate || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const today = new Date().toISOString().slice(0, 10);
    return text >= today ? null : `${text}T23:59:59.999Z`;
  }
  return text;
}

// ---------- attribute readers ----------

function raw(attrs: Record<string, unknown>, code: string): unknown {
  const v = attrs?.[code];
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as Record<string, unknown>)) return (v as { value: unknown }).value;
  return v;
}
export function text(attrs: Record<string, unknown>, code: string): string | null {
  const v = raw(attrs, code);
  if (v == null || v === '') return null;
  return typeof v === 'string' ? v : String(v);
}
export function num(attrs: Record<string, unknown>, code: string): number | null {
  const v = attrs?.[code];
  if (v && typeof v === 'object' && 'value_numeric' in (v as Record<string, unknown>)) {
    const n = (v as { value_numeric: unknown }).value_numeric;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  const t = text(attrs, code);
  if (t == null) return null;
  const n = Number(t.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function bool(attrs: Record<string, unknown>, code: string): boolean | null {
  const t = text(attrs, code);
  if (t == null) return null;
  return /^(true|t|yes|y|1)$/i.test(t);
}

/** The values a target record holds, one attribute each. */
function bandOf(attrs: Record<string, unknown>): Band {
  const out: Band = {};
  for (const field of BAND_FIELDS) {
    const v = num(attrs, TARGET_ATTR[field].code);
    if (v != null) out[field] = v;
  }
  return out;
}

const relTo = (row: Row, code: string, side: 'parent' | 'child') => {
  const rels = side === 'parent' ? row.parentRelationships : row.childRelationships;
  const hit = (rels || []).find((r) => r.relationshipCode === code);
  return (side === 'parent' ? hit?.parentEntityId : hit?.childEntityId) ?? null;
};

function securityFacts(row: Row): SecurityFacts {
  const a = row.attributes || {};
  return {
    securityId: row.id,
    asset: text(a, ATTR.asset) || row.entityName,
    manager: text(a, ATTR.manager) || '',
    tags: {
      cat: text(a, 'OCIO_CATEGORY'),
      ac: text(a, 'OCIO_ASSET_CLASS'),
      st: text(a, 'OCIO_STRATEGY'),
      sub: text(a, 'OCIO_SUB_STRATEGY'),
      rg: text(a, 'OCIO_REGION'),
      ty: text(a, 'OCIO_STRUCTURE_TYPE'),
      det: text(a, 'OCIO_STRUCTURE_DETAIL'),
    },
    investmentType: text(a, 'OCIO_INVESTMENT_TYPE'),
    market: text(a, 'OCIO_MARKET'),
    country: text(a, 'OCIO_COUNTRY_FOCUS'),
    geo: text(a, 'OCIO_GEO_FOCUS'),
    sector: text(a, 'OCIO_SECTOR'),
    fundSize: num(a, ATTR.fundSize),
    firstTime: bool(a, 'OCIO_FIRST_TIME_FUND'),
    relationship: text(a, 'OCIO_RELATIONSHIP'),
    listed: bool(a, 'OCIO_IS_LISTED'),
    fof: bool(a, 'OCIO_IS_FUND_OF_FUNDS'),
    vintage: text(a, 'OCIO_VINTAGE'),
  };
}

function taxValues(rowList: ListRow | null): TaxValue[] {
  return (rowList?.values || [])
    .filter((v) => v.isActive !== false)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((v) => ({ code: v.valueCode, label: v.valueLabel, parent: v.parentValueCode ?? null, level: v.level ?? 1 }));
}

export function shapeData(d: QueryShape): OcioData {
  const edges = (e: Edges | undefined) => (e?.edges || []).map((x) => x.node);

  const fundRows = edges(d.funds).filter((r) => text(r.attributes, ATTR.basis) != null);
  const fundIds = new Set(fundRows.map((r) => r.id));
  const funds: Fund[] = fundRows.map((r) => {
    const a = r.attributes || {};
    const parentId = relTo(r, REL.parent, 'parent');
    const inProgram = parentId != null && fundIds.has(parentId);
    return {
      id: r.id,
      code: r.entityCode,
      name: r.entityName,
      templateCode: r.templateCode ?? null,
      kind: inProgram ? 'sleeve' : 'client',
      parentId: inProgram ? parentId : null,
      programUsd: num(a, ATTR.programUsd),
      programN: num(a, ATTR.programN),
      basis: text(a, ATTR.basis) === 'PARENT_LEVEL' ? 'PARENT_LEVEL' : 'PROGRAM',
      annual: num(a, ATTR.annual),
      start: text(a, ATTR.start),
      end: text(a, ATTR.end),
      overrides: {},
      matrix: emptyMatrix(),
      targets: {},
      currency: text(a, ATTR.currency),
      eligible: bool(a, ATTR.eligible) ?? false,
    };
  });
  // Each target record files its values under its fund, hierarchy and level.
  const byId = new Map(funds.map((f) => [f.id, f]));
  for (const r of edges(d.targets)) {
    const fund = byId.get(relTo(r, REL.targetFund, 'child') || '');
    const scope = CODE_SCOPE[text(r.attributes, TARGET.hierarchy) || ''];
    const level = text(r.attributes, TARGET.level);
    if (!fund || !scope || level == null) continue;
    const key = scope === 'program' ? '' : level;
    fund.targets[targetKey(scope, key)] = { id: r.id, name: r.entityName };
    const band = bandOf(r.attributes || {});
    if (scope === 'program') fund.matrix.program = band;
    else if (scope === 'year') { if (band.usd != null) fund.overrides[level] = band.usd; }
    else if (Object.keys(band).length) fund.matrix[scope][level] = band;
  }

  // Clients first, each followed by its sleeves, in name order.
  const ordered: Fund[] = [];
  funds.filter((f) => f.kind === 'client').sort((x, y) => x.name.localeCompare(y.name)).forEach((c) => {
    ordered.push(c);
    funds.filter((s) => s.parentId === c.id).sort((x, y) => x.name.localeCompare(y.name)).forEach((s) => ordered.push(s));
  });

  const securities = new Map(edges(d.securities).map((r) => [r.id, r]));
  const sleeveIds = new Set(funds.filter((f) => f.kind === 'sleeve').map((f) => f.id));
  const commitments: Commitment[] = [];
  for (const r of edges(d.positions)) {
    const sleeveId = relTo(r, REL.positionFund, 'child');
    const amount = num(r.attributes, ATTR.amount);
    if (!sleeveId || !sleeveIds.has(sleeveId) || amount == null) continue;
    const secId = relTo(r, REL.positionSecurity, 'child');
    const sec = secId ? securities.get(secId) : undefined;
    if (!sec) continue;
    const a = r.attributes || {};
    commitments.push({
      ...securityFacts(sec),
      id: r.id,
      code: r.entityCode,
      name: r.entityName,
      sleeveId,
      amount,
      date: text(a, ATTR.tradeDate) || '',
      currency: text(a, 'POSITION_CURRENCY'),
      allocationYear: text(a, ATTR.allocationYear),
      followOn: bool(a, 'OCIO_IS_FOLLOW_ON'),
      contractual: text(a, 'OCIO_CONTRACTUAL_REVIEW'),
      esg: text(a, 'OCIO_ESG_REVIEW'),
      strategyReview: text(a, 'OCIO_STRATEGY_REVIEW'),
    });
  }
  commitments.sort((x, y) => y.date.localeCompare(x.date));

  const tranchesByDeal = new Map<string, Array<DealTranche & { securityId: string | null }>>();
  for (const r of edges(d.tranches)) {
    const dealId = relTo(r, REL.trancheDeal, 'child');
    if (!dealId) continue;
    const t = { id: r.id, name: r.entityName, hold: num(r.attributes, ATTR.trancheHold) || 0, size: num(r.attributes, 'TRANCHE_SIZE'), rank: num(r.attributes, 'TRANCHE_RANK') || 0, securityId: relTo(r, REL.trancheSecurity, 'child') };
    tranchesByDeal.set(dealId, [...(tranchesByDeal.get(dealId) || []), t]);
  }
  const plansByDeal = new Map<string, FundingPlan[]>();
  for (const r of edges(d.plans)) {
    const dealId = relTo(r, REL.planDeal, 'child');
    const fundId = relTo(r, REL.planFund, 'child');
    if (!dealId || !fundId || !sleeveIds.has(fundId)) continue;
    const p: FundingPlan = { id: r.id, name: r.entityName, fundId, amount: num(r.attributes, ATTR.planAmount), ratio: num(r.attributes, ATTR.planRatio), status: text(r.attributes, ATTR.planStatus) };
    plansByDeal.set(dealId, [...(plansByDeal.get(dealId) || []), p]);
  }
  const deals: Deal[] = [];
  for (const r of edges(d.deals)) {
    const tranches = (tranchesByDeal.get(r.id) || []).sort((x, y) => x.rank - y.rank);
    const secId = tranches.find((t) => t.securityId)?.securityId;
    const sec = secId ? securities.get(secId) : undefined;
    if (!sec || text(sec.attributes, 'OCIO_CATEGORY') == null) continue;
    const a = r.attributes || {};
    deals.push({
      ...securityFacts(sec),
      id: r.id,
      code: r.entityCode,
      name: r.entityName,
      stage: text(a, ATTR.dealStage),
      close: text(a, ATTR.dealClose),
      description: text(a, 'DEAL_DESCRIPTION'),
      size: num(a, ATTR.dealSize),
      tranches: tranches.map(({ securityId: _s, ...t }) => t),
      plans: plansByDeal.get(r.id) || [],
    });
  }

  const strategy = taxValues(d.strategyList);
  const structure = taxValues(d.structureList);
  const region = taxValues(d.regionList);
  const labels: Record<string, string> = {};
  [...strategy, ...structure, ...region].forEach((v) => { labels[v.code] = v.label; });
  const taxonomy: Taxonomy = { strategy, structure, region, labels };
  const stages: StageDef[] = taxValues(d.stageList).map((v) => ({ code: v.code, label: v.label }));
  deals.sort((x, y) => (x.close || '').localeCompare(y.close || ''));
  return { funds: ordered, commitments, deals, taxonomy, stages };
}

export async function loadOcio(host: SurfaceHost): Promise<{ data: OcioData | null; error: string | null }> {
  const variables = { asOfDate: host.asOfDate, knowledgeDate: knowledgeArg(host.knowledgeDate) };
  const merged: Partial<QueryShape> = {};
  for (const document of OCIO_QUERIES) {
    let result = await host.query<Partial<QueryShape>>(document, variables, 'network-only');
    // A busy database can run one statement out of time. Once more, on its own, usually goes through.
    if (result.error && /timeout/i.test(result.error.message)) result = await host.query<Partial<QueryShape>>(document, variables, 'network-only');
    if (result.error) return { data: null, error: result.error.message };
    if (!result.data) return { data: null, error: 'No data came back.' };
    Object.assign(merged, result.data);
  }
  return { data: shapeData(merged as QueryShape), error: null };
}

// ---------- writes ----------

const OVERRIDE = `mutation OcioOverride($input: ManualOverrideInput!) {
  submitManualOverride(input: $input) { success errors { message } }
}`;

/** Store one attribute as a manual entry, effective from the user's As Of date. */
export async function writeAttribute(host: SurfaceHost, entityId: string, attributeCode: string, value: string, reason: string, validFrom?: string): Promise<string | null> {
  const r = await host.mutate<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(OVERRIDE, {
    input: { entityId, attributeCode, value, validFrom: validFrom || host.asOfDate, overrideReason: reason },
  });
  if (r.error) return r.error.message;
  const out = r.data?.submitManualOverride;
  if (!out?.success) return out?.errors?.[0]?.message || 'The change was not saved.';
  return null;
}

// ---------- targets: one value at a time ----------

const LINEAGE = `query OcioValueSources($entityId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) {
  fieldLineage(entityId: $entityId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { attributeCode competingValues { source value } }
}`;
const SOURCE = `query OcioSource($code: String) { dataSource(code: $code) { id } }`;
const DELETE_VALUE = `mutation OcioClearValue($input: DeleteCompetingSourceInput!) {
  deleteCompetingSource(input: $input) { success errors { message } }
}`;
const CREATE_TARGET = `mutation OcioAddTarget($input: CreateEntityInput!) {
  createEntity(input: $input) { entity { id } errors { message } }
}`;

const sourceIds = new Map<string, string>();

/**
 * Take a value away: end it, from the As Of date, for every source that holds one. The
 * platform has no empty manual entry, so removing a target removes its source values, and
 * the history before that date stays.
 */
async function clearAttribute(host: SurfaceHost, entityId: string, attributeCode: string): Promise<string | null> {
  const lineage = await host.query<{ fieldLineage: Array<{ attributeCode: string; competingValues: Array<{ source: string; value: string | null }> }> }>(
    LINEAGE, { entityId, asOfDate: host.asOfDate, knowledgeDate: knowledgeArg(host.knowledgeDate) }, 'network-only');
  if (lineage.error) return lineage.error.message;
  const held = lineage.data?.fieldLineage.find((f) => f.attributeCode === attributeCode)?.competingValues.filter((v) => v.value != null && v.value !== '') || [];
  for (const code of new Set(held.map((v) => v.source))) {
    let sourceId = sourceIds.get(code);
    if (!sourceId) {
      const found = await host.query<{ dataSource: { id: string } | null }>(SOURCE, { code });
      sourceId = found.data?.dataSource?.id;
      if (!sourceId) return found.error?.message || `The source ${code} is not registered.`;
      sourceIds.set(code, sourceId);
    }
    const r = await host.mutate<{ deleteCompetingSource: { success: boolean; errors: Array<{ message: string }> } }>(DELETE_VALUE, {
      input: { entityId, attributeCode, sourceId, asOfDate: host.asOfDate },
    });
    const failed = r.error?.message || (!r.data?.deleteCompetingSource.success ? r.data?.deleteCompetingSource.errors?.[0]?.message || 'The value was not cleared.' : null);
    if (failed) return failed;
  }
  return null;
}

/** One value that differs between what a fund has and what it should have. Null takes the value away. */
export interface TargetChange {
  scope: TargetScope;
  /** The level within the hierarchy; '' for the total program; the year for a deployment year. */
  level: string;
  field: keyof Band;
  value: number | null;
}

/** The values to write to move a fund's targets from one state to another. Nothing else is touched. */
export function targetChanges(from: Pick<Fund, 'matrix' | 'overrides'>, to: Pick<Fund, 'matrix' | 'overrides'>): TargetChange[] {
  const out: TargetChange[] = [];
  const bands = (scope: TargetScope, a: Record<string, Band>, b: Record<string, Band>) => {
    for (const level of new Set([...Object.keys(a), ...Object.keys(b)])) {
      for (const field of BAND_FIELDS) {
        const before = a[level]?.[field] ?? null;
        const after = b[level]?.[field] ?? null;
        if (before !== after) out.push({ scope, level, field, value: after });
      }
    }
  };
  bands('program', { '': from.matrix.program }, { '': to.matrix.program });
  for (const lens of LENSES as Lens[]) bands(lens, from.matrix[lens], to.matrix[lens]);
  const years = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([year, usd]) => [year, { usd } as Band]));
  bands('year', years(from.overrides), years(to.overrides));
  return out;
}

export interface TargetSave {
  /** Records made for levels that had none, by targetKey. */
  created: Fund['targets'];
  error: string | null;
}

/**
 * Store a set of target changes: each value is written to its own attribute on the level's
 * allocation target record, as a manual entry effective from the user's As Of date. A level
 * with no record gets one first, linked to its fund. Levels are saved a few at a time.
 */
export async function saveTargets(
  host: SurfaceHost,
  fund: Fund,
  changes: TargetChange[],
  reason: string,
  nameOf: (scope: TargetScope, level: string) => string,
): Promise<TargetSave> {
  const created: Fund['targets'] = {};
  const groups = new Map<string, TargetChange[]>();
  for (const c of changes) groups.set(targetKey(c.scope, c.level), [...(groups.get(targetKey(c.scope, c.level)) || []), c]);
  const queue = [...groups.entries()];
  const problems: string[] = [];
  const note = reason.slice(0, 900);

  const saveLevel = async (key: string, list: TargetChange[]) => {
    const { scope, level } = list[0];
    let id: string | undefined = fund.targets[key]?.id;
    if (!id) {
      if (list.every((c) => c.value == null)) return;
      const name = `${fund.name} · ${nameOf(scope, level)}`.slice(0, 240);
      const made = await host.mutate<{ createEntity: { entity: { id: string } | null; errors: Array<{ message: string }> } }>(CREATE_TARGET, {
        input: {
          entityCode: `${fund.code}-T-${SCOPE_CODE[scope]}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 100),
          entityName: name,
          domainCode: TARGET.domain,
          templateCode: TARGET.template,
          description: `Allocation target of ${fund.name}.`,
          attributes: {},
          childRelationships: [{ parentEntityId: fund.id, childEntityId: fund.id, relationshipType: 'Target of fund', relationshipCode: REL.targetFund, isPrimary: true, validFrom: host.asOfDate }],
        },
      });
      id = made.data?.createEntity.entity?.id ?? undefined;
      const failed = made.error?.message || made.data?.createEntity.errors?.[0]?.message;
      if (!id || failed) { problems.push(`${name}: ${failed || 'the target record was not created'}`); return; }
      created[key] = { id, name };
      const recordId: string = id;
      for (const [code, value] of [[TARGET.hierarchy, SCOPE_CODE[scope]], [TARGET.level, scope === 'program' ? PROGRAM_LEVEL : level]] as const) {
        const error = await writeAttribute(host, recordId, code, value, note);
        if (error) { problems.push(`${name}: ${error}`); return; }
      }
    }
    const target: string = id;
    for (const c of list) {
      const attr = TARGET_ATTR[c.field];
      const error = c.value == null ? await clearAttribute(host, target, attr.code) : await writeAttribute(host, target, attr.code, String(c.value), note);
      if (error) problems.push(`${attr.name}: ${error}`);
    }
  };

  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await saveLevel(next[0], next[1]);
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { created, error: problems.length ? problems.slice(0, 4).join('; ') : null };
}

const CREATE = `mutation OcioAddSleeve($input: CreateEntityInput!) {
  createEntity(input: $input) { entity { id } errors { message } }
}`;

export interface NewSleeve {
  name: string;
  programUsd: number;
  programN: number | null;
  start: string;
  annual: number | null;
  basis: Fund['basis'];
}

/**
 * Add a mandate sleeve under a client: a FUND record of the client's own template, linked to
 * it, then its program and pacing written as manual entries so each has a source and a
 * history. It starts with no targets. Returns the new record's id, or what went wrong.
 */
export async function createSleeve(host: SurfaceHost, client: Fund, sleeve: NewSleeve): Promise<{ id: string | null; error: string | null }> {
  const slug = sleeve.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'SLEEVE';
  const created = await host.mutate<{ createEntity: { entity: { id: string } | null; errors: Array<{ message: string }> } }>(CREATE, {
    input: {
      entityCode: `${client.code}-${slug}-${Date.now().toString(36).toUpperCase()}`,
      entityName: sleeve.name,
      domainCode: 'FUND',
      templateCode: client.templateCode || undefined,
      description: `Mandate sleeve of ${client.name}.`,
      attributes: {},
      parentRelationships: [{ parentEntityId: client.id, childEntityId: client.id, relationshipType: 'Parent fund', relationshipCode: REL.parent, isPrimary: true, validFrom: sleeve.start }],
    },
  });
  const id = created.data?.createEntity.entity?.id ?? null;
  const failed = created.error?.message || created.data?.createEntity.errors?.[0]?.message;
  if (!id || failed) return { id: null, error: failed || 'The sleeve was not created.' };
  const values: Array<[string, string | null]> = [
    [ATTR.programUsd, String(sleeve.programUsd)],
    [ATTR.programN, sleeve.programN != null ? String(sleeve.programN) : null],
    [ATTR.start, sleeve.start],
    [ATTR.annual, sleeve.annual != null ? String(sleeve.annual) : null],
    [ATTR.basis, sleeve.basis],
  ];
  const problems: string[] = [];
  for (const [code, value] of values) {
    if (value == null) continue;
    const error = await writeAttribute(host, id, code, value, `OCIO: new mandate sleeve under ${client.name}`.slice(0, 900), sleeve.start);
    if (error) problems.push(`${code}: ${error}`);
  }
  return { id, error: problems.length ? `The sleeve was created, but some values were not saved. ${problems.join('; ')}` : null };
}
