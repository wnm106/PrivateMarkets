'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlQuery, ENTITY_QUERY, UPDATE_ENTITY_MUTATION } from '@/lib/graphql';

interface EntityData {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  templateName?: string;
  description?: string;
  isActive: boolean;
  attributes: Record<string, any>;
  parentRelationships: Array<{
    parentEntityId: string;
    parentEntityCode: string;
    parentEntityName: string;
    parentDomainCode: string;
    relationshipType: string;
    relationshipCode: string;
    isPrimary: boolean;
  }>;
  childRelationships: Array<{
    childEntityId: string;
    childEntityCode: string;
    childEntityName: string;
    childDomainCode: string;
    relationshipType: string;
    relationshipCode: string;
    isPrimary: boolean;
  }>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export default function IssuerDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [entity, setEntity] = useState<EntityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingAttribute, setEditingAttribute] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchEntity = async () => {
      setLoading(true);
      setError(null);
      
      // Check if id is a UUID or an entityCode
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const variables = isUUID ? { id } : { entityCode: id };
      
      const { data, error: queryError } = await graphqlQuery<{ entity: EntityData }>(
        ENTITY_QUERY,
        variables
      );

      if (queryError) {
        setError(queryError.message);
      } else if (data?.entity) {
        setEntity(data.entity);
      } else {
        setError('Entity not found');
      }

      setLoading(false);
    };

    if (id) {
      fetchEntity();
    }
  }, [id]);

  if (loading) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href="/issuers" className="crumb-link">Issuers</Link>
          <span className="sep">›</span>
          <span className="crumb-current">Loading...</span>
        </div>
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-3)' }}>
          Loading issuer details...
        </div>
      </div>
    );
  }

  if (error || !entity) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href="/issuers" className="crumb-link">Issuers</Link>
          <span className="sep">›</span>
          <span className="crumb-current">Error</span>
        </div>
        <div className="alert alert-error">
          {error || 'Entity not found'}
        </div>
      </div>
    );
  }

  const attrs = entity.attributes || {};
  const attrEntries = Object.entries(attrs);

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/issuers" className="crumb-link">Issuers</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{entity.entityCode}</span>
      </div>

      {/* Record Header */}
      <div className="record-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="record-meta-row">
              <span className="rec-id">{entity.entityCode}</span>
              <span className="status-chip active">● {entity.isActive ? 'Active' : 'Inactive'}</span>
              <span className="rec-time">Created {new Date(entity.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="record-name">{entity.entityName}</div>
            <div className="record-tag">
              {entity.domainName}
              {entity.templateName && ` · ${entity.templateName}`}
              {entity.description && ` · ${entity.description}`}
            </div>
          </div>
          <div className="record-header-right">
            <div className="record-actions">
              <Link href="/issuers">
                <button className="btn btn-sm">← Back to List</button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Detail Layout */}
      <div className="detail-layout">
        <div>
          {/* Attributes Section */}
          <div className="field-section">
            <div className="field-section-head">
              <div className="field-section-name">Attributes</div>
              <div className="field-section-count">{attrEntries.length} fields</div>
            </div>
            {attrEntries.length === 0 ? (
              <div style={{ padding: '20px', color: 'var(--ink-3)', fontSize: '13px' }}>
                No attributes defined for this entity.
              </div>
            ) : (
              attrEntries.map(([key, val]: [string, any]) => {
                const displayValue = val?.value !== undefined ? val.value : val;
                const isArray = Array.isArray(displayValue);
                const currentValue = isArray 
                  ? displayValue.join(', ') 
                  : (displayValue !== undefined && displayValue !== null ? String(displayValue) : '');
                const isEditing = editingAttribute === key;
                
                return (
                  <div key={key} className="field-row">
                    <div className="field-label">{key}</div>
                    <div className="field-value-cell">
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="field-input"
                            style={{ flex: 1 }}
                            autoFocus
                          />
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={saving}
                            onClick={async () => {
                              setSaving(true);
                              const updatedAttributes = { ...entity.attributes, [key]: editValue };
                              const { data, error: mutationError } = await graphqlQuery(
                                UPDATE_ENTITY_MUTATION,
                                { input: { id: entity.id, attributes: updatedAttributes } }
                              );
                              setSaving(false);
                              if (mutationError) {
                                setError(mutationError.message);
                              } else if (data?.updateEntity?.entity) {
                                setEntity({ ...entity, attributes: data.updateEntity.entity.attributes });
                                setEditingAttribute(null);
                                setEditValue('');
                              }
                            }}
                          >
                            {saving ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setEditingAttribute(null);
                              setEditValue('');
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                          {isArray ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', flex: 1 }}>
                              {displayValue.length === 0 ? (
                                <span style={{ color: 'var(--ink-3)' }}>—</span>
                              ) : (
                                displayValue.map((item: any, idx: number) => (
                                  <span
                                    key={idx}
                                    style={{
                                      display: 'inline-block',
                                      padding: '2px 8px',
                                      background: 'var(--accent-2)',
                                      border: '1px solid var(--accent-3)',
                                      borderRadius: '3px',
                                      fontSize: '11px',
                                      color: 'var(--ink)',
                                    }}
                                  >
                                    {String(item)}
                                  </span>
                                ))
                              )}
                            </div>
                          ) : (
                            <span className="field-value">
                              {currentValue || '—'}
                            </span>
                          )}
                          <button
                            className="btn btn-sm"
                            style={{ padding: '4px 8px', fontSize: '11px', marginLeft: '8px' }}
                            onClick={() => {
                              setEditingAttribute(key);
                              setEditValue(currentValue);
                            }}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Parent Relationships Section */}
          {entity.parentRelationships && entity.parentRelationships.length > 0 && (
            <div className="field-section">
              <div className="field-section-head">
                <div className="field-section-name">Parent Relationships</div>
                <div className="field-section-count">{entity.parentRelationships.length}</div>
              </div>
              {entity.parentRelationships.map((rel, idx) => (
                <Link key={idx} href={`/${rel.parentDomainCode.toLowerCase()}s/${rel.parentEntityId}`}>
                  <div className="field-row" style={{ cursor: 'pointer' }}>
                    <div className="field-label">
                      {rel.relationshipType}
                      {rel.isPrimary && <span className="std-icon" title="Primary">★</span>}
                    </div>
                    <div className="field-value-cell">
                      <span className="field-value">{rel.parentEntityName}</span>
                      <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--ink-3)' }}>
                        ({rel.parentEntityCode})
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Child Relationships Section */}
          {entity.childRelationships && entity.childRelationships.length > 0 && (
            <div className="field-section">
              <div className="field-section-head">
                <div className="field-section-name">Child Relationships</div>
                <div className="field-section-count">{entity.childRelationships.length}</div>
              </div>
              {entity.childRelationships.map((rel, idx) => (
                <Link key={idx} href={`/${rel.childDomainCode.toLowerCase()}s/${rel.childEntityId}`}>
                  <div className="field-row" style={{ cursor: 'pointer' }}>
                    <div className="field-label">
                      {rel.relationshipType}
                      {rel.isPrimary && <span className="std-icon" title="Primary">★</span>}
                    </div>
                    <div className="field-value-cell">
                      <span className="field-value">{rel.childEntityName}</span>
                      <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--ink-3)' }}>
                        ({rel.childEntityCode})
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Right Rail */}
        <div>
          {/* Entity Metadata */}
          <div className="rail-card">
            <div className="rail-head">Entity Metadata</div>
            <div style={{ padding: '12px 16px', fontSize: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ color: 'var(--ink-3)' }}>Domain</span>
                <span style={{ fontWeight: 500 }}>{entity.domainCode}</span>
              </div>
              {entity.templateName && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ color: 'var(--ink-3)' }}>Template</span>
                  <span style={{ fontWeight: 500 }}>{entity.templateName}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ color: 'var(--ink-3)' }}>Created</span>
                <span style={{ fontWeight: 500 }}>{new Date(entity.createdAt).toLocaleDateString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ color: 'var(--ink-3)' }}>Updated</span>
                <span style={{ fontWeight: 500 }}>{new Date(entity.updatedAt).toLocaleDateString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--ink-3)' }}>Status</span>
                <span className={`status-chip ${entity.isActive ? 'active' : ''}`}>
                  {entity.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          </div>

          {/* Relationships Summary */}
          <div className="rail-card">
            <div className="rail-head">Relationships</div>
            <div style={{ padding: '12px 16px', fontSize: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ color: 'var(--ink-3)' }}>Parents</span>
                <span style={{ fontWeight: 500 }}>{entity.parentRelationships?.length || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--ink-3)' }}>Children</span>
                <span style={{ fontWeight: 500 }}>{entity.childRelationships?.length || 0}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
