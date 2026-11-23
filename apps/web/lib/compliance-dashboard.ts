/**
 * The compliance dashboard's story, derived once for the screen and the
 * assistant: which entity types have results, and for one type every active
 * rule with its limits, its newest result for each entity and group, and the
 * cushion left before the limit.
 */

export interface DashboardDomain {
  domainCode: string;
  domainName: string;
  ruleCount: number;
  entityCount: number;
  resultCount: number;
  passCount: number;
  softBreachCount: number;
  hardBreachCount: number;
  noDataCount: number;
}

export interface DashboardRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  anchorDomainCode: string;
  resultUnit?: string | null;
  limitDirection?: string | null;
  groupByAttributeCode?: string | null;
  softLimitValue?: number | null;
  hardLimitValue?: number | null;
}

export interface DashboardThreshold {
  id: string;
  ruleId: string;
  entityId?: string | null;
  groupValue?: string | null;
  rankFrom?: number | null;
  limitDirection?: string | null;
  softLimitValue?: number | null;
  hardLimitValue?: number | null;
  applies: boolean;
}

export interface DashboardResult {
  id: string;
  ruleId: string;
  anchorEntityId: string;
  anchorEntityCode?: string | null;
  anchorEntityName?: string | null;
  groupByValue?: string | null;
  rankPosition?: number | null;
  asOfDate?: string | null;
  computedValue?: number | null;
  limitDirection?: string | null;
  softLimitValue?: number | null;
  hardLimitValue?: number | null;
  status: string;
  contributingCount?: number | null;
}

export interface ComplianceDashboardData {
  asOfDate?: string | null;
  knowledgeDate?: string | null;
  domains: DashboardDomain[];
  rules: DashboardRule[];
  thresholds: DashboardThreshold[];
  results: DashboardResult[];
}

/** NOT_SCORED is a rule of this type with no result at the dates. */
export type RowStatus = 'HARD_BREACH' | 'SOFT_BREACH' | 'PASS' | 'NO_DATA' | 'ERROR' | 'NOT_SCORED';

export interface DashboardRow {
  key: string;
  ruleId: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  resultUnit: string | null;
  entityId: string | null;
  entityName: string | null;
  group: string | null;
  rank: number | null;
  direction: 'MAX' | 'MIN';
  soft: number | null;
  hard: number | null;
  value: number | null;
  status: RowStatus;
  /** Room left before the hard limit (the soft limit when there is no hard), in the result's unit. Negative is past it. */
  cushion: number | null;
  /** The cushion as a share of the limit, in percent. */
  cushionPct: number | null;
  /** How much of the limit the result uses, in percent. Over 100 is past it. */
  usedPct: number | null;
  asOfDate: string | null;
  thresholdCount: number;
}

export const STATUS_ORDER: Record<RowStatus, number> = {
  HARD_BREACH: 0,
  SOFT_BREACH: 1,
  ERROR: 2,
  PASS: 3,
  NO_DATA: 4,
  NOT_SCORED: 5,
};

export function statusTone(status: string) {
  if (status === 'PASS') return 'ok';
  if (status === 'SOFT_BREACH') return 'near';
  if (status === 'HARD_BREACH' || status === 'ERROR') return 'breach';
  return 'na';
}

export function statusLabel(status: string, direction?: string | null) {
  if (status === 'PASS') return 'Within limit';
  if (status === 'SOFT_BREACH') return 'Warning';
  if (status === 'HARD_BREACH') return direction === 'MIN' ? 'Below minimum' : 'Above maximum';
  if (status === 'NO_DATA') return 'No data';
  if (status === 'NOT_SCORED') return 'Not scored';
  if (status === 'ERROR') return 'Error';
  return status.replaceAll('_', ' ');
}

export const CATEGORY_LABEL: Record<string, string> = {
  CONCENTRATION: 'Concentration',
  EXPOSURE: 'Exposure',
  DIVERSIFICATION: 'Diversification',
  ELIGIBILITY: 'Eligibility',
  LEVERAGE: 'Leverage',
  LIQUIDITY: 'Liquidity',
  FORTY_ACT: '40 Act',
  COVERAGE: 'Coverage',
  COLLATERAL_QUALITY: 'Collateral quality',
  OTHER: 'Other',
};

/**
 * Cushion to the binding limit. A maximum has room while the result is below
 * it; a minimum has room while the result is above it.
 */
export function cushionOf(value: number | null | undefined, direction: string | null | undefined, soft: number | null | undefined, hard: number | null | undefined) {
  const limit = hard ?? soft ?? null;
  if (value == null || limit == null || !Number.isFinite(value)) return { cushion: null, cushionPct: null, usedPct: null };
  const isMin = direction === 'MIN';
  const cushion = isMin ? value - limit : limit - value;
  const cushionPct = limit !== 0 ? (cushion / Math.abs(limit)) * 100 : null;
  let usedPct: number | null = null;
  if (isMin) usedPct = value > 0 ? (limit / value) * 100 : (limit > 0 ? Infinity : null);
  else usedPct = limit > 0 ? (value / limit) * 100 : null;
  return { cushion, cushionPct, usedPct };
}

