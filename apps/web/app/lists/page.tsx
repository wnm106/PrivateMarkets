'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { graphqlClient, graphqlQuery, graphqlMutation, REFERENCE_LISTS_QUERY, CREATE_REFERENCE_LIST_MUTATION, DOMAIN_TYPES_QUERY } from '@/lib/graphql';

interface ReferenceListSummary {
  id: string;
  listCode: string;
  listName: string;
  domainCode?: string;
  description?: string;
  isActive: boolean;
  activeValueCount: number;
  totalSynonymCount: number;
  linkedAttributeCount: number;
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

  const totalValues = lists.reduce((sum, l) => sum + l.activeValueCount, 0);
  const totalSynonyms = lists.reduce((sum, l) => sum + l.totalSynonymCount, 0);
  const linkedAttrs = lists.reduce((sum, l) => sum + l.linkedAttributeCount, 0);

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

      {loading ? (
        <div style={{ color: 'var(--ink-3)', fontSize: '12px', textAlign: 'center', padding: '40px' }}>
          Loading reference lists...
        </div>
      ) : lists.length === 0 ? (
        <div style={{ color: 'var(--ink-3)', fontSize: '12px', textAlign: 'center', padding: '40px' }}>
          No reference lists defined yet. Create one to start normalizing imported values.
        </div>
      ) : (
        /* Lists Grid */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
          {lists.map((list) => (
            <Link
              key={list.id}
              href={`/lists/${list.listCode}`}
              className="entity-card"
              style={{ '--card-accent': 'var(--accent-2)', textDecoration: 'none' } as React.CSSProperties}
            >
              <div className="entity-head">
                <div>
                  <div className="entity-name" style={{ fontSize: '15px' }}>
                    {list.listName}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                    {list.activeValueCount} canonical values
                    {list.linkedAttributeCount > 0 && (
                      <span style={{ marginLeft: '8px', color: 'var(--accent-2)' }}>
                        · {list.linkedAttributeCount} attr{list.linkedAttributeCount !== 1 ? 's' : ''} linked
                      </span>
                    )}
                  </div>
                </div>
                {list.domainCode ? (
                  <span className="src-tag" style={{ fontSize: '10px' }}>
                    {list.domainCode}
                  </span>
                ) : (
                  <span className="check" style={{ fontSize: '18px' }}>✓</span>
                )}
              </div>
              {list.description && (
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '6px', lineHeight: '1.4' }}>
                  {list.description}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderTop: '1px solid var(--line)',
                  borderBottom: '1px solid var(--line)',
                  margin: '12px 0',
                  fontSize: '11px',
                }}
              >
                <div>
                  <div
                    style={{
                      color: 'var(--ink-3)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.7px',
                      fontSize: '9px',
                      marginBottom: '3px',
                    }}
                  >
                    Synonyms
                  </div>
                  <div className="mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                    {list.totalSynonymCount}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      color: 'var(--ink-3)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.7px',
                      fontSize: '9px',
                      marginBottom: '3px',
                    }}
                  >
                    Values
                  </div>
                  <div style={{ color: 'var(--ink)', fontWeight: 500, fontSize: '11px' }}>
                    {list.activeValueCount}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

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
    </div>
  );
}
