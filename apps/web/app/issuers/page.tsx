'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { graphqlQuery, graphqlMutation, ISSUERS_QUERY, CREATE_ENTITY_MUTATION, toRelationshipInputs } from '@/lib/graphql';
import { EntityForm } from '@/components/forms/EntityForm';
import { useTemporalStore } from '@/lib/store';
import { DomainKey } from '@/lib/mock-data';

interface EntityNode {
  id: string;
  entityCode: string;
  entityName: string;
  attributes: Record<string, any>;
  parentRelationships: Array<{
    parentEntityCode: string;
    parentEntityName: string;
    relationshipType: string;
  }>;
}

export default function IssuersPage() {
  const domain: DomainKey = 'issuers';
  const [entities, setEntities] = useState<EntityNode[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  const fetchIssuers = useCallback(async () => {
    const { data } = await graphqlQuery<{ issuers: { edges: { node: EntityNode }[]; totalCount: number } }>(
      ISSUERS_QUERY,
      { asOfDate }
    );
    if (data?.issuers) {
      setEntities(data.issuers.edges.map(e => e.node));
      setTotalCount(data.issuers.totalCount);
    }
    setLoading(false);
  }, [asOfDate]);

  useEffect(() => {
    fetchIssuers();
  }, [fetchIssuers]);

  const handleCreate = async (formData: any) => {
    const { data, error } = await graphqlMutation<{ createEntity: { entity: any; errors: any[] } }>(
      CREATE_ENTITY_MUTATION,
      {
        input: {
          entityCode: formData.code,
          entityName: formData.name,
          domainCode: 'ISSUER',
          templateCode: formData.template,
          description: formData.description || '',
          attributes: formData.attributes || {},
          parentRelationships: toRelationshipInputs(formData.parentRelationships, 'parent'),
          childRelationships: toRelationshipInputs(formData.childRelationships, 'child'),
        },
      }
    );
    if (data?.createEntity?.entity) {
      setShowCreateModal(false);
      await fetchIssuers();
    }
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Issuers</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#6d28d9' }}></div>
          <div>
            <div className="page-title">Issuers</div>
            <div className="page-meta">{totalCount} records · Generic Entity Model</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Record</button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <div className="filter-pill">
          Industry: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-pill">
          Country: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-count">
          Showing <strong>{entities.length}</strong> of {totalCount}
        </div>
      </div>

      <div className="data-table">
        <div className="tbl-head">
          <div>ID</div>
          <div>Name</div>
          <div>Attributes</div>
          <div>Relationships</div>
          <div style={{ textAlign: 'center' }}>Status</div>
        </div>
        {loading ? (
          <div className="tbl-row"><div>Loading...</div></div>
        ) : entities.length === 0 ? (
          <div className="tbl-row"><div>No issuers found. Add issuers via the generic entity API.</div></div>
        ) : (
          entities.map((entity) => {
            return (
              <Link key={entity.id} href={`/${domain}/${entity.id}`}>
                <div className="tbl-row" style={{ cursor: 'pointer' }}>
                  <div className="row-id">{entity.entityCode}</div>
                  <div className="row-name">{entity.entityName}</div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                    {Object.keys(entity.attributes || {}).slice(0, 3).map(k => (
                      <span key={k} style={{ marginRight: '8px' }}>
                        {k}: {String(entity.attributes[k]?.value ?? '').slice(0, 20)}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                    {entity.parentRelationships?.map((r, i) => (
                      <span key={i} style={{ marginRight: '8px' }}>
                        ← {r.parentEntityName} ({r.relationshipType})
                      </span>
                    ))}
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <span className="status-chip active">Active</span>
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Create New Issuer</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }}>×</button>
            </div>
            <EntityForm
              domain="issuers"
              mode="create"
              onSubmit={handleCreate}
              onCancel={() => setShowCreateModal(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
