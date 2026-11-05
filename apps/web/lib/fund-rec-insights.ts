import { readBrowserAccessToken } from '@/lib/auth-token';

export type InsightSeverity = 'info' | 'watch' | 'break';

export interface RecInsight {
  title: string;
  detail: string;
  severity: InsightSeverity;
}

/** The slice of a close Gemini is allowed to see. Amounts stay in whole dollars. */
export interface RecInsightPayload {
  fundName: string;
  periodEnd: string;
  periodLabel: string;
  navReported: number | null;
  navProposed: number | null;
  navPrior: number | null;
  navChangePct: number | null;
  netIrr: number | null;
  health: string;
  healthNote: string;
  rules: Array<{ title: string; why: string; admin: number; ours: number; effect: number }>;
  checks: Array<{ label: string; compared: string; result: string; difference: number | null }>;
  statements: Array<{
    title: string;
    lines: Array<{ label: string; role: string; current: number | null; prior: number | null; change: number | null; changePct: number | null; flagged: boolean }>;
  }>;
  drift: Array<{ label: string; prior: number; current: number; change: number; changePct: number | null; explained: string | null; flagged: boolean }>;
  marks: Array<{ name: string; admin: number; agent: number; difference: number; effect: number; flagged: boolean }>;
  accruals: Array<{ name: string; admin: number; ours: number; difference: number }>;
  managementFee: Record<string, number | null>;
  performanceFee: Record<string, number | null | boolean>;
  roll: { present: boolean; tied: boolean; totals: number[]; ties: Array<{ line: string; result: string; rollforward: number; statement: number | null }> };
  positionBreaks: Array<{ name: string; group: string; difference: number }>;
}

type RecLike = {
  fundName: string;
  periodEnd: string;
  periodLabel: string;
  navReported: number | null;
  navProposed: number | null;
  navPrior: number | null;
  navChangePct: number | null;
  netIrr: number | null;
  health: string;
  healthNote: string;
  items: Array<{ title: string; why: string; admin: number; ours: number; effect: number }>;
  checks: Array<{ label: string; compared: string; result: string; difference: number | null }>;
  statements: RecInsightPayload['statements'];
  drift: RecInsightPayload['drift'];
  marks: RecInsightPayload['marks'];
  accruals: RecInsightPayload['accruals'];
  mgmtFee: object;
  perfFee: object;
  roll: {
    present: boolean;
    tied: boolean;
    total: number[];
    ties: RecInsightPayload['roll']['ties'];
    rows: Array<{ name: string; group: string; values: number[]; header: boolean }>;
  };
};

const SEVERITIES = new Set<InsightSeverity>(['info', 'watch', 'break']);

function numberRecord(record: object): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' || value === null) out[key] = value;
  }
  return out;
}

function scalarRecord(record: object): Record<string, number | null | boolean> {
  const out: Record<string, number | null | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

export function recInsightPayload(rec: RecLike): RecInsightPayload {
  const breaks = rec.roll.rows
    .filter((row) => !row.header)
    .map((row) => ({ name: row.name, group: row.group, difference: row.values[row.values.length - 1] ?? 0 }))
    .filter((row) => Math.abs(row.difference) >= 5000)
    .sort((left, right) => Math.abs(right.difference) - Math.abs(left.difference))
    .slice(0, 12);
  return {
    fundName: rec.fundName,
    periodEnd: rec.periodEnd,
    periodLabel: rec.periodLabel,
    navReported: rec.navReported,
    navProposed: rec.navProposed,
    navPrior: rec.navPrior,
    navChangePct: rec.navChangePct,
    netIrr: rec.netIrr,
    health: rec.health,
    healthNote: rec.healthNote,
    rules: rec.items.map((item) => ({ title: item.title, why: item.why, admin: item.admin, ours: item.ours, effect: item.effect })),
    checks: rec.checks.map((check) => ({ label: check.label, compared: check.compared, result: check.result, difference: check.difference })),
    statements: rec.statements.map((statement) => ({
      title: statement.title,
      lines: statement.lines.map((line) => ({
        label: line.label, role: line.role, current: line.current, prior: line.prior,
        change: line.change, changePct: line.changePct, flagged: line.flagged,
      })),
    })),
    drift: rec.drift.map((row) => ({
      label: row.label, prior: row.prior, current: row.current, change: row.change,
      changePct: row.changePct, explained: row.explained, flagged: row.flagged,
    })),
    marks: rec.marks.map((mark) => ({
      name: mark.name, admin: mark.admin, agent: mark.agent, difference: mark.difference, effect: mark.effect, flagged: mark.flagged,
    })),
    accruals: rec.accruals.map((row) => ({ name: row.name, admin: row.admin, ours: row.ours, difference: row.difference })),
    managementFee: numberRecord(rec.mgmtFee),
    performanceFee: scalarRecord(rec.perfFee),
    roll: {
      present: rec.roll.present,
      tied: rec.roll.tied,
      totals: rec.roll.total,
      ties: rec.roll.ties.map((tie) => ({ line: tie.line, result: tie.result, rollforward: tie.rollforward, statement: tie.statement })),
    },
    positionBreaks: breaks,
  };
}

export function parseRecInsights(raw: unknown): RecInsight[] {
  const points = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { points?: unknown }).points)
      ? (raw as { points: unknown[] }).points
      : [];
  const out: RecInsight[] = [];
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    const title = String((point as { title?: unknown }).title ?? '').trim().slice(0, 80);
    const detail = String((point as { detail?: unknown }).detail ?? '').trim().slice(0, 500);
    if (!title || !detail) continue;
    const severity = (point as { severity?: unknown }).severity;
    out.push({
      title,
      detail,
      severity: typeof severity === 'string' && SEVERITIES.has(severity as InsightSeverity) ? severity as InsightSeverity : 'info',
    });
    if (out.length === 4) break;
  }
  return out;
}

/** Drop a point that restates a rule the queue already shows. */
export function withoutRuleEchoes(points: RecInsight[], ruleTitles: string[]): RecInsight[] {
  const rules = ruleTitles.map((title) => title.toLowerCase()).filter(Boolean);
  return points.filter((point) => {
    const title = point.title.toLowerCase();
    return !rules.some((rule) => title.includes(rule) || rule.includes(title));
  });
}

export async function fetchRecInsights(rec: RecLike, signal?: AbortSignal): Promise<RecInsight[]> {
  const token = readBrowserAccessToken();
  const response = await fetch('/api/fund-rec/insights', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ rec: recInsightPayload(rec) }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not read this period');
  return parseRecInsights(body);
}
