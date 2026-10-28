'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { LoadReview } from '@/components/feeds/LoadReview';
import { usePublishViewContext } from '@/lib/view-context';
import type { ColumnAssignment, MappingTarget } from '@/lib/feeds/suggest';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

interface InstanceSummary {
  id: string;
  fileName: string;
  rowCount: number;
  status: string;
  receivedAt: string;
  completedAt: string | null;
  asOfDate: string | null;
  errorMessage: string | null;
  mapName: string | null;
  mapSaved: boolean;
  runs: { startedAt: string; completedAt: string; asOfDate: string; status: string; created: number; matched: number; failed: number }[];
  resultSummary: {
    created: number;
    matched: number;
    failed: number;
    attributesCreated: number;
    attributesUpdated: number;
    attributesUnchanged: number;
    relationshipsMatched: number;
    relationshipsCreated?: number;
  } | null;
}

interface InstanceDetail extends InstanceSummary {
  columnMappings: ColumnAssignment[];
  loadWaves: string[][];
}

interface ReferenceListCatalog {
  listCode: string;
  values: { code: string; label: string; synonyms?: string[] | null }[];
}

interface QueueResponse {
  sourceCode: string;
  name: string;
  description: string;
  targets: MappingTarget[];
  lists: ReferenceListCatalog[];
  instances: InstanceSummary[];
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatWhen(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function resultText(instance: InstanceSummary) {
  if (!instance.resultSummary) return instance.status === 'READY' ? 'Stored, not processed' : instance.status;
  const summary = instance.resultSummary;
  const entities = summary.created === 0 && summary.failed === 0
    ? `${summary.matched} matched`
    : `${summary.created} created · ${summary.matched} matched${summary.failed ? ` · ${summary.failed} failed` : ''}`;
  const attributes = summary.attributesUpdated
    ? `attributes updated ${summary.attributesUpdated}`
    : summary.attributesCreated
      ? `attributes created ${summary.attributesCreated}`
      : `attributes unchanged ${summary.attributesUnchanged}`;
  const links = summary.relationshipsCreated ? ` · ${summary.relationshipsCreated.toLocaleString()} links` : '';
  return `${entities} · ${attributes}${links}`;
}

export default function PositionFilePage() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [asOfMode, setAsOfMode] = useState<'today' | 'specific'>('specific');
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePublishViewContext(
    detail
      ? {
          activity: 'viewing',
          kind: 'import-file',
          label: detail.fileName,
          id: detail.id,
          summary: `${detail.status} · ${detail.rowCount} rows`,
          snapshot: {
            fileName: detail.fileName,
            status: detail.status,
            rowCount: detail.rowCount,
            asOfDate: detail.asOfDate,
            sourceCode: queue?.sourceCode,
            resultSummary: detail.resultSummary,
            mappedColumns: detail.columnMappings.length,
          },
        }
      : queue
        ? {
            activity: 'viewing',
            kind: 'import',
            label: queue.name || 'Load data',
            summary: `${queue.instances.length} files`,
          }
        : null
  );

  async function refreshQueue() {
    const response = await fetch('/api/feeds/position-file');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The import queue is unavailable');
    setQueue(body);
    return body as QueueResponse;
  }

  useEffect(() => {
    refreshQueue().catch((err) => setError(err.message));
  }, []);

  function openDetail(instance: InstanceDetail) {
    setDetail(instance);
    setError(null);
    if (instance.asOfDate) {
      setAsOfDate(instance.asOfDate);
      setAsOfMode('specific');
    }
  }

  async function selectInstance(id: string) {
    setBusy('open');
    setError(null);
    try {
      const response = await fetch(`/api/feeds/position-file/${id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The instance could not be opened');
      openDetail(body);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const fileColumns = useMemo<ColDef<InstanceSummary>[]>(() => [
    { field: 'receivedAt', headerName: 'Received', minWidth: 180, valueFormatter: (params) => formatWhen(params.value) },
    { field: 'fileName', headerName: 'File', minWidth: 200, flex: 1.2 },
    {
      colId: 'map',
      headerName: 'Map',
      minWidth: 160,
      valueGetter: (params) => params.data ? (params.data.mapSaved ? (params.data.mapName || 'Saved map') : (params.data.mapName || 'New file')) : '',
    },
    { field: 'rowCount', headerName: 'Rows', minWidth: 100, filter: 'agNumberColumnFilter' },
    { field: 'status', headerName: 'Status', minWidth: 120 },
    {
      colId: 'result',
      headerName: 'Result',
      minWidth: 220,
      flex: 1.2,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? resultText(params.data) : '',
    },
    {
      colId: 'review',
      headerName: '',
      width: 130,
      sortable: false,
      filter: false,
      cellRenderer: (params) => {
        if (!params.data) return null;
        const opening = params.context?.busy != null;
        return (
          <button type="button" className="btn" disabled={opening} onClick={() => params.context?.open(params.data.id)}>
            {params.context?.busy === 'open' ? 'Opening…' : 'Review'}
          </button>
        );
      },
    },
  ], []);

  function chosenDate() {
    return asOfMode === 'today' ? todayIso() : asOfDate;
  }

  function updateAssignment(index: number, next: ColumnAssignment) {
    setDetail((current) => {
      if (!current) return current;
      const columnMappings = current.columnMappings.slice();
      columnMappings[index] = next;
      return { ...current, columnMappings };
    });
  }

  async function processInstance(instanceId: string, mappings?: ColumnAssignment[]) {
    setBusy(instanceId);
    setError(null);
    try {
      const response = await fetch(`/api/feeds/position-file/${instanceId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columnMappings: mappings,
          asOfDate: mappings ? chosenDate() : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Process failed');
      openDetail(body);
      await refreshQueue();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`view-fade${detail ? ' load-review-page' : ''}`}>
      {error && <div className="filter-bar" style={{ color: '#b42318', borderColor: '#f0c2bc' }}>{error}</div>}
      {detail ? (
        <LoadReview
          fileId={detail.id}
          fileName={detail.fileName}
          rowCount={detail.rowCount}
          assignments={detail.columnMappings}
          targets={queue?.targets || []}
          lists={queue?.lists || []}
          resultText={detail.resultSummary ? resultText(detail) : null}
          errorMessage={detail.errorMessage}
          loading={busy === detail.id}
          asOfMode={asOfMode}
          asOfDate={asOfDate}
          chosenDate={chosenDate()}
          onAsOfMode={setAsOfMode}
          onAsOfDate={setAsOfDate}
          onChange={updateAssignment}
          onLoad={() => processInstance(detail.id, detail.columnMappings)}
          mapNote={detail.mapSaved
            ? `This file matches the saved map${detail.mapName ? ` ${detail.mapName}` : ''}. Columns already on that map are confirmed. Anything new still needs a decision, and loading updates the map.`
            : 'This file shape is new. Suggestions come from the column names and, where those are not enough, from an AI review. Loading saves the map for the next file with these columns.'}
          onClose={() => { setDetail(null); setError(null); }}
        />
      ) : (
      <>
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Load data</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#1b3a4b' }} />
          <div>
            <div className="page-title">Load data</div>
            <div className="page-meta">CSV or Excel · a confirmed map is saved for the next file with the same columns</div>
          </div>
        </div>
        <label className="btn btn-primary">
          {busy === 'upload' ? 'Storing file…' : 'Upload file'}
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setBusy('upload');
              setError(null);
              const form = new FormData();
              form.set('file', file);
              try {
                const response = await fetch('/api/feeds/position-file', { method: 'POST', body: form });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || 'The file could not be stored');
                openDetail(body);
                await refreshQueue();
              } catch (err: any) {
                setError(err.message);
              } finally {
                setBusy(null);
              }
            }}
          />
        </label>
      </div>

      <p className="hero-sub" style={{ maxWidth: 820, marginTop: 0 }}>
        Upload a CSV or Excel file. Tapestr suggests where each column goes, using a saved map when the columns have been seen before and an AI review when they have not. Loading saves that map.
      </p>

      <div className="section-title">
        <h2>Files</h2>
        <span className="hint">Each file keeps its rows. A confirmed column map is reused for the same columns.</span>
      </div>
      <div className="data-table" style={{ marginBottom: 22, minHeight: 280 }}>
        <AppGrid
          rows={queue?.instances || []}
          columns={fileColumns}
          getRowId={(row) => row.id}
          autoHeight={false}
          height="100%"
          loading={!queue}
          emptyMessage="No files stored yet. Upload a CSV or Excel file to add an instance."
          onRowClicked={(row) => selectInstance(row.id)}
          context={{ busy, open: selectInstance }}
        />
      </div>
      </>
      )}
    </div>
  );
}
