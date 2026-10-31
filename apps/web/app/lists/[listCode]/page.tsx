'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  graphqlQuery,
  graphqlMutation,
  REFERENCE_LIST_DETAIL_QUERY,
  UPDATE_REFERENCE_LIST_MUTATION,
  DELETE_REFERENCE_LIST_MUTATION,
  ADD_REFERENCE_LIST_VALUE_MUTATION,
  UPDATE_REFERENCE_LIST_VALUE_MUTATION,
  DELETE_REFERENCE_LIST_VALUE_MUTATION,
} from '@/lib/graphql';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

interface ReferenceListValue {
  id: string;
  valueCode: string;
  valueLabel: string;
  displayOrder: number;
  isActive: boolean;
  synonyms: string[];
}

interface ReferenceListDetail {
  id: string;
  listCode: string;
  listName: string;
  domainCode?: string | null;
  description?: string | null;
  isActive: boolean;
  activeValueCount: number;
  totalSynonymCount: number;
  linkedAttributeCount: number;
  values: ReferenceListValue[];
}

function firstError(result: { data?: any; error?: any }, key: string): string | null {
  const fieldError = result.data?.[key]?.errors?.[0]?.message;
  if (fieldError) return fieldError;
  if (result.error?.message) return result.error.message;
  return null;
}

function LabelCell(props: any) {
  const row = props.data;
  const editing = !!row?.__editing;
  const draft = props.context?.get?.()?.draft;
  const [value, setValue] = useState(draft?.current?.label || row?.valueLabel || '');
  useEffect(() => {
    if (editing) setValue(draft?.current?.label || '');
  }, [editing, row?.id]);
  if (!row || props.node?.group) return props.value || null;
  if (!editing) return <span style={{ color: row.isActive ? 'var(--ink)' : 'var(--ink-3)' }}>{row.valueLabel}</span>;
  return (
    <input
      className="text-input"
      value={value}
      onChange={(event) => {
        if (draft) draft.current.label = event.target.value;
        setValue(event.target.value);
      }}
    />
  );
}

function SynonymCell(props: any) {
  const row = props.data;
  const editing = !!row?.__editing;
  const draft = props.context?.get?.()?.draft;
  const [value, setValue] = useState(draft?.current?.synonyms || '');
  useEffect(() => {
    if (editing) setValue(draft?.current?.synonyms || '');
  }, [editing, row?.id]);
  if (!row || props.node?.group) return props.value || null;
  if (!editing) return <span style={{ color: 'var(--ink-3)' }}>{row.synonymText}</span>;
  return (
    <input
      className="text-input"
      value={value}
      onChange={(event) => {
        if (draft) draft.current.synonyms = event.target.value;
        setValue(event.target.value);
      }}
    />
  );
}

function ValueActions(props: any) {
  const row = props.data;
  if (!row || props.node?.group) return null;
  const actions = props.context.get();
  if (row.__editing) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={actions.saving} onClick={() => actions.saveValue(row)}>Save</button>
        <button type="button" className="btn btn-sm" disabled={actions.saving} onClick={() => actions.setEditingId(null)}>Cancel</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
      <button type="button" className="btn btn-sm" disabled={actions.saving} onClick={() => actions.startEdit(row)}>Edit</button>
      <button type="button" className="btn btn-sm" disabled={actions.saving} onClick={() => actions.toggleValue(row)}>{row.isActive ? 'Hide' : 'Show'}</button>
      <button type="button" className="btn btn-sm" disabled={actions.saving} onClick={() => actions.deleteValue(row)}>Remove</button>
    </div>
  );
}

