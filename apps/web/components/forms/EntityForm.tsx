'use client';

import { useState, useEffect, useCallback } from 'react';
import { DomainKey } from '@/lib/mock-data'; // Only keeping DomainKey type, removing function imports
import { graphqlQuery, DOMAIN_TEMPLATES_QUERY, RELATIONSHIP_TYPES_QUERY, ENTITIES_QUERY } from '@/lib/graphql';

interface EntityFormProps {
  domain: DomainKey;
  mode: 'create' | 'edit';
  initialData?: any;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

interface TemplateAttribute {
  attributeId: string;
  attribute: { attributeCode: string; attributeName: string; dataType: string };
  isRequired: boolean;
  displayOrder: number;
  displayLabel?: string;
}

interface DomainTemplate {
  id: string;
  templateCode: string;
  templateName: string;
  domainCode: string;
  description?: string;
  isActive: boolean;
  attributes: TemplateAttribute[];
}

interface RelationshipType {
  id: string;
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode?: string;
  childDomainCode?: string;
}

interface RelationshipEntry {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  relationshipCode: string;
  relationshipName: string;
  isPrimary: boolean;
  validFrom: string;
}

// Maps the lowercase-plural route keys used across the app to the real,
// singular uppercase domain_code values stored in metadata_register.domain_types.
const DOMAIN_KEY_TO_CODE: Record<string, string> = {
  funds: 'FUND',
  issuers: 'ISSUER',
  securities: 'SECURITY',
  deals: 'DEAL',
  investors: 'INVESTOR',
  positions: 'POSITION',
};

export function EntityForm({ domain, mode, initialData, onSubmit, onCancel }: EntityFormProps) {
  const domainCode = DOMAIN_KEY_TO_CODE[domain] || domain.toUpperCase();

  const [templates, setTemplates] = useState<DomainTemplate[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<RelationshipType[]>([]);
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
    graphqlQuery<{ domainTemplates: DomainTemplate[] }, any>(DOMAIN_TEMPLATES_QUERY, { domainCode }).then(({ data }) => {
      if (cancelled) return;
      const list = data?.domainTemplates || [];
      setTemplates(list);
      if (!initialData?.template && list.length > 0) {
        setFormData((prev: any) => ({ ...prev, template: prev.template || list[0].templateCode }));
      }
      setLoadingTemplates(false);
    });
    graphqlQuery<{ relationshipTypes: RelationshipType[] }, {}>(RELATIONSHIP_TYPES_QUERY, {}).then(({ data }) => {
      if (cancelled) return;
      if (data?.relationshipTypes) setRelationshipTypes(data.relationshipTypes);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainCode]);

  const handleChange = (field: string, value: any) => {
    setFormData({ ...formData, [field]: value });
    if (errors[field]) {
      setErrors({ ...errors, [field]: '' });
    }
  };

  const handleAttributeChange = (attrCode: string, value: any) => {
    setFormData({
      ...formData,
      attributes: { ...formData.attributes, [attrCode]: value }
    });
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.code) newErrors.code = 'Entity code is required';
    if (!formData.name) newErrors.name = 'Entity name is required';
    if (!formData.template) newErrors.template = 'Template is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(formData);
    }
  };

  const selectedTemplate = templates.find(t => t.templateCode === formData.template);
  const templateAttributes = (selectedTemplate?.attributes || []).slice().sort((a, b) => a.displayOrder - b.displayOrder);

  // A blank parent or child domain means the relationship can connect any entity type,
  // so beneficial-ownership, counterparty, and facility edges are offered everywhere.
  const relevantRelationshipTypes = relationshipTypes.filter((r) => {
    if (!r.parentDomainCode || !r.childDomainCode) return true;
    return r.parentDomainCode === domainCode || r.childDomainCode === domainCode;
  });

  return (
    <div className="builder-card">
      <div className="builder-card-head">
        <div className="builder-step">
          <div className="step-number">{mode === 'create' ? '1' : 'E'}</div>
          <div className="step-title">{mode === 'create' ? 'Basic Information' : 'Edit Entity'}</div>
        </div>
      </div>
      <div className="builder-body">
        <div className="form-grid">
          <div className="field">
            <label>Entity Code *</label>
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
            <label>Entity Name *</label>
            <input
              className={`text-input ${errors.name ? 'error' : ''}`}
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Enter entity name"
            />
            {errors.name && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.name}</span>}
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Description</label>
            <textarea
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Brief description of this entity"
              rows={3}
              style={{ resize: 'vertical' }}
            />
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
        </div>

        {/* Template Attributes */}
        {templateAttributes.length > 0 && (
          <div style={{ marginTop: '24px' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
              Template Attributes
            </div>
            <div className="form-grid">
              {templateAttributes.map(tplAttr => (
                <div key={tplAttr.attributeId} className="field">
                  <label>
                    {tplAttr.displayLabel || tplAttr.attribute.attributeName}
                    {tplAttr.isRequired && <span style={{ color: 'var(--red)', marginLeft: '4px' }}>*</span>}
                  </label>
                  {tplAttr.attribute.dataType === 'FLOAT' || tplAttr.attribute.dataType === 'INTEGER' || tplAttr.attribute.dataType === 'NUMBER' ? (
                    <input
                      className="text-input mono"
                      type="number"
                      value={formData.attributes[tplAttr.attribute.attributeCode] || ''}
                      onChange={(e) => handleAttributeChange(tplAttr.attribute.attributeCode, e.target.value)}
                    />
                  ) : tplAttr.attribute.dataType === 'DATE' ? (
                    <input
                      className="text-input mono"
                      type="date"
                      value={formData.attributes[tplAttr.attribute.attributeCode] || ''}
                      onChange={(e) => handleAttributeChange(tplAttr.attribute.attributeCode, e.target.value)}
                    />
                  ) : (
                    <input
                      className="text-input"
                      value={formData.attributes[tplAttr.attribute.attributeCode] || ''}
                      onChange={(e) => handleAttributeChange(tplAttr.attribute.attributeCode, e.target.value)}
                      placeholder={`Enter ${(tplAttr.displayLabel || tplAttr.attribute.attributeName).toLowerCase()}`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Parent Relationships Section */}
        <div style={{ marginTop: '24px' }}>
          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
            Parent Relationships
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginBottom: '10px' }}>
            e.g. the Issuer/Borrower a Security belongs to, or the Fund a Position is held in
          </div>
          <RelationshipEditor
            entries={formData.parentRelationships}
            relationshipTypes={relevantRelationshipTypes}
            onChange={(entries) => handleChange('parentRelationships', entries)}
          />
        </div>
        
        {/* Child Relationships Section */}
        <div style={{ marginTop: '18px' }}>
          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
            Child Relationships
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginBottom: '10px' }}>
            e.g. Deals or Positions that belong to this entity
          </div>
          <RelationshipEditor
            entries={formData.childRelationships}
            relationshipTypes={relevantRelationshipTypes}
            onChange={(entries) => handleChange('childRelationships', entries)}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', padding: '16px 0 0' }}>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleSubmit}>
          {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
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
                  <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--accent)', fontWeight: 600, textTransform: 'uppercase' }}>Primary</span>
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
