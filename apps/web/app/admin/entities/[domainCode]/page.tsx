'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  graphqlClient,
  DOMAIN_TYPES_QUERY,
  ATTRIBUTE_REGISTER_QUERY,
  DOMAIN_TEMPLATES_QUERY,
  UPDATE_DOMAIN_TYPE_MUTATION,
  DELETE_DOMAIN_TYPE_MUTATION,
  CREATE_ATTRIBUTE_MUTATION,
  CREATE_TEMPLATE_MUTATION,
  UPDATE_TEMPLATE_SOURCE_PREFERENCE_MUTATION,
  RELATIONSHIP_TYPES_QUERY,
  CREATE_RELATIONSHIP_TYPE_MUTATION,
  DELETE_RELATIONSHIP_TYPE_MUTATION,
  ENTITY_IDENTIFIER_DEFINITIONS_QUERY,
  CREATE_ENTITY_IDENTIFIER_MUTATION,
  DELETE_ENTITY_IDENTIFIER_MUTATION,
} from '@/lib/graphql';
import { RelationshipTypeForm } from '@/components/forms/RelationshipTypeForm';

type TabType = 'attributes' | 'templates' | 'relationships' | 'identifiers';

interface DomainType {
  id: string;
  domainCode: string;
  domainName: string;
  description?: string;
  isActive: boolean;
}

interface Attribute {
  id: string;
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description?: string;
  isRequired: boolean;
  isMultiValued: boolean;
  referenceDomainCode?: string;
}

interface TemplateAttributeAssignment {
  attributeId: string;
  attribute: {
    attributeCode: string;
    attributeName: string;
    dataType: string;
  };
  isRequired: boolean;
  precedenceRank: number;
  displayOrder: number;
  displayLabel?: string;
  defaultPrecedenceChain?: string[];
}

interface Template {
  id: string;
  templateCode: string;
  templateName: string;
  domainCode: string;
  description?: string;
  isActive: boolean;
  attributes?: TemplateAttributeAssignment[];
}

interface RelationshipType {
  id: string;
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode?: string;
  childDomainCode?: string;
  description?: string;
  isActive: boolean;
}

interface EntityIdentifierDefinition {
  id: string;
  identifierCode: string;
  identifierName: string;
  domainCode: string;
  domainName: string;
  attributeCodes: string[];
  isPrimary: boolean;
  description?: string;
  isActive: boolean;
}