function asStatus(status: string): RowStatus {
  return (status in STATUS_ORDER ? status : 'ERROR') as RowStatus;
}

/** One row per rule, entity, group and rank for the type, and one row for each rule with no result. */
export function dashboardRows(data: ComplianceDashboardData, domainCode: string): DashboardRow[] {
  const rules = data.rules.filter((rule) => rule.anchorDomainCode === domainCode);
  const thresholdsByRule = new Map<string, DashboardThreshold[]>();
  for (const threshold of data.thresholds) {
    if (!threshold.applies) continue;
    const list = thresholdsByRule.get(threshold.ruleId) || [];
    list.push(threshold);
    thresholdsByRule.set(threshold.ruleId, list);
  }
  const resultsByRule = new Map<string, DashboardResult[]>();
  for (const result of data.results) {
    const list = resultsByRule.get(result.ruleId) || [];
    list.push(result);
    resultsByRule.set(result.ruleId, list);
  }

  const rows: DashboardRow[] = [];
  for (const rule of rules) {
    const thresholds = thresholdsByRule.get(rule.id) || [];
    const results = resultsByRule.get(rule.id) || [];
    const base = {
      ruleId: rule.id,
      ruleCode: rule.ruleCode,
      ruleName: rule.ruleName,
      ruleCategory: rule.ruleCategory,
      resultUnit: rule.resultUnit || null,
    };
    if (!results.length) {
      const fallback = thresholds.find((item) => !item.groupValue && item.rankFrom == null) || null;
      const direction = (fallback?.limitDirection || rule.limitDirection) === 'MIN' ? 'MIN' : 'MAX';
      rows.push({
        ...base,
        key: `${rule.id}|none`,
        entityId: null,
        entityName: null,
        group: null,
        rank: null,
        direction,
        soft: fallback?.softLimitValue ?? rule.softLimitValue ?? null,
        hard: fallback?.hardLimitValue ?? rule.hardLimitValue ?? null,
        value: null,
        status: 'NOT_SCORED',
        cushion: null,
        cushionPct: null,
        usedPct: null,
        asOfDate: null,
        thresholdCount: thresholds.length,
      });
      continue;
    }
    for (const result of results) {
      const direction = (result.limitDirection || rule.limitDirection) === 'MIN' ? 'MIN' : 'MAX';
      const soft = result.softLimitValue ?? null;
      const hard = result.hardLimitValue ?? null;
      const status = asStatus(result.status);
      const measured = status === 'NO_DATA' || status === 'ERROR' ? null : result.computedValue ?? null;
      rows.push({
        ...base,
        key: result.id,
        entityId: result.anchorEntityId,
        entityName: result.anchorEntityName || result.anchorEntityCode || null,
        group: result.groupByValue || null,
        rank: result.rankPosition ?? null,
        direction,
        soft,
        hard,
        value: measured,
        status,
        ...cushionOf(measured, direction, soft, hard),
        asOfDate: result.asOfDate || null,
        thresholdCount: thresholds.filter((item) => !item.entityId || item.entityId === result.anchorEntityId).length,
      });
    }
  }
  return rows.sort(compareRows);
}

/** Breaches first, then the tightest cushion, then rule and entity name. */
export function compareRows(a: DashboardRow, b: DashboardRow) {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus) return byStatus;
  const ca = a.cushionPct ?? Infinity;
  const cb = b.cushionPct ?? Infinity;
  if (ca !== cb) return ca - cb;
  return a.ruleName.localeCompare(b.ruleName) || (a.entityName || '').localeCompare(b.entityName || '') || (a.group || '').localeCompare(b.group || '');
}

export interface DashboardSummary {
  rules: number;
  rulesScored: number;
  entities: number;
  tests: number;
  hard: number;
  soft: number;
  pass: number;
  noData: number;
  notScored: number;
  /** Share of scored tests within limit, in percent. */
  passRate: number | null;
  tightest: DashboardRow | null;
  byCategory: Array<{ category: string; label: string; tests: number; hard: number; soft: number; pass: number }>;
}

