'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { ConfirmButton } from '@/components/feeds/ConfirmButton';
import { SourcePane, type SourceTarget } from '@/components/feeds/SourcePane';
import type { FileUnderstanding } from '@tapestrai/mcp-server/src/feeds/import-document';
import type { StageScreenProps } from './index';
import { useReportProgress } from './useProgress';

const METHOD: Record<string, string> = {
  tabular: 'Read as a table',
  json: 'Read as JSON records',
  local: 'Read on this server',
  llamaparse: 'Read with LlamaParse',
  azure_layout: 'Read with Azure Document Intelligence',
  agent: 'Table lifted from the text by a model',
};

const card: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: '#fff', display: 'grid', gap: 6 };
const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };
const cellStyle: CSSProperties = { padding: '4px 8px', borderBottom: '1px solid var(--line)', fontSize: 12, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' };

async function json<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'That could not be done');
  return data as T;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * The first stage of an intake: the file on the left, what was found in it on
 * the right. The person says what kind of document it is, which table to load,
 * and which stored record it is about, before any column is mapped.
 */
export function UnderstandStage({ stage, busy, onComplete, onProgress }: StageScreenProps) {
  const fileId = String(stage.args.importInstanceId || '');
  const [found, setFound] = useState<FileUnderstanding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [typeCode, setTypeCode] = useState('');
  const [entityId, setEntityId] = useState('');
  const [pointing, setPointing] = useState<SourceTarget | null>(null);
  const [revision, setRevision] = useState(0);

  const open = useCallback((next: FileUnderstanding) => {
    setFound(next);
    setTypeCode((current) => current || next.document?.typeCode || '');
    setEntityId((current) => current || next.document?.linked[0]?.entityId || (next.matches.length === 1 ? next.matches[0].id : ''));
  }, []);

  useEffect(() => {
    if (!fileId) {
      setError('This stage was not given a file.');
      return;
    }
    let live = true;
    json<FileUnderstanding>(`/api/feeds/position-file/${fileId}/understanding`)
      .then((next) => live && open(next))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [fileId, open]);

  // The document is read and embedded by the worker after it is stored. Follow it until it settles.
  const indexing = found?.document && (found.document.status === 'RECEIVED' || found.document.status === 'PROCESSING');
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => {
      json<FileUnderstanding>(`/api/feeds/position-file/${fileId}/understanding`).then(open).catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [indexing, fileId, open]);

  async function chooseTable(tableId: string) {
    setWorking(true);
    setError(null);
    try {
      await json(`/api/feeds/position-file/${fileId}/table`, { tableId });
      setPointing(null);
      setRevision((value) => value + 1);
      open(await json<FileUnderstanding>(`/api/feeds/position-file/${fileId}/understanding`));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  /** Read the stored file again and rebuild its column mapping, then look at what was found anew. */
  async function readAgain() {
    setWorking(true);
    setError(null);
    try {
      await json(`/api/feeds/position-file/${fileId}/refresh`, {});
      setEntityId('');
      setRevision((value) => value + 1);
      open(await json<FileUnderstanding>(`/api/feeds/position-file/${fileId}/understanding`));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  async function confirm() {
    if (!found) return;
    setWorking(true);
    setError(null);
    try {
      const role = found.kind.code === 'FINANCIAL_STATEMENT' ? 'BORROWER' : found.kind.code === 'NAV_STATEMENT' ? 'FUND' : 'SUBJECT';
      await json(`/api/feeds/position-file/${fileId}/understanding`, { documentTypeCode: typeCode || null, entityId: entityId || null, role });
      await onComplete('confirmed', { documentId: found.document?.id || null, documentTypeCode: typeCode || null, entityId: entityId || null });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  // What this screen asks of the person, in the order it is laid out.
  const chosenTable = found ? found.tables.find((item) => item.selected) || found.tables[0] || null : null;
  const linked = found?.matches.find((match) => match.id === entityId);
  useReportProgress(onProgress, found ? {
    parts: [
      found.document
        ? { label: 'Say what kind of document this is', done: Boolean(typeCode), note: found.documentTypes.find((type) => type.code === typeCode)?.name }
        : { label: 'Say what kind of document this is', done: true, note: 'Not kept as a document' },
      ...(found.tables.length > 1 ? [{ label: 'Choose the table to load', done: found.rowCount > 0, note: chosenTable?.name }] : []),
      ...(found.subject && found.matches.length > 0 ? [{ label: 'Link the record it is about', done: Boolean(entityId), note: linked ? linked.name : 'Optional' }] : []),
      { label: 'Confirm and go on to mapping', done: false },
    ],
  } : null);

  if (error && !found) return <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>;
  if (!found) return <div style={{ color: 'var(--ink-3)' }}>Reading the file…</div>;

  const table = found.tables.find((item) => item.selected) || found.tables[0] || null;
  const disabled = busy || working;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn" disabled={busy || working} onClick={() => { void readAgain(); }} title="Read the file again and rebuild its column mapping. Your load history is kept.">
          {working ? 'Reading…' : 'Read the file again'}
        </button>
      </div>
      <div className="stage-split stage-split-file-first">
        <div className="stage-source">
          <SourcePane instanceId={fileId} fileName={found.fileName} target={pointing} revision={revision} height="min(70vh, 600px)" />
        </div>

        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <div style={card}>
            <span style={label}>What this is</span>
            <span style={{ fontSize: 14 }}><b>{found.kind.label}</b>{found.asOfDate ? `, as of ${found.asOfDate}` : ''}</span>
            {found.intake && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{METHOD[found.intake.method] || found.intake.method}. {found.intake.note}</span>}
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>File it as</span>
              <select aria-label="Document type" value={typeCode} disabled={disabled || !found.document} onChange={(event) => setTypeCode(event.target.value)}>
                {!typeCode && <option value="">Choose a document type</option>}
                {found.documentTypes.map((type) => <option key={type.code} value={type.code}>{type.name}</option>)}
              </select>
            </label>
          </div>

          {found.tables.length > 1 && (
            <div style={card}>
              <span style={label}>Which table to load</span>
              <select aria-label="Table to load" value={table?.tableId || ''} disabled={disabled} onChange={(event) => chooseTable(event.target.value)}>
                {found.tables.map((item) => <option key={item.tableId} value={item.tableId}>{item.name} · {plural(item.rowCount, 'row')} · {plural(item.headers.length, 'column')}</option>)}
              </select>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{found.tables.length} tables were found. One is loaded by this run.</span>
            </div>
          )}

          <div style={card}>
            <span style={label}>What was found</span>
            {found.recordTypes.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>No column was recognised as identifying a record yet. You choose one in the next stage.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {found.recordTypes.map((item) => (
                  <li key={`${item.domainCode}-${item.identifiedBy}`}>
                    <b>{plural(item.count, 'record')}</b> of type {item.domainCode}, identified by{' '}
                    <button type="button" onClick={() => setPointing({ column: item.identifiedBy, label: item.identifiedBy })} title="Show where this column is in the file" style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
                      “{item.identifiedBy}”
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{plural(found.rowCount, 'row')} in the selected table.</span>
          </div>

          {found.subject && (
            <div style={card}>
              <span style={label}>Who it is about</span>
              <span style={{ fontSize: 14 }}>The file names <b>{found.subject.name || found.subject.code}</b>.</span>
              {found.subjectBasis && (
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  Found by searching the “{found.subjectBasis.column}” value, {found.subjectBasis.value}: {found.subjectBasis.how}. {Math.round(found.subjectBasis.confidence * 100)}% sure.
                </span>
              )}
              {found.matches.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No stored {found.subject.domainCode.toLowerCase()} has this name or code, so loading will create one.</span>
              ) : (
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  <span>Link the document to</span>
                  <select aria-label="Record this file is about" value={entityId} disabled={disabled || !found.document} onChange={(event) => setEntityId(event.target.value)}>
                    <option value="">No stored record</option>
                    {found.matches.map((match) => <option key={match.id} value={match.id}>{match.name} ({match.code}){match.domainCode ? `, ${match.domainCode.toLowerCase().replace(/_/g, ' ')}` : ''}{match.confidence != null ? `, ${Math.round(match.confidence * 100)}%` : ''}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}

          <div style={card}>
            <span style={label}>Search</span>
            {found.document ? (
              <span style={{ fontSize: 13 }}>
                {found.document.status === 'READY' && <>Indexed for search: {plural(found.document.chunkCount, 'passage')}. </>}
                {indexing && <>Being read for search… </>}
                {found.document.status === 'FAILED' && <span style={{ color: '#b42318' }}>It could not be read for search. {found.document.message} </span>}
                <Link href={`/documents/${found.document.id}`} target="_blank" style={{ color: 'var(--entity-link)' }}>Open the document</Link>
              </span>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>Not indexed for search.</span>
            )}
            {found.documentNote && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{found.documentNote}</span>}
          </div>
        </div>
      </div>

      <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <ConfirmButton className="load-btn sec" disabled={disabled} confirmLabel="Yes, stop the run" title="Nothing has been staged or loaded." onConfirm={() => void onComplete('abandoned', {})}>Stop this run</ConfirmButton>
        <button type="button" className="load-btn" disabled={disabled || found.rowCount === 0} onClick={confirm}>
          {working || busy ? 'Working…' : 'This is right, go on to mapping'}
        </button>
      </span>
    </div>
  );
}