// Drill-in view for a single entity type. Everything that used to sit in a
// centralized, cross-entity list (relationship types, identifiers) is scoped
// to this one domainCode here -- this is where you manage an entity type,
// then drill back out via the breadcrumb / Back link.
export default function EntityTypeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const domainCode = params.domainCode as string;

  const [domain, setDomain] = useState<DomainType | null>(null);
  const [allDomainTypes, setAllDomainTypes] = useState<DomainType[]>([]);
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<RelationshipType[]>([]);
  const [identifiers, setIdentifiers] = useState<EntityIdentifierDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [showCreateAttributeModal, setShowCreateAttributeModal] = useState(false);
  const [showCreateTemplateModal, setShowCreateTemplateModal] = useState(false);
  const [preferenceTemplate, setPreferenceTemplate] = useState<Template | null>(null);
  const [showCreateRelationshipModal, setShowCreateRelationshipModal] = useState(false);
  const [showCreateIdentifierModal, setShowCreateIdentifierModal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('attributes');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const domainsResult = await graphqlClient.query(DOMAIN_TYPES_QUERY, {}).toPromise();
      const domains: DomainType[] = domainsResult.data?.domainTypes || [];
      setAllDomainTypes(domains);
      const found = domains.find(d => d.domainCode === domainCode) || null;
      setDomain(found);
      setNotFound(!found);

      const attrsResult = await graphqlClient.query(ATTRIBUTE_REGISTER_QUERY, {}).toPromise();
      setAttributes(attrsResult.data?.attributeRegister || []);

      const templatesResult = await graphqlClient
        .query(DOMAIN_TEMPLATES_QUERY, { domainCode })
        .toPromise();
      setTemplates(templatesResult.data?.domainTemplates || []);

      const relationshipsResult = await graphqlClient.query(RELATIONSHIP_TYPES_QUERY, {}).toPromise();
      setRelationshipTypes(relationshipsResult.data?.relationshipTypes || []);

      const identifiersResult = await graphqlClient
        .query(ENTITY_IDENTIFIER_DEFINITIONS_QUERY, { domainCode })
        .toPromise();
      setIdentifiers(identifiersResult.data?.entityIdentifierDefinitions || []);
    } catch (error) {
      console.error('Error loading entity type:', error);
    } finally {
      setLoading(false);
    }
  }, [domainCode]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleUpdateDomain = async (data: any) => {
    if (!domain) return;
    setActionError(null);
    try {
      const result = await graphqlClient
        .mutation(UPDATE_DOMAIN_TYPE_MUTATION, { input: { id: domain.id, ...data } })
        .toPromise();

      const errors = result.data?.updateDomainType?.errors;
      if (errors && errors.length > 0) {
        setActionError(errors[0].message);
        return;
      }
      if (result.error) {
        setActionError(result.error.message);
        return;
      }

      setShowEditModal(false);
      await loadData();
    } catch (error: any) {
      console.error('Error updating domain:', error);
      setActionError(error?.message || 'Failed to update entity type');
    }
  };

  const handleDeleteDomain = async () => {
    if (!domain) return;
    if (!window.confirm(`Delete entity type "${domain.domainName}"? This cannot be undone.`)) return;
    setActionError(null);
    try {
      const result = await graphqlClient
        .mutation(DELETE_DOMAIN_TYPE_MUTATION, { id: domain.id })
        .toPromise();

      const errors = result.data?.deleteDomainType?.errors;
      if (errors && errors.length > 0) {
        setActionError(errors[0].message);
        return;
      }
      if (result.error) {
        setActionError(result.error.message);
        return;
      }

      router.push('/admin/entities');
    } catch (error: any) {
      console.error('Error deleting domain:', error);
      setActionError(error?.message || 'Failed to delete entity type');
    }
  };

  const handleCreateAttribute = async (data: any) => {
    try {
      await graphqlClient.mutation(CREATE_ATTRIBUTE_MUTATION, { input: data }).toPromise();
      setShowCreateAttributeModal(false);
      loadData();
    } catch (error) {
      console.error('Error creating attribute:', error);
    }
  };

  const handleCreateTemplate = async (data: any) => {
    try {
      await graphqlClient.mutation(CREATE_TEMPLATE_MUTATION, { input: data }).toPromise();
      setShowCreateTemplateModal(false);
      loadData();
    } catch (error) {
      console.error('Error creating template:', error);
    }
  };

  const handleCreateRelationshipType = async (data: any) => {
    try {
      const result = await graphqlClient
        .mutation(CREATE_RELATIONSHIP_TYPE_MUTATION, { input: data })
        .toPromise();
      const errors = result.data?.createRelationshipType?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      setShowCreateRelationshipModal(false);
      loadData();
    } catch (error: any) {
      console.error('Error creating relationship type:', error);
      alert(error?.message || 'Failed to create relationship type');
    }
  };

  const handleDeleteRelationshipType = async (rel: RelationshipType) => {
    if (!window.confirm(`Delete relationship type "${rel.relationshipName}" (${rel.relationshipCode})?`)) return;
    try {
      const result = await graphqlClient
        .mutation(DELETE_RELATIONSHIP_TYPE_MUTATION, { id: rel.id })
        .toPromise();
      const errors = result.data?.deleteRelationshipType?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      loadData();
    } catch (error: any) {
      console.error('Error deleting relationship type:', error);
      alert(error?.message || 'Failed to delete relationship type');
    }
  };

  const handleCreateEntityIdentifier = async (data: any) => {
    try {
      const result = await graphqlClient
        .mutation(CREATE_ENTITY_IDENTIFIER_MUTATION, { input: data })
        .toPromise();
      const errors = result.data?.createEntityIdentifier?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      setShowCreateIdentifierModal(false);
      loadData();
    } catch (error: any) {
      console.error('Error creating identifier:', error);
      alert(error?.message || 'Failed to create identifier');
    }
  };

  const handleDeleteEntityIdentifier = async (identifier: EntityIdentifierDefinition) => {
    if (!window.confirm(`Delete identifier "${identifier.identifierName}" (${identifier.identifierCode})?`)) return;
    try {
      const result = await graphqlClient
        .mutation(DELETE_ENTITY_IDENTIFIER_MUTATION, { id: identifier.id })
        .toPromise();
      const errors = result.data?.deleteEntityIdentifier?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      loadData();
    } catch (error: any) {
      console.error('Error deleting identifier:', error);
      alert(error?.message || 'Failed to delete identifier');
    }
  };

  if (loading) {
    return (
      <div className="view-fade">
        <div className="page-header">
          <div className="page-title">Loading entity type...</div>
        </div>
      </div>
    );
  }

  if (notFound || !domain) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href="/admin" className="crumb-link">Admin</Link>
          <span className="sep">›</span>
          <Link href="/admin/entities" className="crumb-link">Entity Management</Link>
          <span className="sep">›</span>
          <span className="crumb-current">{domainCode}</span>
        </div>
        <div className="alert alert-info" style={{ marginTop: '20px' }}>
          No entity type found for code "{domainCode}".{' '}
          <Link href="/admin/entities" className="crumb-link">Back to Entity Types</Link>
        </div>
      </div>
    );
  }

  // Relationship types where this domain participates on either side
  const scopedRelationshipTypes = relationshipTypes.filter(
    rel => rel.parentDomainCode === domain.domainCode || rel.childDomainCode === domain.domainCode
  );

  const domainAttributes = attributes.filter(a =>
    !a.referenceDomainCode || a.referenceDomainCode === domain.domainCode
  );

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/admin" className="crumb-link">Admin</Link>
        <span className="sep">›</span>
        <Link href="/admin/entities" className="crumb-link">Entity Management</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{domain.domainName}</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="page-title">{domain.domainName}</div>
              <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{domain.domainCode}</span>
              {!domain.isActive && (
                <span style={{
                  fontSize: '10px',
                  padding: '2px 8px',
                  background: 'var(--bg-alt)',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}>
                  Inactive
                </span>
              )}
            </div>
            <div className="page-meta">
              {domain.description || 'Manage attributes, templates, relationship types, and identifiers for this entity type'}
            </div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/admin/entities" className="btn">← Back to Entities</Link>
          <button className="btn" onClick={() => setShowEditModal(true)}>Edit</button>
          <button className="btn" style={{ color: 'var(--red)' }} onClick={handleDeleteDomain}>Delete</button>
        </div>
      </div>

      {actionError && (
        <div style={{
          marginBottom: '20px',
          padding: '12px 14px',
          background: '#fdecec',
          border: '1px solid var(--red)',
          color: 'var(--red)',
          fontSize: '13px',
          borderRadius: '6px',
        }}>
          {actionError}
        </div>
      )}

      {/* Tab Navigation */}
      <div style={{
        display: 'flex',
        gap: '4px',
        borderBottom: '2px solid var(--line)',
        marginBottom: '24px',
      }}>
        <TabButton
          label={`Attributes (${domainAttributes.length})`}
          isActive={activeTab === 'attributes'}
          onClick={() => setActiveTab('attributes')}
        />
        <TabButton
          label={`Templates (${templates.length})`}
          isActive={activeTab === 'templates'}
          onClick={() => setActiveTab('templates')}
        />
        <TabButton
          label={`Relationship Types (${scopedRelationshipTypes.length})`}
          isActive={activeTab === 'relationships'}
          onClick={() => setActiveTab('relationships')}
        />
        <TabButton
          label={`Identifiers (${identifiers.length})`}
          isActive={activeTab === 'identifiers'}
          onClick={() => setActiveTab('identifiers')}
        />
      </div>

      {/* Tab Content */}
      {activeTab === 'attributes' && (
        <Section
          title={`Attributes (${domainAttributes.length})`}
          subtitle="Data fields available when building templates for this entity type"
          action={<button className="btn" onClick={() => setShowCreateAttributeModal(true)}>+ Attribute</button>}
        >
          {domainAttributes.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              {domainAttributes.map(attr => (
                <div key={attr.id} style={rowStyle}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 500 }}>
                      {attr.attributeName}
                      {attr.isRequired && <span style={{ color: 'var(--red)', marginLeft: '4px' }}>*</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: 'var(--ink-3)', marginTop: '2px' }}>
                      <span className="mono">{attr.attributeCode}</span>
                      <span>Type: {attr.dataType}</span>
                      {attr.isMultiValued && <span>Multi-valued</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote text="No attributes defined for this entity type yet." />
          )}
        </Section>
      )}

      {activeTab === 'templates' && (
        <Section
          title={`Templates (${templates.length})`}
          subtitle="Instrument/record shapes available for this entity type"
          action={<button className="btn" onClick={() => setShowCreateTemplateModal(true)}>+ Template</button>}
        >
          {templates.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              {templates.map(template => (
                <div key={template.id} style={rowStyle}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 500 }}>{template.templateName}</div>
                    {template.description && (
                      <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '2px' }}>{template.description}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{template.templateCode}</span>
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => setPreferenceTemplate(template)}
                    >
                      Source preference
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote text="No templates defined for this entity type yet." />
          )}
        </Section>
      )}

      {activeTab === 'relationships' && (
        <Section
          title={`Relationship Types (${scopedRelationshipTypes.length})`}
          subtitle={`Which other entity types ${domain.domainName} can relate to`}
          action={<button className="btn" onClick={() => setShowCreateRelationshipModal(true)}>+ Relationship</button>}
        >
          {scopedRelationshipTypes.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              {scopedRelationshipTypes.map(rel => (
                <div key={rel.id} style={rowStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{rel.relationshipCode}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{rel.relationshipName}</span>
                    <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                      {rel.parentDomainCode || '—'} → {rel.childDomainCode || '—'}
                    </span>
                    {!rel.isActive && (
                      <span style={{ fontSize: '10px', color: 'var(--ink-3)', textTransform: 'uppercase' }}>Inactive</span>
                    )}
                  </div>
                  <button
                    className="btn"
                    style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 10px' }}
                    onClick={() => handleDeleteRelationshipType(rel)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote text={`No relationship types defined for ${domain.domainName} yet.`} />
          )}
        </Section>
      )}

      {activeTab === 'identifiers' && (
        <Section
          title={`Identifiers (${identifiers.length})`}
          subtitle="Which attribute(s) uniquely identify a record of this entity type, for matching/deduping across sources"
          action={<button className="btn" onClick={() => setShowCreateIdentifierModal(true)}>+ Identifier</button>}
          last
        >
          {identifiers.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              {identifiers.map(identifier => (
                <div key={identifier.id} style={rowStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{identifier.identifierCode}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{identifier.identifierName}</span>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                      [{identifier.attributeCodes.join(', ')}]
                    </span>
                    {identifier.isPrimary && (
                      <span style={{
                        fontSize: '10px',
                        padding: '2px 8px',
                        background: 'var(--accent)',
                        color: 'white',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        borderRadius: '4px',
                      }}>
                        Primary
                      </span>
                    )}
                  </div>
                  <button
                    className="btn"
                    style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 10px' }}
                    onClick={() => handleDeleteEntityIdentifier(identifier)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote text="No identifier definitions yet." />
          )}
        </Section>
      )}

      {/* Edit Domain Modal */}
      {showEditModal && (
        <EditDomainModal
          domain={domain}
          error={actionError}
          onClose={() => {
            setShowEditModal(false);
            setActionError(null);
          }}
          onSubmit={handleUpdateDomain}
        />
      )}

      {/* Create Attribute Modal */}
      {showCreateAttributeModal && (
        <CreateAttributeModal
          domainTypes={allDomainTypes}
          onClose={() => setShowCreateAttributeModal(false)}
          onSubmit={handleCreateAttribute}
        />
      )}

      {preferenceTemplate && (
        <SourcePreferenceModal
          template={preferenceTemplate}
          onClose={() => setPreferenceTemplate(null)}
          onSaved={async () => {
            setPreferenceTemplate(null);
            await loadData();
          }}
        />
      )}

      {/* Create Template Modal (domain fixed to this entity type) */}
      {showCreateTemplateModal && (
        <CreateTemplateModal
          fixedDomainCode={domain.domainCode}
          fixedDomainName={domain.domainName}
          onClose={() => setShowCreateTemplateModal(false)}
          onSubmit={handleCreateTemplate}
        />
      )}

      {/* Create Relationship Type Modal (this domain prefilled as one side) */}
      {showCreateRelationshipModal && (
        <ModalOverlay onClose={() => setShowCreateRelationshipModal(false)}>
          <RelationshipTypeForm
            mode="create"
            initialData={{ parentDomainCode: domain.domainCode }}
            domainOptions={allDomainTypes.map(d => ({ domainCode: d.domainCode, domainName: d.domainName }))}
            onCancel={() => setShowCreateRelationshipModal(false)}
            onSubmit={handleCreateRelationshipType}
          />
        </ModalOverlay>
      )}

      {/* Create Entity Identifier Modal (domain fixed to this entity type) */}
      {showCreateIdentifierModal && (
        <CreateIdentifierModal
          fixedDomainCode={domain.domainCode}
          fixedDomainName={domain.domainName}
          attributes={attributes}
          onClose={() => setShowCreateIdentifierModal(false)}
          onSubmit={handleCreateEntityIdentifier}
        />
      )}
    </div>
  );
}

// Shared row style for list items within each scoped management section.
const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  background: 'var(--bg-2, #f5f5f5)',
  borderRadius: '6px',
  border: '1px solid var(--line)',
};

// A tab button used in the horizontal tab navigation across the top of the
// entity detail page. Styled to match the rest of the app (mono font,
// uppercase-ish small labels) with a clear active state.
function TabButton({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '10px 18px',
        fontSize: '13px',
        fontWeight: isActive ? 600 : 500,
        color: isActive ? 'var(--accent)' : 'var(--ink-2)',
        background: 'transparent',
        border: 'none',
        borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
        marginBottom: '-2px',
        cursor: 'pointer',
        transition: 'color 0.15s, border-color 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

// A titled section with an action button in the top-right, used for each
// scoped management area (attributes / templates / relationships / identifiers).
function Section({
  title,
  subtitle,
  action,
  children,
  last,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{ marginBottom: last ? 0 : '32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 600 }}>{title}</div>
          {subtitle && (
            <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{subtitle}</div>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div style={{ fontSize: '13px', color: 'var(--ink-3)', fontStyle: 'italic' }}>
      {text}
    </div>
  );
}

// Generic modal overlay wrapper, for reusing existing "builder-card" style forms as modals
function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '600px',
          maxHeight: '90vh',
          overflow: 'auto',
          border: '1px solid var(--line)',
          padding: '24px',
        }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// Edit Domain Modal
function EditDomainModal({
  domain,
  error,
  onClose,
  onSubmit,
}: {
  domain: DomainType;
  error?: string | null;
  onClose: () => void;
  onSubmit: (data: { domainName: string; description: string; isActive: boolean }) => void;
}) {
  const [formData, setFormData] = useState({
    domainName: domain.domainName,
    description: domain.description || '',
    isActive: domain.isActive,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1001,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '500px',
          border: '1px solid var(--line)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--line)'
          }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>
              Edit Entity Type
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            {error && (
              <div style={{
                marginBottom: '16px',
                padding: '10px 12px',
                background: '#fdecec',
                border: '1px solid var(--red)',
                color: 'var(--red)',
                fontSize: '13px',
                borderRadius: '6px',
              }}>
                {error}
              </div>
            )}
            <div style={{ display: 'grid', gap: '16px' }}>
              <div className="field">
                <label>Domain Code</label>
                <input
                  type="text"
                  className="text-input mono"
                  value={domain.domainCode}
                  disabled
                  style={{ opacity: 0.6, cursor: 'not-allowed' }}
                />
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                  Domain code can't be changed after creation since other records reference it.
                </div>
              </div>
              <div className="field">
                <label>Domain Name *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.domainName}
                  onChange={e => setFormData(prev => ({ ...prev, domainName: e.target.value }))}
                  placeholder="e.g., Fund, Security, Borrower"
                  required
                />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="What is this entity type?"
                  rows={3}
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={formData.isActive}
                  onChange={e => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
                />
                Active
              </label>
            </div>
          </div>

          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px'
          }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Create Attribute Modal
function CreateAttributeModal({
  domainTypes,
  onClose,
  onSubmit
}: {
  domainTypes: DomainType[];
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [formData, setFormData] = useState({
    attributeCode: '',
    attributeName: '',
    dataType: 'STRING',
    description: '',
    referenceDomainCode: '',
    isRequired: false,
    isMultiValued: false
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      referenceDomainCode: formData.referenceDomainCode || undefined
    });
  };

  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '600px',
          border: '1px solid var(--line)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--line)'
          }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>
              Create Attribute
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gap: '16px' }}>
              <div className="field">
                <label>Attribute Code *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.attributeCode}
                  onChange={e => setFormData(prev => ({ ...prev, attributeCode: e.target.value }))}
                  placeholder="e.g., nav, ticker, lei"
                  required
                />
              </div>
              <div className="field">
                <label>Attribute Name *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.attributeName}
                  onChange={e => setFormData(prev => ({ ...prev, attributeName: e.target.value }))}
                  placeholder="e.g., Net Asset Value, Ticker Symbol"
                  required
                />
              </div>
              <div className="field">
                <label>Data Type *</label>
                <select
                  className="select"
                  value={formData.dataType}
                  onChange={e => setFormData(prev => ({ ...prev, dataType: e.target.value }))}
                  required
                >
                  <option value="STRING">String</option>
                  <option value="FLOAT">Float</option>
                  <option value="INTEGER">Integer</option>
                  <option value="DATE">Date</option>
                  <option value="TIMESTAMP">Timestamp</option>
                  <option value="BOOLEAN">Boolean</option>
                </select>
              </div>
              <div className="field">
                <label>Reference Domain (optional)</label>
                <select
                  className="select"
                  value={formData.referenceDomainCode}
                  onChange={e => setFormData(prev => ({ ...prev, referenceDomainCode: e.target.value }))}
                >
                  <option value="">None</option>
                  {domainTypes.map(d => (
                    <option key={d.domainCode} value={d.domainCode}>
                      {d.domainName}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                  If this attribute references another entity type
                </div>
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="What does this attribute represent?"
                  rows={3}
                />
              </div>
              <div style={{ display: 'flex', gap: '24px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="checkbox"
                    checked={formData.isRequired}
                    onChange={e => setFormData(prev => ({ ...prev, isRequired: e.target.checked }))}
                  />
                  Required
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="checkbox"
                    checked={formData.isMultiValued}
                    onChange={e => setFormData(prev => ({ ...prev, isMultiValued: e.target.checked }))}
                  />
                  Multi-valued
                </label>
              </div>
            </div>
          </div>

          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px'
          }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SOURCE_PREFERENCE_OPTIONS = [
  { code: 'BLOOMBERG', name: 'Bloomberg' },
  { code: 'WSO', name: 'WSO' },
  { code: 'DEALCLOUD', name: 'DealCloud' },
  { code: 'ALLVUE', name: 'Allvue' },
  { code: 'SP_CAPITAL_IQ', name: 'S&P Capital IQ' },
  { code: 'INTERNAL', name: 'Internal' },
  { code: 'MANUAL', name: 'Manual' },
  { code: 'CALCULATED', name: 'Calculated' },
];

function sourceLabel(code: string) {
  return SOURCE_PREFERENCE_OPTIONS.find(option => option.code === code)?.name || code;
}

// Ordered source list saved on template_attribute_assignments.default_precedence_chain.
// Earlier entries win when a golden value is resolved for that attribute.
function SourcePreferenceModal({
  template,
  onClose,
  onSaved,
}: {
  template: Template;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const attributes = [...(template.attributes || [])].sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
  );
  const [chains, setChains] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const attribute of attributes) {
      initial[attribute.attributeId] = [...(attribute.defaultPrecedenceChain || [])];
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = (attributeId: string, index: number, direction: -1 | 1) => {
    setChains(prev => {
      const chain = [...(prev[attributeId] || [])];
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= chain.length) return prev;
      const [item] = chain.splice(index, 1);
      chain.splice(nextIndex, 0, item);
      return { ...prev, [attributeId]: chain };
    });
  };

  const remove = (attributeId: string, code: string) => {
    setChains(prev => ({
      ...prev,
      [attributeId]: (prev[attributeId] || []).filter(entry => entry !== code),
    }));
  };

  const add = (attributeId: string, code: string) => {
    if (!code) return;
    setChains(prev => {
      const chain = prev[attributeId] || [];
      if (chain.includes(code)) return prev;
      return { ...prev, [attributeId]: [...chain, code] };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const attribute of attributes) {
        const result = await graphqlClient.mutation(UPDATE_TEMPLATE_SOURCE_PREFERENCE_MUTATION, {
          input: {
            templateId: template.id,
            attributeId: attribute.attributeId,
            defaultPrecedenceChain: chains[attribute.attributeId] || [],
          },
        }).toPromise();

        const mutationError = result.data?.updateTemplateSourcePreference?.errors?.[0];
        if (mutationError) {
          setError(mutationError.message);
          return;
        }
        if (result.error) {
          setError(result.error.message);
          return;
        }
      }
      await onSaved();
    } catch (err: any) {
      setError(err?.message || 'Failed to save source preference');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '680px',
          maxHeight: '90vh',
          overflow: 'auto',
          border: '1px solid var(--line)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontSize: '18px', fontWeight: 600 }}>Source preference</div>
          <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
            {template.templateName} — earlier sources win for each attribute
          </div>
        </div>

        <div style={{ padding: '24px', display: 'grid', gap: '16px' }}>
          {error && (
            <div style={{
              padding: '10px 12px',
              background: '#fdecec',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              fontSize: '13px',
              borderRadius: '6px',
            }}>
              Failed: {error}
            </div>
          )}

          {attributes.length === 0 && (
            <div style={{ fontSize: '13px', color: 'var(--ink-3)' }}>
              This template has no attributes yet. Assign attributes before setting a source preference.
            </div>
          )}

          {attributes.map(attribute => {
            const chain = chains[attribute.attributeId] || [];
            const remaining = SOURCE_PREFERENCE_OPTIONS.filter(option => !chain.includes(option.code));
            return (
              <div key={attribute.attributeId} style={{
                border: '1px solid var(--line)',
                borderRadius: '8px',
                padding: '12px 14px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 500 }}>{attribute.attribute.attributeName}</div>
                    <div className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{attribute.attribute.attributeCode}</div>
                  </div>
                </div>
                {chain.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '8px' }}>
                    No source preference. The attribute default rank is used.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: '6px', marginBottom: '8px' }}>
                    {chain.map((code, index) => (
                      <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="mono" style={{ width: '18px', fontSize: '11px', color: 'var(--ink-3)' }}>{index + 1}</span>
                        <span style={{ flex: 1, fontSize: '13px' }}>{sourceLabel(code)}</span>
                        <button type="button" className="btn" style={{ fontSize: '12px', padding: '2px 8px' }} onClick={() => move(attribute.attributeId, index, -1)} disabled={index === 0}>Up</button>
                        <button type="button" className="btn" style={{ fontSize: '12px', padding: '2px 8px' }} onClick={() => move(attribute.attributeId, index, 1)} disabled={index === chain.length - 1}>Down</button>
                        <button type="button" className="btn" style={{ fontSize: '12px', padding: '2px 8px', color: 'var(--red)' }} onClick={() => remove(attribute.attributeId, code)}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                <select
                  className="select"
                  value=""
                  aria-label={`Add source for ${attribute.attribute.attributeName}`}
                  onChange={e => add(attribute.attributeId, e.target.value)}
                >
                  <option value="">Add source…</option>
                  {remaining.map(option => (
                    <option key={option.code} value={option.code}>{option.name}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
        }}>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || attributes.length === 0}>
            {saving ? 'Saving…' : 'Save source preference'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Create Template Modal -- domain is fixed to the entity type being managed,
// since templates are always created in the context of drilling into one entity type.
function CreateTemplateModal({
  fixedDomainCode,
  fixedDomainName,
  onClose,
  onSubmit
}: {
  fixedDomainCode: string;
  fixedDomainName: string;
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [formData, setFormData] = useState({
    templateCode: '',
    templateName: '',
    description: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ ...formData, domainCode: fixedDomainCode });
  };

  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '500px',
          border: '1px solid var(--line)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--line)'
          }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>
              Create Template
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
              For {fixedDomainName}
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gap: '16px' }}>
              <div className="field">
                <label>Template Code *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.templateCode}
                  onChange={e => setFormData(prev => ({ ...prev, templateCode: e.target.value }))}
                  placeholder="e.g., OPEN_END_FUND, CORPORATE_BOND"
                  required
                />
              </div>
              <div className="field">
                <label>Template Name *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.templateName}
                  onChange={e => setFormData(prev => ({ ...prev, templateName: e.target.value }))}
                  placeholder="e.g., Open-End Fund, Corporate Bond"
                  required
                />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="What is this template for?"
                  rows={3}
                />
              </div>
            </div>
          </div>

          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px'
          }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Create Entity Identifier Modal -- domain is fixed to the entity type being managed.
function CreateIdentifierModal({
  fixedDomainCode,
  fixedDomainName,
  attributes,
  onClose,
  onSubmit,
}: {
  fixedDomainCode: string;
  fixedDomainName: string;
  attributes: Attribute[];
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [formData, setFormData] = useState({
    identifierCode: '',
    identifierName: '',
    attributeCodes: [] as string[],
    isPrimary: false,
    description: '',
  });
  const [error, setError] = useState<string | null>(null);

  const toggleAttribute = (code: string) => {
    setFormData(prev => ({
      ...prev,
      attributeCodes: prev.attributeCodes.includes(code)
        ? prev.attributeCodes.filter(c => c !== code)
        : [...prev.attributeCodes, code],
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.attributeCodes.length === 0) {
      setError('Select at least one attribute that makes up this identifier.');
      return;
    }
    setError(null);
    onSubmit({ ...formData, domainCode: fixedDomainCode });
  };

  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '560px',
          maxHeight: '90vh',
          overflow: 'auto',
          border: '1px solid var(--line)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>Create Identifier (Match Key)</div>
            <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
              For {fixedDomainName} — defines which attribute(s) uniquely identify a record
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            {error && (
              <div style={{
                marginBottom: '16px',
                padding: '10px 12px',
                background: '#fdecec',
                border: '1px solid var(--red)',
                color: 'var(--red)',
                fontSize: '13px',
                borderRadius: '6px',
              }}>
                {error}
              </div>
            )}
            <div style={{ display: 'grid', gap: '16px' }}>
              <div className="field">
                <label>Identifier Code *</label>
                <input
                  type="text"
                  className="text-input mono"
                  value={formData.identifierCode}
                  onChange={e => setFormData(prev => ({ ...prev, identifierCode: e.target.value.toUpperCase() }))}
                  placeholder="e.g., ISIN, LEI, CUSIP"
                  required
                />
              </div>
              <div className="field">
                <label>Identifier Name *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.identifierName}
                  onChange={e => setFormData(prev => ({ ...prev, identifierName: e.target.value }))}
                  placeholder="e.g., ISIN, Legal Entity Identifier"
                  required
                />
              </div>
              <div className="field">
                <label>Attribute(s) that form this identifier *</label>
                <div style={{
                  display: 'grid',
                  gap: '6px',
                  maxHeight: '180px',
                  overflow: 'auto',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  padding: '10px',
                }}>
                  {attributes.length === 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--ink-3)', fontStyle: 'italic' }}>
                      No attributes defined yet.
                    </div>
                  )}
                  {attributes.map(attr => (
                    <label key={attr.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                      <input
                        type="checkbox"
                        checked={formData.attributeCodes.includes(attr.attributeCode)}
                        onChange={() => toggleAttribute(attr.attributeCode)}
                      />
                      <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{attr.attributeCode}</span>
                      <span>{attr.attributeName}</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                  Select one attribute for a simple identifier (e.g. ISIN), or multiple for a composite key (e.g. LEI + Country)
                </div>
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="What does this identifier represent?"
                  rows={2}
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={formData.isPrimary}
                  onChange={e => setFormData(prev => ({ ...prev, isPrimary: e.target.checked }))}
                />
                Primary identifier for this entity type
              </label>
            </div>
          </div>

          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
          }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
