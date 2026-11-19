'use client';

import { useState } from 'react';
import type { BatchDetail, QualityFailure } from '@tapestrai/mcp-server/src/feeds/load-batches';

const SEVERITY_COLOR: Record<string, string> = { CRITICAL: '#b42318', HIGH: '#b54708', MEDIUM: '#475467', LOW: '#667085' };

export function countOf(value: number, one: string, many = `${one}s`) {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

/**
 * What a staged batch would write, and how it stands against the data quality
 * rules. A failing value that came from one cell of the file can be corrected
 * here. Used by the Load data screen and by the quality stage of a guided run.
 */
export function BatchChecks({
  batch,
  busy,
  onCorrect,
  onShowSource,
}: {
  batch: BatchDetail;
  busy: boolean;
  /** Saves a correction and runs the checks again. Rejects with the reason when the value does not fit. */
  onCorrect: (valueId: string, value: string, reason: string) => Promise<void>;
  /** Shows where a failing value sits in the file. Left out where there is nowhere to show it. */
  onShowSource?: (failure: QualityFailure) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const quality = batch.quality;
  const blocking = quality?.summary.blocking || 0;
  const newFailures = quality?.failures.filter((item) => item.state === 'NEW') || [];
  const oldFailures = quality?.failures.filter((item) => item.state === 'EXISTING') || [];

  async function save(valueId: string) {
    setSaving(true);
    try {
      await onCorrect(valueId, draft, reason);
      setEditing(null);
      setDraft('');
      setReason('');
    } catch {
      // The caller shows why. The box stays open so the value can be changed.
    } finally {
      setSaving(false);
    }
  }

  function failureRow(item: QualityFailure, index: number) {
    const key = `${item.recordId}-${item.ruleCode}-${index}`;
    const open = editing === key;
    return (
      <li key={key} style={{ marginBottom: 6 }}>
        <b style={{ color: SEVERITY_COLOR[item.severity] || undefined }}>{item.severity.toLowerCase()}</b>{' · '}
        <b>{item.entityName}</b>{item.recordAction === 'CREATE' ? ' (new)' : ''}{' · '}{item.ruleName}
        {item.attributeName ? ` · ${item.attributeName}` : ''}
        {item.actualValue ? `: ${item.actualValue}` : ''}
        {item.message ? ` · ${item.message}` : ''}
        {onShowSource && item.originColumn && item.originRow !== null && item.originRow !== undefined && (
          <>{' '}<button type="button" className="btn" onClick={() => onShowSource(item)}>Show in file</button></>
        )}
        {item.editable && item.valueId && !open && (
          <>{' '}<button type="button" className="btn" disabled={busy || saving} onClick={() => { setEditing(key); setDraft(item.stagedValue || ''); setReason(''); }}>Correct</button></>
        )}
        {open && item.valueId && (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <input aria-label={`Corrected value for ${item.attributeName || item.attributeCode}`} value={draft} onChange={(event) => setDraft(event.target.value)} />
            <input aria-label="Why the file is wrong" placeholder="Why the file is wrong" value={reason} onChange={(event) => setReason(event.target.value)} style={{ minWidth: 220 }} />
            <button type="button" className="btn" disabled={busy || saving || !draft.trim()} onClick={() => save(item.valueId as string)}>
              {saving ? 'Checking...' : 'Save and check again'}
            </button>
            <button type="button" className="btn" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
          </span>
        )}
      </li>
    );
  }

  return (
    <>
      <p className="load-sub" style={{ margin: 0 }}>
        Staged as of {batch.asOfDate}: <b>{countOf(batch.records.created, 'new record')}</b>, {countOf(batch.records.matched, 'matched record')}.
        Values: <b>{batch.values.added.toLocaleString()}</b> to add, <b>{batch.values.changed.toLocaleString()}</b> to change, {batch.values.unchanged.toLocaleString()} already stored
        {batch.values.edited > 0 && <>, <b>{batch.values.edited.toLocaleString()}</b> corrected here</>}.
      </p>

      {quality && (
        <>
          <p className="load-sub" style={{ margin: 0 }}>
            {countOf(quality.ruleCount, 'rule')} run on {countOf(quality.recordCount, 'record')}:{' '}
            <b style={quality.summary.newFailures ? { color: '#b42318' } : undefined}>{countOf(quality.summary.newFailures, 'new failure')}</b>
            {blocking > 0 && <> ({blocking.toLocaleString()} critical)</>}, {quality.summary.existingFailures.toLocaleString()} already failing today,{' '}
            {quality.summary.cleared.toLocaleString()} cleared by this batch, {countOf(quality.summary.missingRequired, 'required value')} missing.
          </p>
          {newFailures.length > 0 && (
            <details open>
              <summary>Failures this batch brings ({newFailures.length})</summary>
              <ul style={{ margin: '4px 0 8px 18px' }}>{newFailures.slice(0, 50).map(failureRow)}</ul>
              {newFailures.length > 50 && <p className="load-sub">and {newFailures.length - 50} more</p>}
            </details>
          )}
          {quality.missing.length > 0 && (
            <details>
              <summary>Required values still missing ({quality.missing.length})</summary>
              <ul style={{ margin: '4px 0 8px 18px' }}>
                {quality.missing.slice(0, 50).map((item, index) => (
                  <li key={`${item.recordId}-${item.attributeCode}-${index}`}><b>{item.entityName}</b>{item.state === 'NEW' ? ' (new)' : ''} · {item.attributeName}</li>
                ))}
              </ul>
            </details>
          )}
          {oldFailures.length > 0 && (
            <details>
              <summary>Already failing before this batch ({oldFailures.length})</summary>
              <ul style={{ margin: '4px 0 8px 18px' }}>{oldFailures.slice(0, 50).map(failureRow)}</ul>
            </details>
          )}
          {quality.outranked.length > 0 && (
            <details>
              <summary>Values a higher-ranked source will keep overriding ({quality.outranked.length})</summary>
              <ul style={{ margin: '4px 0 8px 18px' }}>
                {quality.outranked.slice(0, 50).map((item) => (
                  <li key={item.valueId}><b>{item.entityName}</b> · {item.attributeName}: file says {item.proposed ?? 'nothing'}, the record keeps {item.winning ?? 'nothing'}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}
