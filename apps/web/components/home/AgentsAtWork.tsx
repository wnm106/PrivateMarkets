'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { relativeTime } from '@/lib/home';

/**
 * The workflow runs in flight and which agent is behind each, then the runs
 * that finished in the last day with what each produced, then the standing of
 * every agent. A finished run stays here so a request that was handed off
 * has somewhere to come back to. The board refreshes on its own while anything
 * is running, and when `refreshKey` changes (a run was just started). With
 * `mine`, only runs the person started or that touch their universe.
 */

interface AgentWork {
  runId: string;
  workflowName: string;
  state: 'working' | 'queued' | 'waiting';
  agentCode: string | null;
  agentName: string | null;
  stepLabel: string;
  detail: string;
  percent: number;
  stepsDone: number;
  stepsTotal: number;
  startedAt: string | null;
}

interface AgentStatus {
  code: string;
  name: string;
  description: string | null;
  state: 'working' | 'queued' | 'waiting' | 'idle';
  runs: number;
}

interface FinishedWork {
  runId: string;
  workflowName: string;
  outcome: 'done' | 'failed';
  request: string | null;
  agentName: string | null;
  result: string;
  changes: string | null;
  finishedAt: string | null;
}

export interface Board {
  agents: AgentStatus[];
  work: AgentWork[];
  finished: FinishedWork[];
  /** Runs moving or queued. */
  running: number;
  /** Runs paused on a person. */
  waiting: number;
}

const QUERY = `
  query HomeAgentsAtWork($mine: Boolean) {
    agentsAtWork(mine: $mine) {
      running waiting
      agents { code name description state runs }
      work { runId workflowName state agentCode agentName stepLabel detail percent stepsDone stepsTotal startedAt }
      finished { runId workflowName outcome request agentName result changes finishedAt }
    }
  }
`;

const REFRESH_MS = 15_000;

const STATE_LABEL: Record<AgentStatus['state'], string> = { working: 'working', queued: 'queued', waiting: 'waiting on you', idle: 'idle' };

/** Loads the board, and asks again while anything is moving or when a run was just started. */
export function useAgentsBoard(refreshKey = 0, mine = false): { board: Board | null; problem: string } {
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState('');
  const active = (board?.running ?? 0) > 0;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      graphqlQuery<{ agentsAtWork: Board }>(QUERY, { mine }, 'network-only').then((result) => {
        if (cancelled) return;
        if (result.error || !result.data) setProblem(result.error?.message || 'The agents could not be loaded.');
        else {
          setProblem('');
          // A page left open across an update can hold an answer from before this list existed.
          setBoard({ ...result.data.agentsAtWork, finished: result.data.agentsAtWork.finished || [] });
        }
      });
    void load();
    // Only a run that is moving is worth asking about again.
    const timer = active ? window.setInterval(load, REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [active, refreshKey, mine]);

  return { board, problem };
}

/** The opening of a result as plain text, for a one-glance preview. The run holds the whole of it. */
function preview(result: string): string {
  const plain = result
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 220 ? `${plain.slice(0, 217).trimEnd()}…` : plain;
}

const SHOWN = 3;

/** The server says so in the result when a workflow had no agent to write one. */
function wroteAnswer(item: FinishedWork): boolean {
  return Boolean(item.result.trim()) && !/has no agent step/i.test(item.result);
}

/**
 * Finished runs with the newest of each kind first. Runs of the same workflow
 * that nobody asked anything of (a scheduled intake, say) read as one line.
 */
function collapseFinished(finished: readonly FinishedWork[]): Array<FinishedWork & { times: number }> {
  const out: Array<FinishedWork & { times: number }> = [];
  for (const item of finished) {
    const same = !item.request ? out.find((entry) => !entry.request && entry.workflowName === item.workflowName && entry.outcome === item.outcome) : undefined;
    if (same) same.times += 1;
    else out.push({ ...item, times: 1 });
  }
  return out;
}