export function summarize(rows: DashboardRow[]): DashboardSummary {
  const scored = rows.filter((row) => row.status !== 'NOT_SCORED');
  const count = (status: RowStatus) => rows.filter((row) => row.status === status).length;
  const hard = count('HARD_BREACH');
  const soft = count('SOFT_BREACH');
  const pass = count('PASS');
  const judged = hard + soft + pass;
  const tightest = rows
    .filter((row) => row.status === 'PASS' && row.cushionPct != null)
    .sort((a, b) => (a.cushionPct as number) - (b.cushionPct as number))[0] || null;
  const categories = new Map<string, { tests: number; hard: number; soft: number; pass: number }>();
  for (const row of scored) {
    const entry = categories.get(row.ruleCategory) || { tests: 0, hard: 0, soft: 0, pass: 0 };
    entry.tests += 1;
    if (row.status === 'HARD_BREACH') entry.hard += 1;
    if (row.status === 'SOFT_BREACH') entry.soft += 1;
    if (row.status === 'PASS') entry.pass += 1;
    categories.set(row.ruleCategory, entry);
  }
  return {
    rules: new Set(rows.map((row) => row.ruleId)).size,
    rulesScored: new Set(scored.map((row) => row.ruleId)).size,
    entities: new Set(scored.map((row) => row.entityId).filter(Boolean)).size,
    tests: scored.length,
    hard,
    soft,
    pass,
    noData: count('NO_DATA') + count('ERROR'),
    notScored: count('NOT_SCORED'),
    passRate: judged ? (pass / judged) * 100 : null,
    tightest,
    byCategory: [...categories.entries()]
      .map(([category, entry]) => ({ category, label: CATEGORY_LABEL[category] || category, ...entry }))
      .sort((a, b) => (b.hard - a.hard) || (b.soft - a.soft) || (b.tests - a.tests)),
  };
}

/** Breaches and warnings, then the passing tests with the least cushion. */
export function watchlist(rows: DashboardRow[], size = 8): DashboardRow[] {
  const flagged = rows.filter((row) => row.status === 'HARD_BREACH' || row.status === 'SOFT_BREACH');
  const tight = rows.filter((row) => row.status === 'PASS' && row.cushionPct != null);
  return [...flagged, ...tight].sort(compareRows).slice(0, size);
}

export function formatValue(value: number | null | undefined, unit?: string | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (unit === 'PERCENTAGE') return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  if (unit === 'CURRENCY') return compactMoney(value);
  if (unit === 'COUNT') return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A cushion is a difference: percentage results differ in percentage points. */
export function formatCushion(value: number | null | undefined, unit?: string | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const size = Math.abs(value);
  if (unit === 'PERCENTAGE') return `${sign}${size.toLocaleString(undefined, { maximumFractionDigits: 2 })} pp`;
  if (unit === 'CURRENCY') return `${sign}${compactMoney(size)}`;
  if (unit === 'COUNT') return `${sign}${size.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `${sign}${size.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function compactMoney(value: number) {
  const size = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (size >= 1e9) return `${sign}$${(size / 1e9).toFixed(2)}B`;
  if (size >= 1e6) return `${sign}$${(size / 1e6).toFixed(1)}M`;
  if (size >= 1e3) return `${sign}$${(size / 1e3).toFixed(0)}K`;
  return `${sign}$${size.toFixed(0)}`;
}

function round(value: number | null, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** What the dashboard tab tells the assistant: the same rows and totals the screen draws, capped. */
export function dashboardTabData(data: ComplianceDashboardData, domainCode: string | null, cap = 80) {
  const domain = data.domains.find((item) => item.domainCode === domainCode) || null;
  const rows = domain ? dashboardRows(data, domain.domainCode) : [];
  const summary = summarize(rows);
  return {
    asOfDate: data.asOfDate || null,
    knowledgeDate: data.knowledgeDate || null,
    entityTypes: data.domains.map((item) => ({
      entityType: item.domainName,
      rules: item.ruleCount,
      entitiesScored: item.entityCount,
      tests: item.resultCount,
      hardBreaches: item.hardBreachCount,
      warnings: item.softBreachCount,
      withinLimit: item.passCount,
      noData: item.noDataCount,
    })),
    selectedEntityType: domain?.domainName || null,
    totals: domain ? {
      rules: summary.rules,
      rulesScored: summary.rulesScored,
      entitiesScored: summary.entities,
      tests: summary.tests,
      hardBreaches: summary.hard,
      warnings: summary.soft,
      withinLimit: summary.pass,
      noData: summary.noData,
      rulesNotScored: summary.notScored,
      passRatePct: round(summary.passRate, 1),
    } : null,
    byCategory: summary.byCategory,
    rows: rows.slice(0, cap).map((row) => ({
      status: statusLabel(row.status, row.direction),
      rule: row.ruleName,
      category: CATEGORY_LABEL[row.ruleCategory] || row.ruleCategory,
      entity: row.entityName,
      group: row.group,
      rank: row.rank,
      unit: row.resultUnit,
      limit: row.direction === 'MIN' ? 'Minimum' : 'Maximum',
      soft: round(row.soft, 4),
      hard: round(row.hard, 4),
      result: round(row.value, 4),
      cushion: round(row.cushion, 4),
      cushionPctOfLimit: round(row.cushionPct, 1),
      asOfDate: row.asOfDate,
    })),
    rowsShown: Math.min(rows.length, cap),
    rowsTotal: rows.length,
  };
}
