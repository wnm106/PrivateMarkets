'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [editLabel, setEditLabel] = useState('');
  const [editSynonyms, setEditSynonyms] = useState('');

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
    setEditingId(row.id);
    setEditLabel(row.valueLabel);
    setEditSynonyms((row.synonyms || []).join(', '));
  };

  const saveValue = (row: ReferenceListValue) => runMutation(async () => {
    const result = await graphqlMutation(UPDATE_REFERENCE_LIST_VALUE_MUTATION, {
      input: {
        id: row.id,
        valueLabel: editLabel.trim() || row.valueLabel,
        synonyms: parseSynonyms(editSynonyms),
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
            <div style={{ display: 'grid', gridTemplateColumns: '160px minmax(120px, 1fr) minmax(160px, 1.4fr) 72px 220px', gap: '12px', padding: '12px 18px', background: 'var(--bg)', borderBottom: '1px solid var(--line)', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)' }}>
              <div>Code</div>
              <div>Label</div>
              <div>Synonyms</div>
              <div>Status</div>
              <div></div>
            </div>
            {values.length === 0 ? (
              <div style={{ padding: '28px 18px', color: 'var(--ink-3)', fontSize: '12px' }}>
                {search ? 'No values match that search.' : 'No canonical values yet. Add the first one above.'}
              </div>
            ) : values.map((row) => (
              <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '160px minmax(120px, 1fr) minmax(160px, 1.4fr) 72px 220px', gap: '12px', padding: '14px 18px', borderBottom: '1px solid var(--line)', fontSize: '12px', alignItems: 'center' }}>
                <div className="mono" style={{ color: 'var(--accent)', fontWeight: 500 }}>{row.valueCode}</div>
                {editingId === row.id ? (
                  <input className="text-input" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} style={{ padding: '7px 10px' }} />
                ) : (
                  <div style={{ color: row.isActive ? 'var(--ink)' : 'var(--ink-3)' }}>{row.valueLabel}</div>
                )}
                {editingId === row.id ? (
                  <input className="text-input" value={editSynonyms} onChange={(e) => setEditSynonyms(e.target.value)} style={{ padding: '7px 10px' }} />
                ) : (
                  <div style={{ color: 'var(--ink-3)', lineHeight: 1.5 }}>
                    {(row.synonyms || []).length > 0 ? row.synonyms.join(', ') : '—'}
                  </div>
                )}
                <div style={{ color: row.isActive ? 'var(--ink)' : 'var(--ink-3)' }}>{row.isActive ? 'Active' : 'Inactive'}</div>
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                  {editingId === row.id ? (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={() => saveValue(row)} disabled={saving}>Save</button>
                      <button className="btn btn-sm" onClick={() => setEditingId(null)} disabled={saving}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-sm" onClick={() => startEdit(row)} disabled={saving}>Edit</button>
                      <button className="btn btn-sm" onClick={() => toggleValue(row)} disabled={saving}>{row.isActive ? 'Hide' : 'Show'}</button>
                      <button className="btn btn-sm" onClick={() => deleteValue(row)} disabled={saving}>Remove</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
