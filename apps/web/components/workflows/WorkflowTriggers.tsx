'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { BREACH_STATUSES, FEED_KINDS, SEVERITIES, TRIGGER_SOURCES, codeList, triggerSummary, type TriggerSource, type TriggerView } from '@/lib/workflow-triggers';
import { when, type MutationErrors } from '@/lib/workflows';

/**
 * Starting a workflow when something happens. A trigger watches feed events or
 * new data quality failures and starts one run for everything new since it last
 * fired, as the person who saved it. See docs/WORKFLOWS.md.
 */

const TRIGGER_FIELDS = 'id name source match input isActive createdByName busy lastFiredAt lastCount lastJob canManage';
const TRIGGERS_QUERY = `query WorkflowTriggers($workflowId: ID!) { workflowTriggers(workflowId: $workflowId) { ${TRIGGER_FIELDS} } }`;
const SAVE_TRIGGER = `mutation SaveWorkflowTrigger($input: SaveWorkflowTriggerInput!) { saveWorkflowTrigger(input: $input) { trigger { id } errors { message } } }`;
const DELETE_TRIGGER = `mutation DeleteWorkflowTrigger($id: ID!) { deleteWorkflowTrigger(id: $id) { success errors { message } } }`;

interface Draft {
  id: string | null;
  name: string;
  source: TriggerSource;
  kinds: string[];
  statuses: string[];
  attributeCodes: string;
  feedCodes: string;
  severities: string[];
  ruleCodes: string;
  domainCodes: string;
  input: string;
  isActive: boolean;
}

function draftFrom(trigger: TriggerView | null): Draft {
  return {
    id: trigger?.id ?? null,
    name: trigger?.name ?? '',
    source: trigger?.source ?? 'DQ_FAILURES',
    kinds: trigger?.match.kinds ?? [],
    statuses: trigger?.match.statuses ?? [],
    attributeCodes: (trigger?.match.attributeCodes ?? []).join(', '),
    feedCodes: (trigger?.match.feedCodes ?? []).join(', '),
    severities: trigger?.match.severities ?? [],
    ruleCodes: (trigger?.match.ruleCodes ?? []).join(', '),
    domainCodes: (trigger?.match.domainCodes ?? []).join(', '),
    input: JSON.stringify(trigger?.input ?? {}, null, 2),
    isActive: trigger?.isActive ?? true,
  };
}

const box: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: 'var(--surface)', display: 'grid', gap: 10 };
const label: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' };
const hint: CSSProperties = { fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 };
const tick: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 };

interface Props {
  workflowId: string;
  /** Triggers start the published version. */
  published: boolean;
  canManage: boolean;
}

