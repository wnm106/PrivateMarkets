'use client';

import Link from 'next/link';
import { standardizedLists } from '@/lib/data';

export default function ListsPage() {
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
            18 controlled vocabularies · 412 mapped synonyms · 23 unmapped values pending review
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Import</button>
          <button className="btn btn-primary">+ New List</button>
        </div>
      </div>

      {/* Lists Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
        {standardizedLists.map((list, idx) => (
          <div key={idx} className="entity-card" style={{ '--card-accent': 'var(--accent-2)' } as React.CSSProperties}>
            <div className="entity-head">
              <div>
                <div className="entity-name" style={{ fontSize: '15px' }}>
                  {list.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                  {list.count} canonical values
                </div>
              </div>
              {list.unmapped > 0 ? (
                <span className="conflict-num" style={{ fontSize: '11px' }}>
                  {list.unmapped} unmapped
                </span>
              ) : (
                <span className="check" style={{ fontSize: '18px' }}>✓</span>
              )}
            </div>
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
                  Mapped
                </div>
                <div className="mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                  {list.mapped}
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
                  Sources
                </div>
                <div style={{ color: 'var(--ink)', fontWeight: 500, fontSize: '11px' }}>
                  {list.sources.length}
                </div>
              </div>
            </div>
            <div className="entity-sources">
              {list.sources.map((src) => (
                <span key={src} className="src-tag">
                  {src}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
