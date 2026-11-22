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
import type { PackComponentKey, PackStatus } from './nav-pack';

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
  /** Dollars, points for a mark, a count of records, or a percentage. */
  unit: 'USD' | 'POINTS' | 'COUNT' | 'PCT';
  /** What the figures are, and what usually explains a difference like this. */
  cause: string;
  /** What settles it. */
  action: string;
  /** Who does that. */
  owner: string;
  /** Whether it stands between the period and certification. */
  blocking: boolean;
  /** The part of the NAV pack it is about, for a pack check or a missing part. */
  component?: PackComponentKey;
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
  /** The NAV pack, part by part: what is on file and where it stands. */
  pack: Array<{ key: PackComponentKey; label: string; status: PackStatus; detail: string; owner: string; required: boolean }>;
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
  // The NAV pack
  bridge: { cause: 'Opening NAV plus contributions, distributions, income, expenses, gains and FX does not reach closing NAV: a movement is missing from the NAV summary, or a line landed on the wrong part of the chart.', action: 'Ask the administrator for the NAV bridge and compare each movement with the statements.', owner: 'Fund accountant' },
  tbBalances: { cause: 'Debits and credits in the trial balance do not agree, so the ledger extract is incomplete.', action: 'Ask the administrator for a complete trial balance at the period end.', owner: 'Fund administrator' },
  tbAssets: { cause: 'The asset accounts in the trial balance do not add up to total assets on the balance sheet: an account is unclassified, or the statements were prepared before a late entry.', action: 'Map the trial balance to the balance sheet and find the account that differs.', owner: 'Fund accountant' },
  tbLiabilities: { cause: 'The liability accounts in the trial balance do not add up to total liabilities on the balance sheet.', action: 'Map the trial balance to the balance sheet and find the account that differs.', owner: 'Fund accountant' },
  tbCapital: { cause: 'Capital, income, expense and gain accounts in the trial balance do not add up to net assets: the ledger and the statements are on different versions.', action: 'Ask the administrator which is final and for the entries posted after the statements.', owner: 'Fund administrator' },
  tbIncome: { cause: 'Income accounts in the trial balance differ from total investment income.', action: 'Compare income accounts with the statement of operations line by line.', owner: 'Fund accountant' },
  tbExpenses: { cause: 'Expense accounts in the trial balance differ from total expenses.', action: 'Compare expense accounts with the statement of operations; accrued expenses posted late are the usual cause.', owner: 'Fund accountant' },
  tbLines: { cause: 'Ledger accounts mapped to a statement line do not add up to it.', action: 'Check the account-to-line mapping (TB_NAV_LINE) and the accounts behind the lines named.', owner: 'Fund accountant' },
  pcapRoll: { cause: 'An investor\'s opening capital, contributions, distributions, allocations and carry do not reach its closing capital.', action: 'Ask investor services for those investors\' capital account statements in full.', owner: 'Investor services' },
  pcapNav: { cause: 'The investors\' closing capital does not add up to net assets: an investor is missing from the capital account summary, or the GP\'s account is left out.', action: 'Check every investor and the GP are in the summary, then ask the administrator.', owner: 'Investor services' },
  pcapOpening: { cause: 'The investors\' opening capital does not add up to opening NAV: the prior period\'s capital accounts were restated, or a transfer is missing.', action: 'Compare with last period\'s closing capital accounts.', owner: 'Investor services' },
  pcapContrib: { cause: 'Contributions in the capital accounts differ from contributions in the statements.', action: 'Compare the capital call allocation with the capital accounts.', owner: 'Investor services' },
  pcapDist: { cause: 'Distributions in the capital accounts differ from distributions in the statements.', action: 'Compare the distribution allocation with the capital accounts.', owner: 'Investor services' },
  pcapPnl: { cause: 'Profit and loss allocated to investors, with carry, differs from the net increase from operations: the allocation was run on an earlier version of the statements.', action: 'Ask the administrator to rerun the allocation on the final statements.', owner: 'Fund accountant' },
  pcapOwnership: { cause: 'Ownership percentages do not add up to 100%.', action: 'Ask investor services for the ownership schedule.', owner: 'Investor services' },
  lpFees: { cause: 'The fee charged to an investor differs from its rate on its share of the fee base: a side letter rate, a fee class, or a late close not reflected.', action: 'Check the investors named against their side letters and fee classes.', owner: 'Fund accountant' },
  feeAllocation: { cause: 'Fees charged to investors do not add up to the fund\'s management fee: an investor\'s fee is missing, or the GP is charged.', action: 'Ask the administrator for the fee allocation by investor.', owner: 'Fund accountant' },
  gpCarry: { cause: 'The carry in the GP\'s capital account differs from carry recalculated on the waterfall.', action: 'Ask for the hypothetical liquidation waterfall and compare tier by tier.', owner: 'Fund controller' },
  carryOffsets: { cause: 'Carry taken from the limited partners is not what the GP received.', action: 'Ask the administrator for the carry reallocation by investor.', owner: 'Fund controller' },
  valuationCoverage: { cause: 'Investments without valuation support dated in the period: their marks have nothing behind them for this close.', action: 'Ask the valuation team for the reports, memos or model outputs for the positions listed.', owner: 'Valuation analyst' },
  valuationMarks: { cause: 'A mark sits outside the range, or away from the value, its valuation support concludes.', action: 'Ask the valuation team why the mark differs from the report, and correct one of them.', owner: 'Valuation analyst' },
  thirdParty: { cause: 'Less of the portfolio has a third-party valuation than the fund requires.', action: 'Ask the valuation agent for the positions not yet covered.', owner: 'Valuation analyst' },
  callsReceived: { cause: 'Capital received on the period\'s calls differs from contributions in the statements: an investor paid late, or a call was booked in another period.', action: 'Match the call notices with cash received and the contributions booked.', owner: 'Investor services' },
  callReceivable: { cause: 'Calls not yet received differ from contributions receivable on the balance sheet.', action: 'Ask investor services which investors have not funded, and the administrator to book the receivable.', owner: 'Investor services' },
  distPayable: { cause: 'Distributions declared and not yet paid differ from distributions payable on the balance sheet.', action: 'Check the distribution notices against the payable booked.', owner: 'Fund accountant' },
  distPaid: { cause: 'Distributions paid in the period differ from distributions in the cash flow statement.', action: 'Match the distribution notices with the cash paid.', owner: 'Fund accountant' },
  lpCommitments: { cause: 'Investors\' commitments do not add up to the fund\'s total commitments: a close or a transfer is not on the fund record.', action: 'Update the fund\'s total commitments, or ask investor services for the commitment schedule.', owner: 'Investor services' },
  lpUnfunded: { cause: 'Investors\' unfunded commitments do not add up to the fund\'s undrawn commitments.', action: 'Update the fund\'s undrawn commitments, or ask investor services for the unfunded schedule.', owner: 'Investor services' },
  unfundedRoll: { cause: 'Commitment less contributions to date is not the unfunded amount for some investors; recallable distributions explain some.', action: 'Ask investor services for those investors\' recallable amounts.', owner: 'Investor services' },
  pendingCalls: { cause: 'Calls still to come exceed the unfunded commitments left.', action: 'Check the call schedule against the unfunded schedule.', owner: 'Investor services' },
  commitmentRecords: { cause: 'An investor\'s commitment in its capital account differs from its commitment record.', action: 'Check the subscription documents and correct one of them.', owner: 'Investor services' },
  fxCoverage: { cause: 'A currency the fund holds has no rate applied in the pack.', action: 'Ask the administrator for the FX translation of the currencies listed.', owner: 'Fund accountant' },
  fxRates: { cause: 'A rate the administrator applied is away from the market rate at the period end: a rate from another date or source.', action: 'Ask the administrator which rate source and time they used.', owner: 'Fund accountant' },
  fxTranslation: { cause: 'Exposure in the currency at the applied rate does not give the exposure in the base currency.', action: 'Ask the administrator for the translation workings.', owner: 'Fund accountant' },
  fxGains: { cause: 'FX gains by currency do not add up to FX gains in the statement of operations.', action: 'Ask the administrator for the split of FX gains, realized and unrealized, by currency.', owner: 'Fund accountant' },
  fxHedgeMtm: { cause: 'The fair value of FX hedges differs from derivatives on the balance sheet.', action: 'Ask the counterparty for its valuation of the hedges and compare.', owner: 'Treasury' },
  fxHedge: { cause: 'The hedged share of foreign currency exposure is away from the fund\'s hedge target.', action: 'Ask treasury whether hedges need to roll or resize.', owner: 'Treasury' },
};

