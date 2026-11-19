'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import type { HomeSummary } from '@/lib/home';
import { useTemporalStore } from '@/lib/store';
import { START_RUN } from '@/lib/workflows';
import {
  ASSISTANT_TARGET,
  COMPOSE_WORKFLOWS_QUERY,
  composeProblem,
  composeTargets,
  handoffInput,
  suggestions,
  targetWorkflowId,
  type ComposeWorkflow,
} from '@/lib/home-compose';

/**
 * One box at the top of the home page. A question goes to the assistant, which
 * answers in its panel. A task can instead be handed to a workflow, which runs
 * in the background and brings what it proposes back for a decision.
 */

type Sent = { kind: 'run'; runId: string; name: string } | { kind: 'problem'; message: string } | null;

export function HomeComposer({ summary, onStarted }: { summary: HomeSummary | null; onStarted(): void }) {
  const askAssistant = useTemporalStore((state) => state.askAssistant);
  const [text, setText] = useState('');
  const [target, setTarget] = useState(ASSISTANT_TARGET.key);
  const [workflows, setWorkflows] = useState<ComposeWorkflow[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Sent>(null);

  useEffect(() => {
    let cancelled = false;
    // Someone who cannot see workflows still gets the assistant.
    void graphqlQuery<{ workflows: ComposeWorkflow[] }>(COMPOSE_WORKFLOWS_QUERY).then((result) => {
      if (!cancelled) setWorkflows(result.data?.workflows || []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const targets = useMemo(() => composeTargets(workflows), [workflows]);
  const chosen = targets.find((entry) => entry.key === target) || ASSISTANT_TARGET;
  const workflowId = targetWorkflowId(chosen.key);
  const chips = useMemo(() => suggestions(summary), [summary]);
  const problem = composeProblem(text);

  async function send() {
    if (problem || sending) return;
    setSent(null);
    if (!workflowId) {
      askAssistant(text.trim());
      setText('');
      return;
    }
    setSending(true);
    const result = await graphqlMutation<{ startWorkflowRun: { run: { id: string } | null; errors: Array<{ message: string }> } }>(START_RUN, {
      workflowId,
      input: handoffInput(text),
      version: null,
    });
    setSending(false);
    const errors = result.data?.startWorkflowRun.errors || [];
    const run = result.data?.startWorkflowRun.run;
    if (result.error || errors.length > 0 || !run) {
      setSent({ kind: 'problem', message: errors.map((error) => error.message).join(' ') || result.error?.message || 'The workflow could not be started.' });
      return;
    }
    setSent({ kind: 'run', runId: run.id, name: chosen.label });
    setText('');
    onStarted();
  }

  return (
    <section className="home-composer" aria-label="Ask or hand off a task">
      <textarea
        className="home-composer-input"
        rows={2}
        placeholder="Ask a question, or hand off a task"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
        aria-label="Your question or task"
      />
      <div className="home-composer-bar">
        <label className="home-composer-target">
          <span className="home-muted">Send to</span>
          <select className="text-input" value={chosen.key} onChange={(event) => setTarget(event.target.value)}>
            <option value={ASSISTANT_TARGET.key}>{ASSISTANT_TARGET.label}</option>
            {targets.length > 1 && (
              <optgroup label="Hand off to a workflow">
                {targets.slice(1).map((entry) => (
                  <option key={entry.key} value={entry.key}>{entry.label}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <span className="home-composer-hint home-muted">{chosen.hint}</span>
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={Boolean(problem) || sending}>
          {sending ? 'Starting…' : workflowId ? 'Hand off' : 'Ask'}
        </button>
      </div>

      {sent?.kind === 'run' && (
        <div className="home-composer-note" role="status">
          <span className="home-clear-mark" aria-hidden>✓</span>
          Handed to {sent.name}. Its answer will appear under Agents at work when it finishes. <Link href={`/workflows/runs/${sent.runId}`}>See the run</Link>
        </div>
      )}
      {sent?.kind === 'problem' && <div className="home-composer-note is-problem" role="alert">{sent.message}</div>}

      <div className="home-composer-chips">
        {chips.map((chip) => (
          <button key={chip} type="button" className="home-chip" onClick={() => askAssistant(chip)}>
            {chip}
          </button>
        ))}
      </div>
    </section>
  );
}
