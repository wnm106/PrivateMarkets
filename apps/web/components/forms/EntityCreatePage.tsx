'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EntityForm } from '@/components/forms/EntityForm';
import { CREATE_ENTITY_MUTATION, DOMAIN_TYPES_QUERY, graphqlMutation, graphqlQuery, toRelationshipInputs } from '@/lib/graphql';
import { domainCodeFromRoute, domainColor } from '@/lib/domain-routes';

const FORM_ID = 'entity-create';

export function EntityCreatePage({ route, domainName }: { route: string; domainName?: string }) {
  const router = useRouter();
  const domainCode = domainCodeFromRoute(route);
  const listHref = `/${route}`;
  const [name, setName] = useState(domainName || titleFromCode(domainCode));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (domainName) return;
    let cancelled = false;
    graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string; isActive: boolean }> }, Record<string, never>>(
      DOMAIN_TYPES_QUERY,
      {},
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const match = (result.data?.domainTypes || []).find((domain) => domain.domainCode === domainCode && domain.isActive);
      if (match?.domainName) setName(match.domainName);
    });
    return () => { cancelled = true; };
  }, [domainCode, domainName]);

  const handleCreate = async (formData: any) => {
    setSaving(true);
    setError('');
    const result = await graphqlMutation<{ createEntity: { entity: { id: string } | null; errors: Array<{ message: string }> } }, { input: Record<string, unknown> }>(
      CREATE_ENTITY_MUTATION,
      {
        input: {
          entityCode: formData.code,
          entityName: formData.name,
          domainCode,
          templateCode: formData.template,
          description: formData.description || '',
          attributes: formData.attributes || {},
          parentRelationships: toRelationshipInputs(formData.parentRelationships, 'parent'),
          childRelationships: toRelationshipInputs(formData.childRelationships, 'child'),
        },
      },
    );
    const message = result.error?.message || result.data?.createEntity?.errors?.[0]?.message;
    if (message || !result.data?.createEntity?.entity) {
      setSaving(false);
      setError(message || 'The record was not created.');
      return;
    }
    router.push(listHref);
  };

  return (
    <div className="view-fade">
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: domainColor(domainCode) }} />
          <div>
            <div className="page-title">Create New {name}</div>
            <div className="page-meta">Attributes follow the sections on the selected template.</div>
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => router.push(listHref)} disabled={saving}>Cancel</button>
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: '12px', padding: '10px 12px', background: '#fdecec', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '13px' }}>
          {error}
        </div>
      )}

      <EntityForm
        domain={route}
        mode="create"
        formId={FORM_ID}
        showActions={false}
        onSubmit={handleCreate}
        onCancel={() => router.push(listHref)}
      />
    </div>
  );
}

function titleFromCode(domainCode: string) {
  return domainCode.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
