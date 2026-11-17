/** What a workflow trigger watches, and how the page describes it. See docs/WORKFLOWS.md. */

export interface TriggerView {
  id: string;
  name: string;
  source: 'FEED' | 'DQ_FAILURES';
  match: { kinds?: string[]; feedCodes?: string[]; severities?: string[]; ruleCodes?: string[]; domainCodes?: string[] };
  input: Record<string, unknown>;
  isActive: boolean;
  createdByName: string | null;
  busy: boolean;
  lastFiredAt: string | null;
  lastCount: number | null;
  lastJob: { status?: string; error?: string | null; workflowRunId?: string | null } | null;
  canManage: boolean;
}

export const FEED_KINDS: Array<{ code: string; label: string }> = [
  { code: 'FEED_LOADED', label: 'Loads a file' },
  { code: 'FEED_NEEDS_REVIEW', label: 'Has a file waiting for review' },
  { code: 'FEED_FAILED', label: 'Fails to load a file' },
  { code: 'FEED_LATE', label: 'Is late' },
];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** "FUND, HSCF2" to ['FUND', 'HSCF2']. */
export function codeList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((part) => part.trim().toUpperCase()).filter(Boolean))];
}

/** One line saying what a trigger watches. */
export function triggerSummary(trigger: Pick<TriggerView, 'source' | 'match'>): string {
  const list = (values: string[] | undefined, none: string) => (values && values.length > 0 ? values.join(', ') : none);
  if (trigger.source === 'FEED') {
    const kinds = (trigger.match.kinds || []).map((code) => FEED_KINDS.find((kind) => kind.code === code)?.label.toLowerCase() || code);
    return `When ${list(trigger.match.feedCodes, 'any feed')} ${kinds.length > 0 ? kinds.join(' or ') : 'loads, fails, is late, or has a file for review'}`;
  }
  const severities = trigger.match.severities && trigger.match.severities.length > 0 ? `${trigger.match.severities.join(' or ').toLowerCase()} ` : '';
  const rules = trigger.match.ruleCodes && trigger.match.ruleCodes.length > 0 ? ` from ${trigger.match.ruleCodes.join(', ')}` : '';
  const types = trigger.match.domainCodes && trigger.match.domainCodes.length > 0 ? ` on ${trigger.match.domainCodes.join(', ')} records` : '';
  return `When a data quality scan finds ${severities}new failures${rules}${types}`;
}
