'use client';

import { useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { usePublishTabs, usePublishViewContext, type TabPayload } from '@/lib/view-context';
import { formatTokens, formatUsd } from '@tapestrai/mcp-server/src/agent/pricing';

/**
 * Token use of every model call, for the clients this session can see.
 * Days are America/New_York, the same zone the usage function groups by.
 */

type Tab = 'overview' | 'turns' | 'conversations' | 'subjects' | 'agents' | 'features' | 'users' | 'models' | 'calls';

interface Bucket {
  key: string;
  feature?: string;
  provider?: string;
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  totalTokens: number;
  costUsd: number;
}

interface UserBucket {
  userId: string | null;
  label: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

interface DayBucket {
  day: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

/** One request: a chat reply, a narrative section, a workflow step. Its calls added up. */
interface TurnRow {
  key: string;
  startedAt: string;
  endedAt: string;
  userLabel: string;
  clientName: string | null;
  feature: string;
  activity: string;
  agent: string | null;
  conversationId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  models: string[];
  calls: number;
  totalTokens: number;
  thinkingTokens: number;
  costUsd: number;
  latencyMs: number;
  errors: number;
}

interface ConversationRow {
  key: string;
  title: string | null;
  userLabel: string;
  startedAt: string;
  lastAt: string;
  calls: number;
  turns: number;
  totalTokens: number;
  costUsd: number;
}

interface SubjectRow {
  type: string;
  key: string;
  label: string | null;
  feature: string;
  startedAt: string;
  lastAt: string;
  calls: number;
  turns: number;
  totalTokens: number;
  costUsd: number;
}

/** Narrows the page to one turn, conversation or subject. */
type Drill =
  | { kind: 'turn'; id: string; label: string }
  | { kind: 'conversation'; id: string; label: string }
  | { kind: 'subject'; type: string; id: string; label: string };

const SUBJECT_NAMES: Record<string, string> = {
  document: 'Document',
  'narrative-run': 'Narrative run',
  narrative: 'Narrative',
  'workflow-run': 'Workflow run',
  feed: 'Feed',
  fund: 'Fund',
  file: 'File',
};

function subjectName(type: string | null): string {
  if (!type) return '';
  return SUBJECT_NAMES[type] ?? type;
}

interface CallRow {
  id: string;
  turnId: string;
  conversationId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  createdAt: string;
  clientName: string | null;
  userLabel: string;
  feature: string;
  activity: string;
  agent: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  costUsd: number;
  status: string;
  error: string | null;
  latencyMs: number | null;
  hasThinking: boolean;
  thinkingPreview: string | null;
}

interface Usage {
  from: string;
  to: string;
  totals: { calls: number; turns: number; inputTokens: number; outputTokens: number; thinkingTokens: number; totalTokens: number; costUsd: number; errors: number };
  facets: { features: string[]; agents: string[]; models: string[]; users: Array<{ id: string | null; label: string }> };
  byFeature: Bucket[];
  byAgent: Bucket[];
  byUser: UserBucket[];
  byModel: Bucket[];
  byDay: DayBucket[];
  byTurn: TurnRow[];
  byConversation: ConversationRow[];
  bySubject: SubjectRow[];
  calls: CallRow[];
}

interface CallDetail extends CallRow {
  thinking: string | null;
  priceInputPerMillion: number | null;
  priceOutputPerMillion: number | null;
  cachedInputTokens: number;
}

const QUERY = `query AgentUsage($days: Int, $from: String, $to: String, $feature: String, $agent: String, $userId: ID, $model: String, $turnId: String, $conversationId: String, $subjectType: String, $subjectId: String) {
  agentUsage(days: $days, from: $from, to: $to, feature: $feature, agent: $agent, userId: $userId, model: $model, turnId: $turnId, conversationId: $conversationId, subjectType: $subjectType, subjectId: $subjectId)
}`;
const CALL_QUERY = `query AgentCall($id: ID!) { agentCall(id: $id) }`;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'turns', label: 'Turns' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'subjects', label: 'Subjects' },
  { id: 'agents', label: 'Agents' },
  { id: 'features', label: 'Features' },
  { id: 'users', label: 'Users' },
  { id: 'models', label: 'Models' },
  { id: 'calls', label: 'Calls' },
];

/** Midnight in New York for a calendar date, as UTC. */
function nyMidnight(date: string): string {
  const utc = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utc);
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
  const wall = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return new Date(utc.getTime() - (wall - utc.getTime())).toISOString();
}

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** What each tab tells the assistant, from the one load that feeds them all. Costs are US dollars. */
/** Every tab, loaded or not: a tab whose usage has not loaded publishes data: null. */
function usageTabs(usage: Usage | null, drill: Drill | null): Record<string, TabPayload> {
  const bucket = (row: Bucket) => ({ name: row.key, feature: row.feature || null, provider: row.provider || null, calls: row.calls, inputTokens: row.inputTokens ?? null, outputTokens: row.outputTokens ?? null, thinkingTokens: row.thinkingTokens ?? null, totalTokens: row.totalTokens, costUsd: row.costUsd });
  const period = !usage ? '' : drill ? `${usage.from} to ${usage.to}, narrowed to ${drill.kind} ${drill.label}` : `${usage.from} to ${usage.to}`;
  return {
    overview: {
      label: 'Overview',
      purpose: 'How many model calls were made in the period, how many tokens they used and what they cost, day by day.',
      howToRead: 'Days are in America/New_York. thinkingTokens are the model\'s reasoning tokens and are counted in totalTokens. errors counts failed calls.',
      data: !usage ? null : { period, totals: usage.totals, byDay: usage.byDay },
    },
    turns: {
      label: 'Turns',
      purpose: 'Each request added up: one chat reply, narrative section or workflow step, with all the model calls it made, newest first.',
      howToRead: 'calls is how many model calls the turn made. A chat reply that used tools makes one call per tool round. costUsd and totalTokens are the sum of those calls. latencyMs is time spent in model calls, not wall time.',
      data: !usage ? null : {
        period, total: usage.totals.turns, shown: Math.min(usage.byTurn.length, 60),
        turns: usage.byTurn.slice(0, 60).map((row) => ({ at: row.startedAt, user: row.userLabel, feature: row.feature, activity: row.activity, agent: row.agent, subject: row.subjectType ? `${subjectName(row.subjectType)}: ${row.subjectLabel || row.subjectId}` : null, conversationId: row.conversationId, models: row.models, calls: row.calls, totalTokens: row.totalTokens, costUsd: row.costUsd, latencyMs: row.latencyMs, errors: row.errors })),
      },
    },
    conversations: {
      label: 'Conversations',
      purpose: 'Cost of each chat conversation: how many replies (turns) and model calls it took, most recent first.',
      data: !usage ? null : { period, conversations: usage.byConversation.map((row) => ({ title: row.title, user: row.userLabel, lastAt: row.lastAt, turns: row.turns, calls: row.calls, totalTokens: row.totalTokens, costUsd: row.costUsd })) },
    },
    subjects: {
      label: 'Subjects',
      purpose: 'Cost by what the work was about: a document, narrative run, workflow run, feed, fund or file, costliest first.',
      howToRead: 'Only calls that name a subject appear here. Chat turns are under Conversations instead.',
      data: !usage ? null : { period, subjects: usage.bySubject.map((row) => ({ type: subjectName(row.type), name: row.label || row.key, feature: row.feature, turns: row.turns, calls: row.calls, totalTokens: row.totalTokens, costUsd: row.costUsd })) },
    },
    agents: {
      label: 'Agents',
      purpose: 'Token use and cost by named agent.',
      data: !usage ? null : { period, agents: usage.byAgent.map(bucket) },
    },
    features: {
      label: 'Features',
      purpose: 'Token use and cost by the feature of the app that made the call, such as the chat or a narrative.',
      data: !usage ? null : { period, features: usage.byFeature.map(bucket) },
    },
    users: {
      label: 'Users',
      purpose: 'Token use and cost by person.',
      data: !usage ? null : { period, users: usage.byUser.map((row) => ({ name: row.label, calls: row.calls, totalTokens: row.totalTokens, costUsd: row.costUsd })) },
    },
    models: {
      label: 'Models',
      purpose: 'Token use and cost by model, with each model\'s input, output and thinking tokens.',
      data: !usage ? null : { period, models: usage.byModel.map(bucket) },
    },
    calls: {
      label: 'Calls',
      purpose: 'The individual model calls, newest first: who made each, which model, tokens, cost, time taken and whether it failed.',
      howToRead: 'status is the call\'s outcome and error says why it failed. latencyMs is the time the call took.',
      data: !usage ? null : {
        period, total: usage.totals.calls, shown: Math.min(usage.calls.length, 60),
        calls: usage.calls.slice(0, 60).map((call) => ({ at: call.createdAt, turnId: call.turnId, user: call.userLabel, client: call.clientName, feature: call.feature, activity: call.activity, agent: call.agent, model: call.model, totalTokens: call.totalTokens, costUsd: call.costUsd, status: call.status, error: call.error, latencyMs: call.latencyMs })),
      },
    },
  };
}

