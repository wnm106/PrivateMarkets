'use client';

import Link from 'next/link';
import { useState } from 'react';
import { graphqlMutation, CREATE_ENTITY_MUTATION, toRelationshipInputs } from '@/lib/graphql';
import { EntityForm } from '@/components/forms/EntityForm';
import { type RelatedAttributeColumn } from '@/components/entities/EntityAttributeTable';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';

const RELATED: RelatedAttributeColumn[] = [
  {
    alias: 'fund',
    label: 'Fund',
    direction: 'UP',
    relationshipCode: 'POSITION_FUND',
    domainCode: 'FUND',
    field: 'entity_name',
    header: 'Fund',
  },
  {
    alias: 'security',
    label: 'Security',
    direction: 'UP',
    relationshipCode: 'POSITION_SECURITY',
    domainCode: 'SECURITY',
    field: 'entity_name',
    header: 'Security',
  },
];

export default function PositionsPage() {
  const [totalCount, setTotalCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  const handleCreate = async (formData: any) => {
    const { data } = await graphqlMutation<{ createEntity: { entity: any; errors: any[] } }>(
      CREATE_ENTITY_MUTATION,
      {
        input: {
          entityCode: formData.code,
          entityName: formData.name,
          domainCode: 'POSITION',
          templateCode: formData.template,
          description: formData.description || '',
          clientId: formData.clientId || null,
          attributes: formData.attributes || {},
          parentRelationships: toRelationshipInputs(formData.parentRelationships, 'parent'),
          childRelationships: toRelationshipInputs(formData.childRelationships, 'child'),
        },
      }
    );
    if (data?.createEntity?.entity) {
      setShowCreateModal(false);
      setRefreshKey((k) => k + 1);
    }
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Positions</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#0369a1' }}></div>
          <div>
            <div className="page-title">Positions</div>
            <div className="page-meta">{totalCount.toLocaleString()} records · Linked to fund and security</div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/imports" className="btn">Load position file</Link>
          <Link href="/load" className="btn">Any file</Link>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Record</button>
        </div>
      </div>

      <EntityHome
        domainCode="POSITION"
        domainKey="positions"
        asOfDate={asOfDate}
        refreshKey={refreshKey}
        emptyMessage="No positions yet. Load a position file to create issuers, funds, securities, and positions."
        related={RELATED}
        onTotalChange={setTotalCount}
      />

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Create New Position</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }}>×</button>
            </div>
            <EntityForm
              domain="positions"
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
