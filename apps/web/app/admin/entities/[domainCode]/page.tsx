'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  graphqlClient,
  graphqlQuery,
  graphqlMutation,
  DOMAIN_TYPES_QUERY,
  ATTRIBUTE_REGISTER_QUERY,
  DOMAIN_TEMPLATES_QUERY,
  TEMPLATE_PRECEDENCE_CHAIN_QUERY,
  UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION,
  UPDATE_DOMAIN_TYPE_MUTATION,
  DELETE_DOMAIN_TYPE_MUTATION,
  CREATE_ATTRIBUTE_MUTATION,
  CREATE_TEMPLATE_MUTATION,
  UPDATE_TEMPLATE_MUTATION,
  ASSIGN_ATTRIBUTE_TO_TEMPLATE_MUTATION,
  UNASSIGN_ATTRIBUTE_FROM_TEMPLATE_MUTATION,
  UPDATE_TEMPLATE_SOURCE_PREFERENCE_MUTATION,
  RELATIONSHIP_TYPES_QUERY,
  CREATE_RELATIONSHIP_TYPE_MUTATION,
  UPDATE_RELATIONSHIP_TYPE_MUTATION,
  DELETE_RELATIONSHIP_TYPE_MUTATION,
  DELETE_ATTRIBUTE_MUTATION,
  ENTITY_IDENTIFIER_DEFINITIONS_QUERY,
  CREATE_ENTITY_IDENTIFIER_MUTATION,
  UPDATE_ENTITY_IDENTIFIER_MUTATION,
  DELETE_ENTITY_IDENTIFIER_MUTATION,
  INTERSECTION_TYPES_QUERY,
  CREATE_INTERSECTION_TYPE_MUTATION,
  UPDATE_INTERSECTION_TYPE_MUTATION,
  DELETE_INTERSECTION_TYPE_MUTATION,
  REFERENCE_LISTS_QUERY,
  UPDATE_TEMPLATE_ATTRIBUTE_MUTATION,
  REORDER_TEMPLATE_ATTRIBUTES_MUTATION,
} from '@/lib/graphql';
import { RelationshipTypeForm } from '@/components/forms/RelationshipTypeForm';
import { SchemaScopeBadge, SchemaScopeField } from '@/components/admin/SchemaScopeField';
import { EntityIdentifierDefinitionForm } from '@/components/forms/EntityIdentifierDefinitionForm';
import { TemplateAttributePicker, type PickerAttribute } from '@/components/forms/TemplateAttributePicker';
import { AttributeExpandPanel } from '@/components/admin/AttributeExpandPanel';

type TabType = 'attributes' | 'templates' | 'relationships' | 'identifiers' | 'intersections';

interface DomainType {
  id: string;
  domainCode: string;
  domainName: string;
  description?: string;
  isActive: boolean;
  clientId?: string | null;
  clientName?: string | null;
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
  domainCode?: string;
  displayFormat?: string;
  listValues?: string[];
  validationRules?: any;
  defaultValue?: string;
  displaySection?: string;
  displayGroup?: number;
  isEditable?: boolean;
  isVisible?: boolean;
  aggregationType?: string;
  weightAttributeCode?: string;
  numericPrecision?: number;
  unitOfMeasure?: string;
  referenceListCode?: string;
  defaultPrecedenceChain?: string[];
  clientId?: string | null;
  clientName?: string | null;
}

interface TemplateAttribute {
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
  applicabilityRules?: any;
  attributes?: TemplateAttributeAssignment[];
  clientId?: string | null;
  clientName?: string | null;
}

