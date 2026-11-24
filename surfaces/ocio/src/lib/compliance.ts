/**
 * Compliance as the engine scores it. The surface does not evaluate rules: it reads
 * complianceSnapshot (the booked book on every rule a sleeve is enrolled in, as of a date),
 * evaluateComplianceProforma and investmentCapacity, and only ranks and labels the results.
 */
import type { SurfaceHost } from '@tapestrai/surface-sdk';
import { knowledgeArg } from './data';

export interface RuleMeta {
  ruleCode: string;
  ruleName: string;
  description: string | null;
  category: string;
  /** A questionnaire or review: an open item is pending, not a breach. */
  attestation: boolean;
  dimension: string | null;
}

export interface SnapshotLine {
  ruleCode: string;
  ruleName: string;
  groupByValue: string | null;
  limitDirection: 'MAX' | 'MIN' | null;
  numeratorValue: number | null;
  denominatorValue: number | null;
  computedValue: number | null;
  softLimitValue: number | null;
  hardLimitValue: number | null;
  status: 'PASS' | 'SOFT_BREACH' | 'HARD_BREACH' | 'NO_DATA' | 'ERROR' | null;
  resultUnit: string | null;
}

export type RuleStatus = 'breach' | 'soft' | 'watch' | 'pending' | 'na' | 'pass';
export const RULE_STATUS: Record<RuleStatus, { label: string; tone: string; rank: number }> = {
  breach: { label: 'Breach', tone: 'breach', rank: 6 },
  soft: { label: 'Soft breach', tone: 'soft', rank: 5 },
  watch: { label: 'Watch', tone: 'near', rank: 4 },
  pending: { label: 'Pending', tone: 'pend', rank: 3 },
  na: { label: 'No data', tone: 'na', rank: 2 },
  pass: { label: 'Pass', tone: 'ok', rank: 1 },
};

export interface GroupResult {
  label: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  status: RuleStatus;
}

export interface RuleResult {
  ruleCode: string;
  ruleName: string;
  description: string | null;
  dimension: string | null;
  /** Null when the engine returned no limit, as for a screen nothing failed. */
  severity: 'Hard' | 'Soft' | null;
  direction: 'MAX' | 'MIN';
  limit: number | null;
  unit: string;
  status: RuleStatus;
  value: number | null;
  worst: string | null;
  cushion: number | null;
  groups: GroupResult[];
  measured: number;
  attestation: boolean;
}

function lineStatus(line: SnapshotLine, attestation: boolean): RuleStatus {
  if (line.status === 'HARD_BREACH') return 'breach';
  if (line.status === 'SOFT_BREACH') return attestation ? 'pending' : 'soft';
  if (line.status === 'NO_DATA' || line.status === 'ERROR' || line.status == null) return 'na';
  const limit = line.hardLimitValue ?? line.softLimitValue;
  const v = line.computedValue;
  // Within 10% of a maximum is a watch item. The engine has passed it; this is only a tone.
  if (line.limitDirection !== 'MIN' && limit && v != null && v / limit >= 0.9) return 'watch';
  return 'pass';
}

/** One result per rule, from the engine's lines for one sleeve. */
export function rulesFromSnapshot(lines: SnapshotLine[], meta: Map<string, RuleMeta>): RuleResult[] {
  const byRule = new Map<string, SnapshotLine[]>();
  for (const l of lines) byRule.set(l.ruleCode, [...(byRule.get(l.ruleCode) || []), l]);
  const out: RuleResult[] = [];
  for (const [code, ls] of byRule) {
    const m = meta.get(code);
    const attestation = m?.attestation ?? false;
    const groups: GroupResult[] = ls.map((l) => ({
      label: l.groupByValue || m?.dimension || l.ruleName,
      value: l.computedValue,
      numerator: l.numeratorValue,
      denominator: l.denominatorValue,
      status: lineStatus(l, attestation),
    }));
    const measured = groups.filter((g) => g.status !== 'na');
    const dir: 'MAX' | 'MIN' = ls[0].limitDirection === 'MIN' ? 'MIN' : 'MAX';
    const pool = measured.length ? measured : groups;
    const worst = [...pool].sort((a, b) => RULE_STATUS[b.status].rank - RULE_STATUS[a.status].rank || (dir === 'MIN' ? (a.value ?? 0) - (b.value ?? 0) : (b.value ?? 0) - (a.value ?? 0)))[0];
    const hard = ls[0].hardLimitValue;
    const soft = ls[0].softLimitValue;
    const limit = hard ?? soft;
    out.push({
      ruleCode: code,
      ruleName: m?.ruleName || ls[0].ruleName,
      description: m?.description ?? null,
      dimension: m?.dimension ?? null,
      severity: hard != null ? 'Hard' : soft != null ? 'Soft' : null,
      direction: dir,
      limit,
      unit: ls[0].resultUnit || 'PERCENTAGE',
      status: worst ? worst.status : 'na',
      value: worst?.value ?? null,
      worst: worst && ls.length > 1 ? worst.label : null,
      cushion: limit != null && worst?.value != null ? (dir === 'MIN' ? worst.value - limit : limit - worst.value) : null,
      groups: [...groups].sort((a, b) => RULE_STATUS[b.status].rank - RULE_STATUS[a.status].rank || (b.value ?? 0) - (a.value ?? 0)),
      measured: measured.length,
      attestation,
    });
  }
  return out.sort((a, b) => RULE_STATUS[b.status].rank - RULE_STATUS[a.status].rank || a.ruleName.localeCompare(b.ruleName));
}

