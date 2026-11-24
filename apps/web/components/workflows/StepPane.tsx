'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { markdownToHtml } from '@/lib/markdown';
import { durationText, type FactTone } from '@/lib/workflow-story';
import type { DetailField, DetailList, StepDetail } from '@/lib/workflow-step-detail';
import { when } from '@/lib/workflows';

/**
 * One step of a run, opened from the step list: what kind of step it is, what
 * it was asked, what it returned and what was recorded while it ran. There is
 * nothing to decide here. It is how a person checks the one line the list gives.
 */

const TONE_FG: Record<FactTone, string> = { good: '#166534', warn: '#b45309', bad: '#b91c1c' };

const STATE_WORD: Record<StepDetail['state'], { label: string; fg: string; bg: string }> = {
  done: { label: 'Done', fg: '#166534', bg: '#dcfce7' },
  skipped: { label: 'Passed with nothing to do', fg: '#475569', bg: '#e2e8f0' },
  running: { label: 'Running now', fg: '#0e7490', bg: '#cffafe' },
  waiting: { label: 'Waiting', fg: '#475569', bg: '#e2e8f0' },
  failed: { label: 'Failed', fg: '#b91c1c', bg: '#fee2e2' },
  ahead: { label: 'Has not run yet', fg: '#475569', bg: '#f1f5f9' },
};

const BY_WORD: Record<StepDetail['kind'], string> = { fixed: 'The system', agent: 'The agent', human: 'A person' };

