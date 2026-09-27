'use client';

import { useState } from 'react';
import { DomainKey } from '@/lib/mock-data'; // Only keeping DomainKey type
import { graphqlQuery, ATTRIBUTE_REGISTER_QUERY } from '@/lib/graphql';

interface TemplateFormProps {
  mode: 'create' | 'edit';
  initialData?: Partial<Template>;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

export function TemplateForm({ mode, initialData, onSubmit, onCancel }: TemplateFormProps) {
  const [formData, setFormData] = useState<Partial<Template>>(initialData || {
    code: '',
    name: '',
    domain: 'securities',
    description: '',
    attributes: [],
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectedAttributes, setSelectedAttributes] = useState<string[]>(
    initialData?.attributes?.map(a => a.attributeId) || []
  );

  const availableAttributes = formData.domain ? getAttributesForDomain(formData.domain as DomainKey) : [];

  const handleChange = (field: string, value: any) => {
    setFormData({ ...formData, [field]: value });
    if (errors[field]) {
      setErrors({ ...errors, [field]: '' });
    }
  };

  const toggleAttribute = (attrId: string) => {
    setSelectedAttributes(prev =>
      prev.includes(attrId)
        ? prev.filter(id => id !== attrId)
        : [...prev, attrId]
    );
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.code) newErrors.code = 'Template code is required';
    if (!formData.name) newErrors.name = 'Template name is required';
    if (!formData.domain) newErrors.domain = 'Domain is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      const templateAttributes = selectedAttributes.map((attrId, idx) => {
        const attr = attributes.find(a => a.id === attrId);
        return {
          attributeId: attrId,
          attributeCode: attr?.code || '',
          attributeName: attr?.name || '',
          required: false,
          displaySection: 'General',
          sortOrder: idx + 1,
        };
      });
      onSubmit({ ...formData, attributes: templateAttributes });
    }
  };

  return (
    <div className="builder-card">
      <div className="builder-card-head">
        <div className="builder-step">
          <div className="step-number">{mode === 'create' ? 'T' : 'E'}</div>
          <div className="step-title">{mode === 'create' ? 'New Template' : 'Edit Template'}</div>
        </div>
      </div>
      <div className="builder-body">
        <div className="form-grid">
          <div className="field">
            <label>Template Code *</label>
            <input
              className={`text-input mono ${errors.code ? 'error' : ''}`}
              value={formData.code}
              onChange={(e) => handleChange('code', e.target.value.toUpperCase())}
              placeholder="TEMPLATE_CODE"
              disabled={mode === 'edit'}
            />
            {errors.code && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.code}</span>}
          </div>
          <div className="field">
            <label>Template Name *</label>
            <input
              className={`text-input ${errors.name ? 'error' : ''}`}
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Display name"
            />
            {errors.name && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.name}</span>}
          </div>
          <div className="field">
            <label>Domain *</label>
            <select
              className={`select ${errors.domain ? 'error' : ''}`}
              value={formData.domain}
              onChange={(e) => handleChange('domain', e.target.value)}
            >
              <option value="funds">Funds</option>
              <option value="issuers">Issuers</option>
              <option value="securities">Securities</option>
              <option value="deals">Deals</option>
              <option value="investors">Investors</option>
              <option value="positions">Positions</option>
            </select>
            {errors.domain && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.domain}</span>}
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Description</label>
            <textarea
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Brief description of this template"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </div>
        </div>

        {formData.domain && (
          <div style={{ marginTop: '18px' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
              Assign Attributes ({selectedAttributes.length} selected)
            </div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '14px', maxHeight: '300px', overflowY: 'auto' }}>
              {availableAttributes.length === 0 ? (
                <div style={{ color: 'var(--ink-3)', fontSize: '12px', textAlign: 'center', padding: '20px' }}>
                  No attributes available for this domain
                </div>
              ) : (
                availableAttributes.map(attr => (
                  <div
                    key={attr.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px',
                      background: selectedAttributes.includes(attr.id) ? '#fef6ec' : 'var(--surface)',
                      border: '1px solid',
                      borderColor: selectedAttributes.includes(attr.id) ? 'var(--accent)' : 'var(--line)',
                      marginBottom: '8px',
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleAttribute(attr.id)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedAttributes.includes(attr.id)}
                      onChange={() => toggleAttribute(attr.id)}
                      style={{ width: '16px', height: '16px' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, color: 'var(--ink)', marginBottom: '2px' }}>
                        {attr.name}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                        <span className="mono">{attr.code}</span> · {attr.dataType}
                        {attr.isUDF && <span style={{ marginLeft: '8px', color: 'var(--accent)' }}>UDF</span>}
                      </div>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                      {attr.usageCount} uses
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
