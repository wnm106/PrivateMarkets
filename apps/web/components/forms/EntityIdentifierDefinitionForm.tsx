'use client';

import { useState, useEffect } from 'react';

interface EntityIdentifierDefinitionFormProps {
  mode: 'create' | 'edit';
  initialData?: any;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

interface FormData {
  domainCode: string;
  identifierCode: string;
  identifierName: string;
  attributeCodes: string[];
  isPrimary: boolean;
  description: string;
}

export function EntityIdentifierDefinitionForm({ 
  mode, 
  initialData, 
  onSubmit, 
  onCancel 
}: EntityIdentifierDefinitionFormProps) {
  const [formData, setFormData] = useState<FormData>({
    domainCode: initialData?.domainCode || '',
    identifierCode: initialData?.identifierCode || '',
    identifierName: initialData?.identifierName || '',
    attributeCodes: initialData?.attributeCodes || [],
    isPrimary: initialData?.isPrimary || false,
    description: initialData?.description || '',
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (initialData) {
      setFormData({
        domainCode: initialData.domainCode || '',
        identifierCode: initialData.identifierCode || '',
        identifierName: initialData.identifierName || '',
        attributeCodes: initialData.attributeCodes || [],
        isPrimary: initialData.isPrimary || false,
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
    if (!formData.domainCode) newErrors.domainCode = 'Domain is required';
    if (!formData.identifierCode) newErrors.identifierCode = 'Identifier code is required';
    if (!formData.identifierName) newErrors.identifierName = 'Identifier name is required';
    
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
          <div className="step-title">{mode === 'create' ? 'Create Identifier' : 'Edit Identifier'}</div>
        </div>
      </div>
      <div className="builder-body">
        <div className="form-grid">
          <div className="field">
            <label>Domain *</label>
            <select
              className={`select ${errors.domainCode ? 'error' : ''}`}
              value={formData.domainCode}
              onChange={(e) => handleChange('domainCode', e.target.value)}
            >
              <option value="">Select domain...</option>
              <option value="SECURITY">Security</option>
              <option value="ISSUER">Issuer</option>
              <option value="FUND">Fund</option>
              <option value="DEAL">Deal</option>
            </select>
            {errors.domainCode && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.domainCode}</span>}
          </div>
          
          <div className="field">
            <label>Identifier Code *</label>
            <input
              className={`text-input ${errors.identifierCode ? 'error' : ''}`}
              value={formData.identifierCode}
              onChange={(e) => handleChange('identifierCode', e.target.value)}
              placeholder="e.g., ISIN, CUSIP, LEI_COUNTRY"
            />
            {errors.identifierCode && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.identifierCode}</span>}
          </div>
          
          <div className="field">
            <label>Identifier Name *</label>
            <input
              className={`text-input ${errors.identifierName ? 'error' : ''}`}
              value={formData.identifierName}
              onChange={(e) => handleChange('identifierName', e.target.value)}
              placeholder="e.g., International Securities Identification Number"
            />
            {errors.identifierName && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.identifierName}</span>}
          </div>
          
          <div className="field">
            <label>Is Primary?</label>
            <div className="toggle-switch">
              <input
                type="checkbox"
                id="isPrimary"
                checked={formData.isPrimary}
                onChange={(e) => handleChange('isPrimary', e.target.checked)}
              />
              <label htmlFor="isPrimary">Mark as primary identifier for this domain</label>
            </div>
          </div>
          
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Description</label>
            <textarea
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Brief description of this identifier"
              rows={3}
              style={{ resize: 'vertical' }}
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