'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  DECIDE_RECONCILIATION_RUN_MUTATION,
  RECONCILIATION_RUN_QUERY,
  RESOLVE_RECONCILIATION_LINE_MUTATION,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { statusLabel } from './ReconciliationHome';

interface Cell {
  key: string;
  label: string;
  value: string | null;
  numeric: number | null;
}

interface Line {
  id: string;
  lineCode: string;
  lineName: string;
  attributeCode: string;
  attributeName: string;
  breakKind: string;
  cells: Cell[];
  goldenValue: string | null;
  variance: number | null;
  isBreak: boolean;
  status: string;
  resolutionSourceCode: string | null;
  resolutionValue: string | null;
}

interface Identity {
  code: string;
  name: string;
  calculated: number | null;
  compareValue: number | null;
  variance: number | null;
  passed: boolean;
  message: string | null;
}

interface Run {
  id: string;
  anchorEntityCode: string;
  anchorEntityName: string;
  domainCode: string;
  asOfDate: string;
  compareAsOfDate: string | null;
  status: string;
  stageIndex: number;
  assignedTo: string | null;
  openBreakCount: number;
  decisionNotes: string | null;
  definition: {
    definitionName: string;
    stages: string[];
  };
  identities: Identity[];
  lines: Line[];
}

function displayValue(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return '—';
  const numeric = Number(value.replace(/,/g, ''));
  if (Number.isFinite(numeric) && /^-?\d/.test(value.trim())) {
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return value;
}

function displayNumber(value: number | null): string {
  if (value == null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function ReconciliationReview({ runId }: { runId: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [breaksOnly, setBreaksOnly] = useState(true);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState('');
  const [sources, setSources] = useState<Record<string, string>>({});

  const load = () => {
    graphqlQuery<{ reconciliationRun: Run | null }>(RECONCILIATION_RUN_QUERY, { id: runId }, 'network-only')
      .then((result) => {
        setRun(result.data?.reconciliationRun || null);
        setError(result.error?.message || (result.data?.reconciliationRun ? '' : 'Review not found'));
      });
  };

  useEffect(() => {
    load();
  }, [runId]);

  const applyResult = (result: { data?: { [key: string]: { run: Run | null; errors: Array<{ message: string }> } }; error?: { message?: string } }, key: string) => {
    const payload = result.data?.[key];
    if (payload?.run) {
      setRun(payload.run);
      setError('');
      return;
    }
    setError(payload?.errors?.[0]?.message || result.error?.message || 'The review could not be updated');
  };

  const resolveLine = async (line: Line, status: string, sourceCode?: string) => {
    setBusy(line.id);
    const result = await graphqlMutation<{ resolveReconciliationLine: { run: Run | null; errors: Array<{ message: string }> } }>(
      RESOLVE_RECONCILIATION_LINE_MUTATION,
      { input: { lineId: line.id, status, sourceCode: sourceCode || null, notes: null } },
    );
    setBusy('');
    applyResult(result, 'resolveReconciliationLine');
  };

  const decide = async (decision: 'APPROVE' | 'SEND_BACK') => {
    setBusy(decision);
    const result = await graphqlMutation<{ decideReconciliationRun: { run: Run | null; errors: Array<{ message: string }> } }>(
      DECIDE_RECONCILIATION_RUN_MUTATION,
      { input: { runId, decision, notes: notes || null } },
    );
    setBusy('');
    applyResult(result, 'decideReconciliationRun');
  };

  const visible = useMemo(() => {
    const lines = run?.lines || [];
    return lines.filter((line) => line.breakKind !== 'IDENTITY' && (!breaksOnly || line.isBreak));
  }, [run, breaksOnly]);

  const sourceLines = visible.filter((line) => line.breakKind === 'SOURCE');
  const periodLines = visible.filter((line) => line.breakKind === 'PERIOD');
  const sourceKeys = Array.from(new Map(sourceLines.flatMap((line) => line.cells.map((cell) => [cell.key, cell.label] as const))).entries());

  if (!run) {
    return <div className="view-fade"><div className="page-meta">{error || 'Loading review…'}</div></div>;
  }

  const locked = run.status === 'APPROVED';

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/reconcile" className="crumb-link">Reconcile</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{run.anchorEntityName}</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{run.definition.definitionName}</div>
          <div className="page-meta">
            {run.anchorEntityName} · {run.anchorEntityCode} · as of {String(run.asOfDate).slice(0, 10)}
            {run.compareAsOfDate ? ` compared with ${String(run.compareAsOfDate).slice(0, 10)}` : ''}
            {run.assignedTo ? ` · ${run.assignedTo}` : ''}
          </div>
        </div>
        <span className={`recon-status status-${run.status.toLowerCase()}`}>{statusLabel(run.status)}</span>
      </div>

      <ol className="recon-steps">
        {run.definition.stages.map((stage, index) => (
          <li key={stage} className={index < run.stageIndex ? 'done' : index === run.stageIndex ? 'current' : ''}>{stage}</li>
        ))}
      </ol>

      {error && <div className="recon-error">{error}</div>}
      {run.decisionNotes && <div className="recon-note">{run.decisionNotes}</div>}

      {run.identities.length > 0 && (
        <div className="recon-identities">
          {run.identities.map((identity) => {
            const line = run.lines.find((item) => item.breakKind === 'IDENTITY' && item.attributeCode === identity.code);
            return (
              <article key={identity.code} className={identity.passed ? 'passed' : 'failed'}>
                <span className="recon-kicker">{identity.passed ? 'Ties' : 'Break'}</span>
                <strong>{identity.name}</strong>
                <div className="recon-identity-figures">
                  <span>Calculated<strong>{displayNumber(identity.calculated)}</strong></span>
                  <span>Reported<strong>{displayNumber(identity.compareValue)}</strong></span>
                </div>
                {identity.message && <p>{identity.message}</p>}
                {line && !locked && line.status === 'OPEN' && (
                  <div className="recon-actions">
                    <button type="button" className="btn btn-sm" disabled={busy === line.id} onClick={() => resolveLine(line, 'ACCEPTED')}>Accept</button>
                    <button type="button" className="btn btn-sm" disabled={busy === line.id} onClick={() => resolveLine(line, 'WAIVED')}>Waive</button>
                  </div>
                )}
                {line && line.status !== 'OPEN' && <span className="recon-code">{statusLabel(line.status)}</span>}
              </article>
            );
          })}
        </div>
      )}

      <div className="recon-toolbar">
        <label>
          <input type="checkbox" checked={breaksOnly} onChange={(event) => setBreaksOnly(event.target.checked)} />
          Breaks only
        </label>
        <span className="page-meta">{run.openBreakCount} open</span>
      </div>

      {sourceLines.length > 0 && (
        <section className="recon-grid-wrap">
          <h2>Sources</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>Attribute</th>
                {sourceKeys.map(([key, label]) => <th key={key}>{label}</th>)}
                <th>Variance</th>
                <th>Status</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {sourceLines.map((line) => (
                <tr key={line.id} className={line.isBreak ? 'recon-break' : ''}>
                  <td>{line.lineName}<span className="recon-code">{line.lineCode}</span></td>
                  <td>{line.attributeName}</td>
                  {sourceKeys.map(([key]) => {
                    const cell = line.cells.find((item) => item.key === key);
                    const chosen = line.resolutionSourceCode === key || (!line.resolutionSourceCode && cell?.value === line.goldenValue);
                    return <td key={key} className={chosen ? 'recon-golden' : ''}>{displayValue(cell?.value)}</td>;
                  })}
                  <td>{displayNumber(line.variance)}</td>
                  <td>{statusLabel(line.status)}</td>
                  <td>{line.isBreak && <LineActions line={line} locked={locked} busy={busy === line.id} sourceCode={sources[line.id] || ''} onSource={(value) => setSources((current) => ({ ...current, [line.id]: value }))} onResolve={resolveLine} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {periodLines.length > 0 && (
        <section className="recon-grid-wrap">
          <h2>Prior period</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>Attribute</th>
                <th>Prior</th>
                <th>Current</th>
                <th>Variance</th>
                <th>Status</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {periodLines.map((line) => (
                <tr key={line.id} className={line.isBreak ? 'recon-break' : ''}>
                  <td>{line.lineName}<span className="recon-code">{line.lineCode}</span></td>
                  <td>{line.attributeName}</td>
                  <td className={line.resolutionSourceCode === 'PRIOR' ? 'recon-golden' : ''}>{displayValue(line.cells.find((cell) => cell.key === 'PRIOR')?.value)}</td>
                  <td className={line.resolutionSourceCode === 'CURRENT' || line.status === 'ACCEPTED' ? 'recon-golden' : ''}>{displayValue(line.cells.find((cell) => cell.key === 'CURRENT')?.value)}</td>
                  <td>{displayNumber(line.variance)}</td>
                  <td>{statusLabel(line.status)}</td>
                  <td>
                    {line.isBreak && !locked && line.status === 'OPEN' && (
                      <div className="recon-actions">
                        <button type="button" className="btn btn-sm" disabled={busy === line.id} onClick={() => resolveLine(line, 'ACCEPTED')}>Keep current</button>
                        <button type="button" className="btn btn-sm" disabled={busy === line.id} onClick={() => resolveLine(line, 'OVERRIDDEN', 'PRIOR')}>Keep prior</button>
                        <button type="button" className="btn btn-sm" disabled={busy === line.id} onClick={() => resolveLine(line, 'WAIVED')}>Waive</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {visible.length === 0 && <div className="page-meta">Nothing to show for this filter. Agreed rows are hidden while “Breaks only” is on.</div>}

      {!locked && (
        <section className="recon-decide">
          <label>
            Note
            <textarea className="input" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
          </label>
          <div className="recon-actions">
            <button type="button" className="btn" disabled={busy === 'SEND_BACK'} onClick={() => decide('SEND_BACK')}>Send back</button>
            <button type="button" className="btn btn-primary" disabled={busy === 'APPROVE' || run.openBreakCount > 0} onClick={() => decide('APPROVE')}>
              Approve and reconcile
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function LineActions({
  line,
  locked,
  busy,
  sourceCode,
  onSource,
  onResolve,
}: {
  line: Line;
  locked: boolean;
  busy: boolean;
  sourceCode: string;
  onSource: (value: string) => void;
  onResolve: (line: Line, status: string, sourceCode?: string) => void;
}) {
  if (locked || line.status !== 'OPEN') return null;
  return (
    <div className="recon-actions">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve(line, 'ACCEPTED')}>Accept golden</button>
      <select className="select" value={sourceCode} onChange={(event) => onSource(event.target.value)}>
        <option value="">Keep source…</option>
        {line.cells.filter((cell) => cell.value).map((cell) => (
          <option key={cell.key} value={cell.key}>{cell.label}</option>
        ))}
      </select>
      <button type="button" className="btn btn-sm" disabled={busy || !sourceCode} onClick={() => onResolve(line, 'OVERRIDDEN', sourceCode)}>Keep source</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve(line, 'WAIVED')}>Waive</button>
    </div>
  );
}