const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };
const th: CSSProperties = { padding: '5px 10px', fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textAlign: 'left', borderBottom: '1px solid var(--line)', background: 'var(--bg-alt)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '5px 10px', fontSize: 12.5, verticalAlign: 'top', borderBottom: '1px solid var(--line)', overflowWrap: 'anywhere', minWidth: 96 };

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ ...label, margin: 0 }}>{title}</h3>
        {note && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Fields({ fields }: { fields: DetailField[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 200px) minmax(0, 1fr)', gap: '3px 12px', margin: 0 }}>
      {fields.map((field, index) => (
        <div key={`${field.label}:${index}`} style={{ display: 'contents' }}>
          <dt style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{field.label}</dt>
          <dd style={{ fontSize: 12.5, fontWeight: 600, margin: 0, minWidth: 0, wordBreak: 'break-word' }}>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ListTable({ list }: { list: DetailList }) {
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
        {list.label} <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}>· {list.count.toLocaleString()}</span>
      </div>
      {list.columns.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {list.columns.map((column) => (
                  <th key={column} scope="col" style={th}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.rows.map((cells, index) => (
                <tr key={index}>
                  {cells.map((cell, at) => (
                    <td key={at} style={td}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.more > 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>And {list.more.toLocaleString()} more, not shown here.</div>}
    </div>
  );
}

const READS_SHOWN = 12;

interface Props {
  step: StepDetail;
  /** The label of the control that leaves the step: back to the open decision, or close. */
  backLabel: string;
  onBack(): void;
}

export function StepPane({ step, backLabel, onBack }: Props) {
  const [allReads, setAllReads] = useState(false);
  const state = STATE_WORD[step.state];
  const ran = step.state !== 'ahead';
  const took = durationText(step.seconds);
  const html = useMemo(() => (step.summary ? markdownToHtml(step.summary.replace(/^#{4,}\s/gm, '### ')) : ''), [step.summary]);
  const reads = allReads ? step.reads : step.reads.slice(0, READS_SHOWN);
  const failedReads = step.reads.filter((read) => !read.ok).length;
  const result = step.result;
  const nothingBack = ran && step.kind === 'fixed' && step.type === 'tool' && !result && !step.error && step.state === 'done';

  const timing = [
    step.startedAt ? `Started ${when(step.startedAt)}` : '',
    step.finishedAt && took ? `took ${took}` : '',
    step.attempts > 1 ? `${step.attempts} attempts` : '',
    step.outcome ? `went the “${step.outcome}” way` : '',
  ].filter(Boolean);

  return (
    <article aria-label={`Step: ${step.label}`} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
      <header style={{ padding: '14px 16px 12px', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={label}>Step · {BY_WORD[step.kind]}</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: state.fg, background: state.bg, padding: '1px 8px', borderRadius: 999 }}>{state.label}</span>
          {step.changesData && step.type === 'tool' && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '1px 8px', borderRadius: 999 }}>Changes data</span>}
          <button type="button" className="btn" onClick={onBack} style={{ marginLeft: 'auto', fontSize: 12.5 }}>
            {backLabel}
          </button>
        </div>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{step.label}</h2>
        {step.did && <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: 0, color: step.state === 'failed' ? '#b91c1c' : 'var(--ink)' }}>{step.did}</p>}
        {step.facts.length > 0 && (
          <div style={{ display: 'flex', gap: '2px 18px', flexWrap: 'wrap' }}>
            {step.facts.map((fact) => (
              <span key={fact.label} style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                {fact.label}: <span style={{ fontWeight: 600, color: fact.tone ? TONE_FG[fact.tone] : 'var(--ink-2)' }}>{fact.value}</span>
              </span>
            ))}
          </div>
        )}
        {timing.length > 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{timing.join(' · ')}.</div>}
        {step.error && (
          <div role="alert" style={{ border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
            {step.error}
          </div>
        )}
        {step.trouble && !step.error && <div style={{ fontSize: 12.5, color: '#b45309' }}>{step.trouble}</div>}
      </header>

      <Section title="What this step is">
        <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0, color: 'var(--ink-2)' }}>
          {step.what}
          {step.tool ? ` It runs ${step.tool.replace(/_/g, ' ')}.` : ''}
          {!step.certain && step.state === 'ahead' ? ' The run reaches it only on some choices.' : ''}
        </p>
      </Section>

      {step.asked.length > 0 && (
        <Section title={step.type === 'tool' ? (ran && !step.askedAsDesigned ? 'What it was asked' : 'What it will be asked') : step.type === 'branch' ? (ran ? 'What it tested' : 'What it will test') : 'How it is set up'} note={step.askedAsDesigned && step.type === 'tool' ? 'As designed. The values are filled in when it runs.' : undefined}>
          <Fields fields={step.asked} />
        </Section>
      )}

      {step.reads.length > 0 && (
        <Section title="What it read" note={`${step.reads.length} ${step.reads.length === 1 ? 'read' : 'reads'}${failedReads > 0 ? `, ${failedReads} that did not work` : ''}. An agent can only read; it cannot change data.`}>
          <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...th, width: 28 }}>#</th>
                  <th scope="col" style={th}>Read</th>
                  <th scope="col" style={th}>Asked for</th>
                  <th scope="col" style={{ ...th, width: 90 }}>Result</th>
                </tr>
              </thead>
              <tbody>
                {reads.map((read, index) => (
                  <tr key={index}>
                    <td style={{ ...td, minWidth: 0, color: 'var(--ink-4)' }}>{index + 1}</td>
                    <td style={{ ...td, fontWeight: 600 }} title={read.tool}>{read.what.charAt(0).toUpperCase() + read.what.slice(1)}</td>
                    <td style={{ ...td, color: 'var(--ink-2)' }}>{read.about || '—'}</td>
                    <td style={{ ...td, fontWeight: 600, color: read.ok ? '#166534' : '#b45309' }}>{read.ok ? 'Read' : 'Did not work'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {step.reads.length > READS_SHOWN && (
            <button type="button" onClick={() => setAllReads((current) => !current)} style={{ border: 'none', background: 'none', padding: 0, marginTop: 5, fontSize: 12, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
              {allReads ? 'Show the first few' : `Show all ${step.reads.length}`}
            </button>
          )}
        </Section>
      )}

      {step.kind === 'agent' && ran && step.state !== 'running' && (
        <Section title="What it proposed" note={step.proposals.length === 0 ? undefined : 'Nothing is written until a person approves it.'}>
          {step.proposals.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{step.state === 'failed' ? 'Nothing. It stopped before it finished.' : 'No changes.'}</div>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
              {step.proposals.map((proposal, index) => (
                <li key={index} style={{ fontSize: 13, lineHeight: 1.45 }}>
                  {proposal.summary}{' '}
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: proposal.needsReview ? '#b45309' : '#166534' }}>{proposal.needsReview ? 'Flagged for a close look' : 'Confident'}</span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}

      {html && (
        <Section title="Its write-up">
          <div className="markdown-content" style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, maxWidth: 900 }} dangerouslySetInnerHTML={{ __html: html }} />
        </Section>
      )}

      {step.changes.length > 0 && (
        <Section title="The changes it made" note={`${step.changes.filter((change) => change.ok).length} of ${step.changes.length} made.`}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 5 }}>
            {step.changes.map((change, index) => (
              <li key={index} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 8, fontSize: 13, lineHeight: 1.45 }}>
                <span aria-hidden style={{ fontWeight: 700, color: change.ok ? '#16a34a' : '#dc2626' }}>{change.ok ? '✓' : '!'}</span>
                <span>
                  {change.summary}
                  {!change.ok && <span style={{ display: 'block', fontSize: 12.5, color: '#b91c1c' }}>Not made. {change.error || 'No reason was recorded.'}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {result && (
        <Section title="What it returned">
          <div style={{ display: 'grid', gap: 12 }}>
            {result.fields.length > 0 && <Fields fields={result.fields} />}
            {result.groups.map((group) => (
              <div key={group.label}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>{group.label}</div>
                <Fields fields={group.fields} />
              </div>
            ))}
            {result.lists.map((list) => (
              <ListTable key={list.label} list={list} />
            ))}
          </div>
        </Section>
      )}
      {nothingBack && (
        <Section title="What it returned">
          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>Nothing was kept from this step.</div>
        </Section>
      )}

      {!ran && (
        <Section title="What happened">
          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>Nothing yet. The run has not reached this step.</div>
        </Section>
      )}

      {(step.history.length > 0 || step.usage) && (
        <Section title="As it happened" note={step.usage ? `${step.usage.calls} model ${step.usage.calls === 1 ? 'call' : 'calls'}${step.usage.model ? ` to ${step.usage.model}` : ''}${step.usage.costUsd !== null ? `, about $${step.usage.costUsd.toFixed(2)}` : ''}.` : undefined}>
          {step.history.length > 0 && (
            <details>
              <summary style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
                {step.history.length} {step.history.length === 1 ? 'entry' : 'entries'} in the run’s history for this step
              </summary>
              <ol style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 3 }}>
                {step.history.map((event, index) => (
                  <li key={index} style={{ display: 'grid', gridTemplateColumns: '150px 70px minmax(0, 1fr)', gap: 10, fontSize: 12.5, lineHeight: 1.45 }}>
                    <span style={{ color: 'var(--ink-3)' }}>{event.at ? when(event.at) : ''}</span>
                    <span style={{ color: 'var(--ink-3)' }}>{event.by === 'person' ? event.name || 'Person' : event.by === 'agent' ? 'Agent' : 'System'}</span>
                    <span style={{ wordBreak: 'break-word' }}>{event.summary}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </Section>
      )}
    </article>
  );
}
