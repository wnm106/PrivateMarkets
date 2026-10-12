'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { graphqlClient, REFERENCE_LISTS_QUERY } from '@/lib/graphql';

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

export default function ListsPage() {
  const [lists, setLists] = useState<ReferenceListSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    graphqlClient
      .query(REFERENCE_LISTS_QUERY, {}, { requestPolicy: 'network-only' })
      .toPromise()
      .then((result) => {
        setLists(result.data?.referenceLists || []);
      })
      .finally(() => setLoading(false));
  }, []);

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
          <button className="btn">Import</button>
          <button className="btn btn-primary">+ New List</button>
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
    </div>
  );
}
