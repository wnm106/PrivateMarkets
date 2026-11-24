'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ConfirmButton } from '@/components/feeds/ConfirmButton';
import { SourcePane } from '@/components/feeds/SourcePane';
import { aboutList, fileChoices, likelyChoice, searchChoices, type FileChoice, type StoredFile } from '@/lib/file-choice';
import type { StageScreenProps } from './index';
import { useReportProgress } from './useProgress';

/**
 * The stage that gives a run its file. The files stored in Load data are on
 * the left, with the ones that name the run's records first; the file chosen
 * is shown as it is on the right. A file not stored yet is uploaded here and
 * goes through the standard loader, the same as an upload in Load data. The
 * person hands one file to the run, or says there is none.
 */

const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };
const TONE: Record<FileChoice['tone'], string> = { new: '#166534', loaded: 'var(--ink-3)', trouble: '#b45309' };
const SHOWN = 30;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function day(value: string) {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReceiveStage({ stage, busy, onComplete, onProgress }: StageScreenProps) {
  const expecting = String(stage.args.expecting || '').trim();
  const about = stage.args.about;
  const aboutNames = useMemo(() => aboutList(about), [about]);
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState<'upload' | 'hand' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/feeds/position-file');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The stored files could not be listed');
    setFiles((body.instances || []) as StoredFile[]);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  const choices = useMemo(() => fileChoices(files || [], about), [files, about]);
  const listed = useMemo(() => searchChoices(choices, typed), [choices, typed]);
  const chosen = choices.find((choice) => choice.file.id === chosenId) || null;
  const mentioning = choices.filter((choice) => choice.mentions).length;

  // When one file stands out it is opened to start with. The person still hands it over themself.
  useEffect(() => {
    if (chosenId || choices.length === 0) return;
    const likely = likelyChoice(choices);
    if (likely) setChosenId(likely.file.id);
  }, [choices, chosenId]);

  useReportProgress(onProgress, files ? {
    parts: [
      { label: 'Choose the file, or upload it', done: Boolean(chosen), note: chosen?.file.fileName },
      { label: 'Look at it and hand it to the run', done: false },
    ],
  } : null);

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setWorking('upload');
    setError(null);
    try {
      let last: string | null = null;
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch('/api/feeds/position-file', { method: 'POST', body: form });
        const body = await response.json();
        if (!response.ok) throw new Error(`${file.name}: ${body.error || 'the file could not be stored'}`);
        last = String(body.id);
        setUploaded((current) => [...current, String(body.id)]);
      }
      await load();
      if (last) setChosenId(last);
    } catch (err: any) {
      setError(err.message);
      await load().catch(() => undefined);
    } finally {
      setWorking(null);
      if (picker.current) picker.current.value = '';
    }
  }

  async function hand() {
    if (!chosen) return;
    setWorking('hand');
    setError(null);
    try {
      await onComplete('received', { importInstanceId: chosen.file.id, fileName: chosen.file.fileName, loadedBefore: chosen.loaded, uploadedHere: uploaded.includes(chosen.file.id) });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }

  const disabled = busy || working !== null;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {expecting && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', background: 'var(--bg-alt)', display: 'grid', gap: 2 }}>
          <span style={label}>What this run expects</span>
          <span style={{ fontSize: 13.5 }}>{expecting}</span>
          {aboutNames.length > 0 && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>The run is about {aboutNames.slice(0, 4).join(', ')}{aboutNames.length > 4 ? ` and ${aboutNames.length - 4} more` : ''}.</span>}
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}

      <div className="stage-split">
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="text-input" type="search" aria-label="Find a stored file by name" placeholder="Find a stored file by name" value={typed} onChange={(event) => setTyped(event.target.value)} style={{ flex: 1, minWidth: 180, fontSize: 13 }} />
            <label className="btn" style={{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
              {working === 'upload' ? 'Reading the file…' : 'Upload a file'}
              <input ref={picker} type="file" multiple hidden disabled={disabled} onChange={(event) => void upload(event.target.files)} />
            </label>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {files === null
              ? 'Listing the stored files…'
              : `${plural(choices.length, 'file')} stored in Load data${mentioning > 0 ? `, ${mentioning} naming a record of this run, listed first` : ''}. An upload is read into tables whatever its format, and kept.`}
          </div>

          <ul role="listbox" aria-label="Stored files" style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', maxHeight: 'min(60vh, 520px)', overflowY: 'auto' }}>
            {files !== null && listed.length === 0 && (
              <li style={{ padding: 14, fontSize: 13, color: 'var(--ink-3)' }}>{choices.length === 0 ? 'No file is stored yet. Upload the file this run needs.' : 'No stored file has that in its name.'}</li>
            )}
            {listed.slice(0, SHOWN).map((choice) => {
              const selected = choice.file.id === chosenId;
              return (
                <li key={choice.file.id} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    className="run-step"
                    onClick={() => setChosenId(choice.file.id)}
                    style={{ display: 'grid', gap: 2, width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: '1px solid var(--line)', background: selected ? 'var(--bg-alt, #f8fafc)' : 'transparent', boxShadow: selected ? 'inset 3px 0 0 var(--accent)' : undefined, cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-word' }}>{choice.file.fileName}</span>
                    <span style={{ display: 'flex', gap: '2px 10px', flexWrap: 'wrap', fontSize: 12, color: 'var(--ink-3)' }}>
                      <span style={{ fontWeight: 600, color: TONE[choice.tone] }}>{choice.standing}</span>
                      <span>Received {day(choice.file.receivedAt)}</span>
                      <span>{plural(choice.file.rowCount, 'row')}</span>
                      {choice.mentions && <span style={{ color: '#6d28d9', fontWeight: 600 }}>Names {choice.mentions}</span>}
                      {uploaded.includes(choice.file.id) && <span style={{ fontWeight: 600 }}>Uploaded just now</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {listed.length > SHOWN && <li style={{ padding: '8px 12px', fontSize: 12, color: 'var(--ink-3)' }}>And {listed.length - SHOWN} more. Type part of the name to find one.</li>}
          </ul>
        </div>

        <div className="stage-source" style={{ display: 'grid', gap: 8 }}>
          {chosen ? (
            <>
              <div style={{ display: 'grid', gap: 2 }}>
                <span style={label}>The file as it is</span>
                <span style={{ fontSize: 13 }}>
                  <b>{chosen.file.fileName}</b>
                  {chosen.file.asOfDate ? `, as of ${chosen.file.asOfDate}` : ''}
                  {chosen.file.mapSaved && chosen.file.mapName ? `. A saved map fits it: ${chosen.file.mapName}` : ''}.
                </span>
                {chosen.loaded && (
                  <span role="note" style={{ fontSize: 12.5, color: '#b45309' }}>
                    {chosen.standing}. Handing it over loads it again, which states its values again as of the date you set when you map it.
                  </span>
                )}
                {chosen.file.errorMessage && chosen.tone === 'trouble' && <span style={{ fontSize: 12.5, color: '#b45309' }}>{chosen.file.errorMessage}</span>}
              </div>
              <SourcePane instanceId={chosen.file.id} fileName={chosen.file.fileName} target={null} height="min(60vh, 520px)" />
            </>
          ) : (
            <div style={{ border: '1px dashed var(--line-strong)', borderRadius: 8, padding: 24, fontSize: 13, color: 'var(--ink-3)', textAlign: 'center' }}>
              Choose a file on the left to see it here, or upload the one this run needs.
            </div>
          )}
        </div>
      </div>

      <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <ConfirmButton className="load-btn sec" disabled={disabled} confirmLabel="Yes, go on without a file" title="The run goes on with what is already on file. Nothing is loaded." onConfirm={() => void onComplete('none', { reason: 'No file to load' })}>
          There is no file to load
        </ConfirmButton>
        <button type="button" className="load-btn" disabled={disabled || !chosen || chosen.file.status === 'PROCESSING'} onClick={hand}>
          {working === 'hand' || busy ? 'Working…' : chosen ? 'Use this file' : 'Choose a file first'}
        </button>
      </span>
    </div>
  );
}
