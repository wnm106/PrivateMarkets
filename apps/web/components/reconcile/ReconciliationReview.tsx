'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
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
  const locked = run?.status === 'APPROVED';
  const reviewActions = useRef({ resolveLine, setSources });
  reviewActions.current = { resolveLine, setSources };
  const reviewContext = useMemo(() => ({ get: () => reviewActions.current }), []);
  const sourceKeySignature = sourceKeys.map(([key]) => key).join('|');
  const sourceColumns = useMemo<ColDef[]>(() => {
    const columns: ColDef[] = [
      {
        colId: 'line',
        headerName: 'Line',
        minWidth: 160,
        flex: 1,
        valueGetter: (params) => params.data?.lineName || '',
        cellRenderer: (params: any) => <span>{params.data.lineName}<span className="recon-code">{params.data.lineCode}</span></span>,
      },
      { field: 'attributeName', headerName: 'Attribute', minWidth: 140, flex: 1 },
    ];
    for (const [key, label] of sourceKeySignature.split('|').filter(Boolean).map((key) => {
      const match = sourceKeys.find(([item]) => item === key);
      return [key, match?.[1] || key] as const;
    })) {
      columns.push({
        colId: `src:${key}`,
        headerName: label,
        minWidth: 120,
        valueGetter: (params) => displayValue(params.data?.cells?.find((cell: Cell) => cell.key === key)?.value),
        cellClass: (params) => {
          const cell = params.data?.cells?.find((item: Cell) => item.key === key);
          const chosen = params.data?.resolutionSourceCode === key || (!params.data?.resolutionSourceCode && cell?.value === params.data?.goldenValue);
          return chosen ? 'recon-golden' : '';
        },
      });
    }
    columns.push(
      { field: 'variance', headerName: 'Variance', width: 120, valueFormatter: (params) => displayNumber(params.value) },
      { field: 'status', headerName: 'Status', width: 130, valueFormatter: (params) => statusLabel(params.value) },
      { colId: 'resolution', headerName: 'Resolution', minWidth: 280, sortable: false, filter: false, autoHeight: true, cellRenderer: SourceResolutionCell },
    );
    return columns;
    // sourceKeys is rebuilt each render; the signature captures the column set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKeySignature]);
  const periodColumns = useMemo<ColDef[]>(() => [
    {
      colId: 'line',
      headerName: 'Line',
      minWidth: 160,
      flex: 1,
      valueGetter: (params) => params.data?.lineName || '',
      cellRenderer: (params: any) => <span>{params.data.lineName}<span className="recon-code">{params.data.lineCode}</span></span>,
    },
    { field: 'attributeName', headerName: 'Attribute', minWidth: 140, flex: 1 },
    {
      colId: 'prior',
      headerName: 'Prior',
      minWidth: 120,
      valueGetter: (params) => displayValue(params.data?.cells?.find((cell: Cell) => cell.key === 'PRIOR')?.value),
      cellClass: (params) => (params.data?.resolutionSourceCode === 'PRIOR' ? 'recon-golden' : ''),
    },
    {
      colId: 'current',
      headerName: 'Current',
      minWidth: 120,
      valueGetter: (params) => displayValue(params.data?.cells?.find((cell: Cell) => cell.key === 'CURRENT')?.value),
      cellClass: (params) => (params.data?.resolutionSourceCode === 'CURRENT' || params.data?.status === 'ACCEPTED' ? 'recon-golden' : ''),
    },
    { field: 'variance', headerName: 'Variance', width: 120, valueFormatter: (params) => displayNumber(params.value) },
    { field: 'status', headerName: 'Status', width: 130, valueFormatter: (params) => statusLabel(params.value) },
    { colId: 'resolution', headerName: 'Resolution', minWidth: 280, sortable: false, filter: false, autoHeight: true, cellRenderer: PeriodResolutionCell },
  ], []);

  if (!run) {
    return <div className="view-fade"><div className="page-meta">{error || 'Loading review…'}</div></div>;
  }


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
          <AppGrid
            rows={sourceLines.map((line) => ({ ...line, __sourceCode: sources[line.id] || '', __busy: busy === line.id, __locked: locked }))}
            columns={sourceColumns}
            getRowId={(row) => row.id}
            autoHeight
            autoRowHeight
            context={reviewContext}
            getRowClass={(params) => (params.data?.isBreak ? 'recon-break' : '')}
            emptyMessage="No source lines."
          />
        </section>
      )}

      {periodLines.length > 0 && (
        <section className="recon-grid-wrap">
          <h2>Prior period</h2>
          <AppGrid
            rows={periodLines.map((line) => ({ ...line, __busy: busy === line.id, __locked: locked }))}
            columns={periodColumns}
            getRowId={(row) => row.id}
            autoHeight
            autoRowHeight
            context={reviewContext}
            getRowClass={(params) => (params.data?.isBreak ? 'recon-break' : '')}
            emptyMessage="No prior-period lines."
          />
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

function SourceResolutionCell(props: any) {
  if (!props.data.isBreak) return null;
  const actions = props.context.get();
  return (
    <LineActions
      line={props.data}
      locked={props.data.__locked}
      busy={props.data.__busy}
      sourceCode={props.data.__sourceCode}
      onSource={(value) => actions.setSources((current: Record<string, string>) => ({ ...current, [props.data.id]: value }))}
      onResolve={actions.resolveLine}
    />
  );
}

function PeriodResolutionCell(props: any) {
  const line = props.data;
  if (!line.isBreak || line.__locked || line.status !== 'OPEN') return null;
  const resolve = props.context.get().resolveLine as (line: Line, status: string, sourceCode?: string) => void;
  return (
    <div className="recon-actions">
      <button type="button" className="btn btn-sm" disabled={line.__busy} onClick={() => resolve(line, 'ACCEPTED')}>Keep current</button>
      <button type="button" className="btn btn-sm" disabled={line.__busy} onClick={() => resolve(line, 'OVERRIDDEN', 'PRIOR')}>Keep prior</button>
      <button type="button" className="btn btn-sm" disabled={line.__busy} onClick={() => resolve(line, 'WAIVED')}>Waive</button>
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
