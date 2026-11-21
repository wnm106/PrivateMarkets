/**
 * Views an agent can put in front of the person who reviews its proposal.
 *
 * An agent step may list the views it is allowed to show. While it works, the
 * agent names one or more of them, with the record and period to show and the
 * rows to point at, and says why. The review shows each view beside the
 * proposed changes, read through the same queries the platform's own pages
 * use, so the reviewer sees what the agent saw.
 *
 * The agent cannot invent a view or give one settings it does not take. Pure,
 * so the worker, the API, and the editor read a view the same way. Each view's
 * component lives in the web app under the same code.
 */

export interface ViewArg {
  key: string;
  label: string;
  help: string;
  required: boolean;
}

export interface ReviewViewSpec {
  code: string;
  label: string;
  /** What the view shows. The agent reads this to choose. */
  description: string;
  args: ViewArg[];
  /** What the ids in focus are: rows the view marks for the reviewer. */
  focus: string;
}

/** A view the agent chose, as stored on the proposal. */
export interface ProposalView {
  id: string;
  view: string;
  args: Record<string, string>;
  /** Rows to mark, by the ids the view's own data uses. */
  focus: string[];
  /** Why the reviewer should look at it, in the agent's words. */
  why: string;
}

const FUND: ViewArg = { key: 'fundId', label: 'Fund', help: 'The fund: its record id or its fund code.', required: true };
const PERIOD: ViewArg = { key: 'periodEnd', label: 'Period end', help: 'YYYY-MM-DD. Leave out for the period now closing.', required: false };

export const REVIEW_VIEWS: readonly ReviewViewSpec[] = [
  {
    code: 'rec.cash',
    label: 'Cash reconciliation',
    description: "One fund's bank transactions beside its book cash flows for a period: what is matched, what is open, the adjustments posted, and whether the two sides tie.",
    args: [FUND, PERIOD],
    focus: 'Bank transaction ids and cash flow ids, from get_cash_reconciliation.',
  },
  {
    code: 'rec.nav',
    label: 'NAV reconciliation',
    description: "One fund's close for a period: the reported and proposed NAV, and each review item (fees, valuations, drift) with the administrator's figure, ours, the NAV effect and its decision.",
    args: [FUND, PERIOD],
    focus: 'Review item ids, from get_nav_reconciliation: "fee", "perf", "int", "pos:<position id>", or a drift id.',
  },
];

export function reviewView(code: unknown): ReviewViewSpec | null {
  return REVIEW_VIEWS.find((view) => view.code === code) || null;
}

/** The most views one proposal can carry. */
export const MAX_VIEWS = 6;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * Cleans the views an agent asked for. `allowed` are the view codes its step
 * may show; null accepts any known view, for reading a stored proposal back.
 * Returns what was kept and, for each view refused, why.
 */
export function normalizeViews(raw: unknown, allowed: readonly string[] | null, existing: ProposalView[] = []): { views: ProposalView[]; refused: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const views: ProposalView[] = [];
  const refused: string[] = [];
  const used = new Set(existing.map((view) => view.id));
  for (const entry of list) {
    const row = record(entry);
    const spec = reviewView(text(row.view));
    if (!spec) {
      refused.push(`"${text(row.view) || '(none)'}" is not a view. Views: ${REVIEW_VIEWS.map((view) => view.code).join(', ')}.`);
      continue;
    }
    if (allowed && !allowed.includes(spec.code)) {
      refused.push(`${spec.code} is not a view this step can show.${allowed.length > 0 ? ` It can show ${allowed.join(', ')}.` : ''}`);
      continue;
    }
    const given = record(row.args);
    const args: Record<string, string> = {};
    for (const arg of spec.args) {
      const value = text(given[arg.key]);
      if (value) args[arg.key] = value;
    }
    const missing = spec.args.filter((arg) => arg.required && !args[arg.key]).map((arg) => arg.key);
    if (missing.length > 0) {
      refused.push(`${spec.code} needs ${missing.join(', ')}.`);
      continue;
    }
    if (existing.length + views.length >= MAX_VIEWS) {
      refused.push(`A review shows at most ${MAX_VIEWS} views. Show the ones that matter most.`);
      break;
    }
    let id = text(row.id) || `view-${existing.length + views.length + 1}`;
    for (let index = 2; used.has(id); index += 1) id = `${text(row.id) || 'view'}-${index}`;
    used.add(id);
    views.push({
      id,
      view: spec.code,
      args,
      focus: (Array.isArray(row.focus) ? row.focus : []).map(text).filter(Boolean).slice(0, 50),
      why: text(row.why).slice(0, 600),
    });
  }
  return { views, refused };
}
