'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery, CREATE_ENTITY_MUTATION, DOMAIN_TYPES_QUERY, toRelationshipInputs } from '@/lib/graphql';
import { EntityForm } from '@/components/forms/EntityForm';
import { EntityAttributeTable } from '@/components/entities/EntityAttributeTable';
import { useTemporalStore } from '@/lib/store';
import { domainCodeFromRoute } from '@/lib/domain-routes';

const ACCENTS: Record<string, string> = {
  PRICE: '#0a84e0',
  CASH_FLOW: '#047857',
};

export default function DomainListPage() {
  const params = useParams();
  const route = String(params.domain || '');
  const domainCode = domainCodeFromRoute(route);
  const [domainName, setDomainName] = useState(domainCode.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
  const [known, setKnown] = useState<boolean | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string; isActive: boolean }> }>(
      DOMAIN_TYPES_QUERY,
      {},
      'network-only'
    ).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setKnown(false);
        return;
      }
      const match = (result.data?.domainTypes || []).find((domain) => domain.domainCode === domainCode && domain.isActive);
      setKnown(Boolean(match));
      if (match) setDomainName(match.domainName);
    });
    return () => { cancelled = true; };
  }, [domainCode]);

  const handleCreate = async (formData: any) => {
    const { data } = await graphqlMutation<{ createEntity: { entity: any; errors: any[] } }>(
      CREATE_ENTITY_MUTATION,
      {
        input: {
          entityCode: formData.code,
          entityName: formData.name,
          domainCode,
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

  if (known === false) {
    return (
      <div className="view-fade" style={{ padding: '48px 0', color: 'var(--ink-3)' }}>
        No entity type matches this page.
      </div>
    );
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{domainName}</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: ACCENTS[domainCode] || '#1e40af' }}></div>
          <div>
            <div className="page-title">{domainName}</div>
            <div className="page-meta">{totalCount} records · Generic Entity Model</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Record</button>
        </div>
      </div>

      <EntityAttributeTable
        domainCode={domainCode}
        domainKey={route}
        asOfDate={asOfDate}
        refreshKey={refreshKey}
        emptyMessage={`No ${domainName.toLowerCase()} records yet.`}
        onTotalChange={setTotalCount}
      />

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Create New {domainName}</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }}>×</button>
            </div>
            <EntityForm
              domain={route}
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
