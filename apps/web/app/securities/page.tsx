'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { graphqlQuery, graphqlMutation, SECURITIES_QUERY, CREATE_ENTITY_MUTATION, toRelationshipInputs } from '@/lib/graphql';
import { EntityForm } from '@/components/forms/EntityForm';

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

export default function SecuritiesPage() {
  const [entities, setEntities] = useState<EntityNode[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchSecurities = useCallback(async () => {
    const { data } = await graphqlQuery<{ securities: { edges: { node: EntityNode }[]; totalCount: number } }>(
      SECURITIES_QUERY,
      {}
    );
    if (data?.securities) {
      setEntities(data.securities.edges.map(e => e.node));
      setTotalCount(data.securities.totalCount);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSecurities();
  }, [fetchSecurities]);

  const handleCreate = async (formData: any) => {
    const { data, error } = await graphqlMutation<{ createEntity: { entity: any; errors: any[] } }>(
      CREATE_ENTITY_MUTATION,
      {
        input: {
          entityCode: formData.code,
          entityName: formData.name,
          domainCode: 'SECURITY',
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
      await fetchSecurities();
    }
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Securities</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#c2410c' }}></div>
          <div>
            <div className="page-title">Securities</div>
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
          Instrument Type: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-pill">
          Primary Source: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
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
          <div>Issuer</div>
          <div style={{ textAlign: 'center' }}>Status</div>
        </div>
        {loading ? (
          <div className="tbl-row"><div>Loading...</div></div>
        ) : entities.length === 0 ? (
          <div className="tbl-row"><div>No securities found. Add securities via the generic entity API.</div></div>
        ) : (
          entities.map((entity) => {
            const issuerRel = entity.parentRelationships?.find(r => r.relationshipType === 'SECURITY_ISSUER');
            return (
              <Link key={entity.id} href={`/securities/${entity.id}`}>
                <div className="tbl-row">
                  <div className="row-id">{entity.entityCode}</div>
                  <div className="row-name">{entity.entityName}</div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                    {Object.entries(entity.attributes || {}).slice(0, 3).map(([k, v]: [string, any]) => (
                      <span key={k} style={{ marginRight: '8px' }}>
                        {k}: {String(v?.value ?? '').slice(0, 20)}
                      </span>
                    ))}
                  </div>
                  <div style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
                    {issuerRel ? issuerRel.parentEntityName : '—'}
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
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Create New Security</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }}>×</button>
            </div>
            <EntityForm
              domain="securities"
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
