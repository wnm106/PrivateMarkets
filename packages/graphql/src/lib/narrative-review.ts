/**
 * Consistency review: a second reader checks a finished report against its own evidence.
 *
 * Numbers are already checked one by one (verifyBlocks). What that cannot see is a claim that is
 * wrong without containing a figure: "Strategy: middle-market credit" with no strategy data, a status
 * nobody recorded, an action described as underway, a summary that contradicts an earlier section, or
 * a value read from a different record that happens to share a name. A reviewer model looks for those.
 *
 * Pure and dependency-free. The app runner and the MCP server both use it, so a review means the same
 * thing wherever it was made.
 */

export type ReviewSeverity = 'high' | 'medium' | 'low';
export type ReviewKind = 'contradiction' | 'gap-vs-figure' | 'unsupported' | 'record-mixup' | 'stated-as-fact' | 'other';

export interface ReviewIssue {
  severity: ReviewSeverity;
  kind: ReviewKind;
  /** Section keys the issue touches. */
  sections: string[];
  /** The exact words in the report that raise the issue. Always found in the text; issues whose quote is not are dropped. */
  quote: string;
  problem: string;
  suggestion?: string;
}

export interface RunReview {
  issues: ReviewIssue[];
  reviewedAt: string;
  model?: string;
  sectionsReviewed: number;
  /** Issues the reviewer raised whose quote could not be found in the report, and so were discarded. */
  discarded: number;
  source: 'APP' | 'MCP';
}

export interface ReviewSectionInput {
  key: string;
  title: string;
  markdown: string;
  /** Data gaps and caveats recorded when the section was written. */
  notes: string[];
  /** What the section's tool gathering reported finding. */
  findings?: string;
  /** Figures that could not be traced to evidence. */
  untraced?: string[];
}

export const REVIEW_CHECKLIST = `Look for these, and only these:
1. contradiction: two sections state incompatible facts about the same thing (a count, a share, a status, a date, a total).
2. gap-vs-figure: one section says something is "data not available" or absent while another section gives a value for it, or the reverse.
3. unsupported: a statement about the fund, the manager, or a borrower (strategy, status, rating, trend, intention, reason, activity, "no issues") that nothing in the section's own data, notes, or findings supports. A positive conclusion drawn from missing data counts.
4. record-mixup: a value attributed to a record that the evidence shows may belong to a different record, for example records that share a name, or a figure from a lookup by name.
5. stated-as-fact: an action, plan, or remediation described as already happening when the evidence does not show it.
6. other: a figure that is plainly the writer's own arithmetic presented as data, or an internal inconsistency in one section.`;

export function reviewSystemPrompt(): string {
  return [
    'You are an independent reviewer of a finished, multi-section report built from a data platform. You did not write it. Your job is to find places where it says something its own evidence does not support, or contradicts itself. You do not rewrite it and you do not improve its style.',
    REVIEW_CHECKLIST,
    'Work in two steps. Step 1: list every statement in the report that something is absent, unavailable, unpopulated, zero, or "none" for the fund, the portfolio, or all borrowers (for example "no industry classification", "no covenant data", "0 non-accruals"). Step 2: for each one, look through ALL the other sections, including their tables and scorecards, for any value of that same thing. If another section shows one, that is a gap-vs-figure issue, and you must report it. Do the same in reverse for any figure a section gives that another section says is unavailable.',
    'Rules for what you report:',
    '- Report an issue only if you can quote the exact words from the report (at most 200 characters, copied verbatim). If you cannot quote the exact words, do not report it.',
    '- Use each section\'s "Data notes" and "Findings" as the evidence for that section. A statement the notes plainly support is not an issue.',
    '- Prefer a few real issues to many doubtful ones. Severity is high when a reader could be misled about the fund or a borrower, medium when a statement is unsupported, low for tidy-ups. If the report is consistent, return an empty list.',
    'Respond with ONLY JSON: { "absenceClaims": [ { "section": "section_key", "claim": "<what is said to be absent>", "shownElsewhere": true|false } ], "issues": [ { "severity": "high"|"medium"|"low", "kind": "contradiction"|"gap-vs-figure"|"unsupported"|"record-mixup"|"stated-as-fact"|"other", "sections": ["section_key"], "quote": "<exact words>", "problem": "<one sentence>", "suggestion": "<one sentence: what the section should say or do instead>" } ] }',
  ].join('\n\n');
}

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(text.length - (max - head))}`;
};

export function reviewUserPrompt(sections: ReviewSectionInput[]): string {
  const per = Math.min(12000, Math.max(3000, Math.floor(70000 / Math.max(sections.length, 1))));
  return sections.map((s) => [
    `## Section [${s.key}]: ${s.title}`,
    s.notes.length ? `Data notes: ${clip(s.notes.join(' | '), 1200)}` : 'Data notes: none',
    s.findings ? `Findings: ${clip(s.findings, 1500)}` : '',
    s.untraced?.length ? `Figures not traced to evidence: ${s.untraced.slice(0, 12).join(', ')}` : '',
    'Text:',
    clip(s.markdown, per),
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

