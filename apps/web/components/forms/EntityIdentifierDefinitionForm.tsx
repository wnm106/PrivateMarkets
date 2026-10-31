'use client';

import { useState, useEffect } from 'react';

interface Attribute {
  id: string;
  attributeCode: string;
  attributeName: string;
  dataType: string;
}

interface EntityIdentifierDefinitionFormProps {
  mode: 'create' | 'edit';
  initialData?: any;
  availableAttributes?: Attribute[];
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
  availableAttributes = [],
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

  const toggleAttribute = (attrCode: string) => {
    setFormData(prev => {
      const codes = prev.attributeCodes.includes(attrCode)
        ? prev.attributeCodes.filter(c => c !== attrCode)
        : [...prev.attributeCodes, attrCode];
      return { ...prev, attributeCodes: codes };
    });
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.domainCode) newErrors.domainCode = 'Domain is required';
    if (!formData.identifierCode) newErrors.identifierCode = 'Identifier code is required';
    if (!formData.identifierName) newErrors.identifierName = 'Identifier name is required';
    if (formData.attributeCodes.length === 0) newErrors.attributeCodes = 'At least one attribute is required';
    
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

          {/* Composite Attribute Selection */}
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>
              Composite Attributes *
              <span style={{ fontWeight: 400, color: 'var(--ink-3)', fontSize: '11px', marginLeft: '8px' }}>
                ({formData.attributeCodes.length} selected)
              </span>
            </label>
            {errors.attributeCodes && (
              <div style={{ color: 'var(--red)', fontSize: '11px', marginBottom: '8px' }}>{errors.attributeCodes}</div>
            )}
            {availableAttributes.length === 0 ? (
              <div style={{
                padding: '16px', background: 'var(--surface, #fafafa)',
                border: '1px solid var(--line)', borderRadius: '6px',
                fontSize: '12px', color: 'var(--ink-3)', textAlign: 'center',
              }}>
                No attributes available for this domain. Create attributes first.
              </div>
            ) : (
              <div style={{
                maxHeight: '200px', overflowY: 'auto',
                border: '1px solid var(--line)', borderRadius: '6px',
                background: 'var(--surface, #fafafa)',
              }}>
                {availableAttributes.map(attr => {
                  const isSelected = formData.attributeCodes.includes(attr.attributeCode);
                  return (
                    <div
                      key={attr.attributeCode}
                      onClick={() => toggleAttribute(attr.attributeCode)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '8px 12px', borderBottom: '1px solid var(--line)',
                        cursor: 'pointer', background: isSelected ? '#fef6ec' : 'transparent',
                        transition: 'background 0.15s',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleAttribute(attr.attributeCode)}
                        style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: '12px', fontWeight: 500 }}>{attr.attributeName}</span>
                        <span style={{ fontSize: '11px', color: 'var(--ink-3)', marginLeft: '8px' }}>
                          <span className="mono">{attr.attributeCode}</span> · {attr.dataType}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {formData.attributeCodes.length > 0 && (
              <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--ink-3)' }}>
                Composite key: {formData.attributeCodes.join(', ')}
              </div>
            )}
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