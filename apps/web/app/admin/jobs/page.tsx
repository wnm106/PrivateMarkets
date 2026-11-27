'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery, ME_QUERY } from '@/lib/graphql';
import { codeFromName, describeCron, duration, parsePayload, platformFor, type JobTypeOption } from '@/lib/jobs';
import { useVisiblePolling } from '@/lib/use-visible-polling';

const SCHEDULE_FIELDS = `
  id clientId scheduleCode scheduleName jobType jobTypeLabel payload cronExpression timezone
  isActive maxAttempts nextRunAt lastRunAt lastRunStatus
`;
const RUN_FIELDS = `
  id clientId scheduleId scheduleName jobType jobTypeLabel payload status attempts maxAttempts
  runAfter startedAt finishedAt result errorMessage createdAt
`;

const JOBS_QUERY = `
  query Jobs($status: String) {
    jobTypes { code label description scope payloadExample }
    jobSchedules { ${SCHEDULE_FIELDS} }
    jobRuns(status: $status, first: 100) { ${RUN_FIELDS} }
  }
`;
const SAVE_SCHEDULE = `
  mutation SaveJobSchedule($input: SaveJobScheduleInput!) {
    saveJobSchedule(input: $input) { schedule { id } errors { field message } }
  }
`;
const DELETE_SCHEDULE = `mutation DeleteJobSchedule($id: ID!) { deleteJobSchedule(id: $id) { success errors { message } } }`;
const RUN_NOW = `mutation RunJobScheduleNow($id: ID!) { runJobScheduleNow(id: $id) { run { id } errors { message } } }`;
const RETRY_RUN = `mutation RetryJobRun($id: ID!) { retryJobRun(id: $id) { run { id } errors { message } } }`;
const CANCEL_RUN = `mutation CancelJobRun($id: ID!) { cancelJobRun(id: $id) { run { id } errors { message } } }`;