export interface ComplianceCounts {
  breach: number;
  soft: number;
  watch: number;
  pending: number;
  na: number;
  pass: number;
  total: number;
}

export function countRules(rules: RuleResult[]): ComplianceCounts {
  const c: ComplianceCounts = { breach: 0, soft: 0, watch: 0, pending: 0, na: 0, pass: 0, total: 0 };
  for (const r of rules) { c[r.status] += 1; c.total += 1; }
  return c;
}

export function fmtRuleValue(unit: string, v: number | null): string {
  if (v == null) return '—';
  if (unit === 'PERCENTAGE') return `${(Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
  if (unit === 'CURRENCY') {
    const a = Math.abs(v);
    return a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`;
  }
  return String(Math.round(v * 100) / 100);
}

// ---------- reads ----------

const RULES_QUERY = `query OcioRules {
  complianceRules(filter: { anchorDomainCode: "FUND", isActive: true }) { ruleCode ruleName description ruleCategory metadata }
}`;

export async function loadRuleMeta(host: SurfaceHost): Promise<Map<string, RuleMeta>> {
  const r = await host.query<{ complianceRules: Array<{ ruleCode: string; ruleName: string; description: string | null; ruleCategory: string; metadata: Record<string, unknown> | null }> }>(RULES_QUERY, {}, 'cache-first');
  const map = new Map<string, RuleMeta>();
  for (const rule of r.data?.complianceRules || []) {
    const md = rule.metadata || {};
    map.set(rule.ruleCode, {
      ruleCode: rule.ruleCode,
      ruleName: typeof md.workbook_name === 'string' ? md.workbook_name : rule.ruleName,
      description: rule.description,
      category: rule.ruleCategory,
      attestation: md.attestation === true,
      dimension: typeof md.dimension_label === 'string' ? md.dimension_label : null,
    });
  }
  return map;
}

const LINE_FIELDS = 'ruleCode ruleName groupByValue limitDirection numeratorValue denominatorValue computedValue softLimitValue hardLimitValue status resultUnit';

/** The booked book of each sleeve, scored by the engine at the user's dates. */
/** How many sleeves are scored in one request. Each is a heavy statement; more at once and they run each other out of time. */
const SCORED_AT_ONCE = 2;

/**
 * Score every sleeve, a couple at a time. A sleeve whose scoring fails is tried once more on
 * its own. One that still fails is reported in `errors` and has no lines: it was not scored,
 * which is not the same as passing.
 */
export async function loadSnapshots(host: SurfaceHost, sleeveIds: string[]): Promise<{ lines: Record<string, SnapshotLine[]>; errors: Record<string, string> }> {
  const lines: Record<string, SnapshotLine[]> = {};
  const errors: Record<string, string> = {};
  for (let i = 0; i < sleeveIds.length; i += SCORED_AT_ONCE) {
    const batch = sleeveIds.slice(i, i + SCORED_AT_ONCE);
    const first = await scoreSleeves(host, batch);
    Object.assign(lines, first.lines);
    for (const id of Object.keys(first.errors)) {
      const again = await scoreSleeves(host, [id]);
      Object.assign(lines, again.lines);
      if (again.errors[id]) errors[id] = again.errors[id];
    }
  }
  return { lines, errors };
}