interface RelationshipType {
  id: string;
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode?: string;
  childDomainCode?: string;
  description?: string;
  isActive: boolean;
  isRequired?: boolean;
  clientId?: string | null;
  clientName?: string | null;
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

interface IntersectionMember {
  id?: string;
  domainCode: string;
  memberRole: string;
  isRequired: boolean;
  displayOrder: number;
}

interface IntersectionType {
  id: string;
  intersectionCode: string;
  intersectionName: string;
  description?: string;
  isActive: boolean;
  members: IntersectionMember[];
  createdAt: string;
  updatedAt: string;
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
  const [intersectionTypes, setIntersectionTypes] = useState<IntersectionType[]>([]);
  const [referenceLists, setReferenceLists] = useState<{ id: string; listCode: string; listName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [showCreateAttributeModal, setShowCreateAttributeModal] = useState(false);
  const [showCreateTemplateModal, setShowCreateTemplateModal] = useState(false);
  const [preferenceTemplate, setPreferenceTemplate] = useState<Template | null>(null);
  const [showCreateRelationshipModal, setShowCreateRelationshipModal] = useState(false);
  const [showCreateIdentifierModal, setShowCreateIdentifierModal] = useState(false);
  const [showCreateIntersectionModal, setShowCreateIntersectionModal] = useState(false);
  const [editingIntersection, setEditingIntersection] = useState<IntersectionType | null>(null);
  const [expandedAttributeId, setExpandedAttributeId] = useState<string | null>(null);
  const [editingRelationship, setEditingRelationship] = useState<RelationshipType | null>(null);
  const [editingIdentifier, setEditingIdentifier] = useState<EntityIdentifierDefinition | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('attributes');

  const refreshAttributes = useCallback(async () => {
    const attrsResult = await graphqlClient.query(ATTRIBUTE_REGISTER_QUERY, { domainCode }, { requestPolicy: 'network-only' }).toPromise();
    setAttributes(attrsResult.data?.attributeRegister || []);
  }, [domainCode]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const domainsResult = await graphqlClient.query(DOMAIN_TYPES_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      const domains: DomainType[] = domainsResult.data?.domainTypes || [];
      setAllDomainTypes(domains);
      const found = domains.find(d => d.domainCode === domainCode) || null;
      setDomain(found);
      setNotFound(!found);

      const attrsResult = await graphqlClient.query(ATTRIBUTE_REGISTER_QUERY, { domainCode }, { requestPolicy: 'network-only' }).toPromise();
      console.log('[EntityDetailPage] Attributes query result:', {
        domainCode,
        data: attrsResult.data,
        error: attrsResult.error?.message,
        attributeCount: attrsResult.data?.attributeRegister?.length
      });
      setAttributes(attrsResult.data?.attributeRegister || []);

      const templatesResult = await graphqlClient
        .query(DOMAIN_TEMPLATES_QUERY, { domainCode }, { requestPolicy: 'network-only' })
        .toPromise();
      setTemplates(templatesResult.data?.domainTemplates || []);

      const relationshipsResult = await graphqlClient.query(RELATIONSHIP_TYPES_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      setRelationshipTypes(relationshipsResult.data?.relationshipTypes || []);

      const identifiersResult = await graphqlClient
        .query(ENTITY_IDENTIFIER_DEFINITIONS_QUERY, { domainCode }, { requestPolicy: 'network-only' })
        .toPromise();
      setIdentifiers(identifiersResult.data?.entityIdentifierDefinitions || []);

      const intersectionsResult = await graphqlClient.query(INTERSECTION_TYPES_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      const allIntersections: IntersectionType[] = intersectionsResult.data?.intersectionTypes || [];
      // Filter to show intersection types that match this domain code or include this domain as a member
      setIntersectionTypes(allIntersections.filter(it => 
        it.intersectionCode === domainCode || it.members.some(m => m.domainCode === domainCode)
      ));

      // Fetch reference lists for the attribute edit form
      const refListsResult = await graphqlClient.query(REFERENCE_LISTS_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      setReferenceLists(refListsResult.data?.referenceLists || []);
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
      const result = await graphqlClient.mutation(CREATE_ATTRIBUTE_MUTATION, { input: { ...data, domainCode } }).toPromise();
      const errors = result.data?.createAttribute?.errors;
      if (errors && errors.length > 0) {
        window.alert(errors[0].message);
        return;
      }
      if (result.error) {
        window.alert(result.error.message);
        return;
      }
      setShowCreateAttributeModal(false);
      loadData();
    } catch (error) {
      console.error('Error creating attribute:', error);
    }
  };

  const handleDeleteAttribute = async (attr: Attribute) => {
    if (!window.confirm(`Delete attribute "${attr.attributeName}" (${attr.attributeCode})?`)) return;
    try {
      const result = await graphqlClient
        .mutation(DELETE_ATTRIBUTE_MUTATION, { id: attr.id })
        .toPromise();
      const errors = result.data?.deleteAttribute?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      loadData();
    } catch (error: any) {
      console.error('Error deleting attribute:', error);
      alert(error?.message || 'Failed to delete attribute');
    }
  };

  const handleCreateTemplate = async (data: any) => {
    try {
      const result = await graphqlClient.mutation(CREATE_TEMPLATE_MUTATION, { input: data }).toPromise();
      const errors = result.data?.createTemplate?.errors;
      if (errors && errors.length > 0) {
        window.alert(errors[0].message);
        return;
      }
      if (result.error) {
        window.alert(result.error.message);
        return;
      }
      setShowCreateTemplateModal(false);
      loadData();
    } catch (error) {
      console.error('Error creating template:', error);
    }
  };

  const handleUpdateTemplate = async (data: { templateName?: string; description?: string; isActive?: boolean; applicabilityRules?: any }) => {
    if (!editingTemplate) return;
    try {
      const result = await graphqlClient
        .mutation(UPDATE_TEMPLATE_MUTATION, { id: editingTemplate.id, input: data })
        .toPromise();
      const errors = result.data?.updateTemplate?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      if (result.data?.updateTemplate?.template) {
        setEditingTemplate(result.data.updateTemplate.template);
      }
      loadData();
    } catch (error: any) {
      console.error('Error updating template:', error);
      alert(error?.message || 'Failed to update template');
    }
  };

  const handleAssignAttributeToTemplate = async (attributeId: string, isRequired: boolean, displayOrder: number, displayLabel?: string) => {
    if (!editingTemplate) return;
    try {
      const result = await graphqlClient
        .mutation(ASSIGN_ATTRIBUTE_TO_TEMPLATE_MUTATION, {
          input: {
            templateId: editingTemplate.id,
            attributeId,
            isRequired,
            displayOrder,
            displayLabel,
          },
        })
        .toPromise();
      const errors = result.data?.assignAttributeToTemplate?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      loadData();
    } catch (error: any) {
      console.error('Error assigning attribute:', error);
      alert(error?.message || 'Failed to assign attribute');
    }
  };

  const handleUnassignAttributeFromTemplate = async (attributeId: string) => {
    if (!editingTemplate) return;
    try {
      const result = await graphqlClient
        .mutation(UNASSIGN_ATTRIBUTE_FROM_TEMPLATE_MUTATION, {
          templateId: editingTemplate.id,
          attributeId,
        })
        .toPromise();
      const errors = result.data?.unassignAttributeFromTemplate?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      loadData();
    } catch (error: any) {
      console.error('Error unassigning attribute:', error);
      alert(error?.message || 'Failed to unassign attribute');
    }
  };

  const handleSaveAttributes = async (changes: { added: string[]; removed: string[]; reordered: string[]; aliases: Record<string, string | undefined> }) => {
    if (!editingTemplate) return;
    try {
      for (const attrId of changes.removed) {
        await graphqlClient.mutation(UNASSIGN_ATTRIBUTE_FROM_TEMPLATE_MUTATION, {
          templateId: editingTemplate.id, attributeId: attrId,
        }).toPromise();
      }
      const currentAttrs = editingTemplate.attributes || [];
      const existingCount = currentAttrs.length - changes.removed.length;
      for (let i = 0; i < changes.added.length; i++) {
        await graphqlClient.mutation(ASSIGN_ATTRIBUTE_TO_TEMPLATE_MUTATION, {
          input: {
            templateId: editingTemplate.id,
            attributeId: changes.added[i],
            isRequired: false,
            displayOrder: existingCount + i + 1,
          },
        }).toPromise();
      }
      if (changes.reordered.length > 0) {
        await graphqlClient.mutation(REORDER_TEMPLATE_ATTRIBUTES_MUTATION, {
          input: { templateId: editingTemplate.id, attributeIds: changes.reordered },
        }).toPromise();
      }
      for (const [attrId, label] of Object.entries(changes.aliases)) {
        await graphqlClient.mutation(UPDATE_TEMPLATE_ATTRIBUTE_MUTATION, {
          input: { templateId: editingTemplate.id, attributeId: attrId, displayLabel: label },
        }).toPromise();
      }
      loadData();
    } catch (error: any) {
      console.error('Error saving attributes:', error);
      alert(error?.message || 'Failed to save attributes');
    }
  };

  const handleDeleteTemplate = async (template: Template) => {
    if (!window.confirm(`Delete template "${template.templateName}" (${template.templateCode})?`)) return;
    // No delete template mutation exists yet; inform user
    alert('Template deletion is not yet supported. Please remove all attributes first.');
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

  const handleUpdateRelationshipType = async (data: any) => {
    if (!editingRelationship) return;
    try {
      const result = await graphqlClient
        .mutation(UPDATE_RELATIONSHIP_TYPE_MUTATION, { input: { id: editingRelationship.id, ...data } })
        .toPromise();
      const errors = result.data?.updateRelationshipType?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      setEditingRelationship(null);
      loadData();
    } catch (error: any) {
      console.error('Error updating relationship type:', error);
      alert(error?.message || 'Failed to update relationship type');
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

  const handleUpdateEntityIdentifier = async (data: any) => {
    if (!editingIdentifier) return;
    try {
      const result = await graphqlClient
        .mutation(UPDATE_ENTITY_IDENTIFIER_MUTATION, { input: { id: editingIdentifier.id, ...data } })
        .toPromise();
      const errors = result.data?.updateEntityIdentifier?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      setEditingIdentifier(null);
      loadData();
    } catch (error: any) {
      console.error('Error updating identifier:', error);
      alert(error?.message || 'Failed to update identifier');
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

  const handleCreateIntersectionType = async (data: any) => {
    try {
      const result = await graphqlClient
        .mutation(CREATE_INTERSECTION_TYPE_MUTATION, { input: data })
        .toPromise();
      const errors = result.data?.createIntersectionType?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      setShowCreateIntersectionModal(false);
      loadData();
    } catch (error: any) {
      console.error('Error creating intersection type:', error);
      alert(error?.message || 'Failed to create intersection type');
    }
  };

  const handleUpdateIntersectionType = async (data: any) => {
    try {
      const result = await graphqlClient
        .mutation(UPDATE_INTERSECTION_TYPE_MUTATION, { input: data })
        .toPromise();
      const errors = result.data?.updateIntersectionType?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      setEditingIntersection(null);
      loadData();
    } catch (error: any) {
      console.error('Error updating intersection type:', error);
      alert(error?.message || 'Failed to update intersection type');
    }
  };

  const handleDeleteIntersectionType = async (it: IntersectionType) => {
    if (!window.confirm(`Delete intersection type "${it.intersectionName}" (${it.intersectionCode})?`)) return;
    try {
      const result = await graphqlClient
        .mutation(DELETE_INTERSECTION_TYPE_MUTATION, { id: it.id })
        .toPromise();
      const errors = result.data?.deleteIntersectionType?.errors;
      if (errors && errors.length > 0) {
        alert(errors[0].message);
        return;
      }
      loadData();
    } catch (error: any) {
      console.error('Error deleting intersection type:', error);
      alert(error?.message || 'Failed to delete intersection type');
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

  // Attributes are now pre-filtered by domain_code from the GraphQL query.
  // Sort: attributes assigned to templates first, then the rest.
  const domainAttributes = [...attributes].sort((a, b) => {
    const aInTemplate = templates.some(t => 
      t.domainCode === domain.domainCode && 
      t.attributes?.some(attr => attr.attributeId === a.id)
    );
    const bInTemplate = templates.some(t => 
      t.domainCode === domain.domainCode && 
      t.attributes?.some(attr => attr.attributeId === b.id)
    );
    if (aInTemplate && !bInTemplate) return -1;
    if (!aInTemplate && bInTemplate) return 1;
    return a.attributeCode.localeCompare(b.attributeCode);
  });

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
              <SchemaScopeBadge clientId={domain.clientId} clientName={domain.clientName} />
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
        <TabButton
          label={`Intersection Types (${intersectionTypes.length})`}
          isActive={activeTab === 'intersections'}
          onClick={() => setActiveTab('intersections')}
        />
      </div>

      {/* Tab Content */}
      {activeTab === 'attributes' && (
        <Section
          title={`Attributes (${domainAttributes.length})`}
          subtitle="Click an attribute to edit its values. The source sequence at the bottom is the global default; templates only override it."
          action={<button className="btn" onClick={() => setShowCreateAttributeModal(true)}>+ Attribute</button>}
        >
          {domainAttributes.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              {domainAttributes.map(attr => {
                const expanded = expandedAttributeId === attr.id;
                const sequence = (attr.defaultPrecedenceChain || []).filter((code) => code && code !== 'MANUAL');
                return (
                <div
                  key={attr.id}
                  style={{
                    ...rowStyle,
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: 0,
                    padding: 0,
                    overflow: 'hidden',
                    borderColor: expanded ? 'var(--accent)' : 'var(--line)',
                    background: expanded ? 'var(--surface)' : rowStyle.background,
                    boxShadow: expanded ? 'var(--shadow-sm)' : undefined,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px 16px',
                      cursor: 'pointer',
                      background: expanded ? 'var(--bg-alt)' : 'transparent',
                      borderBottom: expanded ? '1px solid var(--line-strong)' : 'none',
                      borderLeft: expanded ? '3px solid var(--accent)' : '3px solid transparent',
                    }}
                    onClick={() => setExpandedAttributeId(expanded ? null : attr.id)}
                  >
                    <div>
                      {expanded && (
                        <div style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          color: 'var(--accent-2)',
                          marginBottom: '2px',
                        }}>
                          Editing attribute
                        </div>
                      )}
                      <div style={{ fontSize: expanded ? '16px' : '14px', fontWeight: expanded ? 600 : 500, color: 'var(--ink)' }}>
                        {expanded ? '▾' : '▸'} {attr.attributeName}
                        {attr.isRequired && <span style={{ color: 'var(--red)', marginLeft: '4px' }}>*</span>}
                      </div>
                      <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: 'var(--ink-3)', marginTop: '2px', flexWrap: 'wrap' }}>
                        <span className="mono">{attr.attributeCode}</span>
                        <SchemaScopeBadge clientId={attr.clientId} clientName={attr.clientName} />
                        <span>Type: {attr.dataType}</span>
                        {attr.isMultiValued && <span>Multi-valued</span>}
                        {attr.referenceListCode && (
                          <span style={{ color: 'var(--accent-2)' }}>
                            📋 {attr.referenceListCode}
                          </span>
                        )}
                        {sequence.length > 0 && (
                          <span>Sequence: Manual → {sequence.join(' → ')}</span>
                        )}
                      </div>
                    </div>
                    <button
                      className="btn"
                      style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 10px' }}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDeleteAttribute(attr);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ padding: '16px', background: 'var(--bg)' }}>
                      <AttributeExpandPanel
                        attribute={attr}
                        weightAttributes={attributes}
                        referenceLists={referenceLists}
                        onSaved={() => { void refreshAttributes(); }}
                        onCancel={() => setExpandedAttributeId(null)}
                      />
                    </div>
                  )}
                </div>
                );
              })}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 500 }}>{template.templateName}</span>
                      <SchemaScopeBadge clientId={template.clientId} clientName={template.clientName} />
                      {!template.isActive && (
                        <span style={{ fontSize: '10px', color: 'var(--ink-3)', textTransform: 'uppercase' }}>Inactive</span>
                      )}
                    </div>
                    {template.description && (
                      <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '2px' }}>{template.description}</div>
                    )}
                    <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                      <span className="mono">{template.templateCode}</span>
                      <span>{template.attributes?.length || 0} attributes</span>
                      {template.applicabilityRules && Object.keys(template.applicabilityRules).length > 0 && (
                        <span style={{ color: 'var(--accent)' }}>Has applicability rules</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => setEditingTemplate(template)}
                    >
                      Edit
                    </button>
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
                    <SchemaScopeBadge clientId={rel.clientId} clientName={rel.clientName} />
                    <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                      {rel.parentDomainCode || '—'} → {rel.childDomainCode || '—'}
                    </span>
                    {rel.isRequired && (
                      <span style={{ fontSize: '10px', color: 'var(--red)', textTransform: 'uppercase', fontWeight: 600 }}>Required</span>
                    )}
                    {!rel.isRequired && rel.parentDomainCode && (
                      <span style={{ fontSize: '10px', color: 'var(--ink-3)', textTransform: 'uppercase' }}>Optional</span>
                    )}
                    {!rel.isActive && (
                      <span style={{ fontSize: '10px', color: 'var(--ink-3)', textTransform: 'uppercase' }}>Inactive</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => setEditingRelationship(rel)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn"
                      style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => handleDeleteRelationshipType(rel)}
                    >
                      Delete
                    </button>
                  </div>
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
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => setEditingIdentifier(identifier)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn"
                      style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => handleDeleteEntityIdentifier(identifier)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote text="No identifier definitions yet." />
          )}
        </Section>
      )}

      {/* Intersection Types Tab */}
      {activeTab === 'intersections' && (
        <Section
          title={`Intersection Types (${intersectionTypes.length})`}
          subtitle="Composite entity schemas where this entity type participates as a member"
          action={<button className="btn" onClick={() => setShowCreateIntersectionModal(true)}>+ Intersection Type</button>}
          last
        >
          {intersectionTypes.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              {intersectionTypes.map(it => (
                <div key={it.id} style={rowStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
                    <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{it.intersectionCode}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{it.intersectionName}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginLeft: '8px' }}>
                      {it.members.sort((a, b) => a.displayOrder - b.displayOrder).map((m, idx) => (
                        <span key={idx} style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          background: m.isRequired ? '#fef3c7' : '#f3f4f6',
                          border: `1px solid ${m.isRequired ? '#f59e0b' : '#d1d5db'}`,
                          borderRadius: '4px',
                          color: m.isRequired ? '#92400e' : '#374151',
                        }}>
                          {m.memberRole} ({m.domainCode}){m.isRequired && <span style={{ marginLeft: '4px', color: '#dc2626' }}>●</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => setEditingIntersection(it)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn"
                      style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => handleDeleteIntersectionType(it)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote text={`No intersection types defined for ${domain.domainName} yet.`} />
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
          owner={domain.clientId ? { id: domain.clientId, name: domain.clientName || 'This client' } : null}
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
          owner={domain.clientId ? { id: domain.clientId, name: domain.clientName || 'This client' } : null}
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
            owner={domain.clientId ? { id: domain.clientId, name: domain.clientName || 'This client' } : null}
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
          attributes={domainAttributes}
          onClose={() => setShowCreateIdentifierModal(false)}
          onSubmit={handleCreateEntityIdentifier}
        />
      )}

      {/* Create Intersection Type Modal */}
      {showCreateIntersectionModal && (
        <IntersectionTypeForm
          mode="create"
          domainTypes={allDomainTypes.map(d => ({ domainCode: d.domainCode, domainName: d.domainName }))}
          prefillDomain={domain.domainCode}
          onClose={() => setShowCreateIntersectionModal(false)}
          onSubmit={handleCreateIntersectionType}
        />
      )}

      {/* Edit Intersection Type Modal */}
      {editingIntersection && (
        <IntersectionTypeForm
          mode="edit"
          initialData={editingIntersection}
          domainTypes={allDomainTypes.map(d => ({ domainCode: d.domainCode, domainName: d.domainName }))}
          onClose={() => setEditingIntersection(null)}
          onSubmit={handleUpdateIntersectionType}
        />
      )}

      {/* Edit Relationship Type Modal */}
      {editingRelationship && (
        <ModalOverlay onClose={() => setEditingRelationship(null)}>
          <RelationshipTypeForm
            mode="edit"
            initialData={editingRelationship}
            domainOptions={allDomainTypes.map(d => ({ domainCode: d.domainCode, domainName: d.domainName }))}
            onCancel={() => setEditingRelationship(null)}
            onSubmit={handleUpdateRelationshipType}
          />
        </ModalOverlay>
      )}

      {/* Edit Entity Identifier Modal */}
      {editingIdentifier && (
        <ModalOverlay onClose={() => setEditingIdentifier(null)}>
          <EntityIdentifierDefinitionForm
            mode="edit"
            initialData={editingIdentifier}
            availableAttributes={domainAttributes}
            onCancel={() => setEditingIdentifier(null)}
            onSubmit={handleUpdateEntityIdentifier}
          />
        </ModalOverlay>
      )}

      {/* Edit Template Modal (comprehensive editor) */}
      {editingTemplate && (
        <TemplateEditorModal
          template={editingTemplate}
          domainCode={domain.domainCode}
          domainName={domain.domainName}
          allAttributes={attributes}
          onClose={() => setEditingTemplate(null)}
          onUpdateTemplate={handleUpdateTemplate}
          onSaveAttributes={handleSaveAttributes}
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
  owner,
  onClose,
  onSubmit
}: {
  domainTypes: DomainType[];
  owner?: { id: string; name: string } | null;
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
    isMultiValued: false,
    clientId: null as string | null,
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
              <SchemaScopeField
                value={formData.clientId}
                owner={owner}
                onChange={(clientId) => setFormData(prev => ({ ...prev, clientId }))}
              />
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
  owner,
  onClose,
  onSubmit
}: {
  fixedDomainCode: string;
  fixedDomainName: string;
  owner?: { id: string; name: string } | null;
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [formData, setFormData] = useState({
    templateCode: '',
    templateName: '',
    description: '',
    clientId: null as string | null,
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
              <SchemaScopeField
                value={formData.clientId}
                owner={owner}
                onChange={(clientId) => setFormData(prev => ({ ...prev, clientId }))}
              />
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

// Intersection Type Form Modal
function IntersectionTypeForm({
  mode,
  initialData,
  domainTypes,
  prefillDomain,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initialData?: IntersectionType;
  domainTypes: { domainCode: string; domainName: string }[];
  prefillDomain?: string;
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [formData, setFormData] = useState({
    intersectionCode: initialData?.intersectionCode || '',
    intersectionName: initialData?.intersectionName || '',
    description: initialData?.description || '',
    members: initialData?.members || (prefillDomain ? [{ domainCode: prefillDomain, memberRole: '', isRequired: true, displayOrder: 0 }] : []),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }));
  };

  const handleMemberChange = (index: number, field: string, value: any) => {
    const newMembers = [...formData.members];
    newMembers[index] = { ...newMembers[index], [field]: value };
    setFormData(prev => ({ ...prev, members: newMembers }));
  };

  const addMember = () => {
    setFormData(prev => ({
      ...prev,
      members: [...prev.members, { domainCode: '', memberRole: '', isRequired: false, displayOrder: prev.members.length }],
    }));
  };

  const removeMember = (index: number) => {
    setFormData(prev => ({ ...prev, members: prev.members.filter((_, i) => i !== index) }));
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.intersectionCode) newErrors.intersectionCode = 'Required';
    if (!formData.intersectionName) newErrors.intersectionName = 'Required';
    if (formData.members.length === 0) newErrors.members = 'At least one member required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) {
      onSubmit({
        ...(mode === 'edit' ? { id: initialData?.id } : {}),
        intersectionName: formData.intersectionName,
        description: formData.description,
        members: formData.members.map((m: any, i: number) => ({
          domainCode: m.domainCode,
          memberRole: m.memberRole,
          isRequired: m.isRequired ?? true,
          displayOrder: m.displayOrder ?? i,
        })),
      });
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
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '700px',
          maxHeight: '90vh',
          overflow: 'auto',
          border: '1px solid var(--line)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>
              {mode === 'create' ? 'Create Intersection Type' : 'Edit Intersection Type'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
              Define which entity domains compose this composite entity
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gap: '16px' }}>
              <div className="field">
                <label>Intersection Code *</label>
                <input
                  type="text"
                  className={`text-input ${errors.intersectionCode ? 'error' : ''}`}
                  value={formData.intersectionCode}
                  onChange={e => handleChange('intersectionCode', e.target.value.toUpperCase())}
                  placeholder="e.g., POSITION, LOAN"
                  disabled={mode === 'edit'}
                  required
                />
                {errors.intersectionCode && <span style={{ color: 'var(--red)', fontSize: '11px' }}>{errors.intersectionCode}</span>}
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                  Unique identifier (uppercase)
                </div>
              </div>

              <div className="field">
                <label>Intersection Name *</label>
                <input
                  type="text"
                  className={`text-input ${errors.intersectionName ? 'error' : ''}`}
                  value={formData.intersectionName}
                  onChange={e => handleChange('intersectionName', e.target.value)}
                  placeholder="e.g., Position, Loan"
                  required
                />
                {errors.intersectionName && <span style={{ color: 'var(--red)', fontSize: '11px' }}>{errors.intersectionName}</span>}
              </div>

              <div className="field">
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={formData.description}
                  onChange={e => handleChange('description', e.target.value)}
                  placeholder="What is this composite entity?"
                  rows={2}
                />
              </div>

              <div className="field">
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Members *</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={addMember}
                    style={{ fontSize: '11px', padding: '4px 10px' }}
                  >
                    + Add Member
                  </button>
                </label>
                {errors.members && <span style={{ color: 'var(--red)', fontSize: '11px' }}>{errors.members}</span>}

                {formData.members.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: '13px' }}>
                    No members defined. Click "+ Add Member" to add entity domains.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: '12px', marginTop: '8px' }}>
                    {formData.members.map((member, index) => (
                      <div
                        key={index}
                        style={{
                          padding: '12px',
                          background: 'var(--bg)',
                          border: '1px solid var(--line)',
                          borderRadius: '6px',
                        }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px', alignItems: 'end' }}>
                          <div>
                            <label style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Domain *</label>
                            <select
                              className="select"
                              value={member.domainCode}
                              onChange={(e) => handleMemberChange(index, 'domainCode', e.target.value)}
                            >
                              <option value="">Select domain...</option>
                              {domainTypes.map(d => (
                                <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Role *</label>
                            <input
                              type="text"
                              className="text-input"
                              value={member.memberRole}
                              onChange={(e) => handleMemberChange(index, 'memberRole', e.target.value.toLowerCase())}
                              placeholder="e.g., fund, security"
                            />
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '8px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={member.isRequired}
                                onChange={(e) => handleMemberChange(index, 'isRequired', e.target.checked)}
                              />
                              Required
                            </label>
                            <button
                              type="button"
                              className="btn"
                              style={{ fontSize: '11px', padding: '4px 8px', color: 'var(--red)' }}
                              onClick={() => removeMember(index)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
            <button type="submit" className="btn btn-primary">
              {mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


// ============== TEMPLATE EDITOR MODAL ==============
// Comprehensive editor for a template: metadata, applicability rules, and attribute assignments.

interface ApplicabilityCondition {
  attributeCode: string;
  operator: 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'exists';
  value: string;
}

interface ApplicabilityRules {
  conditions: ApplicabilityCondition[];
  logic: 'AND' | 'OR';
}

function TemplateEditorModal({
  template,
  domainCode,
  domainName,
  allAttributes,
  onClose,
  onUpdateTemplate,
  onSaveAttributes,
}: {
  template: Template;
  domainCode: string;
  domainName: string;
  allAttributes: Attribute[];
  onClose: () => void;
  onUpdateTemplate: (data: { templateName?: string; description?: string; isActive?: boolean; applicabilityRules?: any }) => void;
  onSaveAttributes: (changes: { added: string[]; removed: string[]; reordered: string[]; aliases: Record<string, string | undefined> }) => void;
}) {
  const [activeSection, setActiveSection] = useState<'details' | 'rules' | 'attributes' | 'sourcePrefs'>('details');
  const [templateName, setTemplateName] = useState(template.templateName);
  const [description, setDescription] = useState(template.description || '');
  const [isActive, setIsActive] = useState(template.isActive);
  const [rules, setRules] = useState<ApplicabilityRules>(
    template.applicabilityRules && Object.keys(template.applicabilityRules).length > 0
      ? template.applicabilityRules
      : { conditions: [], logic: 'AND' }
  );

  const currentAttributes = template.attributes || [];
  const assignedAttributeIds = new Set(currentAttributes.map(a => a.attributeId));
  const availableAttributes = allAttributes.filter(a => !assignedAttributeIds.has(a.id));

  const handleSaveDetails = () => {
    onUpdateTemplate({ templateName, description, isActive });
  };

  const handleSaveRules = () => {
    onUpdateTemplate({ applicabilityRules: rules });
  };

  const addCondition = () => {
    setRules(prev => ({
      ...prev,
      conditions: [...prev.conditions, { attributeCode: '', operator: 'eq', value: '' }],
    }));
  };

  const updateCondition = (index: number, field: keyof ApplicabilityCondition, value: string) => {
    setRules(prev => {
      const newConditions = [...prev.conditions];
      newConditions[index] = { ...newConditions[index], [field]: value };
      return { ...prev, conditions: newConditions };
    });
  };

  const removeCondition = (index: number) => {
    setRules(prev => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }));
  };

  const handleDeleteTemplate = async (template: Template) => {
    if (!window.confirm(`Delete template "${template.templateName}" (${template.templateCode})?`)) return;
    alert('Template deletion is not yet supported. Please remove all attributes first.');
  };

  return (
    <TemplateEditorOverlay
      template={template}
      domainName={domainName}
      activeSection={activeSection}
      setActiveSection={setActiveSection}
      onClose={onClose}
    >
      {activeSection === 'details' && (
        <TemplateDetailsSection
          templateName={templateName}
          setTemplateName={setTemplateName}
          description={description}
          setDescription={setDescription}
          isActive={isActive}
          setIsActive={setIsActive}
          onSave={handleSaveDetails}
        />
      )}
      {activeSection === 'rules' && (
        <TemplateRulesSection
          rules={rules}
          setRules={setRules}
          allAttributes={allAttributes}
          addCondition={addCondition}
          updateCondition={updateCondition}
          removeCondition={removeCondition}
          onSave={handleSaveRules}
        />
      )}
      {activeSection === 'attributes' && (
        <TemplateAttributesSection
          currentAttributes={currentAttributes}
          availableAttributes={availableAttributes}
          onSave={onSaveAttributes}
          onCancel={() => setActiveSection('details')}
        />
      )}
      {activeSection === 'sourcePrefs' && (
        <TemplateSourcePrefsSection
          template={template}
          currentAttributes={currentAttributes}
        />
      )}
    </TemplateEditorOverlay>
  );
}

function TemplateEditorOverlay({
  template,
  domainName,
  activeSection,
  setActiveSection,
  onClose,
  children,
}: {
  template: Template;
  domainName: string;
  activeSection: string;
  setActiveSection: (s: 'details' | 'rules' | 'attributes' | 'sourcePrefs') => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overlay"
      style={{
        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
        background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px 20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)', borderRadius: '12px', width: '100%', maxWidth: '1400px',
          border: '1px solid var(--line)', height: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '18px', fontWeight: 600 }}>Edit Template</div>
              <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
                <span className="mono">{template.templateCode}</span> · {domainName}
              </div>
            </div>
            <button className="btn" onClick={onClose} style={{ fontSize: '18px', padding: '4px 10px' }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: '4px', marginTop: '16px' }}>
            {(['details', 'rules', 'attributes', 'sourcePrefs'] as const).map(section => (
              <button
                key={section}
                onClick={() => setActiveSection(section)}
                style={{
                  padding: '8px 16px', fontSize: '12px',
                  fontWeight: activeSection === section ? 600 : 400,
                  color: activeSection === section ? 'var(--ink)' : 'var(--ink-3)',
                  background: 'none', border: 'none',
                  borderBottom: activeSection === section ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px',
                }}
              >
                {section === 'details' ? 'Details' : section === 'rules' ? 'Applicability Rules' : section === 'attributes' ? 'Attributes' : 'Source Preferences'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}


function TemplateDetailsSection({
  templateName, setTemplateName, description, setDescription, isActive, setIsActive, onSave,
}: {
  templateName: string;
  setTemplateName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  isActive: boolean;
  setIsActive: (v: boolean) => void;
  onSave: () => void;
}) {
  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div className="field">
        <label>Template Name</label>
        <input
          type="text"
          className="text-input"
          value={templateName}
          onChange={e => setTemplateName(e.target.value)}
          placeholder="e.g., Open-End Fund, Corporate Bond"
        />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea
          className="text-input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What is this template for?"
          rows={3}
        />
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={e => setIsActive(e.target.checked)}
            style={{ width: '16px', height: '16px' }}
          />
          <span>Active</span>
        </label>
        <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
          Inactive templates are hidden from entity creation forms
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '8px' }}>
        <button className="btn btn-primary" onClick={onSave}>Save Details</button>
      </div>
    </div>
  );
}


function TemplateRulesSection({
  rules, setRules, allAttributes, addCondition, updateCondition, removeCondition, onSave,
}: {
  rules: ApplicabilityRules;
  setRules: (r: ApplicabilityRules) => void;
  allAttributes: Attribute[];
  addCondition: () => void;
  updateCondition: (index: number, field: keyof ApplicabilityCondition, value: string) => void;
  removeCondition: (index: number) => void;
  onSave: () => void;
}) {
  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div style={{ fontSize: '12px', color: 'var(--ink-3)', lineHeight: '1.5' }}>
        Define which records this template applies to. Conditions are evaluated against entity attributes
        when assigning templates. Leave empty to apply to all records of this type.
      </div>
      {rules.conditions.length > 1 && (
        <div className="field">
          <label>Combine conditions with</label>
          <select
            className="select"
            value={rules.logic}
            onChange={e => setRules({ ...rules, logic: e.target.value as 'AND' | 'OR' })}
          >
            <option value="AND">ALL conditions must match (AND)</option>
            <option value="OR">ANY condition can match (OR)</option>
          </select>
        </div>
      )}
      {rules.conditions.map((condition, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid', gridTemplateColumns: '1fr 120px 1fr auto', gap: '8px', alignItems: 'end',
            padding: '12px', background: 'var(--surface, #fafafa)', border: '1px solid var(--line)', borderRadius: '6px',
          }}
        >
          <div>
            <label style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Attribute</label>
            <select
              className="select"
              value={condition.attributeCode}
              onChange={e => updateCondition(idx, 'attributeCode', e.target.value)}
              style={{ fontSize: '12px' }}
            >
              <option value="">Select attribute...</option>
              {allAttributes.map(a => (
                <option key={a.id} value={a.attributeCode}>{a.attributeName} ({a.attributeCode})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Operator</label>
            <select
              className="select"
              value={condition.operator}
              onChange={e => updateCondition(idx, 'operator', e.target.value)}
              style={{ fontSize: '12px' }}
            >
              <option value="eq">equals</option>
              <option value="neq">not equals</option>
              <option value="in">in list</option>
              <option value="not_in">not in list</option>
              <option value="gt">greater than</option>
              <option value="lt">less than</option>
              <option value="gte">&ge;</option>
              <option value="lte">&le;</option>
              <option value="contains">contains</option>
              <option value="exists">exists</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Value</label>
            <input
              type="text"
              className="text-input"
              value={condition.value}
              onChange={e => updateCondition(idx, 'value', e.target.value)}
              placeholder={condition.operator === 'in' || condition.operator === 'not_in' ? 'val1, val2, val3' : 'Value'}
              style={{ fontSize: '12px' }}
            />
          </div>
          <button
            className="btn"
            style={{ color: 'var(--red)', fontSize: '11px', padding: '6px 8px' }}
            onClick={() => removeCondition(idx)}
            title="Remove condition"
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', paddingTop: '8px' }}>
        <button className="btn" onClick={addCondition} style={{ fontSize: '12px' }}>+ Add Condition</button>
        <button className="btn btn-primary" onClick={onSave}>Save Rules</button>
      </div>
    </div>
  );
}


function TemplateAttributesSection({
  currentAttributes, availableAttributes, onSave, onCancel,
}: {
  currentAttributes: TemplateAttribute[];
  availableAttributes: Attribute[];
  onSave: (changes: { added: string[]; removed: string[]; reordered: string[]; aliases: Record<string, string | undefined> }) => void;
  onCancel?: () => void;
}) {
  const pickerAvailable: PickerAttribute[] = availableAttributes.map(a => ({
    id: a.id,
    attributeCode: a.attributeCode,
    attributeName: a.attributeName,
    dataType: a.dataType,
    description: a.description,
  }));

  return (
    <TemplateAttributePicker
      availableAttributes={pickerAvailable}
      selectedAttributes={currentAttributes}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
}


function TemplateSourcePrefsSection({
  template,
  currentAttributes,
}: {
  template: Template;
  currentAttributes: TemplateAttribute[];
}) {
  const [attributeChains, setAttributeChains] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadChains();
  }, [template.id]);

  const loadChains = async () => {
    setLoading(true);
    try {
      const register = await graphqlQuery<{ attributeRegister: Attribute[] }, { domainCode: string }>(
        ATTRIBUTE_REGISTER_QUERY,
        { domainCode: template.domainCode },
      );
      const globalByCode = new Map(
        (register.data?.attributeRegister || []).map((attr) => [attr.attributeCode, attr.defaultPrecedenceChain || []]),
      );
      const chains = await Promise.all(currentAttributes.map(async (attr) => {
        const attrCode = attr.attribute?.attributeCode || (attr as any).attributeCode;
        const attrName = attr.attribute?.attributeName || (attr as any).attributeName;
        const chainResult = await graphqlQuery<{ templatePrecedenceChain: any }, { templateId: string; attributeCode: string }>(
          TEMPLATE_PRECEDENCE_CHAIN_QUERY,
          { templateId: template.id, attributeCode: attrCode }
        );
        const override = chainResult.data?.templatePrecedenceChain;
        const globalChain = globalByCode.get(attrCode) || [];
        return {
          attributeCode: attrCode,
          attributeName: attrName,
          globalChain,
          hasOverride: Boolean(override),
          chain: override?.chain || ['MANUAL', ...globalChain],
          chainVersion: override?.chainVersion || 0,
        };
      }));
      setAttributeChains(chains);
    } catch (error) {
      console.error('Error loading chains:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleChainUpdated = (attrCode: string, update: { chain: string[]; hasOverride: boolean; chainVersion: number }) => {
    setAttributeChains(prev =>
      prev.map(c =>
        c.attributeCode === attrCode ? { ...c, ...update } : c
      )
    );
  };

  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--ink-3)' }}>Loading source preferences...</div>;
  }

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div style={{ fontSize: '12px', color: 'var(--ink-3)', lineHeight: '1.5' }}>
        Each attribute uses its global source sequence. Set an override here only when this template should differ. Manual override still wins first, then conditional rules, then this template override, then the global sequence.
      </div>

      {attributeChains.map(attr => (
        <SourceChainEditor
          key={attr.attributeCode}
          attributeCode={attr.attributeCode}
          attributeName={attr.attributeName}
          chain={attr.chain}
          globalChain={attr.globalChain}
          hasOverride={attr.hasOverride}
          chainVersion={attr.chainVersion}
          templateId={template.id}
          onChainUpdated={handleChainUpdated}
        />
      ))}
    </div>
  );
}

function SourceChainEditor({
  attributeCode,
  attributeName,
  chain,
  globalChain,
  hasOverride,
  chainVersion,
  templateId,
  onChainUpdated,
}: {
  attributeCode: string;
  attributeName: string;
  chain: string[];
  globalChain: string[];
  hasOverride: boolean;
  chainVersion: number;
  templateId: string;
  onChainUpdated: (attrCode: string, update: { chain: string[]; hasOverride: boolean; chainVersion: number }) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftChain, setDraftChain] = useState<string[]>(chain.filter(c => c !== 'MANUAL'));
  const [saving, setSaving] = useState(false);

  const sourceColors: Record<string, string> = {
    BLOOMBERG: '#c2410c',
    WSO: '#6d28d9',
    DEALCLOUD: '#0369a1',
    ALLVUE: '#047857',
    SPCIQ: '#be185d',
    MANUAL: '#b45309',
    DERIVED: '#475569',
  };

  const allSources = ['BLOOMBERG', 'WSO', 'DEALCLOUD', 'ALLVUE', 'SPCIQ'];

  const moveItem = (fromIdx: number, toIdx: number) => {
    setDraftChain(prev => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  };

  const removeItem = (idx: number) => {
    setDraftChain(prev => prev.filter((_, i) => i !== idx));
  };

  const addSource = (sourceCode: string) => {
    if (!draftChain.includes(sourceCode)) {
      setDraftChain(prev => [...prev, sourceCode]);
    }
  };

  const saveChain = async (nextChain: string[]) => {
    setSaving(true);
    try {
      const result = await graphqlMutation<{ updateTemplatePrecedenceChain: any }>(
        UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION,
        { templateId, attributeCode, chain: nextChain }
      );
      if (result.data?.updateTemplatePrecedenceChain?.success) {
        const r = result.data.updateTemplatePrecedenceChain;
        const kept = nextChain.filter((code) => code && code !== 'MANUAL');
        const usingOverride = kept.length > 0;
        onChainUpdated(attributeCode, {
          hasOverride: usingOverride,
          chain: usingOverride ? ['MANUAL', ...kept] : ['MANUAL', ...globalChain.filter((code) => code !== 'MANUAL')],
          chainVersion: r.chainVersion || 0,
        });
        setIsEditing(false);
      } else {
        const err = result.data?.updateTemplatePrecedenceChain?.errors?.[0];
        alert(`Failed: ${err?.message || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      border: '1px solid var(--line)',
      borderRadius: '8px',
      padding: '16px',
      background: 'var(--surface, #fafafa)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>{attributeName}</div>
          <div style={{ fontSize: '11px', color: 'var(--ink-3)', fontFamily: 'monospace' }}>
            {attributeCode} · {hasOverride ? `template override v${chainVersion}` : 'using global sequence'}
          </div>
        </div>
        {!isEditing ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            {hasOverride && (
              <button className="btn" onClick={() => saveChain([])} disabled={saving} style={{ fontSize: '12px' }}>
                Use global sequence
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                setDraftChain((hasOverride ? chain : ['MANUAL', ...globalChain]).filter(c => c !== 'MANUAL'));
                setIsEditing(true);
              }}
              style={{ fontSize: '12px' }}
            >
              {hasOverride ? 'Edit override' : 'Override for this template'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn"
              onClick={() => setIsEditing(false)}
              style={{ fontSize: '12px' }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => saveChain(draftChain)}
              disabled={saving || draftChain.length === 0}
              style={{ fontSize: '12px' }}
            >
              {saving ? 'Saving...' : 'Save override'}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '8px 12px', borderRadius: '6px',
          border: '2px dashed #b4530960', background: '#b4530908',
        }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#b45309' }} />
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#b45309' }}>Manual Override</span>
          <span style={{ fontSize: '9px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>always #1</span>
        </div>
        <span style={{ color: 'var(--ink-3)' }}>→</span>
        {(() => {
          const shownChain = isEditing ? draftChain : chain.filter((code) => code !== 'MANUAL');
          if (shownChain.length === 0) {
            return <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>No sources in this sequence yet.</span>;
          }
          return shownChain.map((srcCode, idx) => {
          const color = sourceColors[srcCode] || '#6b7280';
          return (
            <div key={srcCode} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '8px 12px', borderRadius: '6px',
                border: `1px solid ${color}40`, background: `${color}0a`,
                position: 'relative',
              }}>
                {isEditing && (
                  <div style={{
                    position: 'absolute', top: '-8px', right: '-8px',
                    display: 'flex', gap: '2px', opacity: 0.8,
                  }}>
                    {idx > 0 && (
                      <button
                        onClick={() => moveItem(idx, idx - 1)}
                        style={{
                          width: '16px', height: '16px', borderRadius: '50%',
                          background: 'white', border: '1px solid #e5e7eb',
                          fontSize: '10px', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        ↑
                      </button>
                    )}
                    {idx < shownChain.length - 1 && (
                      <button
                        onClick={() => moveItem(idx, idx + 1)}
                        style={{
                          width: '16px', height: '16px', borderRadius: '50%',
                          background: 'white', border: '1px solid #e5e7eb',
                          fontSize: '10px', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        ↓
                      </button>
                    )}
                    <button
                      onClick={() => removeItem(idx)}
                      style={{
                        width: '16px', height: '16px', borderRadius: '50%',
                        background: 'white', border: '1px solid #fecaca',
                        fontSize: '10px', color: '#ef4444', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
                <span style={{ fontSize: '12px', fontWeight: 500, color }}>{srcCode}</span>
                <span style={{ fontSize: '9px', color: 'var(--ink-3)' }}>#{idx + 2}</span>
              </div>
              {idx < shownChain.length - 1 && <span style={{ color: 'var(--ink-3)' }}>→</span>}
            </div>
          );
        });
        })()}
      </div>

      {isEditing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Add source:</span>
          {allSources.filter(s => !draftChain.includes(s)).map(srcCode => {
            const color = sourceColors[srcCode] || '#6b7280';
            return (
              <button
                key={srcCode}
                onClick={() => addSource(srcCode)}
                style={{
                  padding: '4px 8px', fontSize: '11px', borderRadius: '4px',
                  border: `1px dashed ${color}40`, color, background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                + {srcCode}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


