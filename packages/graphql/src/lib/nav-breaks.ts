/**
 * The breaks of a NAV reconciliation, summarized for the person who signs it.
 *
 * Read from the reconciliation the pages draw (buildReview), never worked out
 * again: each tie-out check that breaks, each figure that is missing, each
 * review item still open, and each input that is not on file, with both
 * figures, what usually causes it, what settles it, and who does that. The
 * fund reconciliation page and the workflow step both use this, so they say
 * the same thing.
 */

import type { RecCheck, RecItem, RecReview } from './fund-rec';

type Review = RecReview & { fundCode?: string };

export type BreakKind = 'break' | 'missing' | 'item' | 'gap';

export interface BreakEntry {
  kind: BreakKind;
  id: string;
  title: string;
  /** The first figure: what the statements or the administrator say. */
  reported: number | null;
  /** The second figure: what it is compared with. */
  expected: number | null;
  difference: number | null;
  /** Dollars, or points for a mark. */
  unit: 'USD' | 'POINTS' | 'COUNT';
  /** What the figures are, and what usually explains a difference like this. */
  cause: string;
  /** What settles it. */
  action: string;
  /** Who does that. */
  owner: string;
  /** Whether it stands between the period and certification. */
  blocking: boolean;
}

export interface BreakSummary {
  fund: { id: string; code: string | null; name: string };
  periodEnd: string;
  periodLabel: string;
  comparedWith: string;
  spanMonths: number;
  headline: string;
  nav: { reported: number | null; prior: number | null; proposed: number | null; changePct: number | null };
  counts: { breaks: number; missing: number; items: number; gaps: number; checks: number; ties: number };
  entries: BreakEntry[];
  /** Checks that tie, by name, so a reader sees what was covered. */
  tied: string[];
  markdown: string;
}

interface Guidance {
  cause: string;
  action: string;
  owner: string;
}

/** What a break in each tie-out check usually means and what settles it. Keyed by the check, so every fund reads the same. */
const CHECK_GUIDANCE: Record<string, Guidance> = {
  balance: { cause: 'Assets less liabilities does not equal net assets, so a line of the balance sheet is missing or doubled.', action: 'Compare the loaded balance sheet with the statement line by line and reload the line that differs.', owner: 'Fund accountant' },
  assetsFoot: { cause: 'The asset lines on file do not add up to total assets: a line did not load, or landed on the wrong chart line.', action: 'Open the mapping of the balance sheet and place the line that is missing.', owner: 'Fund accountant' },
  liabilitiesFoot: { cause: 'The liability lines on file do not add up to total liabilities: a line did not load, or landed on the wrong chart line.', action: 'Open the mapping of the balance sheet and place the line that is missing.', owner: 'Fund accountant' },
  equityFoot: { cause: 'The capital lines on file do not add up to net assets.', action: 'Check paid-in capital and distributable earnings against the statement.', owner: 'Fund accountant' },
  opening: { cause: 'Opening net assets in the statement of changes differ from the NAV on file at the prior date: the prior period was restated, or the NAV on file is for another date.', action: 'Ask the administrator whether the prior period NAV was restated, and certify the prior period first if it is open.', owner: 'Senior reviewer' },
  rollNav: { cause: 'Opening net assets and the period\'s change do not reach closing net assets.', action: 'Ask the administrator for the roll-forward of net assets.', owner: 'Fund administrator' },
  changesFoot: { cause: 'Operations, distributions and share or capital transactions do not add up to the total change in net assets.', action: 'Check every class\'s distributions and share transactions loaded, then ask the administrator.', owner: 'Fund accountant' },
  opsCash: { cause: 'The net increase from operations differs between the statement of operations and the cash flow statement, so the two were prepared from different numbers.', action: 'Ask the administrator which figure is final.', owner: 'Fund administrator' },
  sleeves: { cause: 'The strategy sleeves do not add up to total investments.', action: 'Ask the administrator for the sleeve breakdown.', owner: 'Fund administrator' },
  schedule: { cause: 'The positions in the administrator\'s schedule of investments do not add up to investments on the balance sheet: a position was missed when the schedule was read, or the balance sheet holds investments the schedule does not list.', action: 'Compare the loaded schedule with the report\'s own total; if they agree, ask the administrator for the reconciliation of the schedule to the balance sheet.', owner: 'Portfolio accountant' },
  positions: { cause: 'Investments on the balance sheet differ from the market value in our own position book.', action: 'Reconcile position by position on the roll-forward and the marks; a missing trade or a stale mark is the usual cause.', owner: 'Portfolio accountant' },
  invRoll: { cause: 'Purchases, cost of sales, PIK, accretion and unrealized change do not explain the move in investments: look for a restructuring, a non-cash exchange, a write-off, or currency translation on non-dollar positions.', action: 'Ask the administrator for the roll-forward of investments for the period.', owner: 'Portfolio accountant' },
  cashCf: { cause: 'Opening cash plus the period\'s net cash flow does not reach closing cash.', action: 'Ask the administrator for the cash reconciliation.', owner: 'Fund accountant' },
  bank: { cause: 'Closing cash on the balance sheet differs from the bank statement.', action: 'Match the bank transactions in the cash reconciliation.', owner: 'Fund accountant' },
  contribNotice: { cause: 'Contributions in the period differ from the capital call notices on file.', action: 'Check the call notices for the period and any late or excused investors.', owner: 'Investor services' },
  distNotice: { cause: 'Distributions in the period differ from the distribution notices on file.', action: 'Check the distribution notices for the period.', owner: 'Investor services' },
  facility: { cause: 'The facility balance rolled from the prior period differs from the lender statement.', action: 'Ask the facility agent for the statement and check draws and repayments.', owner: 'Treasury' },
};

