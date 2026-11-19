'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { relativeTime } from '@/lib/home';
import { markdownToHtml } from '@/lib/markdown';

/**
 * The workflow runs in flight and which agent is behind each, then the runs
 * that finished in the last day with what each produced, then the standing of
 * every agent. A finished run stays here so a request that was handed off
 * has somewhere to come back to. Refreshes on its own while anything is
 * running, and when `refreshKey` changes (a run was just started). With
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

interface Board {
  agents: AgentStatus[];
  work: AgentWork[];
  finished: FinishedWork[];
  running: number;
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

/** Results longer than this open clipped, with a way to read the rest in place. */
const RESULT_PREVIEW_CHARS = 420;

function Finished({ item }: { item: FinishedWork }) {
  const long = item.result.length > RESULT_PREVIEW_CHARS;
  const [open, setOpen] = useState(false);
  // The renderer knows three heading levels. Deeper ones are shown as the third.
  const html = useMemo(() => markdownToHtml(item.result.replace(/^#{4,}\s/gm, '### ')), [item.result]);
  return (
    <li className={`home-finished-item outcome-${item.outcome}`}>
      <div className="home-work-head">
        <Link href={`/workflows/runs/${item.runId}`} className="home-work-title">
          {item.workflowName}
        </Link>
        <span className="home-work-percent">
          {item.outcome === 'failed' ? 'Failed' : 'Done'}
          {item.finishedAt ? ` · ${relativeTime(item.finishedAt)}` : ''}
        </span>
      </div>
      {item.request && <div className="home-finished-request">You asked: {item.request}</div>}
      <div className={`home-brief-body home-finished-result${long && !open ? ' is-clipped' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="home-work-detail">
        {long && (
          <>
            <button type="button" className="home-link-button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
              {open ? 'Show less' : 'Read it all'}
            </button>
            {' · '}
          </>
        )}
        {item.agentName ? `${item.agentName} · ` : ''}
        {item.changes ? `${item.changes} · ` : ''}
        <Link href={`/workflows/runs/${item.runId}`}>Open the run</Link>
      </div>
    </li>
  );
}

export function AgentsAtWork({ refreshKey = 0, mine = false }: { refreshKey?: number; mine?: boolean }) {
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
          setBoard(result.data.agentsAtWork);
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

  if (!board) return <div className="home-empty">{problem || 'Checking what the agents are doing…'}</div>;

  // A page left open across an update can hold an answer from before this list existed.
  const finished = board.finished || [];

  return (
    <div className="home-agents">
      {board.work.length === 0 ? (
        <div className="home-lane-empty">
          <span className="home-clear-mark" aria-hidden>✓</span>
          {mine ? 'Nothing is running on your records.' : 'Nothing is running. Hand off a task above, or start a workflow.'}
        </div>
      ) : (
        <ul className="home-work">
          {board.work.map((item) => (
            <li key={item.runId} className={`home-work-item state-${item.state}`}>
              <div className="home-work-head">
                <Link href={`/workflows/runs/${item.runId}`} className="home-work-title">
                  {item.workflowName} <span className="home-muted">· {item.stepLabel}</span>
                </Link>
                <span className="home-work-percent">{item.state === 'waiting' ? 'Waiting' : item.state === 'queued' ? 'Queued' : `${item.percent}%`}</span>
              </div>
              <div
                className="home-work-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.percent}
                aria-label={`${item.workflowName}: step ${Math.min(item.stepsDone + 1, item.stepsTotal)} of ${item.stepsTotal}`}
              >
                <span style={{ width: `${item.percent}%` }} />
              </div>
              <div className="home-work-detail">
                {item.agentName ? `${item.agentName} · ` : ''}
                {item.detail}
                {item.startedAt ? ` · started ${relativeTime(item.startedAt)}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      {finished.length > 0 && (
        <div className="home-finished">
          <div className="home-finished-title">Finished in the last day</div>
          <ul className="home-work">
            {finished.map((item) => (
              <Finished key={item.runId} item={item} />
            ))}
          </ul>
        </div>
      )}

      {board.agents.length > 0 && (
        <ul className="home-agent-roster">
          {board.agents.map((agent) => (
            <li key={agent.code} className={`home-agent state-${agent.state}`} title={agent.description || undefined}>
              <span className="home-agent-dot" aria-hidden />
              <span className="home-agent-name">{agent.name}</span>
              <span className="home-muted">
                {STATE_LABEL[agent.state]}
                {agent.runs > 1 ? ` · ${agent.runs} runs` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {problem && <div className="home-muted" role="status">{problem}</div>}
    </div>
  );
}