async function scoreSleeves(host: SurfaceHost, sleeveIds: string[]): Promise<{ lines: Record<string, SnapshotLine[]>; errors: Record<string, string> }> {
  const lines: Record<string, SnapshotLine[]> = {};
  const errors: Record<string, string> = {};
  if (!sleeveIds.length) return { lines, errors };
  const doc = `query OcioSnapshots($asOfDate: Date!, $knowledgeDate: DateTime, ${sleeveIds.map((_, i) => `$a${i}: ID!`).join(', ')}) {
    ${sleeveIds.map((_, i) => `s${i}: complianceSnapshot(anchorEntityId: $a${i}, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { lines { ${LINE_FIELDS} } errors { message } }`).join('\n    ')}
  }`;
  const vars: Record<string, unknown> = { asOfDate: host.asOfDate, knowledgeDate: knowledgeArg(host.knowledgeDate) };
  sleeveIds.forEach((id, i) => { vars[`a${i}`] = id; });
  const r = await host.query<Record<string, { lines: SnapshotLine[]; errors: Array<{ message: string }> }>>(doc, vars, 'network-only');
  sleeveIds.forEach((id, i) => {
    const part = r.data?.[`s${i}`];
    if (r.error && !part) errors[id] = r.error.message;
    else if (part?.errors?.length) errors[id] = part.errors.map((e) => e.message).join('; ');
    lines[id] = part?.lines || [];
  });
  return { lines, errors };
}

export interface ProformaLine {
  ruleCode: string;
  ruleName: string;
  groupByValue: string | null;
  baselineValue: number | null;
  scenarioValue: number | null;
  baselineStatus: string | null;
  scenarioStatus: string | null;
  hardLimitValue: number | null;
  softLimitValue: number | null;
  verdict: string;
  approved: boolean;
}

/** Attributes a proposed commitment carries, so the rules see it as they see a booked one. */
export function legAttributes(amount: number, closeDate: string | null): Record<string, string> {
  const year = (closeDate || '').slice(0, 4);
  const out: Record<string, string> = { OCIO_COMMITMENT_AMOUNT: String(amount) };
  if (year) out.OCIO_ALLOCATION_YEAR = `${year} Allocation`;
  if (closeDate) out.TRADE_DATE = closeDate;
  return out;
}

const PROFORMA = `query OcioProforma($anchor: ID!, $legs: [ComplianceProformaLegInput!]!, $asOfDate: Date!, $knowledgeDate: DateTime) {
  evaluateComplianceProforma(anchorEntityId: $anchor, legs: $legs, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
    approved lines { ruleCode ruleName groupByValue baselineValue scenarioValue baselineStatus scenarioStatus hardLimitValue softLimitValue verdict approved } errors { message }
  }
}`;

export async function proformaFor(host: SurfaceHost, sleeveId: string, securityId: string, amount: number, closeDate: string | null): Promise<{ approved: boolean; lines: ProformaLine[]; error: string | null }> {
  const r = await host.query<{ evaluateComplianceProforma: { approved: boolean; lines: ProformaLine[]; errors: Array<{ message: string }> } }>(PROFORMA, {
    anchor: sleeveId,
    legs: [{ securityId, par: amount, attributes: legAttributes(amount, closeDate) }],
    asOfDate: host.asOfDate,
    knowledgeDate: knowledgeArg(host.knowledgeDate),
  }, 'network-only');
  const out = r.data?.evaluateComplianceProforma;
  if (r.error || !out) return { approved: false, lines: [], error: r.error?.message || 'No result' };
  return { approved: out.approved, lines: out.lines, error: out.errors?.[0]?.message ?? null };
}

export interface CapacityQuote {
  capacity: number | null;
  bindingRule: string | null;
  bindingGroup: string | null;
  error: string | null;
}

const CAPACITY = `query OcioCapacity($anchor: ID!, $security: ID!, $asOfDate: Date!, $knowledgeDate: DateTime, $attrs: JSON, $parAttrs: [String!]) {
  investmentCapacity(anchorEntityId: $anchor, securityId: $security, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate, limitKind: "HARD", probeAttributes: $attrs, probeParAttributes: $parAttrs) {
    capacityPar bindingRuleCode bindingGroup errors { message }
  }
}`;

/** The most a sleeve can commit to the deal's investment before a hard limit, from the engine. */
export async function capacityFor(host: SurfaceHost, sleeveId: string, securityId: string, closeDate: string | null): Promise<CapacityQuote> {
  const attrs = legAttributes(0, closeDate);
  delete attrs.OCIO_COMMITMENT_AMOUNT;
  const r = await host.query<{ investmentCapacity: { capacityPar: number | null; bindingRuleCode: string | null; bindingGroup: string | null; errors: Array<{ message: string }> } }>(CAPACITY, {
    anchor: sleeveId,
    security: securityId,
    asOfDate: host.asOfDate,
    knowledgeDate: knowledgeArg(host.knowledgeDate),
    attrs,
    parAttrs: ['OCIO_COMMITMENT_AMOUNT'],
  }, 'network-only');
  const q = r.data?.investmentCapacity;
  if (r.error || !q) return { capacity: null, bindingRule: null, bindingGroup: null, error: r.error?.message || 'No result' };
  return { capacity: q.capacityPar, bindingRule: q.bindingRuleCode, bindingGroup: q.bindingGroup, error: q.errors?.[0]?.message ?? null };
}
