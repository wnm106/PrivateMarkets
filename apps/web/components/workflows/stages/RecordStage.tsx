'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { SourcePane } from '@/components/feeds/SourcePane';
import type { FileRecordIdentity } from '@tapestrai/mcp-server/src/feeds/import-document';
import type { StageScreenProps } from './index';
import { useReportProgress } from './useProgress';

/**
 * The stage that asks which stored record a file is about, when the file did not name one surely enough.
 * The file is on the left. On the right are the records it resembles, best first, and a search for any other
 * record of the type. The person chooses one, or stops the run.
 */

const card: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: '#fff', display: 'grid', gap: 8 };
const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };

interface Option { id: string; code: string; name: string; note?: string }

export function RecordStage({ stage, busy, onComplete, onProgress }: StageScreenProps) {
  const fileId = String(stage.args.importInstanceId || '');
  const recordType = String(stage.args.recordType || '');
  const typeLabel = recordType.toLowerCase().replace(/_/g, ' ') || 'record';
  const [found, setFound] = useState<(FileRecordIdentity & { matches: { id: string; code: string; name: string }[] }) | null>(null);
  const [typed, setTyped] = useState('');
  const [chosen, setChosen] = useState<Option | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!fileId || !recordType) {
      setError('This stage was not given a file and a type of record.');
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      fetch(`/api/feeds/position-file/${fileId}/record?recordType=${encodeURIComponent(recordType)}&q=${encodeURIComponent(typed)}`)
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'The records could not be searched');
          return body;
        })
        .then((body) => live && setFound(body))
        .catch((err) => live && setError(err.message));
    }, typed ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [fileId, recordType, typed]);

  const likely: Option[] = (found?.candidates || []).map((item) => ({ id: item.id, code: item.code, name: item.name, note: `${Math.round(item.confidence * 100)}%, ${item.how}` }));
  const searched: Option[] = (found?.matches || []).filter((item) => !likely.some((other) => other.id === item.id)).slice(0, 12);

  useReportProgress(onProgress, {
    parts: [
      { label: `Choose the ${typeLabel} this file is about`, done: Boolean(chosen), note: chosen?.name },
      { label: 'Use it and go on', done: false },
    ],
  });

  async function settle(outcome: 'chosen' | 'none') {
    setWorking(true);
    setError(null);
    try {
      await onComplete(outcome, outcome === 'chosen' && chosen ? { entityId: chosen.id, name: chosen.name } : {});
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;
  const row = (option: Option) => (
    <label key={option.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, cursor: 'pointer' }}>
      <input type="radio" name="record" checked={chosen?.id === option.id} onChange={() => setChosen(option)} disabled={disabled} />
      <span><b>{option.name}</b> <span style={{ color: 'var(--ink-3)' }}>({option.code}){option.note ? `, ${option.note}` : ''}</span></span>
    </label>
  );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      <div className="stage-split stage-split-file-first">
        <div className="stage-source">
          <SourcePane instanceId={fileId} fileName={found?.fileName || ''} target={null} revision={0} height="min(70vh, 600px)" />
        </div>
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <div style={card}>
            <span style={label}>Which {typeLabel}</span>
            <span style={{ fontSize: 14 }}>{found ? found.note : 'Searching the file for a name…'}</span>
          </div>
          <div style={card}>
            {likely.length > 0 && <span style={label}>The file resembles</span>}
            {likely.map(row)}
            <span style={label}>Search all {typeLabel}s</span>
            <input aria-label={`Search ${typeLabel}s`} value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={`Name or code of the ${typeLabel}`} disabled={disabled} />
            {typed.trim().length >= 2 && searched.length === 0 && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No stored {typeLabel} has that name or code.</span>}
            {searched.map(row)}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" disabled={disabled} onClick={() => { void settle('none'); }}>Stop this run</button>
            <button type="button" className="btn btn-primary" disabled={disabled || !chosen} onClick={() => { void settle('chosen'); }}>
              {working ? 'Working…' : `Use this ${typeLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
