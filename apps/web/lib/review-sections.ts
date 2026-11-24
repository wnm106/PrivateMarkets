import type { ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';

/**
 * A review's changes, grouped by the kind of change, each group with the
 * screen that suits it. The kind is read from the tool a change runs, so a
 * cash pair is shown as a bank line beside its book flows wherever an agent
 * proposes one, and a change of any other kind keeps the general table.
 *
 * The order is the order a person should decide them in: what explains a
 * break comes before the break, and the notes, which describe everything
 * else as approved, come last. Pure, so the page and the tests agree.
 */

export type SectionKind = 'cash-pairs' | 'cash-adjustments' | 'rec-decisions' | 'rec-notes' | 'fin-certificates' | 'fin-review' | 'general';

interface SectionSpec {
  kind: SectionKind;
  label: string;
  /** One line on what to check, shown above the section. */
  howTo: string;
  tools: readonly string[];
}

const SECTIONS: readonly SectionSpec[] = [
  {
    kind: 'cash-pairs',
    label: 'Cash pairs',
    howTo: 'Each pair puts a bank transaction beside the book cash flows it settled. Check the amounts and dates agree, change the flows if the pair is wrong, then approve or reject.',
    tools: ['approve_cash_match'],
  },
  {
    kind: 'cash-adjustments',
    label: 'Cash adjustments',
    howTo: 'An adjustment records a difference whose cause is known; it does not explain one. Check the cause, the side and the amount.',
    tools: ['post_cash_adjustment'],
  },
  {
    kind: 'rec-decisions',
    label: 'Reconciliation decisions',
    howTo: "Each decision settles one review item of the close: accept the administrator's figure, adjust to ours, or query the administrator. Check the figures and the note that goes on the file.",
    tools: ['record_rec_decision'],
  },
  { kind: 'general', label: 'Other changes', howTo: 'Open a change to see exactly what it does and why.', tools: [] },
  {
    kind: 'fin-certificates',
    label: 'Certificate values',
    howTo: "Each records what the borrower's compliance certificate says a covenant was. Check the figure is the one certified. Our own calculation is not changed by it.",
    tools: ['record_borrower_covenant_value'],
  },
  {
    kind: 'rec-notes',
    label: 'Reconciliation notes',
    howTo: 'The notes describe the reconciliation as it stands once everything above for the fund is approved. If you reject something above, edit them to match.',
    tools: ['save_reconciliation_notes'],
  },
  {
    kind: 'fin-review',
    label: 'Review notes',
    howTo: 'The notes describe the quarter as it stands once everything above for the borrower is approved. If you reject something above, edit them to match.',
    tools: ['save_borrower_review'],
  },
];

export interface ReviewSection {
  kind: SectionKind;
  label: string;
  howTo: string;
  items: ProposalItem[];
}

function kindOf(item: ProposalItem): SectionKind {
  return SECTIONS.find((section) => section.tools.includes(item.tool))?.kind || 'general';
}

/** The review's changes in sections, in the order to decide them. Empty sections are left out. */
export function reviewSections(items: readonly ProposalItem[]): ReviewSection[] {
  return SECTIONS.map((spec) => ({ kind: spec.kind, label: spec.label, howTo: spec.howTo, items: items.filter((item) => kindOf(item) === spec.kind) })).filter((section) => section.items.length > 0);
}

/** Whether the review needs sections at all: a review of only general changes keeps the one table. */
export function sectioned(sections: readonly ReviewSection[]): boolean {
  return sections.some((section) => section.kind !== 'general');
}

/** The changes of a general table under the record each is aimed at, in the order the records first appear. */
export interface RecordGroup {
  key: string;
  label: string;
  kind: string;
  items: ProposalItem[];
}

export function byRecord(items: readonly ProposalItem[]): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const item of items) {
    const key = item.target.entityId || `${item.target.kind}|${item.target.label}`;
    const group = groups.get(key) || { key, label: item.target.label, kind: item.target.kind, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Whether a table of changes reads better under a heading per record: true once any record has more
 * than one change, so its name is said once and not on every row.
 */
export function groupsByRecord(groups: readonly RecordGroup[]): boolean {
  return groups.some((group) => group.items.length > 1);
}

/**
 * How big a difference is beside the figure it is a difference in, so a reviewer can
 * judge whether it matters without doing the division.
 */
export function shareText(part: number, whole: number): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return null;
  const share = Math.abs(part / whole) * 100;
  if (share === 0) return '0%';
  if (share < 0.01) return 'under 0.01%';
  return `${share < 1 ? share.toFixed(2) : share.toFixed(1)}%`;
}

/** A fund and period a rec section or view reads, keyed so each is loaded once. */
export interface RecKey {
  key: string;
  fundId: string;
  periodEnd: string | null;
}

export function recKey(fundId: unknown, periodEnd: unknown): RecKey | null {
  const fund = typeof fundId === 'string' ? fundId.trim() : '';
  if (!fund) return null;
  const period = typeof periodEnd === 'string' && periodEnd.trim() ? periodEnd.trim() : null;
  return { key: `${fund}|${period || ''}`, fundId: fund, periodEnd: period };
}

/** Whether a section is one of the reconciliation's: it reads a fund's close. */
export function isRecSection(kind: SectionKind): boolean {
  return kind === 'cash-pairs' || kind === 'cash-adjustments' || kind === 'rec-decisions' || kind === 'rec-notes';
}

/** A record and a date a borrower section or view reads, keyed so each is loaded once. */
export interface FinKey {
  key: string;
  entityId: string;
  periodEnd: string | null;
}

export function finKey(entityId: unknown, periodEnd: unknown): FinKey | null {
  const id = typeof entityId === 'string' ? entityId.trim() : '';
  if (!id) return null;
  const period = typeof periodEnd === 'string' && periodEnd.trim() ? periodEnd.trim().slice(0, 10) : null;
  return { key: `${id}|${period || ''}`, entityId: id, periodEnd: period };
}

/**
 * What the borrower sections and views of a review read: each borrower and quarter (the review notes
 * and the views), and each covenant at the quarter its certificate covers.
 */
export function finKeys(sections: readonly ReviewSection[], views: ReadonlyArray<{ view: string; args: Record<string, string> }> = []): { borrowers: FinKey[]; covenants: FinKey[] } {
  const borrowers = new Map<string, FinKey>();
  const covenants = new Map<string, FinKey>();
  const add = (into: Map<string, FinKey>, key: FinKey | null) => {
    if (key && !into.has(key.key)) into.set(key.key, key);
  };
  for (const section of sections) {
    for (const item of section.items) {
      if (section.kind === 'fin-review') add(borrowers, finKey(item.args.entityId, item.args.periodEnd));
      if (section.kind === 'fin-certificates') add(covenants, finKey(item.args.entityId, item.args.testDate));
    }
  }
  for (const view of views) {
    if (view.view.startsWith('fin.')) add(borrowers, finKey(view.args.entityId, view.args.periodEnd));
  }
  return { borrowers: [...borrowers.values()], covenants: [...covenants.values()] };
}

/** Every fund and period the rec sections and views of a review read, once each. */
export function recKeys(sections: readonly ReviewSection[], views: ReadonlyArray<{ view: string; args: Record<string, string> }> = []): RecKey[] {
  const found = new Map<string, RecKey>();
  const add = (key: RecKey | null) => {
    if (key && !found.has(key.key)) found.set(key.key, key);
  };
  for (const section of sections) {
    if (!isRecSection(section.kind)) continue;
    for (const item of section.items) add(recKey(item.args.fundId, item.args.periodEnd));
  }
  for (const view of views) {
    if (view.view.startsWith('rec.')) add(recKey(view.args.fundId, view.args.periodEnd));
  }
  return [...found.values()];
}
