'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { domainCodeFromRoute } from '@/lib/domain-routes';
import { graphqlQuery, DOMAIN_TYPES_QUERY, ENTITY_CREATE_TEMPLATES_QUERY, INTERSECTION_TYPES_QUERY, RELATIONSHIP_TYPES_QUERY, ENTITIES_QUERY } from '@/lib/graphql';
import { AttributeValueInput } from '@/components/forms/AttributeValueInput';
import { CreateParentFields } from '@/components/forms/CreateParentFields';
import { clampAttributeSpan, type AttributeSectionOrder } from '@/lib/attribute-layout';
import { createParentSlots, createParentSummary, unfilledRequiredParents, type CreateIntersectionMember, type ParentSelection } from '@/lib/create-parents';
import { groupCreateAttributes } from '@/lib/entity-create-layout';
import { toParentLinkCounts, type ParentLinkCount } from '@/lib/parent-entities';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

interface EntityFormProps {
  domain: string;
  mode: 'create' | 'edit';
  initialData?: any;
  onSubmit: (data: any) => void;
  onCancel: () => void;
  formId?: string;
  showActions?: boolean;
}

interface TemplateAttribute {
  attributeId: string;
  attribute: {
    attributeCode: string;
    attributeName: string;
    dataType: string;
    displaySection?: string | null;
    displayGroup?: number | null;
    displaySpanColumns?: number | null;
    displaySpanRows?: number | null;
    isVisible?: boolean | null;
  };
  isRequired: boolean;
  displayOrder: number;
  displayLabel?: string;
  sectionName?: string | null;
}

interface TemplateSection {
  sectionCode: string;
  sectionName: string;
  displayOrder: number;
}

interface DomainTemplate {
  id: string;
  templateCode: string;
  templateName: string;
  description?: string;
  isActive: boolean;
  attributes: TemplateAttribute[];
  sections?: TemplateSection[];
}

interface RelationshipType {
  id: string;
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode?: string;
  childDomainCode?: string;
  cardinality?: string | null;
  isRequired?: boolean | null;
}

type RelationshipEntry = ParentSelection;