const MISSING_GUIDANCE: Record<string, Guidance> = {
  positions: { cause: 'Our own position book for the period is not on file, so investments cannot be compared position by position.', action: 'Load our position book (source INTERNAL) at the period end.', owner: 'Portfolio accountant' },
  bank: { cause: 'No bank statement is on file at the period end.', action: 'Ask the custodian for the statement and load it as evidence.', owner: 'Fund accountant' },
  opening: { cause: 'There is no NAV on file at the prior date to compare opening net assets with.', action: 'Load the prior period\'s statement, or the report\'s comparative column.', owner: 'Fund accountant' },
  facility: { cause: 'No lender statement is on file at the period end.', action: 'Ask the facility agent for the statement.', owner: 'Treasury' },
};

const REPORT_GUIDANCE: Guidance = {
  cause: 'The report\'s own figures do not add up: a subtotal or total printed in the report differs from the lines above it.',
  action: 'Check the page; if the report is as printed, ask the administrator, or the filer, whether it was restated.',
  owner: 'Fund administrator',
};

const ITEM_OWNER: Record<RecItem['tab'], string> = { fees: 'Fund accountant', val: 'Valuation analyst', drift: 'Senior reviewer' };

/** Who gets each input on file. */
const GAP_OWNER: Record<string, string> = {
  statement: 'Fund administrator', prior: 'Fund accountant', marks: 'Valuation analyst', roll: 'Portfolio accountant',
  bank: 'Fund accountant', lender: 'Treasury', notices: 'Investor services', terms: 'Fund accountant',
};

