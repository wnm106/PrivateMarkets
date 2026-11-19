'use client';

import { useCallback, useEffect, useState } from 'react';
import { LoadReview } from '@/components/feeds/LoadReview';
import { SourcePane, type SourceTarget } from '@/components/feeds/SourcePane';
import type { ColumnAssignment, MappingTarget } from '@/lib/feeds/suggest';
import type { EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';
import type { StageScreenProps } from './index';

interface FileDetail {
  id: string;
  fileName: string;
  rowCount: number;
  asOfDate: string | null;
  sourceCode?: string | null;
  mapName: string | null;
  mapSaved: boolean;
  intake?: { method: string; note: string | null; profile: { format: string; pages: number | null; route: string; reasons: string[] } | null } | null;
  tables?: { id: string; name: string; rowCount: number; columnCount: number }[];
  tableId?: string | null;
  columnMappings: ColumnAssignment[];
}

interface Catalog {
  targets: MappingTarget[];
  lists: { listCode: string; values: { code: string; label: string; synonyms?: string[] | null }[] }[];
  sources?: { code: string; name: string }[];
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'That could not be done');
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * The mapping stage of a guided run: the stored file beside where each column
 * goes. Confirming saves the mapping and the date on the file and hands the run
 * on to stage the values.
 */
export function LoadMapStage({ stage, busy, onComplete }: StageScreenProps) {
  const fileId = String(stage.args.importInstanceId || '');
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [asOfMode, setAsOfMode] = useState<'today' | 'specific'>('specific');
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [revision, setRevision] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pointing, setPointing] = useState<SourceTarget | null>(null);

  const open = useCallback((file: FileDetail) => {
    setDetail(file);
    if (file.asOfDate) {
      setAsOfDate(file.asOfDate);
      setAsOfMode('specific');
    }
  }, []);

  useEffect(() => {
    if (!fileId) {
      setError('This stage was not given a file.');
      return;
    }
    let live = true;
    Promise.all([json<FileDetail>(`/api/feeds/position-file/${fileId}`), json<Catalog>('/api/feeds/position-file')])
      .then(([file, queue]) => {
        if (!live) return;
        open(file);
        setCatalog(queue);
      })
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [fileId, open]);

  const chosenDate = asOfMode === 'today' ? todayIso() : asOfDate;

  async function replaceFile(url: string, body?: unknown) {
    setWorking('reload');
    setError(null);
    try {
      open(await json<FileDetail>(url, post(body ?? {})));
      setRevision((value) => value + 1);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }

  async function confirm(resolutions: EntityResolutionDecision[]) {
    if (!detail) return;
    setWorking('confirm');
    setError(null);
    try {
      await json(`/api/feeds/position-file/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnMappings: detail.columnMappings, asOfDate: chosenDate }),
      });
      await onComplete('confirmed', { asOfDate: chosenDate, ...(resolutions.length > 0 ? { resolutions } : {}) });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }

  if (error && !detail) return <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>;
  if (!detail || !catalog) return <div style={{ color: 'var(--ink-3)' }}>Opening the file…</div>;

  return (
    <div className="stage-split">
      <div style={{ minWidth: 0 }}>
      {error && <div role="alert" style={{ color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
      <LoadReview
        fileId={detail.id}
        fileName={detail.fileName}
        rowCount={detail.rowCount}
        assignments={detail.columnMappings}
        targets={catalog.targets}
        lists={catalog.lists}
        resultText={null}
        errorMessage={null}
        loading={busy || working === 'confirm'}
        reloading={working === 'reload'}
        mappingRevision={revision}
        asOfMode={asOfMode}
        asOfDate={asOfDate}
        chosenDate={chosenDate}
        onAsOfMode={setAsOfMode}
        onAsOfDate={setAsOfDate}
        onChange={(index, next) => setDetail((current) => {
          if (!current) return current;
          const columnMappings = current.columnMappings.slice();
          columnMappings[index] = next;
          return { ...current, columnMappings };
        })}
        onLoad={() => undefined}
        onPreview={(resolutions) => json(`/api/feeds/position-file/${detail.id}/preview`, post({ columnMappings: detail.columnMappings, asOfDate: chosenDate, resolutions }))}
        intake={detail.intake}
        tables={detail.tables}
        tableId={detail.tableId}
        onSelectTable={(tableId) => replaceFile(`/api/feeds/position-file/${detail.id}/table`, { tableId })}
        sources={catalog.sources}
        sourceCode={detail.sourceCode}
        onSourceChange={async (code) => {
          try {
            const saved = await json<{ sourceCode: string | null }>(`/api/feeds/position-file/${detail.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sourceCode: code }),
            });
            setDetail((current) => (current ? { ...current, sourceCode: saved.sourceCode } : current));
          } catch (err: any) {
            setError(err.message);
          }
        }}
        onTrackAttribute={async (input) => {
          const added = await json<{ domainCode: string; attributeCode: string }>('/api/feeds/position-file/attributes', post(input));
          setCatalog(await json<Catalog>('/api/feeds/position-file'));
          return `attribute:${added.domainCode}:${added.attributeCode}`;
        }}
        onReload={() => replaceFile(`/api/feeds/position-file/${detail.id}/refresh`)}
        mapNote={detail.mapSaved
          ? `This file matches the saved map${detail.mapName ? ` ${detail.mapName}` : ''}. Columns already on that map are confirmed.`
          : 'This file shape is new. Suggestions come from the column names and, where those are not enough, from an AI review.'}
        onClose={() => undefined}
        guided={{
          confirming: busy || working === 'confirm',
          onConfirm: confirm,
          onAbandon: () => void onComplete('abandoned', {}),
          onShowSource: setPointing,
        }}
      />
      </div>
      <div className="stage-source">
        <SourcePane instanceId={detail.id} fileName={detail.fileName} target={pointing} revision={revision} height="min(72vh, 660px)" />
        <p className="load-sub" style={{ margin: '6px 2px 0' }}>Click a column name, or Show in file, to see where it is read from.</p>
      </div>
    </div>
  );
}