export function AgentsAtWork({ board, problem, mine = false }: { board: Board | null; problem: string; mine?: boolean }) {
  if (!board) return <div className="home-empty">{problem || 'Checking what the agents are doing…'}</div>;

  const work = board.work.slice(0, SHOWN);
  const collapsed = collapseFinished(board.finished);
  const finished = collapsed.slice(0, SHOWN);
  const moreWork = board.work.length - work.length;

  return (
    <div className="hx-agents">
      {board.agents.length > 0 && (
        <ul className="hx-roster" aria-label="Your agents">
          {board.agents.map((agent) => (
            <li key={agent.code} className={`hx-roster-chip state-${agent.state}`} title={agent.description || undefined}>
              <span className="hx-dot" aria-hidden />
              <span>{agent.name}</span>
              <span className="hx-roster-state">{STATE_LABEL[agent.state]}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="hx-agents-block">
        <div className="hx-block-title">In progress</div>
        {work.length === 0 ? (
          <p className="hx-quiet">{mine ? 'Nothing is running on your records.' : 'Nothing is running. Hand off a task above, or start a workflow.'}</p>
        ) : (
          <ul className="hx-work">
            {work.map((item) => (
              <li key={item.runId} className={`hx-work-item state-${item.state}`}>
                <div className="hx-work-head">
                  <Link href={`/workflows/runs/${item.runId}`} className="hx-work-title">{item.workflowName}</Link>
                  <span className={`hx-work-state state-${item.state}`}>
                    {item.state === 'waiting' ? 'Needs review' : item.state === 'queued' ? 'Queued' : `${item.percent}%`}
                  </span>
                </div>
                <div
                  className="hx-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.percent}
                  aria-label={`${item.workflowName}: step ${Math.min(item.stepsDone + 1, item.stepsTotal)} of ${item.stepsTotal}`}
                >
                  <span style={{ width: `${Math.max(item.percent, 4)}%` }} />
                </div>
                <div className="hx-work-detail">
                  {item.agentName ? `${item.agentName} · ` : ''}
                  {item.stepLabel}
                  {item.startedAt ? ` · started ${relativeTime(item.startedAt)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
        {moreWork > 0 && <Link href="/workflows" className="hx-more">{moreWork} more in progress →</Link>}
      </div>

      {finished.length > 0 && (
        <div className="hx-agents-block">
          <div className="hx-block-title">Finished in the last day</div>
          <ul className="hx-work">
            {finished.map((item) => (
              <li key={item.runId} className={`hx-finished outcome-${item.outcome}`}>
                <div className="hx-work-head">
                  <Link href={`/workflows/runs/${item.runId}`} className="hx-work-title">{item.workflowName}</Link>
                  <span className={`hx-work-state outcome-${item.outcome}`}>
                    {item.outcome === 'failed' ? 'Failed' : 'Done'}
                    {item.times > 1 ? ` ×${item.times}` : ''}
                    {item.finishedAt ? ` · ${item.times > 1 ? 'latest ' : ''}${relativeTime(item.finishedAt)}` : ''}
                  </span>
                </div>
                {item.request && <div className="hx-finished-request">You asked: {item.request}</div>}
                {wroteAnswer(item) ? (
                  <>
                    <p className="hx-finished-result">{preview(item.result)}</p>
                    <Link href={`/workflows/runs/${item.runId}`} className="hx-more">Read the answer →</Link>
                  </>
                ) : (
                  <div className="hx-work-detail">{item.changes || 'Ran without an agent step, so there is nothing to read.'}</div>
                )}
              </li>
            ))}
          </ul>
          {collapsed.length > SHOWN && <Link href="/workflows" className="hx-more">{collapsed.length - SHOWN} more finished →</Link>}
        </div>
      )}
      {problem && <div className="home-muted" role="status">{problem}</div>}
    </div>
  );
}