export function EntityForm({ domain, mode, initialData, onSubmit, onCancel, formId = 'entity-form', showActions = true }: EntityFormProps) {
  const domainCode = domainCodeFromRoute(domain);

  const [templates, setTemplates] = useState<DomainTemplate[]>([]);
  const [attributeSections, setAttributeSections] = useState<AttributeSectionOrder[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<RelationshipType[]>([]);
  const [domainNames, setDomainNames] = useState<Record<string, string>>({});
  const [intersectionMembers, setIntersectionMembers] = useState<CreateIntersectionMember[]>([]);
  const [linkCounts, setLinkCounts] = useState<ParentLinkCount[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  const [formData, setFormData] = useState(initialData || {
    code: '',
    name: '',
    description: '',
    template: '',
    attributes: {} as Record<string, any>,
    sources: [] as string[],
    parentRelationships: [] as RelationshipEntry[],
    childRelationships: [] as RelationshipEntry[],
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoadingTemplates(true);
    graphqlQuery<{ domainTemplates: DomainTemplate[]; attributeSections: AttributeSectionOrder[] }, { domainCode: string }>(
      ENTITY_CREATE_TEMPLATES_QUERY,
      { domainCode },
    ).then(({ data }) => {
      if (cancelled) return;
      const list = data?.domainTemplates || [];
      setTemplates(list);
      setAttributeSections(data?.attributeSections || []);
      if (!initialData?.template && list.length > 0) {
        setFormData((prev: any) => ({ ...prev, template: prev.template || list[0].templateCode }));
      }
      setLoadingTemplates(false);
    });
    graphqlQuery<{ relationshipTypes: RelationshipType[] }, {}>(RELATIONSHIP_TYPES_QUERY, {}).then(({ data }) => {
      if (cancelled) return;
      if (data?.relationshipTypes) setRelationshipTypes(data.relationshipTypes);
    });
    graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string }> }, Record<string, never>>(DOMAIN_TYPES_QUERY, {}).then(({ data }) => {
      if (cancelled) return;
      const names: Record<string, string> = {};
      for (const domainType of data?.domainTypes || []) names[domainType.domainCode] = domainType.domainName;
      setDomainNames(names);
    });
    graphqlQuery<{ intersectionTypes: Array<{ intersectionCode: string; isActive: boolean; members: CreateIntersectionMember[] }> }, Record<string, never>>(
      INTERSECTION_TYPES_QUERY,
      {},
    ).then(({ data }) => {
      if (cancelled) return;
      const match = (data?.intersectionTypes || []).find((intersection) => intersection.isActive && intersection.intersectionCode.toUpperCase() === domainCode);
      setIntersectionMembers(match?.members || []);
    });
    void Promise.resolve(supabaseBrowserClient().rpc('relationship_link_counts')).then(({ data }) => {
      if (cancelled) return;
      setLinkCounts(toParentLinkCounts((data || []) as Array<Record<string, unknown>>));
    }).catch(() => {
      if (!cancelled) setLinkCounts([]);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainCode]);

  const handleChange = (field: string, value: any) => {
    setFormData((prev: typeof formData) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const handleAttributeChange = (attrCode: string, value: any) => {
    setFormData((prev: typeof formData) => ({
      ...prev,
      attributes: { ...prev.attributes, [attrCode]: value },
    }));
  };

  const parentSlots = useMemo(
    () => createParentSlots(domainCode, relationshipTypes, { names: domainNames, linkCounts, intersectionMembers }),
    [domainCode, relationshipTypes, domainNames, linkCounts, intersectionMembers],
  );
  const parentSummary = createParentSummary(parentSlots);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.code) newErrors.code = 'Entity code is required';
    if (!formData.name) newErrors.name = 'Entity name is required';
    if (!formData.template) newErrors.template = 'Template is required';
    if (mode === 'create') {
      for (const slot of unfilledRequiredParents(parentSlots, formData.parentRelationships, formData.childRelationships)) {
        newErrors[slot.key] = `${slot.label} is required`;
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(formData);
    }
  };

  const selectedTemplate = templates.find(t => t.templateCode === formData.template);
  const templateAttributes = (selectedTemplate?.attributes || []).filter((attribute) => attribute.attribute.isVisible !== false);
  const attributeGroups = groupCreateAttributes(
    templateAttributes.map((attribute) => ({
      ...attribute,
      name: attribute.displayLabel || attribute.attribute.attributeName,
      templateSection: attribute.sectionName,
      displaySection: attribute.attribute.displaySection,
      displayOrder: attribute.displayOrder,
      displayGroup: attribute.attribute.displayGroup,
    })),
    (selectedTemplate?.sections || []).map((section) => ({
      sectionName: section.sectionName,
      displayOrder: section.displayOrder,
    })),
    attributeSections,
  );

  // A blank parent or child domain means the relationship can connect any entity type,
  // so beneficial-ownership, counterparty, and facility edges are offered everywhere.
  const slottedCodes = new Set(parentSlots.map((slot) => slot.relationshipCode.toUpperCase()));
  const memberDomains = new Set(intersectionMembers.map((member) => member.domainCode.trim().toUpperCase()).filter(Boolean));
  const relevantRelationshipTypes = relationshipTypes.filter((r) => {
    if (slottedCodes.has(r.relationshipCode.toUpperCase())) return false;
    if (!r.parentDomainCode || !r.childDomainCode) return true;
    const parent = r.parentDomainCode.toUpperCase();
    const child = r.childDomainCode.toUpperCase();
    if (parent !== domainCode && child !== domainCode) return false;
    if (memberDomains.size === 0) return true;
    const other = parent === domainCode ? child : parent;
    return memberDomains.has(other);
  });

  return (
    <form id={formId} onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
    <CreateParentFields
      slots={parentSlots}
      summary={parentSummary}
      parents={formData.parentRelationships}
      children={formData.childRelationships}
      errors={errors}
      onChange={(next) => {
        setFormData((prev: typeof formData) => ({ ...prev, ...next }));
        setErrors((prev) => {
          const cleared = { ...prev };
          for (const slot of parentSlots) delete cleared[slot.key];
          return cleared;
        });
      }}
    />
    <div className="field-section">
      <div className="field-section-head">
        <div className="field-section-name">Entity information</div>
      </div>
      <div className="builder-body">
        <div className="entity-identity">
          <div className="field">
            <label>Entity name *</label>
            <input
              className={`text-input ${errors.name ? 'error' : ''}`}
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Enter entity name"
            />
            {errors.name && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.name}</span>}
          </div>
          <div className="field">
            <label>Code *</label>
            <input
              className={`text-input ${errors.code ? 'error' : ''}`}
              value={formData.code}
              onChange={(e) => handleChange('code', e.target.value)}
              placeholder={`${domainCode}-001`}
              disabled={mode === 'edit'}
            />
            {errors.code && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.code}</span>}
          </div>
          <div className="field">
            <label>Template *</label>
            <select
              className={`select ${errors.template ? 'error' : ''}`}
              value={formData.template}
              onChange={(e) => handleChange('template', e.target.value)}
              disabled={loadingTemplates}
            >
              <option value="">{loadingTemplates ? 'Loading templates...' : 'Select template...'}</option>
              {templates.map(t => (
                <option key={t.templateCode} value={t.templateCode}>{t.templateName} ({t.templateCode})</option>
              ))}
            </select>
            {errors.template && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.template}</span>}
            {!loadingTemplates && templates.length === 0 && (
              <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                No templates defined for this entity type yet — create one in Entity Type Management.
              </div>
            )}
          </div>
          <div className="field entity-identity-description">
            <label>Description</label>
            <input
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Brief description of this entity"
            />
          </div>
        </div>
      </div>
    </div>

        {attributeGroups.map((group) => (
          <div className="field-section" key={group.section}>
            <div className="field-section-head">
              <div className="field-section-name">{group.section}</div>
              <div className="field-section-count">{group.items.length}</div>
            </div>
            <div className="create-section-grid" style={{ ['--section-columns' as string]: String(group.columnCount) }}>
              {group.items.map((tplAttr) => {
                const span = clampAttributeSpan(
                  tplAttr.attribute.displaySpanColumns,
                  tplAttr.attribute.displaySpanRows,
                  group.columnCount,
                );
                const label = tplAttr.displayLabel || tplAttr.attribute.attributeName;
                return (
                  <div key={tplAttr.attributeId} className={`field attr-span-cols-${span.columns} attr-span-rows-${span.rows}`}>
                    <label>
                      {label}
                      {tplAttr.isRequired && <span style={{ color: 'var(--red)', marginLeft: '4px' }}>*</span>}
                    </label>
                    <AttributeValueInput
                      attributeCode={tplAttr.attribute.attributeCode}
                      dataType={tplAttr.attribute.dataType}
                      value={formData.attributes[tplAttr.attribute.attributeCode] || ''}
                      onChange={(value) => handleAttributeChange(tplAttr.attribute.attributeCode, value)}
                      placeholder={`Enter ${label.toLowerCase()}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {relevantRelationshipTypes.length > 0 && (
          <>
            <div className="field-section">
              <div className="field-section-head">
                <div className="field-section-name">{parentSlots.length > 0 ? 'Other parent relationships' : 'Parent relationships'}</div>
              </div>
              <div className="builder-body">
                <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '10px' }}>
                  {parentSlots.length > 0
                    ? 'Additional records this one belongs to.'
                    : 'The issuer a security belongs to, or the fund a position is held in.'}
                </div>
                <RelationshipEditor
                  entries={formData.parentRelationships.filter((entry: RelationshipEntry) => !slottedCodes.has(entry.relationshipCode.toUpperCase()))}
                  relationshipTypes={relevantRelationshipTypes}
                  onChange={(entries) => {
                    setFormData((prev: typeof formData) => ({
                      ...prev,
                      parentRelationships: [
                        ...prev.parentRelationships.filter((entry: RelationshipEntry) => slottedCodes.has(entry.relationshipCode.toUpperCase())),
                        ...entries.filter((entry: RelationshipEntry) => !slottedCodes.has(entry.relationshipCode.toUpperCase())),
                      ],
                    }));
                  }}
                />
              </div>
            </div>

            <div className="field-section">
              <div className="field-section-head">
                <div className="field-section-name">Child relationships</div>
              </div>
              <div className="builder-body">
                <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '10px' }}>
                  Deals or positions that belong to this record.
                </div>
                <RelationshipEditor
                  entries={formData.childRelationships.filter((entry: RelationshipEntry) => !slottedCodes.has(entry.relationshipCode.toUpperCase()))}
                  relationshipTypes={relevantRelationshipTypes}
                  onChange={(entries) => {
                    setFormData((prev: typeof formData) => ({
                      ...prev,
                      childRelationships: [
                        ...prev.childRelationships.filter((entry: RelationshipEntry) => slottedCodes.has(entry.relationshipCode.toUpperCase())),
                        ...entries.filter((entry: RelationshipEntry) => !slottedCodes.has(entry.relationshipCode.toUpperCase())),
                      ],
                    }));
                  }}
                />
              </div>
            </div>
          </>
        )}
      {showActions && (
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', padding: '4px 0 16px' }}>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      )}
    </form>
  );
}

// Lets the user attach existing entity records (e.g. an Issuer/Borrower) as
// parent/child relationships of the entity being created or edited.
function RelationshipEditor({
  entries,
  relationshipTypes,
  onChange,
}: {
  entries: RelationshipEntry[];
  relationshipTypes: RelationshipType[];
  onChange: (entries: RelationshipEntry[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [relCode, setRelCode] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [isPrimary, setIsPrimary] = useState(true);

  const runSearch = useCallback(async (term: string) => {
    if (!term || term.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const { data } = await graphqlQuery<{ entities: { edges: { node: any }[] } }, any>(ENTITIES_QUERY, {
      filter: { entityName: term },
      pagination: { first: 10 },
    });
    setResults(data?.entities?.edges?.map(e => e.node) || []);
    setSearching(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => runSearch(search), 350);
    return () => clearTimeout(t);
  }, [search, runSearch]);

  const addEntry = (entity: any) => {
    const rel = relationshipTypes.find(r => r.relationshipCode === relCode);
    if (!rel) return;
    const entry: RelationshipEntry = {
      entityId: entity.id,
      entityCode: entity.entityCode,
      entityName: entity.entityName,
      domainCode: entity.domainCode,
      relationshipCode: rel.relationshipCode,
      relationshipName: rel.relationshipName,
      isPrimary,
      validFrom: new Date().toISOString().split('T')[0],
    };
    onChange([...entries, entry]);
    setAdding(false);
    setRelCode('');
    setSearch('');
    setResults([]);
    setIsPrimary(true);
  };

  const removeEntry = (idx: number) => {
    onChange(entries.filter((_, i) => i !== idx));
  };

  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '14px' }}>
      {entries.length > 0 && (
        <div style={{ display: 'grid', gap: '8px', marginBottom: adding ? '14px' : 0 }}>
          {entries.map((entry, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--bg-2, #f5f5f5)',
                border: '1px solid var(--line)',
                borderRadius: '4px',
                fontSize: '12px',
              }}
            >
              <div>
                <span className="mono" style={{ color: 'var(--ink-3)', marginRight: '8px' }}>{entry.relationshipCode}</span>
                <strong>{entry.entityName}</strong>
                <span style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>({entry.domainCode} · {entry.entityCode})</span>
                {entry.isPrimary && (
                  <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--accent)', fontWeight: 600, textTransform: 'none' }}>Primary</span>
                )}
              </div>
              <button
                type="button"
                className="btn"
                style={{ color: 'var(--red)', padding: '2px 8px', fontSize: '11px' }}
                onClick={() => removeEntry(idx)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <button type="button" className="btn" style={{ fontSize: '12px' }} onClick={() => setAdding(true)}>
          + Add Relationship
        </button>
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          <select className="select" value={relCode} onChange={e => setRelCode(e.target.value)}>
            <option value="">Select relationship type...</option>
            {relationshipTypes.map(r => (
              <option key={r.id} value={r.relationshipCode}>{r.relationshipName} ({r.relationshipCode})</option>
            ))}
            {relationshipTypes.length === 0 && <option disabled>No relationship types configured for this entity type</option>}
          </select>

          {relCode && (
            <>
              <input
                className="text-input"
                placeholder="Search entities by name..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
              {searching && <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Searching...</div>}
              {results.length > 0 && (
                <div style={{ display: 'grid', gap: '4px', maxHeight: '140px', overflow: 'auto' }}>
                  {results.map(entity => (
                    <div
                      key={entity.id}
                      onClick={() => addEntry(entity)}
                      style={{
                        padding: '6px 10px',
                        border: '1px solid var(--line)',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        background: 'var(--bg-2, #f5f5f5)',
                      }}
                    >
                      <strong>{entity.entityName}</strong>
                      <span style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>
                        ({entity.domainCode} · {entity.entityCode})
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {search.length >= 2 && !searching && results.length === 0 && (
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', fontStyle: 'italic' }}>No matching entities found.</div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <input type="checkbox" checked={isPrimary} onChange={e => setIsPrimary(e.target.checked)} />
                Primary relationship
              </label>
            </>
          )}

          <div>
            <button type="button" className="btn" style={{ fontSize: '12px' }} onClick={() => { setAdding(false); setRelCode(''); setSearch(''); setResults([]); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
