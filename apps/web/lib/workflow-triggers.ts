/** What a workflow trigger watches, and how the page describes it. See docs/WORKFLOWS.md. */

export type TriggerSource = 'FEED' | 'DQ_FAILURES' | 'BREACH' | 'VALUE_CHANGE';

export interface TriggerMatch {
  kinds?: string[];
  feedCodes?: string[];
  severities?: string[];
  ruleCodes?: string[];
  domainCodes?: string[];
  statuses?: string[];
  attributeCodes?: string[];
}

export interface TriggerView {
  id: string;
  name: string;
  source: TriggerSource;
  match: TriggerMatch;
  input: Record<string, unknown>;
  isActive: boolean;
  createdByName: string | null;
  busy: boolean;
  lastFiredAt: string | null;
  lastCount: number | null;
  lastJob: { status?: string; error?: string | null; workflowRunId?: string | null } | null;
  canManage: boolean;
}

export const TRIGGER_SOURCES: Array<{ code: TriggerSource; label: string }> = [
  { code: 'DQ_FAILURES', label: 'A data quality scan finds new failures' },
  { code: 'BREACH', label: 'A compliance rule is breached' },
  { code: 'VALUE_CHANGE', label: 'A value changes' },
  { code: 'FEED', label: 'A feed does something' },
];

export const FEED_KINDS: Array<{ code: string; label: string }> = [
  { code: 'FEED_LOADED', label: 'Loads a file' },
  { code: 'FEED_NEEDS_REVIEW', label: 'Has a file waiting for review' },
  { code: 'FEED_FAILED', label: 'Fails to load a file' },
  { code: 'FEED_LATE', label: 'Is late' },
];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const BREACH_STATUSES: Array<{ code: string; label: string }> = [
  { code: 'HARD_BREACH', label: 'Hard breach' },
  { code: 'SOFT_BREACH', label: 'Soft breach' },
];

/** "FUND, HSCF2" to ['FUND', 'HSCF2']. */
export function codeList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((part) => part.trim().toUpperCase()).filter(Boolean))];
}

/** One line saying what a trigger watches. */
export function triggerSummary(trigger: Pick<TriggerView, 'source' | 'match'>): string {
  const list = (values: string[] | undefined, none: string) => (values && values.length > 0 ? values.join(', ') : none);
  const types = trigger.match.domainCodes && trigger.match.domainCodes.length > 0 ? ` on ${trigger.match.domainCodes.join(', ')} records` : '';
  if (trigger.source === 'FEED') {
    const kinds = (trigger.match.kinds || []).map((code) => FEED_KINDS.find((kind) => kind.code === code)?.label.toLowerCase() || code);
    return `When ${list(trigger.match.feedCodes, 'any feed')} ${kinds.length > 0 ? kinds.join(' or ') : 'loads, fails, is late, or has a file for review'}`;
  }
  if (trigger.source === 'BREACH') {
    const statuses = (trigger.match.statuses || []).map((code) => BREACH_STATUSES.find((status) => status.code === code)?.label.toLowerCase() || code);
    const what = statuses.length > 0 ? statuses.join(' or ') : 'breach';
    return `When ${list(trigger.match.ruleCodes, 'any compliance rule')} has a new ${what}`;
  }
  if (trigger.source === 'VALUE_CHANGE') {
    return `When a new value is recorded for ${list(trigger.match.attributeCodes, 'no attribute yet')}${types}`;
  }
  const severities = trigger.match.severities && trigger.match.severities.length > 0 ? `${trigger.match.severities.join(' or ').toLowerCase()} ` : '';
  const rules = trigger.match.ruleCodes && trigger.match.ruleCodes.length > 0 ? ` from ${trigger.match.ruleCodes.join(', ')}` : '';
  return `When a data quality scan finds ${severities}new failures${rules}${types}`;
}
