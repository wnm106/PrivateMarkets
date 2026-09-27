'use client';

import { useState, useEffect } from 'react';

interface RelationshipTypeFormProps {
  mode: 'create' | 'edit';
  initialData?: any;
  domainOptions?: { domainCode: string; domainName: string }[];
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
}

export function RelationshipTypeForm({ 
  mode, 
  initialData, 
  domainOptions,
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
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});

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
      onSubmit(formData);
    }
  };

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
            <label>Parent Domain *</label>
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
          </div>
          
          <div className="field">
            <label>Child Domain *</label>
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
              {formData.cardinality === 'COMPOSITE' && 'Multiple child domains form a single relationship'}
              {formData.cardinality === 'ONE_TO_MANY' && 'One parent can have multiple children'}
              {formData.cardinality === 'MANY_TO_ONE' && 'Multiple parents can reference one child'}
              {formData.cardinality === 'ONE_TO_ONE' && 'Single parent to single child'}
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