export default function AgentUsagePage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(30);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [feature, setFeature] = useState('');
  const [agent, setAgent] = useState('');
  const [userId, setUserId] = useState('');
  const [model, setModel] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<CallDetail | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  usePublishViewContext({ activity: 'viewing', kind: 'agent usage', label: 'Agent usage', summary: 'Token use and cost of model calls' });
  usePublishTabs(usageTabs(usage, drill));

  /** Narrows to one turn, conversation or subject and shows what it is made of. */
  const narrow = (next: Drill) => {
    setDrill(next);
    setSelected(null);
    setTab(next.kind === 'turn' ? 'calls' : 'turns');
  };

  useEffect(() => {
    let live = true;
    setUsage(null);
    setMessage('');
    const ranged = Boolean(fromDate && toDate);
    const variables = {
      days: ranged ? null : days,
      from: ranged ? nyMidnight(fromDate) : null,
      to: ranged ? nyMidnight(nextDay(toDate)) : null,
      feature: feature || null,
      agent: agent || null,
      userId: userId || null,
      model: model || null,
      turnId: drill?.kind === 'turn' ? drill.id : null,
      conversationId: drill?.kind === 'conversation' ? drill.id : null,
      subjectType: drill?.kind === 'subject' ? drill.type : null,
      subjectId: drill?.kind === 'subject' ? drill.id : null,
    };
    void graphqlQuery<{ agentUsage: Usage }>(QUERY, variables, 'network-only').then((result) => {
      if (!live || result.aborted) return;
      if (result.error) setMessage(result.error.message);
      else setUsage(result.data?.agentUsage ?? null);
    });
    return () => {
      live = false;
    };
  }, [days, fromDate, toDate, feature, agent, userId, model, drill]);

  const openCall = (id: string) => {
    setSelected(null);
    void graphqlQuery<{ agentCall: CallDetail | null }>(CALL_QUERY, { id }, 'network-only').then((result) => {
      if (result.data?.agentCall) setSelected(result.data.agentCall);
    });
  };

  const totals = usage?.totals;
  const peak = Math.max(1, ...(usage?.byDay.map((day) => day.costUsd) ?? [1]));

  return (
    <div className="da view-fade">
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Audit</span>
          <h1>Agent usage</h1>
          <p>Every model call, with who asked, which feature, the tokens, the cost, and the thinking.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Cost</span><strong>{totals ? formatUsd(totals.costUsd) : '—'}</strong></div>
          <div className="da-fact"><span>Tokens</span><strong>{totals ? formatTokens(totals.totalTokens) : '—'}</strong></div>
          <div className="da-fact"><span>Turns</span><strong>{totals ? formatTokens(totals.turns ?? 0) : '—'}</strong></div>
          <div className="da-fact"><span>Calls</span><strong>{totals ? formatTokens(totals.calls) : '—'}</strong></div>
          <div className="da-fact"><span>Failed</span><strong>{totals ? formatTokens(totals.errors) : '—'}</strong></div>
        </div>
      </header>

      <div className="da-sec">
        <div className="da-sechead">
          <div>
            <h2>Period</h2>
            <p>Dates are America/New_York. Leave the dates empty to use the rolling window.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select className="text-input" aria-label="Window" value={days} onChange={(event) => setDays(Number(event.target.value))} style={{ padding: '7px 8px', fontSize: 12 }}>
              {[7, 30, 90, 365].map((value) => (
                <option key={value} value={value}>Last {value} days</option>
              ))}
            </select>
            <input className="text-input" type="date" aria-label="From" value={fromDate} onChange={(event) => setFromDate(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }} />
            <input className="text-input" type="date" aria-label="To" value={toDate} onChange={(event) => setToDate(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }} />
            <select className="text-input" aria-label="Feature" value={feature} onChange={(event) => setFeature(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }}>
              <option value="">All features</option>
              {(usage?.facets.features ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select className="text-input" aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }}>
              <option value="">All agents</option>
              {(usage?.facets.agents ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select className="text-input" aria-label="User" value={userId} onChange={(event) => setUserId(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }}>
              <option value="">All users</option>
              {(usage?.facets.users ?? []).filter((user) => user.id).map((user) => <option key={user.id!} value={user.id!}>{user.label}</option>)}
            </select>
            <select className="text-input" aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }}>
              <option value="">All models</option>
              {(usage?.facets.models ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        </div>

        {drill && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', fontSize: 13 }}>
            <span className="da-chip">{drill.kind === 'subject' ? subjectName(drill.type) : drill.kind === 'turn' ? 'Turn' : 'Conversation'}</span>
            <span>{drill.label}</span>
            <button type="button" className="btn" onClick={() => setDrill(null)} style={{ fontSize: 12 }}>Show all</button>
          </div>
        )}
        {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0' }}>{message}</div>}
        {!usage && !message && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Reading usage…</div>}

        {usage && (
          <>
            <div className="da-tabs" role="tablist">
              {TABS.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'on' : ''} onClick={() => setTab(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <div className="da-sec">
                <div className="da-facts" style={{ marginBottom: 16 }}>
                  <div className="da-fact"><span>Input tokens</span><strong>{formatTokens(totals?.inputTokens ?? 0)}</strong></div>
                  <div className="da-fact"><span>Output tokens</span><strong>{formatTokens(totals?.outputTokens ?? 0)}</strong></div>
                  <div className="da-fact"><span>Thinking tokens</span><strong>{formatTokens(totals?.thinkingTokens ?? 0)}</strong></div>
                </div>
                {usage.byDay.length === 0 ? (
                  <div style={{ padding: 16, border: '1px dashed var(--line-strong)', borderRadius: 8, color: 'var(--ink-3)', fontSize: 13 }}>No model calls in this period.</div>
                ) : (
                  <div aria-label="Cost by day" style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
                    {usage.byDay.map((day) => (
                      <div key={day.day}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                          <span>{day.day}</span>
                          <span>{formatTokens(day.calls)} calls · {formatUsd(day.costUsd)}</span>
                        </div>
                        <div className="da-bar"><i style={{ width: `${Math.max(2, (100 * day.costUsd) / peak)}%` }} /></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'turns' && (
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr>
                      <th>When</th><th>User</th><th>Feature</th><th>About</th>
                      <th className="num">Calls</th><th className="num">Tokens</th><th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byTurn.length === 0 && <tr><td colSpan={7}>No turns.</td></tr>}
                    {usage.byTurn.map((row) => (
                      <tr
                        key={row.key}
                        onClick={() => narrow({ kind: 'turn', id: row.key, label: `${row.activity} · ${when(row.startedAt)}` })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            narrow({ kind: 'turn', id: row.key, label: `${row.activity} · ${when(row.startedAt)}` });
                          }
                        }}
                        tabIndex={0}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>{when(row.startedAt)}{row.errors > 0 ? <small>{row.errors} failed</small> : null}</td>
                        <td>{row.userLabel}<small>{row.clientName || ''}</small></td>
                        <td>{row.feature}<small>{row.agent ? `${row.activity} · ${row.agent}` : row.activity}</small></td>
                        <td>{row.subjectType ? <>{row.subjectLabel || row.subjectId}<small>{subjectName(row.subjectType)}</small></> : row.conversationId ? <>Chat<small>Conversation</small></> : '—'}</td>
                        <td className="num">{formatTokens(row.calls)}<small>{row.models.join(', ')}</small></td>
                        <td className="num">{formatTokens(row.totalTokens)}</td>
                        <td className="num">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'conversations' && (
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr><th>Conversation</th><th>User</th><th>Last</th><th className="num">Turns</th><th className="num">Calls</th><th className="num">Tokens</th><th className="num">Cost</th></tr>
                  </thead>
                  <tbody>
                    {usage.byConversation.length === 0 && <tr><td colSpan={7}>No chat conversations in this period.</td></tr>}
                    {usage.byConversation.map((row) => (
                      <tr
                        key={row.key}
                        onClick={() => narrow({ kind: 'conversation', id: row.key, label: row.title || 'Untitled chat' })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            narrow({ kind: 'conversation', id: row.key, label: row.title || 'Untitled chat' });
                          }
                        }}
                        tabIndex={0}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>{row.title || 'Untitled chat'}</td>
                        <td>{row.userLabel}</td>
                        <td>{when(row.lastAt)}</td>
                        <td className="num">{formatTokens(row.turns)}</td>
                        <td className="num">{formatTokens(row.calls)}</td>
                        <td className="num">{formatTokens(row.totalTokens)}</td>
                        <td className="num">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'subjects' && (
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr><th>Subject</th><th>Feature</th><th>Last</th><th className="num">Turns</th><th className="num">Calls</th><th className="num">Tokens</th><th className="num">Cost</th></tr>
                  </thead>
                  <tbody>
                    {usage.bySubject.length === 0 && <tr><td colSpan={7}>No calls named a subject in this period.</td></tr>}
                    {usage.bySubject.map((row) => (
                      <tr
                        key={`${row.type}:${row.key}`}
                        onClick={() => narrow({ kind: 'subject', type: row.type, id: row.key, label: row.label || row.key })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            narrow({ kind: 'subject', type: row.type, id: row.key, label: row.label || row.key });
                          }
                        }}
                        tabIndex={0}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>{row.label || row.key}<small>{subjectName(row.type)}</small></td>
                        <td>{row.feature}</td>
                        <td>{when(row.lastAt)}</td>
                        <td className="num">{formatTokens(row.turns)}</td>
                        <td className="num">{formatTokens(row.calls)}</td>
                        <td className="num">{formatTokens(row.totalTokens)}</td>
                        <td className="num">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'agents' && <BucketTable rows={usage.byAgent} name="Agent" />}
            {tab === 'features' && <BucketTable rows={usage.byFeature} name="Feature" />}
            {tab === 'users' && (
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr><th>User</th><th className="num">Calls</th><th className="num">Tokens</th><th className="num">Cost</th></tr>
                  </thead>
                  <tbody>
                    {usage.byUser.length === 0 && <tr><td colSpan={4}>No calls.</td></tr>}
                    {usage.byUser.map((row) => (
                      <tr key={row.userId ?? 'system'}>
                        <td>{row.label}</td>
                        <td className="num">{formatTokens(row.calls)}</td>
                        <td className="num">{formatTokens(row.totalTokens)}</td>
                        <td className="num">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'models' && <BucketTable rows={usage.byModel} name="Model" showSplit />}
            {tab === 'calls' && (
              <div className="da-main" style={{ display: 'grid', gridTemplateColumns: selected ? 'minmax(0, 1.4fr) minmax(280px, 0.8fr)' : '1fr', gap: 16 }}>
                <div className="da-gridwrap">
                  <table className="da-grid">
                    <thead>
                      <tr>
                        <th>When</th><th>User</th><th>Feature</th><th>Agent</th><th>Model</th>
                        <th className="num">Tokens</th><th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.calls.length === 0 && <tr><td colSpan={7}>No calls.</td></tr>}
                      {usage.calls.map((row) => (
                        <tr
                          key={row.id}
                          className={selected?.id === row.id ? 'sel' : ''}
                          onClick={() => openCall(row.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              openCall(row.id);
                            }
                          }}
                          tabIndex={0}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>{when(row.createdAt)}{row.status === 'error' ? <small>Failed</small> : null}</td>
                          <td>{row.userLabel}<small>{row.clientName || ''}</small></td>
                          <td>{row.feature}<small>{row.activity}</small></td>
                          <td>{row.agent || '—'}</td>
                          <td>{row.model}<small>{row.provider}</small></td>
                          <td className="num">{formatTokens(row.totalTokens)}<small>{formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out</small></td>
                          <td className="num">{formatUsd(row.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {selected && (
                  <aside className="da-panel">
                    <div className="da-big">{formatUsd(selected.costUsd)}</div>
                    <p>{selected.model} · {formatTokens(selected.totalTokens)} tokens · {selected.latencyMs ?? '—'} ms</p>
                    <p>{selected.userLabel} · {selected.feature}{selected.agent ? ` · ${selected.agent}` : ''}</p>
                    {selected.subjectType && <p>{subjectName(selected.subjectType)}: {selected.subjectLabel || selected.subjectId}</p>}
                    {drill?.kind !== 'turn' && selected.turnId && (
                      <button type="button" className="btn" style={{ fontSize: 12 }} onClick={() => narrow({ kind: 'turn', id: selected.turnId, label: `${selected.activity} · ${when(selected.createdAt)}` })}>
                        Show every call in this turn
                      </button>
                    )}
                    {selected.error && <p style={{ color: 'var(--red)' }}>{selected.error}</p>}
                    <h3 style={{ fontSize: 14, margin: '12px 0 6px' }}>Thinking</h3>
                    {selected.thinking ? (
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.45, margin: 0 }}>{selected.thinking}</pre>
                    ) : (
                      <p>This call did not record thinking.</p>
                    )}
                  </aside>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BucketTable({ rows, name, showSplit = false }: { rows: Bucket[]; name: string; showSplit?: boolean }) {
  return (
    <div className="da-gridwrap">
      <table className="da-grid">
        <thead>
          <tr>
            <th>{name}</th>
            <th className="num">Calls</th>
            {showSplit && <th className="num">Input</th>}
            {showSplit && <th className="num">Output</th>}
            {showSplit && <th className="num">Thinking</th>}
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={showSplit ? 7 : 4}>No calls.</td></tr>}
          {rows.map((row) => (
            <tr key={`${row.feature || ''}:${row.key}`}>
              <td>{row.key}{row.feature ? <small>{row.feature}</small> : null}{row.provider ? <small>{row.provider}</small> : null}</td>
              <td className="num">{formatTokens(row.calls)}</td>
              {showSplit && <td className="num">{formatTokens(row.inputTokens ?? 0)}</td>}
              {showSplit && <td className="num">{formatTokens(row.outputTokens ?? 0)}</td>}
              {showSplit && <td className="num">{formatTokens(row.thinkingTokens ?? 0)}</td>}
              <td className="num">{formatTokens(row.totalTokens)}</td>
              <td className="num">{formatUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