/** An input that a missing check already names is not listed twice. */
const GAP_CHECK: Record<string, string> = { bank: 'bank', lender: 'facility' };

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'not on file';
  const millions = value / 1e6;
  const digits = Math.abs(millions) >= 100 ? 1 : Math.abs(millions) >= 1 ? 2 : 3;
  const text = Math.abs(millions).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${millions < 0 ? '−' : ''}$${text}M`;
}

function figure(value: number | null, unit: BreakEntry['unit']): string {
  if (unit === 'POINTS') return value == null ? 'not on file' : `${value.toFixed(2)}`;
  if (unit === 'COUNT') return value == null ? 'not on file' : String(value);
  return money(value);
}

function checkEntry(check: RecCheck): BreakEntry {
  const missing = check.result === 'Missing';
  const guide = check.origin === 'report'
    ? REPORT_GUIDANCE
    : (missing ? MISSING_GUIDANCE[check.id] : null) ?? CHECK_GUIDANCE[check.id] ?? {
      cause: missing ? 'A figure this check needs is not on file.' : 'The two figures do not agree.',
      action: missing ? 'Load the figure that is missing.' : 'Find which figure is wrong.',
      owner: 'Fund accountant',
    };
  return {
    kind: missing ? 'missing' : 'break',
    id: check.id,
    title: check.label,
    reported: check.a,
    expected: check.b,
    difference: check.difference,
    unit: 'USD',
    cause: check.origin === 'report' ? `${guide.cause} ${check.compared}.` : guide.cause,
    action: guide.action,
    owner: guide.owner,
    blocking: !missing,
  };
}

function itemEntry(item: RecItem): BreakEntry {
  return {
    kind: 'item',
    id: item.id,
    title: item.title,
    reported: item.admin,
    expected: item.ours,
    difference: item.unit === 'POINTS' ? item.admin - item.ours : item.effect,
    unit: item.unit,
    cause: item.why,
    action: item.decision === 'QUERY' ? `With the administrator: ${item.note || 'query sent'}` : 'Accept, adjust, or query the administrator on the reconciliation page.',
    owner: ITEM_OWNER[item.tab],
    blocking: item.decision !== 'ACCEPT' && item.decision !== 'ADJUST',
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The summary of one fund's reconciliation for one period. */
export function summarizeBreaks(review: Review): BreakSummary {
  const breaks = review.checks.filter((check) => check.result === 'Break').map(checkEntry);
  const missing = review.checks.filter((check) => check.result === 'Missing').map(checkEntry);
  const items = review.items.filter((item) => item.decision !== 'ACCEPT' && item.decision !== 'ADJUST').map(itemEntry);
  const missingIds = new Set(review.checks.filter((check) => check.result === 'Missing').map((check) => check.id));
  const gaps: BreakEntry[] = review.readiness
    .filter((item) => item.required && !item.ok && !(GAP_CHECK[item.key] && missingIds.has(GAP_CHECK[item.key])))
    .map((item) => ({
      kind: 'gap', id: `gap:${item.key}`, title: item.label, reported: null, expected: null, difference: null, unit: 'COUNT',
      cause: /[.!?]$/.test(item.detail) ? item.detail : `${item.detail}.`,
      action: `Get the ${item.label.toLowerCase()} on file for the period.`, owner: GAP_OWNER[item.key] || 'Fund accountant', blocking: false,
    }));
  const entries = [...breaks, ...missing, ...items, ...gaps];
  const ties = review.checks.filter((check) => check.result === 'Ties');
  const tied = ties.map((check) => check.label);
  const comparedWith = review.priorPeriodEnd;

  const parts: string[] = [];
  if (!review.statementId) parts.push(`No statement is loaded for ${review.periodLabel}.`);
  else if (!breaks.length && !items.length) parts.push(`${review.fundName} ties for ${review.periodLabel}: ${plural(ties.length, 'check')} tie and nothing is open.`);
  else parts.push(`${review.fundName}, ${review.periodLabel}: ${plural(breaks.length, 'break')} and ${plural(items.length, 'open review item')}.`);
  if (missing.length) parts.push(`${plural(missing.length, 'check')} cannot be made because a figure is not on file.`);
  if (review.navReported != null) {
    const change = review.navChangePct == null ? '' : `, ${review.navChangePct >= 0 ? 'up' : 'down'} ${Math.abs(review.navChangePct).toFixed(1)}% from ${money(review.navPrior)} at ${comparedWith}`;
    parts.push(`Reported NAV ${money(review.navReported)}${change}.`);
  }
  const headline = parts.join(' ');

  const lines: string[] = [];
  lines.push(`## ${review.fundName}: ${review.periodLabel} NAV review`);
  lines.push('');
  lines.push(headline);
  lines.push('');
  lines.push(`Period end ${review.periodEnd}, compared with ${comparedWith} (${plural(review.spanMonths, 'month')}). ${plural(review.checks.length, 'check')}: ${ties.length} tie, ${breaks.length} break, ${missing.length} with a figure missing.`);
  const own = review.readiness.find((item) => item.key === 'report');
  if (own) lines.push('', `${own.detail}.`);
  const section = (title: string, list: BreakEntry[]) => {
    if (!list.length) return;
    lines.push('');
    lines.push(`### ${title}`);
    list.forEach((entry, index) => {
      const figures = entry.kind === 'gap' ? '' : ` ${figure(entry.reported, entry.unit)} against ${figure(entry.expected, entry.unit)}${entry.difference != null ? `, difference ${figure(entry.difference, entry.unit)}` : ''}.`;
      lines.push(`${index + 1}. **${entry.title}.**${figures} ${entry.cause} *Next:* ${entry.action} (${entry.owner})`);
    });
  };
  section('Breaks', breaks);
  section('Open review items', items);
  section('Checks with a figure missing', missing);
  section('Not on file', gaps);
  if (tied.length) {
    lines.push('');
    lines.push('### What ties');
    const shown = tied.slice(0, 20);
    lines.push(shown.map((label) => `- ${label}`).join('\n'));
    if (tied.length > shown.length) lines.push(`- and ${tied.length - shown.length} more`);
  }

  return {
    fund: { id: review.fundId, code: review.fundCode ?? null, name: review.fundName },
    periodEnd: review.periodEnd,
    periodLabel: review.periodLabel,
    comparedWith,
    spanMonths: review.spanMonths,
    headline,
    nav: { reported: review.navReported, prior: review.navPrior, proposed: review.navProposed, changePct: review.navChangePct },
    counts: { breaks: breaks.length, missing: missing.length, items: items.length, gaps: gaps.length, checks: review.checks.length, ties: ties.length },
    entries,
    tied,
    markdown: lines.join('\n'),
  };
}
