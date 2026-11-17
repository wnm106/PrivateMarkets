'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { duration } from '@/lib/workflow-versions';
import { usePublishViewContext } from '@/lib/view-context';

/** How each workflow is doing: runs, durations, how long reviews take, and where runs slow down or fail. */

interface Row {
  workflowId: string;
  name: string;
  code: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  open: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  reviews: number;
  reviewsWaiting: number;
  reviewsOverdue: number;
  medianReviewSeconds: number | null;
  changesApproved: number;
  changesRejected: number;
  slowestSteps: Array<{ step: string; type: string; avgSeconds: number | null; failures: number }>;
  commonFailure: { error: string; times: number } | null;
}

const QUERY = `query WorkflowAnalytics($days: Int) { workflowAnalytics(days: $days) }`;
const cell: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 13, textAlign: 'left', verticalAlign: 'top' };
const head: CSSProperties = { ...cell, fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', background: 'var(--bg-alt)', whiteSpace: 'nowrap' };
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

export default function WorkflowAnalyticsPage() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState('');
  usePublishViewContext({ activity: 'viewing', kind: 'workflows', label: 'Workflow analytics', summary: `How workflows did over the last ${days} days` });

  useEffect(() => {
    let live = true;
    setRows(null);
    void graphqlQuery<{ workflowAnalytics: { workflows: Row[] } }>(QUERY, { days }, 'network-only').then((result) => {
      if (!live || result.aborted) return;
      if (result.error) setMessage(result.error.message);
      else setRows(result.data?.workflowAnalytics.workflows || []);
    });
    return () => {
      live = false;
    };
  }, [days]);

  const totals = (rows || []).reduce(
    (acc, row) => ({ runs: acc.runs + row.runs, failed: acc.failed + row.failed, waiting: acc.waiting + row.reviewsWaiting, overdue: acc.overdue + row.reviewsOverdue }),
    { runs: 0, failed: 0, waiting: 0, overdue: 0 },
  );

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/workflows" className="crumb-link">Workflows</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Analytics</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Workflow analytics</div>
            <div className="page-meta">How long runs take, how long people take to review, and where runs slow down or fail.</div>
          </div>
        </div>
        <select className="text-input" aria-label="Period" value={days} onChange={(event) => setDays(Number(event.target.value))} style={{ padding: '7px 8px', fontSize: 12 }}>
          {[7, 30, 90, 365].map((value) => (
            <option key={value} value={value}>Last {value} days</option>
          ))}
        </select>
      </div>

      {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0' }}>{message}</div>}
      {!rows && !message && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Reading runs…</div>}

      {rows && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '16px 0', fontSize: 13 }}>
            <span><strong>{totals.runs}</strong> runs</span>
            <span><strong>{totals.failed}</strong> failed</span>
            <span><strong>{totals.waiting}</strong> reviews waiting</span>
            <span style={{ color: totals.overdue > 0 ? '#b91c1c' : undefined }}><strong>{totals.overdue}</strong> reviews overdue</span>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 16, border: '1px dashed var(--line-strong)', borderRadius: 8, color: 'var(--ink-3)', fontSize: 13 }}>No runs in this period.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--line)' }}>
                <thead>
                  <tr>
                    <th style={head}>Workflow</th>
                    <th style={{ ...head, textAlign: 'right' }}>Runs</th>
                    <th style={{ ...head, textAlign: 'right' }}>Succeeded</th>
                    <th style={{ ...head, textAlign: 'right' }}>Failed</th>
                    <th style={{ ...head, textAlign: 'right' }}>Still going</th>
                    <th style={{ ...head, textAlign: 'right' }}>Typical run</th>
                    <th style={{ ...head, textAlign: 'right' }}>Slowest 10%</th>
                    <th style={{ ...head, textAlign: 'right' }}>Typical review</th>
                    <th style={{ ...head, textAlign: 'right' }}>Overdue</th>
                    <th style={{ ...head, textAlign: 'right' }}>Changes approved</th>
                    <th style={head}>Slowest steps</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const decided = row.changesApproved + row.changesRejected;
                    return (
                      <tr key={row.workflowId}>
                        <td style={cell}>
                          <Link href={`/workflows/${row.workflowId}`} style={{ fontWeight: 600 }}>{row.name}</Link>
                          {row.commonFailure && (
                            <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, maxWidth: 360 }}>
                              Commonest failure ({row.commonFailure.times}×): {row.commonFailure.error}
                            </div>
                          )}
                        </td>
                        <td style={num}>{row.runs}</td>
                        <td style={num}>{row.succeeded}</td>
                        <td style={{ ...num, color: row.failed > 0 ? '#b91c1c' : undefined }}>{row.failed}</td>
                        <td style={num}>{row.open}</td>
                        <td style={num}>{duration(row.medianSeconds)}</td>
                        <td style={num}>{duration(row.p90Seconds)}</td>
                        <td style={num}>{duration(row.medianReviewSeconds)}</td>
                        <td style={{ ...num, color: row.reviewsOverdue > 0 ? '#b91c1c' : undefined }}>{row.reviewsOverdue}</td>
                        <td style={num}>{decided > 0 ? `${Math.round((100 * row.changesApproved) / decided)}% of ${decided}` : '—'}</td>
                        <td style={{ ...cell, fontSize: 12 }}>
                          {row.slowestSteps.length === 0
                            ? '—'
                            : row.slowestSteps.map((step) => (
                                <div key={step.step}>
                                  {step.step} · {duration(step.avgSeconds)}
                                  {step.failures > 0 ? <span style={{ color: '#b91c1c' }}> · {step.failures} failed</span> : null}
                                </div>
                              ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
