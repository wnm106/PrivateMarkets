'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { relativeTime } from '@/lib/home';

/**
 * The workflow runs in flight and which agent is behind each, with the
 * standing of every agent beneath. Refreshes on its own while anything is
 * running, and when `refreshKey` changes (a run was just started).
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

interface Board {
  agents: AgentStatus[];
  work: AgentWork[];
  running: number;
  waiting: number;
}

const QUERY = `
  query HomeAgentsAtWork {
    agentsAtWork {
      running waiting
      agents { code name description state runs }
      work { runId workflowName state agentCode agentName stepLabel detail percent stepsDone stepsTotal startedAt }
    }
  }
`;

const REFRESH_MS = 15_000;

const STATE_LABEL: Record<AgentStatus['state'], string> = { working: 'working', queued: 'queued', waiting: 'waiting on you', idle: 'idle' };

export function AgentsAtWork({ refreshKey = 0 }: { refreshKey?: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState('');
  const active = (board?.running ?? 0) > 0;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      graphqlQuery<{ agentsAtWork: Board }>(QUERY, {}, 'network-only').then((result) => {
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
  }, [active, refreshKey]);

  if (!board) return <div className="home-empty">{problem || 'Checking what the agents are doing…'}</div>;

  return (
    <div className="home-agents">
      {board.work.length === 0 ? (
        <div className="home-lane-empty">
          <span className="home-clear-mark" aria-hidden>✓</span>
          Nothing is running. Hand off a task above, or start a workflow.
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