export function WorkflowTriggers({ workflowId, published, canManage }: Props) {
  const [triggers, setTriggers] = useState<TriggerView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ workflowTriggers: TriggerView[] }>(TRIGGERS_QUERY, { workflowId }, 'network-only');
    if (result.aborted) return;
    if (result.error) setMessage(result.error.message || 'The triggers could not be read.');
    else setTriggers(result.data?.workflowTriggers || []);
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    let input: unknown;
    try {
      input = JSON.parse(draft.input || '{}');
    } catch {
      setMessage('What each run starts with must be JSON.');
      return;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      setMessage('What each run starts with must be a JSON object.');
      return;
    }
    const match =
      draft.source === 'FEED'
        ? { kinds: draft.kinds, feedCodes: codeList(draft.feedCodes) }
        : draft.source === 'BREACH'
          ? { statuses: draft.statuses, ruleCodes: codeList(draft.ruleCodes) }
          : draft.source === 'VALUE_CHANGE'
            ? { attributeCodes: codeList(draft.attributeCodes), domainCodes: codeList(draft.domainCodes) }
            : { severities: draft.severities, ruleCodes: codeList(draft.ruleCodes), domainCodes: codeList(draft.domainCodes) };
    setSaving(true);
    setMessage('');
    const { data, error } = await graphqlMutation<{ saveWorkflowTrigger: { errors: MutationErrors } }>(SAVE_TRIGGER, {
      input: { id: draft.id, workflowId, name: draft.name, source: draft.source, match, input, isActive: draft.isActive },
    });
    setSaving(false);
    const problem = error?.message || data?.saveWorkflowTrigger.errors[0]?.message;
    if (problem) {
      setMessage(problem);
      return;
    }
    setDraft(null);
    void load();
  };

  const remove = async (trigger: TriggerView) => {
    if (!window.confirm(`Delete the trigger "${trigger.name}"? Runs it already started are kept.`)) return;
    const { data, error } = await graphqlMutation<{ deleteWorkflowTrigger: { errors: MutationErrors } }>(DELETE_TRIGGER, { id: trigger.id });
    const problem = error?.message || data?.deleteWorkflowTrigger.errors[0]?.message;
    if (problem) setMessage(problem);
    else void load();
  };

  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value));

  return (
    <section style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 8px' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Start automatically</div>
        {canManage && !draft && (
          <button type="button" className="btn btn-sm" onClick={() => { setMessage(''); setDraft(draftFrom(null)); }}>
            Add a trigger
          </button>
        )}
      </div>
      <div style={{ ...hint, marginBottom: 8 }}>
        Starts a run of the published version when a data quality scan finds new failures, a compliance rule is breached, a value changes, or a feed does something. Everything new since the last run goes into one run, which starts as the person who saved the trigger. Except for feeds, the run works on the records that started it.
        {!published && <strong style={{ color: '#b45309' }}> This workflow is not published, so its triggers start nothing yet.</strong>}
      </div>
      {message && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{message}</div>}

      {triggers && triggers.length === 0 && !draft && <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>No triggers.</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {(triggers || []).map((trigger) => (
          <div key={trigger.id} style={{ ...box, gap: 4, opacity: trigger.isActive ? 1 : 0.6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>{trigger.name}</strong>
              {!trigger.isActive && <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Off</span>}
              {trigger.busy && <span style={{ fontSize: 11, color: '#b45309' }}>Run in progress: new events wait for the next one</span>}
              <span style={{ flex: 1 }} />
              {trigger.canManage && (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => { setMessage(''); setDraft(draftFrom(trigger)); }}>Edit</button>
                  <button type="button" className="btn btn-sm" onClick={() => void remove(trigger)}>Delete</button>
                </>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{triggerSummary(trigger)}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              Starts runs as {trigger.createdByName || 'its owner'}
              {trigger.lastFiredAt ? ` · last fired ${when(trigger.lastFiredAt)} for ${trigger.lastCount ?? 0}` : ' · has not fired yet'}
              {trigger.lastJob?.workflowRunId && (
                <>
                  {' · '}
                  <Link href={`/workflows/runs/${trigger.lastJob.workflowRunId}`}>last run</Link>
                </>
              )}
            </div>
            {trigger.lastJob?.status === 'FAILED' && trigger.lastJob.error && (
              <div style={{ fontSize: 12, color: 'var(--red)' }}>The last run could not start: {trigger.lastJob.error}</div>
            )}
          </div>
        ))}
      </div>

      {draft && (
        <div style={{ ...box, marginTop: 8, maxWidth: 560 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={label}>Name</span>
            <input className="text-input" value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Clean up new critical failures" />
          </label>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={label}>Start when</span>
            <div style={{ display: 'grid', gap: 4 }}>
              {TRIGGER_SOURCES.map((source) => (
                <label key={source.code} style={tick}>
                  <input type="radio" checked={draft.source === source.code} onChange={() => set({ source: source.code })} />
                  {source.label}
                </label>
              ))}
            </div>
          </div>

          {draft.source === 'BREACH' && (
            <>
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Breach</span>
                <div style={{ display: 'flex', gap: 12 }}>
                  {BREACH_STATUSES.map((status) => (
                    <label key={status.code} style={tick}>
                      <input type="checkbox" checked={draft.statuses.includes(status.code)} onChange={(event) => set({ statuses: toggle(draft.statuses, status.code, event.target.checked) })} />
                      {status.label}
                    </label>
                  ))}
                </div>
                <span style={hint}>Tick none for either. Only a new breach counts: one where the result before it, for the same rule and record, was not a breach.</span>
              </div>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Rule codes</span>
                <input className="text-input" value={draft.ruleCodes} onChange={(event) => set({ ruleCodes: event.target.value })} placeholder="Blank for every rule" />
              </label>
            </>
          )}
          {draft.source === 'VALUE_CHANGE' && (
            <>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Attributes</span>
                <input className="text-input" value={draft.attributeCodes} onChange={(event) => set({ attributeCodes: event.target.value })} placeholder="NAV, FUND_STATUS" />
                <span style={hint}>Name 1 to 20 attribute codes. A new current value recorded for any of them starts a run.</span>
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Types of record</span>
                <input className="text-input" value={draft.domainCodes} onChange={(event) => set({ domainCodes: event.target.value })} placeholder="Blank for every type, or FUND, POSITION" />
              </label>
            </>
          )}
          {draft.source === 'BREACH' || draft.source === 'VALUE_CHANGE' ? null : draft.source === 'FEED' ? (
            <>
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={label}>The feed</span>
                {FEED_KINDS.map((kind) => (
                  <label key={kind.code} style={tick}>
                    <input type="checkbox" checked={draft.kinds.includes(kind.code)} onChange={(event) => set({ kinds: toggle(draft.kinds, kind.code, event.target.checked) })} />
                    {kind.label}
                  </label>
                ))}
                <span style={hint}>Tick none for any of these.</span>
              </div>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Feed codes</span>
                <input className="text-input" value={draft.feedCodes} onChange={(event) => set({ feedCodes: event.target.value })} placeholder="Blank for every feed" />
              </label>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Severity</span>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {SEVERITIES.map((severity) => (
                    <label key={severity} style={tick}>
                      <input type="checkbox" checked={draft.severities.includes(severity)} onChange={(event) => set({ severities: toggle(draft.severities, severity, event.target.checked) })} />
                      {severity.charAt(0) + severity.slice(1).toLowerCase()}
                    </label>
                  ))}
                </div>
                <span style={hint}>Tick none for any severity. A record that only lost a required value has no rule, so it starts a run only when no severity or rule code is set.</span>
              </div>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Rule codes</span>
                <input className="text-input" value={draft.ruleCodes} onChange={(event) => set({ ruleCodes: event.target.value })} placeholder="Blank for every rule" />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Types of record</span>
                <input className="text-input" value={draft.domainCodes} onChange={(event) => set({ domainCodes: event.target.value })} placeholder="Blank for every type, or FUND, POSITION" />
              </label>
            </>
          )}

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={label}>What each run starts with</span>
            <textarea className="text-input" rows={4} spellCheck={false} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} value={draft.input} onChange={(event) => set({ input: event.target.value })} />
            <span style={hint}>
              The same as a schedule's input, such as {'{ "periodEnd": "" }'}. A run started by anything but a feed is also given the records that started it in filters.entityIds, and steps can read what started it as {'{{input.trigger}}'}.
            </span>
          </label>
          <label style={tick}>
            <input type="checkbox" checked={draft.isActive} onChange={(event) => set({ isActive: event.target.checked })} />
            On. Turning a trigger back on does not act on what arrived while it was off.
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save trigger'}
            </button>
            <button type="button" className="btn btn-sm" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          <span style={hint}>Saving makes you the person its runs start as. You need to be allowed to run workflows.</span>
        </div>
      )}
    </section>
  );
}