/** Pack checks whose figures are counts of records or shares, not dollars. */
const COUNT_CHECKS = new Set(['pcapRoll', 'tbLines', 'lpFees', 'valuationMarks', 'unfundedRoll', 'commitmentRecords', 'fxCoverage', 'fxRates', 'fxTranslation']);
const PCT_CHECKS = new Set(['pcapOwnership', 'valuationCoverage', 'thirdParty', 'fxHedge']);

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
  if (unit === 'PCT') return value == null ? 'not on file' : `${value.toFixed(2)}%`;
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
    unit: COUNT_CHECKS.has(check.id) ? 'COUNT' : PCT_CHECKS.has(check.id) ? 'PCT' : 'USD',
    cause: check.origin === 'report' ? `${guide.cause} ${check.compared}.` : guide.cause,
    action: guide.action,
    owner: guide.owner,
    blocking: !missing,
    ...(check.component ? { component: check.component } : {}),
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
    .filter((item) => item.key !== 'pack' && item.required && !item.ok && !(GAP_CHECK[item.key] && missingIds.has(GAP_CHECK[item.key])))
    .map((item) => ({
      kind: 'gap', id: `gap:${item.key}`, title: item.label, reported: null, expected: null, difference: null, unit: 'COUNT',
      cause: /[.!?]$/.test(item.detail) ? item.detail : `${item.detail}.`,
      action: `Get the ${item.label.toLowerCase()} on file for the period.`, owner: GAP_OWNER[item.key] || 'Fund accountant', blocking: false,
    }));
  // Each part of the NAV pack the fund's terms call for, or the fund lists, that is not on file.
  const parts = review.pack?.components ?? [];
  for (const part of parts.filter((item) => item.status === 'Not on file')) {
    gaps.push({
      kind: 'gap', id: `pack:${part.key}`, title: part.label, reported: null, expected: null, difference: null, unit: 'COUNT',
      cause: `${part.detail}. The pack should hold: ${part.covers.charAt(0).toLowerCase()}${part.covers.slice(1)}.`,
      action: `Ask for the ${part.label.charAt(0).toLowerCase()}${part.label.slice(1)} for the period and load it.`, owner: part.owner, blocking: part.required,
      component: part.key,
    });
  }
  const entries = [...breaks, ...missing, ...items, ...gaps];
  const ties = review.checks.filter((check) => check.result === 'Ties');
  const tied = ties.map((check) => check.label);
  const comparedWith = review.priorPeriodEnd;

  const said: string[] = [];
  if (!review.statementId) said.push(`No statement is loaded for ${review.periodLabel}.`);
  else if (!breaks.length && !items.length) said.push(`${review.fundName} ties for ${review.periodLabel}: ${plural(ties.length, 'check')} tie and nothing is open.`);
  else said.push(`${review.fundName}, ${review.periodLabel}: ${plural(breaks.length, 'break')} and ${plural(items.length, 'open review item')}.`);
  if (missing.length) said.push(`${plural(missing.length, 'check')} cannot be made because a figure is not on file.`);
  if (review.navReported != null) {
    const change = review.navChangePct == null ? '' : `, ${review.navChangePct >= 0 ? 'up' : 'down'} ${Math.abs(review.navChangePct).toFixed(1)}% from ${money(review.navPrior)} at ${comparedWith}`;
    said.push(`Reported NAV ${money(review.navReported)}${change}.`);
  }
  const packMissing = parts.filter((item) => item.status === 'Not on file');
  if (packMissing.length) said.push(`${plural(packMissing.length, 'part')} of the NAV pack ${packMissing.length === 1 ? 'is' : 'are'} not on file.`);
  const headline = said.join(' ');

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
  if (parts.length) {
    lines.push('');
    lines.push('### The NAV pack');
    for (const part of parts.filter((item) => item.status !== 'Not expected')) {
      lines.push(`- **${part.label}:** ${part.status.toLowerCase()}${part.required ? ' (required)' : ''}. ${part.detail}.`);
    }
    const notExpected = parts.filter((item) => item.status === 'Not expected');
    if (notExpected.length) lines.push(`- Not expected of this fund: ${notExpected.map((item) => item.label.toLowerCase()).join(', ')}.`);
  }
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
    pack: parts.map((part) => ({ key: part.key, label: part.label, status: part.status, detail: part.detail, owner: part.owner, required: part.required })),
    markdown: lines.join('\n'),
  };
}