interface Schedule {
  id: string;
  clientId: string | null;
  scheduleCode: string;
  scheduleName: string;
  jobType: string;
  jobTypeLabel: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  isActive: boolean;
  maxAttempts: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

interface Run {
  id: string;
  clientId: string | null;
  scheduleId: string | null;
  scheduleName: string | null;
  jobType: string;
  jobTypeLabel: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  errorMessage: string | null;
  createdAt: string;
}

interface Draft {
  id: string | null;
  scheduleName: string;
  scheduleCode: string;
  jobType: string;
  cronExpression: string;
  timezone: string;
  payloadText: string;
  maxAttempts: number;
  isActive: boolean;
  platform: boolean;
}

type MutationErrors = Array<{ field?: string | null; message: string }>;

const STATUSES = ['', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
const STATUS_COLOR: Record<string, string> = {
  QUEUED: 'var(--ink-3)',
  RUNNING: 'var(--accent)',
  SUCCEEDED: 'var(--success, #276749)',
  FAILED: 'var(--danger, #9b2c2c)',
  CANCELLED: 'var(--ink-3)',
};

function when(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export default function JobsPage() {
  const [types, setTypes] = useState<JobTypeOption[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState('');
  const [isTenantAdmin, setIsTenantAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  usePublishViewContext({ activity: 'viewing', kind: 'jobs', label: 'Jobs', summary: 'Job schedules and run history' });

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ jobTypes: JobTypeOption[]; jobSchedules: Schedule[]; jobRuns: Run[] }, { status: string | null }>(
      JOBS_QUERY,
      { status: status || null },
      'network-only',
    );
    if (result.aborted) return;
    if (result.error) {
      setMessage(result.error.message);
    } else if (result.data) {
      setTypes(result.data.jobTypes);
      setSchedules(result.data.jobSchedules);
      setRuns(result.data.jobRuns);
      setMessage('');
    }
    setLoading(false);
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    graphqlQuery<{ me: { isTenantAdmin: boolean } | null }, Record<string, never>>(ME_QUERY).then(({ data }) => {
      setIsTenantAdmin(Boolean(data?.me?.isTenantAdmin));
    });
  }, []);

  // Keep the history moving while something is queued or running.
  const open = runs.some((run) => run.status === 'QUEUED' || run.status === 'RUNNING');
  useVisiblePolling(load, 5000, open);

  const typeByCode = useMemo(() => new Map(types.map((type) => [type.code, type])), [types]);
  const draftType = draft ? typeByCode.get(draft.jobType) : undefined;

  const startDraft = (schedule?: Schedule) => {
    setDraftError('');
    if (schedule) {
      setDraft({
        id: schedule.id,
        scheduleName: schedule.scheduleName,
        scheduleCode: schedule.scheduleCode,
        jobType: schedule.jobType,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        payloadText: JSON.stringify(schedule.payload ?? {}, null, 2),
        maxAttempts: schedule.maxAttempts,
        isActive: schedule.isActive,
        platform: schedule.clientId === null,
      });
      return;
    }
    const first = types.find((type) => platformFor(type, isTenantAdmin, false) !== null) || types[0];
    setDraft({
      id: null,
      scheduleName: '',
      scheduleCode: '',
      jobType: first?.code || '',
      cronExpression: '0 6 * * 1-5',
      timezone: localZone(),
      payloadText: JSON.stringify(first?.payloadExample ?? {}, null, 2),
      maxAttempts: 3,
      isActive: true,
      platform: first ? platformFor(first, isTenantAdmin, false) === true : false,
    });
  };

  const save = async () => {
    if (!draft) return;
    const payload = parsePayload(draft.payloadText);
    if (!payload.ok) {
      setDraftError(payload.message);
      return;
    }
    if (!draft.scheduleName.trim()) {
      setDraftError('Give the schedule a name.');
      return;
    }
    setSaving(true);
    setDraftError('');
    const { data, error } = await graphqlMutation<{ saveJobSchedule: { errors: MutationErrors } }>(SAVE_SCHEDULE, {
      input: {
        id: draft.id,
        platform: draft.platform,
        scheduleCode: draft.scheduleCode.trim() || codeFromName(draft.scheduleName),
        scheduleName: draft.scheduleName.trim(),
        jobType: draft.jobType,
        payload: payload.value,
        cronExpression: draft.cronExpression.trim(),
        timezone: draft.timezone.trim() || 'UTC',
        isActive: draft.isActive,
        maxAttempts: draft.maxAttempts,
      },
    });
    setSaving(false);
    const problem = error?.message || data?.saveJobSchedule.errors[0]?.message;
    if (problem) {
      setDraftError(problem);
      return;
    }
    setDraft(null);
    load();
  };

  /** Runs a mutation that returns { errors }, shows the first error, and reloads. */
  const act = async (mutation: string, field: string, id: string) => {
    const { data, error } = await graphqlMutation<Record<string, { errors: MutationErrors }>>(mutation, { id });
    const problem = error?.message || data?.[field]?.errors[0]?.message;
    setMessage(problem || '');
    load();
  };

  const remove = (schedule: Schedule) => {
    if (!window.confirm(`Delete the schedule "${schedule.scheduleName}"? Its past runs stay in the history.`)) return;
    act(DELETE_SCHEDULE, 'deleteJobSchedule', schedule.id);
  };

  const pickType = (code: string) => {
    if (!draft) return;
    const type = typeByCode.get(code);
    const platform = type ? platformFor(type, isTenantAdmin, draft.platform) : draft.platform;
    setDraft({
      ...draft,
      jobType: code,
      platform: platform ?? false,
      payloadText: draft.id ? draft.payloadText : JSON.stringify(type?.payloadExample ?? {}, null, 2),
    });
  };

  let cronHint = '';
  if (draft) {
    try {
      cronHint = describeCron(draft.cronExpression, draft.timezone);
    } catch (error) {
      cronHint = error instanceof Error ? error.message : 'The schedule is not valid.';
    }
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Jobs</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Jobs</div>
            <div className="page-meta">
              Work that runs on a schedule without anyone signed in. A worker process picks up each run, retries a failure with a growing wait, and records the outcome here.
            </div>
          </div>
        </div>
        <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => startDraft()} disabled={types.length === 0}>
          New schedule
        </button>
      </div>

      {message && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)', margin: '12px 0' }}>{message}</div>}
      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading jobs…</div>}

      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          style={{ margin: '16px 0', padding: 16, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, display: 'grid', gap: 12, maxWidth: 760 }}
        >
          <div style={{ fontWeight: 600 }}>{draft.id ? 'Edit schedule' : 'New schedule'}</div>
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Name</span>
              <input
                className="text-input"
                value={draft.scheduleName}
                onChange={(event) => setDraft({ ...draft, scheduleName: event.target.value })}
                placeholder="Morning compliance check"
                autoFocus
              />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Job</span>
              <select className="text-input" value={draft.jobType} onChange={(event) => pickType(event.target.value)}>
                {types.map((type) => (
                  <option key={type.code} value={type.code} disabled={platformFor(type, isTenantAdmin, draft.platform) === null}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {draftType && <div style={hint}>{draftType.description}</div>}
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Schedule (minute hour day month weekday)</span>
              <input
                className="text-input"
                value={draft.cronExpression}
                onChange={(event) => setDraft({ ...draft, cronExpression: event.target.value })}
                style={{ fontFamily: 'var(--font-mono, monospace)' }}
                spellCheck={false}
              />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Time zone</span>
              <input
                className="text-input"
                value={draft.timezone}
                onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
                placeholder="America/New_York"
                spellCheck={false}
              />
            </label>
          </div>
          <div style={hint}>{cronHint}</div>
          <label style={field}>
            <span style={fieldLabel}>Settings (JSON)</span>
            <textarea
              className="text-input"
              value={draft.payloadText}
              onChange={(event) => setDraft({ ...draft, payloadText: event.target.value })}
              rows={4}
              style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
              spellCheck={false}
            />
          </label>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={fieldLabel}>Attempts</span>
              <input
                className="text-input"
                type="number"
                min={1}
                max={10}
                value={draft.maxAttempts}
                onChange={(event) => setDraft({ ...draft, maxAttempts: Number(event.target.value) || 1 })}
                style={{ width: 72 }}
              />
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
              Active
            </label>
            {isTenantAdmin && !draft.id && draftType?.scope === 'ANY' && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={draft.platform} onChange={(event) => setDraft({ ...draft, platform: event.target.checked })} />
                Platform schedule (not tied to a client)
              </label>
            )}
          </div>
          {draftError && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)' }}>{draftError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save schedule'}</button>
            <button type="button" className="btn" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      <h2 style={sectionTitle}>Schedules</h2>
      {!loading && schedules.length === 0 && (
        <div style={{ color: 'var(--ink-3)' }}>No schedules yet. Add one to run a job on a timetable.</div>
      )}
      {schedules.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Name</th>
                <th style={cell}>Job</th>
                <th style={cell}>Schedule</th>
                <th style={cell}>Next run</th>
                <th style={cell}>Last run</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id} style={bodyRow}>
                  <td style={{ ...cell, fontWeight: 500 }}>
                    {schedule.scheduleName}
                    <div style={hint}>{schedule.clientId ? schedule.scheduleCode : `${schedule.scheduleCode} · platform`}</div>
                  </td>
                  <td style={cell}>{schedule.jobTypeLabel}</td>
                  <td style={cell}>
                    <code>{schedule.cronExpression}</code>
                    <div style={hint}>{schedule.timezone}</div>
                  </td>
                  <td style={cell}>{schedule.isActive ? when(schedule.nextRunAt) || 'Within a minute' : 'Paused'}</td>
                  <td style={cell}>
                    {schedule.lastRunAt ? when(schedule.lastRunAt) : 'Never'}
                    {schedule.lastRunStatus && (
                      <div style={{ ...hint, color: STATUS_COLOR[schedule.lastRunStatus] }}>{schedule.lastRunStatus.toLowerCase()}</div>
                    )}
                  </td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" className="btn" onClick={() => act(RUN_NOW, 'runJobScheduleNow', schedule.id)}>Run now</button>{' '}
                    <button type="button" className="btn" onClick={() => startDraft(schedule)}>Edit</button>{' '}
                    <button type="button" className="btn" onClick={() => remove(schedule)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 28 }}>
        <h2 style={{ ...sectionTitle, margin: 0 }}>Run history</h2>
        <select className="text-input" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter runs by status">
          {STATUSES.map((value) => (
            <option key={value || 'all'} value={value}>{value ? value.charAt(0) + value.slice(1).toLowerCase() : 'All statuses'}</option>
          ))}
        </select>
        <button type="button" className="btn" onClick={load}>Refresh</button>
      </div>
      {!loading && runs.length === 0 && <div style={{ color: 'var(--ink-3)', marginTop: 12 }}>No runs to show.</div>}
      {runs.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={{ width: 28 }} />
                <th style={cell}>Queued</th>
                <th style={cell}>Job</th>
                <th style={cell}>Status</th>
                <th style={cell}>Attempts</th>
                <th style={cell}>Took</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const isOpen = expanded === run.id;
                return (
                  <Fragment key={run.id}>
                    <tr style={{ ...bodyRow, cursor: 'pointer' }} onClick={() => setExpanded(isOpen ? null : run.id)} aria-expanded={isOpen}>
                      <td style={{ ...cell, color: 'var(--ink-3)' }}>{isOpen ? '▾' : '▸'}</td>
                      <td style={cell}>{when(run.createdAt)}</td>
                      <td style={cell}>
                        {run.jobTypeLabel}
                        <div style={hint}>{run.scheduleName || 'Run on request'}</div>
                      </td>
                      <td style={{ ...cell, color: STATUS_COLOR[run.status], fontWeight: 500 }}>
                        {run.status.charAt(0) + run.status.slice(1).toLowerCase()}
                        {run.status === 'QUEUED' && run.attempts > 0 && <div style={hint}>Retry at {when(run.runAfter)}</div>}
                      </td>
                      <td style={cell}>{run.attempts} of {run.maxAttempts}</td>
                      <td style={cell}>{duration(run.startedAt, run.finishedAt)}</td>
                      <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }} onClick={(event) => event.stopPropagation()}>
                        {(run.status === 'FAILED' || run.status === 'CANCELLED') && (
                          <button type="button" className="btn" onClick={() => act(RETRY_RUN, 'retryJobRun', run.id)}>Retry</button>
                        )}
                        {run.status === 'QUEUED' && (
                          <button type="button" className="btn" onClick={() => act(CANCEL_RUN, 'cancelJobRun', run.id)}>Cancel</button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={6} style={{ padding: '4px 8px 16px' }}>
                          {run.errorMessage && <p style={{ margin: '0 0 10px', color: 'var(--danger, #9b2c2c)' }}>{run.errorMessage}</p>}
                          <div style={hint}>Settings</div>
                          <pre style={pre}>{JSON.stringify(run.payload ?? {}, null, 2)}</pre>
                          {run.result != null && (
                            <>
                              <div style={{ ...hint, marginTop: 8 }}>Result</div>
                              <pre style={pre}>{JSON.stringify(run.result, null, 2)}</pre>
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: '8px 8px', verticalAlign: 'top' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const headRow: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
const bodyRow: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)' };
const hint: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12 };
const sectionTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: '24px 0 10px' };
const formRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };
const field: React.CSSProperties = { display: 'grid', gap: 4 };
const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--ink-2)' };
const pre: React.CSSProperties = { margin: '4px 0 0', padding: 12, background: 'var(--bg-alt)', borderRadius: 8, overflow: 'auto', fontSize: 12 };