/** Lowercases and reduces text to words and numbers, so a quote matches the text it was copied from whatever its markdown or punctuation. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const KINDS: ReviewKind[] = ['contradiction', 'gap-vs-figure', 'unsupported', 'record-mixup', 'stated-as-fact', 'other'];
const SEVERITIES: ReviewSeverity[] = ['high', 'medium', 'low'];
const ORDER: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };

const text = (v: unknown, max: number): string => (v === null || v === undefined ? '' : String(v).slice(0, max));

/**
 * Turns the reviewer's JSON into issues, keeping only those whose quote really appears in the report.
 * A reviewer that invents a quote is discarded, so every issue shown can be found in the text.
 */
export function normalizeReview(
  raw: unknown,
  sections: Array<{ key: string; markdown: string }>,
): { issues: ReviewIssue[]; discarded: number } {
  const list: any[] = Array.isArray((raw as any)?.issues) ? (raw as any).issues : Array.isArray(raw) ? (raw as any[]) : [];
  const texts = new Map(sections.map((s) => [s.key, plain(s.markdown)]));
  const keys = new Set(sections.map((s) => s.key));
  const issues: ReviewIssue[] = [];
  let discarded = 0;
  for (const item of list.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const quote = text(item.quote, 400).trim();
    const problem = text(item.problem, 600).trim();
    if (!quote || !problem) { discarded++; continue; }
    const named = (Array.isArray(item.sections) ? item.sections : []).map((k: unknown) => String(k)).filter((k: string) => keys.has(k));
    const needle = plain(quote).slice(0, 80);
    const searched: string[] = named.length ? named : [...keys];
    const where = searched.filter((k: string) => (texts.get(k) ?? '').includes(needle));
    if (!needle || !where.length) { discarded++; continue; }
    issues.push({
      severity: SEVERITIES.includes(item.severity) ? item.severity : 'medium',
      kind: KINDS.includes(item.kind) ? item.kind : 'other',
      sections: named.length ? named : where,
      quote: quote.slice(0, 200),
      problem,
      ...(item.suggestion ? { suggestion: text(item.suggestion, 500) } : {}),
    });
  }
  issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return { issues: issues.slice(0, 30), discarded };
}

/** One line for a banner: "3 issues (1 high)". */
export function reviewSummary(review: Pick<RunReview, 'issues'> | null | undefined): string {
  const issues = review?.issues ?? [];
  if (!issues.length) return 'No consistency issues found';
  const high = issues.filter((i) => i.severity === 'high').length;
  return `${issues.length} consistency issue${issues.length === 1 ? '' : 's'}${high ? ` (${high} high)` : ''}`;
}

/** Notes a section should address when it is written again to fix what a review found. */
export function reviewNotesFor(sectionKey: string, issues: ReviewIssue[]): string {
  return issues
    .filter((i) => i.sections.includes(sectionKey))
    .map((i) => `- ${i.problem} (you wrote: "${i.quote}")${i.suggestion ? ` Do this instead: ${i.suggestion}` : ''}`)
    .join('\n');
}
