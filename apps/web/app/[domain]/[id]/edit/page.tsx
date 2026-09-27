'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { DomainKey } from '@/lib/mock-data'; // Only keeping DomainKey type
import { graphqlQuery, ATTRIBUTE_REGISTER_QUERY, ENTITY_QUERY } from '@/lib/graphql';
import { sources, SourceKey } from '@/lib/data';

export default function EditEntityPage() {
  const params = useParams();
  const router = useRouter();
  const domain = params.domain as DomainKey;
  const id = params.id as string;
  const domainConfig = getDomainConfig(domain);
  const templates = getTemplatesForDomain(domain);
  const attributes = getAttributesForDomain(domain);

  // Mock existing entity data
  const [entity] = useState({
    id,
    code: id,
    name: 'BlueRiver Energy Unitranche 2030',
    description: 'Senior secured unitranche loan facility',
    template: 'LOAN',
    attributes: {
      CUSIP: 'LX1284AB7',
      ISIN: 'US12849ABCD7',
      INSTRUMENT_TYPE: 'Unitranche',
      SENIORITY: 'Senior Secured',
      NOTIONAL: '180000000',
      MATURITY_DATE: '2030-09-15',
      SPREAD_BPS: '575',
      REFERENCE_RATE: 'Term SOFR',
    },
    sources: ['wso', 'bloomberg', 'manual'],
  });

  const [formData, setFormData] = useState(entity);
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  const handleSave = () => {
    console.log('Saving entity:', formData);
    router.push(`/${domain}/${id}`);
  };

  const handleCancel = () => {
    router.push(`/${domain}/${id}`);
  };

  const selectedTemplate = templates.find(t => t.code === formData.template);
  const templateAttributes = selectedTemplate?.attributes || [];

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href={`/${domain}`} className="crumb-link">{domainConfig.name}</Link>
        <span className="sep">›</span>
        <Link href={`/${domain}/${id}`} className="crumb-link">{id}</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Edit</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Edit {domainConfig.name.slice(0, -1)}</div>
          <div className="page-meta">
            {entity.code} · {entity.name}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={handleCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>

      {/* Edit Form */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">E</div>
            <div className="step-title">Entity Information</div>
          </div>
        </div>
        <div className="builder-body">
          <div className="form-grid">
            <div className="field">
              <label>Entity Code</label>
              <input
                className="text-input mono"
                value={formData.code}
                disabled
                style={{ background: 'var(--bg)', color: 'var(--ink-3)' }}
              />
            </div>
            <div className="field">
              <label>Entity Name *</label>
              <input
                className={`text-input ${errors.name ? 'error' : ''}`}
                value={formData.name}
                onChange={(e) => handleChange('name', e.target.value)}
              />
              {errors.name && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.name}</span>}
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Description</label>
              <textarea
                className="text-input"
                value={formData.description}
                onChange={(e) => handleChange('description', e.target.value)}
                rows={3}
                style={{ resize: 'vertical' }}
              />
            </div>
            <div className="field">
              <label>Template</label>
              <select
                className="select"
                value={formData.template}
                onChange={(e) => handleChange('template', e.target.value)}
              >
                {templates.map(t => (
                  <option key={t.code} value={t.code}>{t.name} ({t.code})</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Template Attributes */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">A</div>
            <div className="step-title">Template Attributes</div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
            {selectedTemplate?.name || 'No template selected'}
          </span>
        </div>
        <div className="builder-body">
          <div className="form-grid">
            {templateAttributes.map(tplAttr => {
              const attr = attributes.find(a => a.code === tplAttr.attributeCode);
              return (
                <div key={tplAttr.attributeId} className="field">
                  <label>
                    {tplAttr.attributeName}
                    {tplAttr.required && <span style={{ color: 'var(--red)', marginLeft: '4px' }}>*</span>}
                  </label>
                  {attr?.dataType === 'REFERENCE_LIST' ? (
                    attr.isMultiValued ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', minHeight: '32px' }}>
                          {(Array.isArray(formData.attributes[tplAttr.attributeCode]) 
                            ? formData.attributes[tplAttr.attributeCode] 
                            : []
                          ).map((val: string) => (
                            <span
                              key={val}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '4px 8px',
                                background: 'var(--accent-2)',
                                color: 'var(--ink)',
                                fontSize: '11px',
                                borderRadius: '3px',
                              }}
                            >
                              {val}
                              <button
                                type="button"
                                onClick={() => {
                                  const current = Array.isArray(formData.attributes[tplAttr.attributeCode])
                                    ? formData.attributes[tplAttr.attributeCode]
                                    : [];
                                  handleAttributeChange(
                                    tplAttr.attributeCode,
                                    current.filter((v: string) => v !== val)
                                  );
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: 'var(--ink-3)',
                                  padding: '0',
                                  fontSize: '14px',
                                  lineHeight: 1,
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                        <select
                          className="select"
                          value=""
                          onChange={(e) => {
                            if (e.target.value) {
                              const current = Array.isArray(formData.attributes[tplAttr.attributeCode])
                                ? formData.attributes[tplAttr.attributeCode]
                                : [];
                              if (!current.includes(e.target.value)) {
                                handleAttributeChange(tplAttr.attributeCode, [...current, e.target.value]);
                              }
                              e.target.value = '';
                            }
                          }}
                        >
                          <option value="">Add value...</option>
                          {(attr.listValues || []).filter(v => 
                            !Array.isArray(formData.attributes[tplAttr.attributeCode]) || 
                            !formData.attributes[tplAttr.attributeCode].includes(v)
                          ).map(v => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <select
                        className="select"
                        value={formData.attributes[tplAttr.attributeCode] || ''}
                        onChange={(e) => handleAttributeChange(tplAttr.attributeCode, e.target.value)}
                      >
                        <option value="">Select...</option>
                        {(attr.listValues || []).map(v => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    )
                  ) : attr?.dataType === 'FLOAT' || attr?.dataType === 'INTEGER' ? (
                    <input
                      className="text-input mono"
                      type="number"
                      value={formData.attributes[tplAttr.attributeCode] || ''}
                      onChange={(e) => handleAttributeChange(tplAttr.attributeCode, e.target.value)}
                    />
                  ) : attr?.dataType === 'DATE' ? (
                    <input
                      className="text-input mono"
                      type="date"
                      value={formData.attributes[tplAttr.attributeCode] || ''}
                      onChange={(e) => handleAttributeChange(tplAttr.attributeCode, e.target.value)}
                    />
                  ) : (
                    <input
                      className="text-input"
                      value={formData.attributes[tplAttr.attributeCode] || ''}
                      onChange={(e) => handleAttributeChange(tplAttr.attributeCode, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Source Assignment */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">S</div>
            <div className="step-title">Source Assignment</div>
          </div>
        </div>
        <div className="builder-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
            {Object.entries(sources).map(([key, src]) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px',
                  background: formData.sources.includes(key) ? '#fef6ec' : 'var(--bg)',
                  border: '1px solid',
                  borderColor: formData.sources.includes(key) ? 'var(--accent)' : 'var(--line)',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  const newSources = formData.sources.includes(key)
                    ? formData.sources.filter(s => s !== key)
                    : [...formData.sources, key];
                  handleChange('sources', newSources);
                }}
              >
                <input
                  type="checkbox"
                  checked={formData.sources.includes(key)}
                  onChange={() => {}}
                  style={{ width: '16px', height: '16px' }}
                />
                <span
                  className="src-badge"
                  style={{
                    color: src.hex,
                    borderColor: `${src.hex}40`,
                    background: `${src.hex}0a`,
                  }}
                >
                  <span className="dot" style={{ background: src.hex }}></span>
                  {src.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Audit Trail */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">H</div>
            <div className="step-title">Audit Trail</div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
            Recent changes to this entity
          </span>
        </div>
        <div className="builder-body">
          {auditLog.slice(0, 5).map((entry) => (
            <div key={entry.id} className="activity-item">
              <div className="act-avatar">{entry.whoInitials}</div>
              <div style={{ flex: 1 }}>
                <div className="act-txt">
                  <strong>{entry.who}</strong> {entry.action}
                  {entry.field && <span> · {entry.field}</span>}
                  {entry.oldValue && entry.newValue && (
                    <span style={{ color: 'var(--ink-3)' }}>
                      {' '}({entry.oldValue} → {entry.newValue})
                    </span>
                  )}
                </div>
                <div className="act-time">
                  {entry.timestamp} · {entry.source}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="builder-footer">
        <div className="left">
          <Link href={`/${domain}/${id}`}>
            <button className="btn">← Back to Entity</button>
          </Link>
        </div>
        <div className="right">
          <button className="btn" onClick={handleCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}
