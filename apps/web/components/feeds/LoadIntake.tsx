'use client';

import { useState } from 'react';

export interface IntakeInfo {
  method: string;
  note: string | null;
  profile: { format: string; pages: number | null; route: string; reasons: string[] } | null;
}

export interface TableChoice {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
}

const METHOD_LABEL: Record<string, string> = {
  tabular: 'Read as a table',
  json: 'Read as JSON records',
  local: 'Read on this server',
  llamaparse: 'Read with LlamaParse',
  azure_layout: 'Read with Azure Document Intelligence',
  agent: 'Table lifted from text by the model',
};

/** How the file was read, and which table is being loaded when there is more than one. */
export function IntakePanel({
  intake,
  tables,
  tableId,
  disabled,
  onSelectTable,
  onViewOriginal,
}: {
  onViewOriginal?: () => void;
  intake: IntakeInfo | null;
  tables: TableChoice[];
  tableId: string | null;
  disabled: boolean;
  onSelectTable: (id: string) => void;
}) {
  if (!intake && tables.length < 2) return null;
  const outside = intake?.method === 'llamaparse' || intake?.method === 'azure_layout' || intake?.method === 'agent';
  return (
    <div className="load-sub" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
      {intake && (
        <p style={{ margin: 0 }}>
          <b>{METHOD_LABEL[intake.method] || intake.method}.</b>{' '}
          {intake.note}
          {outside && ' The file was sent to that service to be read. Check the columns before you load.'}
          {onViewOriginal && <>{' '}<button type="button" className="btn" onClick={onViewOriginal}>View the original</button></>}
        </p>
      )}
      {tables.length > 1 && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span><b>{tables.length} tables found.</b> Load:</span>
          <select
            aria-label="Table to load"
            value={tableId || tables[0].id}
            disabled={disabled}
            onChange={(event) => onSelectTable(event.target.value)}
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name} · {table.rowCount.toLocaleString()} rows · {table.columnCount} columns
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

const NEW_SOURCE = '__new__';

/** Which source the values belong to. A new name is added to the registry when the file loads. */
export function SourcePicker({
  sources,
  value,
  fallbackLabel,
  disabled,
  onChange,
}: {
  sources: { code: string; name: string }[];
  value: string | null;
  fallbackLabel: string;
  disabled: boolean;
  onChange: (code: string | null) => void;
}) {
  const known = value ? sources.some((source) => source.code === value) : true;
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const selected = creating ? NEW_SOURCE : value && known ? value : value ? NEW_SOURCE : '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>Source</span>
        <select
          aria-label="Source of these values"
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (next === NEW_SOURCE) {
              setCreating(true);
              return;
            }
            setCreating(false);
            onChange(next || null);
          }}
        >
          <option value="">{fallbackLabel}</option>
          {sources.map((source) => <option key={source.code} value={source.code}>{source.name}</option>)}
          {value && !known && <option value={NEW_SOURCE}>{value} (new)</option>}
          <option value={NEW_SOURCE}>A new source…</option>
        </select>
      </label>
      {creating && (
        <span style={{ display: 'flex', gap: 6 }}>
          <input
            aria-label="New source name"
            placeholder="Name the source"
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={disabled || !draft.trim()}
            onClick={() => {
              onChange(draft.trim());
              setCreating(false);
              setDraft('');
            }}
          >
            Use it
          </button>
        </span>
      )}
    </div>
  );
}

const TYPE_OPTIONS = [
  { value: 'STRING', label: 'Text' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'DATE', label: 'Date' },
  { value: 'PERCENTAGE', label: 'Percent' },
];

export function guessDataType(samples: string[]): string {
  const values = samples.map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return 'STRING';
  const share = (test: (value: string) => boolean) => values.filter(test).length / values.length;
  if (share((value) => /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) >= 0.8) return 'DATE';
  if (share((value) => /^[($€£-]?[\d.,]+%?\)?$/.test(value)) >= 0.8) return values.every((value) => value.endsWith('%')) ? 'PERCENTAGE' : 'NUMBER';
  return 'STRING';
}

/** Add a field to the catalog for a column that has nowhere to live. Nothing is created until the user presses the button. */
export function TrackAttribute({
  column,
  samples,
  domains,
  onTrack,
}: {
  column: string;
  samples: string[];
  domains: { code: string; label: string }[];
  onTrack: (input: { domainCode: string; attributeName: string; dataType: string; column: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(column);
  const [domain, setDomain] = useState(domains[0]?.code || '');
  const [dataType, setDataType] = useState(guessDataType(samples));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (domains.length === 0) return null;
  if (!open) {
    return (
      <button type="button" className="btn" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        None of these fit. Track it as a new field…
      </button>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      <label>Field name <input aria-label="New field name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>
        On{' '}
        <select aria-label="Record type for the new field" value={domain} onChange={(event) => setDomain(event.target.value)}>
          {domains.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
        </select>
      </label>
      <label>
        Holds{' '}
        <select aria-label="Type of the new field" value={dataType} onChange={(event) => setDataType(event.target.value)}>
          {TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      {error && <span style={{ color: '#b42318' }}>{error}</span>}
      <span style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onTrack({ domainCode: domain, attributeName: name.trim(), dataType, column });
              setOpen(false);
            } catch (err: any) {
              setError(err?.message || 'The field could not be added');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Adding…' : 'Add the field and use it'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </span>
    </div>
  );
}
