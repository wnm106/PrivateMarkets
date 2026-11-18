'use client';

import { useState, useEffect } from 'react';
import { SchemaScopeField } from '@/components/admin/SchemaScopeField';

interface RelationshipTypeFormProps {
  mode: 'create' | 'edit';
  initialData?: any;
  domainOptions?: { domainCode: string; domainName: string }[];
  owner?: { id: string; name: string } | null;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

interface FormData {
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode: string;
  childDomainCode: string;
  cardinality: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE' | 'COMPOSITE';
  compositeKey: string[];
  description: string;
  isRequired: boolean;
  templateFromSide: '' | 'PARENT' | 'CHILD';
}

export function RelationshipTypeForm({ 
  mode, 
  initialData, 
  domainOptions,
  owner,
  onSubmit, 
  onCancel 
}: RelationshipTypeFormProps) {
  const domains = domainOptions && domainOptions.length > 0
    ? domainOptions
    : [
        { domainCode: 'SECURITY', domainName: 'Security' },
        { domainCode: 'ISSUER', domainName: 'Issuer' },
        { domainCode: 'FUND', domainName: 'Fund' },
        { domainCode: 'DEAL', domainName: 'Deal' },
      ];
  const [formData, setFormData] = useState<FormData>({
    relationshipCode: initialData?.relationshipCode || '',
    relationshipName: initialData?.relationshipName || '',
    parentDomainCode: initialData?.parentDomainCode || '',
    childDomainCode: initialData?.childDomainCode || '',
    cardinality: initialData?.cardinality || 'ONE_TO_ONE',
    compositeKey: initialData?.compositeKey || [],
    description: initialData?.description || '',
    isRequired: initialData?.isRequired || false,
    templateFromSide: initialData?.templateFromSide || '',
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    if (initialData) {
      setFormData({
        relationshipCode: initialData.relationshipCode || '',
        relationshipName: initialData.relationshipName || '',
        parentDomainCode: initialData.parentDomainCode || '',
        childDomainCode: initialData.childDomainCode || '',
        cardinality: initialData.cardinality || 'ONE_TO_ONE',
        compositeKey: initialData.compositeKey || [],
        description: initialData.description || '',
        isRequired: initialData.isRequired || false,
        templateFromSide: initialData.templateFromSide || '',
      });
    }
  }, [initialData]);

  const handleChange = (field: keyof FormData, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.relationshipCode) newErrors.relationshipCode = 'Required';
    if (!formData.relationshipName) newErrors.relationshipName = 'Required';
    if (!formData.parentDomainCode) newErrors.parentDomainCode = 'Required';
    if (!formData.childDomainCode) newErrors.childDomainCode = 'Required';
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      // Remove isRequired - not in GraphQL schema
      const { isRequired, templateFromSide, ...rest } = formData;
      const submitData = { ...rest, templateFromSide: templateFromSide || null };
      onSubmit(mode === 'create' ? { ...submitData, clientId } : submitData);
    }
  };

  const nameOf = (code: string, fallback: string) => domains.find((d) => d.domainCode === code)?.domainName || fallback;
  const fromName = nameOf(formData.parentDomainCode, 'From');
  const toName = nameOf(formData.childDomainCode, 'To');

  return (
    <div className="builder-card">
      <div className="builder-card-head">
        <div className="builder-step">
          <div className="step-number">{mode === 'create' ? '1' : 'E'}</div>
          <div className="step-title">{mode === 'create' ? 'Create Relationship Type' : 'Edit Relationship Type'}</div>
        </div>
      </div>
      <div className="builder-body">
        <div className="form-grid">
          <div className="field">
            <label>Relationship Code *</label>
            <input
              className={`text-input ${errors.relationshipCode ? 'error' : ''}`}
              value={formData.relationshipCode}
              onChange={(e) => handleChange('relationshipCode', e.target.value)}
            />
            {errors.relationshipCode && <span>{errors.relationshipCode}</span>}
          </div>
          
          <div className="field">
            <label>Relationship Name *</label>
            <input
              className={`text-input ${errors.relationshipName ? 'error' : ''}`}
              value={formData.relationshipName}
              onChange={(e) => handleChange('relationshipName', e.target.value)}
            />
            {errors.relationshipName && <span>{errors.relationshipName}</span>}
          </div>
          
          <div className="field">
            <label>From entity type *</label>
            <select
              className={`select ${errors.parentDomainCode ? 'error' : ''}`}
              value={formData.parentDomainCode}
              onChange={(e) => handleChange('parentDomainCode', e.target.value)}
            >
              <option value="">Select...</option>
              {domains.map(d => (
                <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
              ))}
            </select>
            {errors.parentDomainCode && <span>{errors.parentDomainCode}</span>}
            <small className="field-hint">The record that carries the link, such as a statement period.</small>
          </div>
          
          <div className="field">
            <label>To entity type *</label>
            <select
              className={`select ${errors.childDomainCode ? 'error' : ''}`}
              value={formData.childDomainCode}
              onChange={(e) => handleChange('childDomainCode', e.target.value)}
            >
              <option value="">Select...</option>
              {domains.map(d => (
                <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
              ))}
            </select>
            {errors.childDomainCode && <span>{errors.childDomainCode}</span>}
            <small className="field-hint">The record it points to, such as the issuer.</small>
          </div>
          
          <div className="field">
            <label>Cardinality *</label>
            <select
              className="select"
              value={formData.cardinality}
              onChange={(e) => handleChange('cardinality', e.target.value)}
            >
              <option value="ONE_TO_ONE">One to One</option>
              <option value="ONE_TO_MANY">One to Many</option>
              <option value="MANY_TO_ONE">Many to One</option>
              <option value="COMPOSITE">Composite</option>
            </select>
            <small className="field-hint">
              {formData.cardinality === 'COMPOSITE' && 'Several entity types together form a single relationship'}
              {formData.cardinality === 'ONE_TO_MANY' && `One ${fromName} record can link to many ${toName} records`}
              {formData.cardinality === 'MANY_TO_ONE' && `Many ${fromName} records can link to one ${toName} record`}
              {formData.cardinality === 'ONE_TO_ONE' && `One ${fromName} record links to one ${toName} record`}
            </small>
          </div>
          
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={formData.isRequired}
                onChange={(e) => handleChange('isRequired', e.target.checked)}
                style={{ width: '16px', height: '16px' }}
              />
              <span>Required link</span>
            </label>
            <small className="field-hint">
              {formData.isRequired 
                ? 'A record cannot be saved without this link'
                : 'This link is optional'}
            </small>
          </div>
          
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Template inheritance</label>
            <select
              className="select"
              value={formData.templateFromSide}
              onChange={(e) => handleChange('templateFromSide', e.target.value)}
            >
              <option value="">None: each record keeps its own template</option>
              <option value="CHILD">{`${fromName} records use the template chosen on their ${toName}`}</option>
              <option value="PARENT">{`${toName} records use the template chosen on their ${fromName}`}</option>
            </select>
            <small className="field-hint">
              The template is picked once on the record that supplies it, on that record&apos;s Relationships tab.
            </small>
          </div>

          {formData.cardinality === 'COMPOSITE' && (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Composite Key (comma-separated domain codes)</label>
              <input
                className="text-input"
                value={formData.compositeKey.join(', ')}
                onChange={(e) => {
                  const keys = e.target.value.split(',').map(k => k.trim()).filter(k => k);
                  handleChange('compositeKey', keys);
                }}
                placeholder="e.g., FUND, SECURITY"
              />
              <small className="field-hint">List the domain codes that form this composite relationship</small>
            </div>
          )}
          
          {mode === 'create' && (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <SchemaScopeField value={clientId} owner={owner} onChange={setClientId} />
            </div>
          )}

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Description</label>
            <textarea
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              rows={2}
            />
          </div>
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