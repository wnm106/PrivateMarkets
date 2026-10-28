'use client';

import Link from 'next/link';
import { useState } from 'react';
import { graphqlMutation, CREATE_ENTITY_MUTATION, toRelationshipInputs } from '@/lib/graphql';
import { EntityForm } from '@/components/forms/EntityForm';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';
import { DomainKey } from '@/lib/mock-data';

export default function IssuersPage() {
  const domain: DomainKey = 'issuers';
  const [totalCount, setTotalCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const asOfDate = useTemporalStore(state => state.asOfDate);

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

      <EntityHome
        domainCode="ISSUER"
        domainKey={domain}
        asOfDate={asOfDate}
        refreshKey={refreshKey}
        emptyMessage="No issuers found. Add issuers via the generic entity API."
        onTotalChange={setTotalCount}
      />

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
