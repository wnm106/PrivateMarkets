'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { graphqlQuery, graphqlMutation, DEALS_QUERY, CREATE_ENTITY_MUTATION, toRelationshipInputs } from '@/lib/graphql';
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

export default function DealsPage() {
  const [entities, setEntities] = useState<EntityNode[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchDeals = useCallback(async () => {
    const { data } = await graphqlQuery<{ deals: { edges: { node: EntityNode }[]; totalCount: number } }>(
      DEALS_QUERY,
      {}
    );
    if (data?.deals) {
      setEntities(data.deals.edges.map(e => e.node));
      setTotalCount(data.deals.totalCount);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  const handleCreate = async (formData: any) => {
    const { data, error } = await graphqlMutation<{ createEntity: { entity: any; errors: any[] } }>(
      CREATE_ENTITY_MUTATION,
      {
        input: {
          entityCode: formData.code,
          entityName: formData.name,
          domainCode: 'DEAL',
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
      await fetchDeals();
    }
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Deals</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#047857' }}></div>
          <div>
            <div className="page-title">Deals</div>
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
          Status: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-pill">
          Deal Type: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
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
          <div className="tbl-row"><div>No deals found. Add deals via the generic entity API.</div></div>
        ) : (
          entities.map((entity) => (
            <div key={entity.id} className="tbl-row">
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
          ))
        )}
      </div>

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Create New Deal</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }}>×</button>
            </div>
            <EntityForm
              domain="deals"
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