function parseSynonyms(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export default function ReferenceListDetailPage() {
  const params = useParams();
  const router = useRouter();
  const listCode = params.listCode as string;

  const [list, setList] = useState<ReferenceListDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const [listName, setListName] = useState('');
  const [description, setDescription] = useState('');

  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newSynonyms, setNewSynonyms] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const draft = useRef({ label: '', synonyms: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{ referenceList: ReferenceListDetail | null }, { listCode: string }>(
      REFERENCE_LIST_DETAIL_QUERY,
      { listCode },
      'network-only'
    );
    if (result.error) {
      setError(result.error.message || 'Failed to load this value list');
      setList(null);
    } else if (!result.data?.referenceList) {
      setError('This value list could not be found.');
      setList(null);
    } else {
      const next = result.data.referenceList;
      setList(next);
      setListName(next.listName);
      setDescription(next.description || '');
    }
    setLoading(false);
  }, [listCode]);

  useEffect(() => {
    if (listCode) load();
  }, [listCode, load]);

  const values = useMemo(() => {
    const rows = [...(list?.values || [])].sort((a, b) => a.displayOrder - b.displayOrder || a.valueLabel.localeCompare(b.valueLabel));
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) =>
      row.valueCode.toLowerCase().includes(query) ||
      row.valueLabel.toLowerCase().includes(query) ||
      (row.synonyms || []).some((synonym) => synonym.toLowerCase().includes(query))
    );
  }, [list, search]);

  const runMutation = async (work: () => Promise<string | null>) => {
    setSaving(true);
    setError(null);
    try {
      const message = await work();
      if (message) setError(message);
      else await load();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const saveList = () => runMutation(async () => {
    if (!list) return 'List is still loading';
    const result = await graphqlMutation(UPDATE_REFERENCE_LIST_MUTATION, {
      input: { id: list.id, listName: listName.trim(), description: description.trim() || null },
    });
    return firstError(result, 'updateReferenceList');
  });

  const toggleListActive = () => runMutation(async () => {
    if (!list) return 'List is still loading';
    const result = await graphqlMutation(UPDATE_REFERENCE_LIST_MUTATION, {
      input: { id: list.id, isActive: !list.isActive },
    });
    return firstError(result, 'updateReferenceList');
  });

  const deleteList = async () => {
    if (!list) return;
    if (!window.confirm(`Delete ${list.listName}? Canonical values on this list will be removed.`)) return;
    setSaving(true);
    setError(null);
    const result = await graphqlMutation<{ deleteReferenceList: { success: boolean } }>(
      DELETE_REFERENCE_LIST_MUTATION,
      { id: list.id }
    );
    const message = firstError(result, 'deleteReferenceList');
    setSaving(false);
    if (message) {
      setError(message);
      return;
    }
    router.push('/lists');
  };

  const addValue = () => runMutation(async () => {
    const valueCode = newCode.trim().toUpperCase().replace(/\s+/g, '_');
    const valueLabel = newLabel.trim();
    if (!valueCode || !valueLabel) return 'A value code and label are required.';
    const nextOrder = (list?.values || []).reduce((max, row) => Math.max(max, row.displayOrder || 0), 0) + 1;
    const result = await graphqlMutation(ADD_REFERENCE_LIST_VALUE_MUTATION, {
      input: {
        listCode,
        valueCode,
        valueLabel,
        displayOrder: nextOrder,
        synonyms: parseSynonyms(newSynonyms),
      },
    });
    const message = firstError(result, 'addReferenceListValue');
    if (!message) {
      setNewCode('');
      setNewLabel('');
      setNewSynonyms('');
    }
    return message;
  });

  const startEdit = (row: ReferenceListValue) => {
    draft.current = { label: row.valueLabel, synonyms: (row.synonyms || []).join(', ') };
    setEditingId(row.id);
  };

  const saveValue = (row: ReferenceListValue) => runMutation(async () => {
    const result = await graphqlMutation(UPDATE_REFERENCE_LIST_VALUE_MUTATION, {
      input: {
        id: row.id,
        valueLabel: draft.current.label.trim() || row.valueLabel,
        synonyms: parseSynonyms(draft.current.synonyms),
      },
    });
    const message = firstError(result, 'updateReferenceListValue');
    if (!message) setEditingId(null);
    return message;
  });

  const toggleValue = (row: ReferenceListValue) => runMutation(async () => {
    const result = await graphqlMutation(UPDATE_REFERENCE_LIST_VALUE_MUTATION, {
      input: { id: row.id, isActive: !row.isActive },
    });
    return firstError(result, 'updateReferenceListValue');
  });

  const deleteValue = (row: ReferenceListValue) => runMutation(async () => {
    if (!window.confirm(`Remove ${row.valueLabel} from this list?`)) return null;
    const result = await graphqlMutation(DELETE_REFERENCE_LIST_VALUE_MUTATION, { id: row.id });
    return firstError(result, 'deleteReferenceListValue');
  });

  const gridRows = useMemo(() => values.map((row) => ({
    ...row,
    synonymText: (row.synonyms || []).length > 0 ? row.synonyms.join(', ') : '—',
    statusLabel: row.isActive ? 'Active' : 'Inactive',
    __editing: row.id === editingId,
  })), [values, editingId]);
  const valueActions = useRef({ startEdit, saveValue, toggleValue, deleteValue, setEditingId, draft, saving });
  valueActions.current = { startEdit, saveValue, toggleValue, deleteValue, setEditingId, draft, saving };
  const valueContext = useMemo(() => ({ get: () => valueActions.current }), []);
  const valueColumns = useMemo<ColDef<(typeof gridRows)[number]>[]>(() => [
    { field: 'valueCode', headerName: 'Code', minWidth: 160, cellClass: 'mono' },
    { colId: 'label', headerName: 'Label', minWidth: 180, flex: 1, autoHeight: true, valueGetter: (params) => params.data?.valueLabel || '', cellRenderer: LabelCell },
    { colId: 'synonyms', headerName: 'Synonyms', minWidth: 220, flex: 1.4, autoHeight: true, wrapText: true, valueGetter: (params) => params.data?.synonymText || '', cellRenderer: SynonymCell },
    { field: 'statusLabel', headerName: 'Status', minWidth: 110 },
    { colId: 'actions', headerName: '', width: 250, sortable: false, filter: false, cellRenderer: ValueActions },
  ], []);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/lists" className="crumb-link">Standardized Value Lists</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{list?.listName || listCode}</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{list?.listName || 'Value list'}</div>
          <div className="page-meta">
            <span className="mono">{listCode}</span>
            {list?.domainCode ? ` · ${list.domainCode}` : ''}
            {list ? ` · ${list.activeValueCount} canonical values · ${list.totalSynonymCount} synonyms · ${list.linkedAttributeCount} linked attributes` : ''}
          </div>
        </div>
        {list && (
          <div className="page-actions">
            <button className="btn" onClick={toggleListActive} disabled={saving}>
              {list.isActive ? 'Deactivate' : 'Activate'}
            </button>
            <button className="btn" onClick={deleteList} disabled={saving}>Delete</button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: '#fdecec', color: 'var(--red)', border: '1px solid var(--red)', padding: '12px 16px', marginBottom: '14px', fontSize: '12px' }}>
          {error}
        </div>
      )}
      {loading && !list ? (
        <div style={{ color: 'var(--ink-3)', fontSize: '12px', textAlign: 'center', padding: '40px' }}>
          Loading value list...
        </div>
      ) : list ? (
        <>
          <div className="data-table" style={{ padding: '18px 20px', marginBottom: '14px' }}>
            <div className="form-grid">
              <div className="field">
                <label>List name</label>
                <input className="text-input" value={listName} onChange={(e) => setListName(e.target.value)} />
              </div>
              <div className="field">
                <label>Description</label>
                <input className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>
            <div style={{ marginTop: '12px' }}>
              <button className="btn btn-primary" onClick={saveList} disabled={saving || !listName.trim()}>
                Save list
              </button>
            </div>
          </div>

          <div className="data-table" style={{ padding: '18px 20px', marginBottom: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>Add canonical value</div>
            <div className="form-grid" style={{ gridTemplateColumns: '180px 1fr 1.4fr' }}>
              <div className="field">
                <label>Code</label>
                <input className="text-input" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} placeholder="SENIOR_SECURED" />
              </div>
              <div className="field">
                <label>Label</label>
                <input className="text-input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Senior Secured" />
              </div>
              <div className="field">
                <label>Synonyms</label>
                <input className="text-input" value={newSynonyms} onChange={(e) => setNewSynonyms(e.target.value)} placeholder="Sr. Sec., First Lien" />
              </div>
            </div>
            <div style={{ marginTop: '12px' }}>
              <button className="btn btn-primary" onClick={addValue} disabled={saving}>Add value</button>
            </div>
          </div>

          <div className="filter-bar">
            <span className="filter-label">Values</span>
            <input
              className="text-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search code, label, or synonym"
              style={{ maxWidth: '320px', padding: '7px 10px' }}
            />
            <span className="filter-count"><strong>{values.length}</strong> shown</span>
          </div>

          <div className="data-table">
            <AppGrid
              rows={gridRows}
              columns={valueColumns}
              getRowId={(row) => row.id}
              autoHeight={false}
              height="100%"
              autoRowHeight
              emptyMessage={search ? 'No values match that search.' : 'No canonical values yet. Add the first one above.'}
              context={valueContext}
              layoutKey={`${editingId || ''}:${saving}`}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
