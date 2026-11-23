'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { graphqlClient, graphqlQuery, graphqlMutation, REFERENCE_LISTS_QUERY, CREATE_REFERENCE_LIST_MUTATION, DOMAIN_TYPES_QUERY } from '@/lib/graphql';
import { usePublishPageData, usePublishViewContext } from '@/lib/view-context';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

interface ReferenceListSummary {
  id: string;
  listCode: string;
  listName: string;
  domainCode?: string;
  description?: string;
  isActive: boolean;
  activeValueCount: number;
  totalSynonymCount: number;
  totalValueCount: number;
  linkedAttributeCount: number;
  createdAt?: string;
  updatedAt?: string;
}

interface DomainTypeOption {
  domainCode: string;
  domainName: string;
}

export default function ListsPage() {
  const router = useRouter();
  const [lists, setLists] = useState<ReferenceListSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [domains, setDomains] = useState<DomainTypeOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState({ listCode: '', listName: '', domainCode: '', description: '' });

  useEffect(() => {
    graphqlClient
      .query(REFERENCE_LISTS_QUERY, {}, { requestPolicy: 'network-only' })
      .toPromise()
      .then((result) => {
        setLists(result.data?.referenceLists || []);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!showCreate || domains.length > 0) return;
    graphqlQuery<{ domainTypes: DomainTypeOption[] }>(DOMAIN_TYPES_QUERY, {}, 'network-only').then((result) => {
      setDomains(result.data?.domainTypes || []);
    });
  }, [showCreate, domains.length]);

  const createList = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    const listCode = form.listCode.trim().toUpperCase().replace(/\s+/g, '_');
    const result = await graphqlMutation<{ createReferenceList: { referenceList?: { listCode: string } | null; errors: Array<{ message: string }> } }>(
      CREATE_REFERENCE_LIST_MUTATION,
      {
        input: {
          listCode,
          listName: form.listName.trim(),
          domainCode: form.domainCode || null,
          description: form.description.trim() || null,
        },
      }
    );
    const message = result.data?.createReferenceList?.errors?.[0]?.message || result.error?.message;
    setCreating(false);
    if (message || !result.data?.createReferenceList?.referenceList) {
      setCreateError(message || 'Could not create the list');
      return;
    }
    router.push(`/lists/${result.data.createReferenceList.referenceList.listCode}`);
  };

  const sortedLists = useMemo(
    () => [...lists].sort((a, b) => a.listName.localeCompare(b.listName, undefined, { sensitivity: 'base' })),
    [lists]
  );

  const columns = useMemo<ColDef<ReferenceListSummary>[]>(() => [
    { field: 'listName', headerName: 'List', minWidth: 200, flex: 1, sort: 'asc', cellStyle: { fontWeight: 600 } },
    { field: 'listCode', headerName: 'Code', minWidth: 180, cellClass: 'mono' },
    { field: 'domainCode', headerName: 'Domain', minWidth: 160, valueGetter: (p) => p.data?.domainCode || 'Shared' },
    { field: 'description', headerName: 'Description', minWidth: 280, flex: 2, tooltipField: 'description' },
    { field: 'activeValueCount', headerName: 'Active values', minWidth: 120, type: 'numericColumn', filter: 'agNumberColumnFilter' },
    { field: 'totalValueCount', headerName: 'Total values', minWidth: 120, type: 'numericColumn', filter: 'agNumberColumnFilter' },
    { field: 'totalSynonymCount', headerName: 'Synonyms', minWidth: 110, type: 'numericColumn', filter: 'agNumberColumnFilter' },
    { field: 'linkedAttributeCount', headerName: 'Linked attributes', minWidth: 140, type: 'numericColumn', filter: 'agNumberColumnFilter' },
    { field: 'isActive', headerName: 'Status', minWidth: 100, valueGetter: (p) => (p.data?.isActive ? 'Active' : 'Inactive') },
    { field: 'updatedAt', headerName: 'Updated', minWidth: 120, valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : '') },
  ], []);

  const totalSynonyms = lists.reduce((sum, l) => sum + l.totalSynonymCount, 0);
  const linkedAttrs = lists.reduce((sum, l) => sum + l.linkedAttributeCount, 0);

  usePublishViewContext({
    activity: 'viewing',
    kind: 'reference_list',
    label: 'Standardized Value Lists',
    summary: 'Controlled vocabularies that normalize imported values',
  });

  usePublishPageData(loading ? null : {
    purpose: 'Every standardized value list, alphabetical, with its domain and counts',
    howToRead: 'Active values are the canonical values a source value maps to; synonyms are source spellings mapped onto them; linked attributes are attributes whose values are drawn from the list. Domain "Shared" means the list is not tied to one domain.',
    totals: { lists: lists.length, synonyms: totalSynonyms, linkedAttributes: linkedAttrs },
    lists: sortedLists.map((l) => ({
      list: l.listName,
      code: l.listCode,
      domain: l.domainCode || 'Shared',
      description: l.description || null,
      activeValues: l.activeValueCount,
      totalValues: l.totalValueCount,
      synonyms: l.totalSynonymCount,
      linkedAttributes: l.linkedAttributeCount,
      active: l.isActive,
    })),
  });

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Standardized Value Lists</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Standardized Value Lists</div>
          <div className="page-meta">
            {lists.length} controlled vocabularies · {totalSynonyms} mapped synonyms · {linkedAttrs} linked attributes
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" type="button">Import</button>
          <button className="btn btn-primary" type="button" onClick={() => { setCreateError(null); setShowCreate(true); }}>+ New List</button>
        </div>
      </div>

      {showCreate && (
        <div
          className="overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
          onClick={() => setShowCreate(false)}
        >
          <div
            style={{ background: 'var(--bg)', width: '100%', maxWidth: '520px', border: '1px solid var(--line)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <form onSubmit={createList}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)', fontSize: '18px', fontWeight: 600 }}>
                New value list
              </div>
              <div style={{ padding: '24px', display: 'grid', gap: '16px' }}>
                {createError && <div className="field-error">{createError}</div>}
                <div className="field">
                  <label>List code</label>
                  <input className="text-input" required value={form.listCode} onChange={(e) => setForm({ ...form, listCode: e.target.value.toUpperCase() })} placeholder="INSTRUMENT_TYPE" />
                </div>
                <div className="field">
                  <label>List name</label>
                  <input className="text-input" required value={form.listName} onChange={(e) => setForm({ ...form, listName: e.target.value })} placeholder="Instrument Type" />
                </div>
                <div className="field">
                  <label>Domain</label>
                  <select className="select" value={form.domainCode} onChange={(e) => setForm({ ...form, domainCode: e.target.value })}>
                    <option value="">Shared</option>
                    {domains.map((domain) => (
                      <option key={domain.domainCode} value={domain.domainCode}>{domain.domainName}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Description</label>
                  <input className="text-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
              </div>
              <div style={{ padding: '16px 24px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button className="btn" type="button" onClick={() => setShowCreate(false)}>Cancel</button>
                <button className="btn btn-primary" type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create list'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      <div className="data-table">
        <AppGrid
          rows={sortedLists}
          columns={columns}
          getRowId={(row) => row.id}
          autoHeight={false}
          height="100%"
          loading={loading}
          emptyMessage="No reference lists defined yet. Create one to start normalizing imported values."
          onRowClicked={(row) => router.push(`/lists/${row.listCode}`)}
        />
      </div>
    </div>
  );
}
