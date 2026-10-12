'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { DomainKey } from '@/lib/mock-data'; // Only keeping DomainKey type
import { graphqlQuery, DOMAIN_TEMPLATES_QUERY, ATTRIBUTE_REGISTER_QUERY } from '@/lib/graphql';
import { sources, SourceKey } from '@/lib/data';

interface EntityCreationWizardProps {
  domain: DomainKey;
}

export function EntityCreationWizard({ domain }: EntityCreationWizardProps) {
  const router = useRouter();
  const domainConfig = getDomainConfig(domain);
  const templates = getTemplatesForDomain(domain);
  const attributes = getAttributesForDomain(domain);

  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    description: '',
    template: templates[0]?.code || '',
    attributes: {} as Record<string, any>,
    sources: [] as string[],
    parentRelationships: [] as any[],
    childRelationships: [] as any[],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const totalSteps = 5;

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

  const validateStep = (currentStep: number) => {
    const newErrors: Record<string, string> = {};
    if (currentStep === 1) {
      if (!formData.code) newErrors.code = 'Entity code is required';
      if (!formData.name) newErrors.name = 'Entity name is required';
      if (!formData.template) newErrors.template = 'Template is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const nextStep = () => {
    if (validateStep(step)) {
      setStep(Math.min(step + 1, totalSteps));
    }
  };

  const prevStep = () => {
    setStep(Math.max(step - 1, 1));
  };

  const handleSubmit = () => {
    console.log('Submitting entity:', formData);
    router.push(`/${domain}`);
  };

  const handleCancel = () => {
    router.push(`/${domain}`);
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
        <span className="crumb-current">New {domainConfig.name.slice(0, -1)}</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Create {domainConfig.name.slice(0, -1)}</div>
          <div className="page-meta">
            Step {step} of {totalSteps} · {step === 1 ? 'Basic Information' : step === 2 ? 'Template Attributes' : step === 3 ? 'Relationships' : step === 4 ? 'Source Assignment' : 'Review & Submit'}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={handleCancel}>Cancel</button>
          {step < totalSteps && (
            <button className="btn" onClick={() => console.log('Save draft')}>Save Draft</button>
          )}
          {step < totalSteps ? (
            <button className="btn btn-primary" onClick={nextStep}>Next →</button>
          ) : (
            <button className="btn btn-primary" onClick={handleSubmit}>Create Entity</button>
          )}
        </div>
      </div>

      {/* Progress Indicator */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 22px', marginBottom: '18px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {[1, 2, 3, 4].map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  background: s === step ? 'var(--accent)' : s < step ? 'var(--green)' : 'var(--bg-alt)',
                  color: s <= step ? '#fff' : 'var(--ink-3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-ibm-plex-serif), serif',
                  fontWeight: 600,
                  fontSize: '13px',
                }}
              >
                {s < step ? '✓' : s}
              </div>
              <div style={{ fontSize: '11px', color: s === step ? 'var(--ink)' : 'var(--ink-3)', fontWeight: s === step ? 600 : 400 }}>
                {s === 1 ? 'Basic Info' : s === 2 ? 'Attributes' : s === 3 ? 'Sources' : 'Review'}
              </div>
              {s < 4 && <span style={{ color: 'var(--ink-4)', margin: '0 4px' }}>→</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Step Content */}
      {step === 1 && (
        <div className="builder-card">
          <div className="builder-card-head">
            <div className="builder-step">
              <div className="step-number">1</div>
              <div className="step-title">Basic Information</div>
            </div>
          </div>
          <div className="builder-body">
            <div className="form-grid">
              <div className="field">
                <label>Entity Code *</label>
                <input
                  className={`text-input mono ${errors.code ? 'error' : ''}`}
                  value={formData.code}
                  onChange={(e) => handleChange('code', e.target.value.toUpperCase())}
                  placeholder={`${domainConfig.key.toUpperCase()}-001`}
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
                >
                  <option value="">Select template...</option>
                  {templates.map(t => (
                    <option key={t.code} value={t.code}>{t.name} ({t.code})</option>
                  ))}
                </select>
                {errors.template && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.template}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="builder-card">
          <div className="builder-card-head">
            <div className="builder-step">
              <div className="step-number">2</div>
              <div className="step-title">Template-Specific Attributes</div>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
              {selectedTemplate?.name || 'No template selected'}
            </span>
          </div>
          <div className="builder-body">
            {templateAttributes.length === 0 ? (
              <div style={{ color: 'var(--ink-3)', fontSize: '12px', textAlign: 'center', padding: '40px' }}>
                No attributes defined for this template. Please select a template in Step 1.
              </div>
            ) : (
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
                          placeholder={attr.unitOfMeasure || ''}
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
                          placeholder={`Enter ${tplAttr.attributeName.toLowerCase()}`}
                        />
                      )}
                      {attr?.unitOfMeasure && (
                        <span style={{ fontSize: '10px', color: 'var(--ink-3)', marginTop: '2px' }}>
                          Unit: {attr.unitOfMeasure}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="builder-card">
          <div className="builder-card-head">
            <div className="builder-step">
              <div className="step-number">3</div>
              <div className="step-title">Relationships</div>
            </div>
          </div>
          <div className="builder-body">
            <div className="form-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Parent Relationships</label>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '14px', minHeight: '120px' }}>
                  <div style={{ fontStyle: 'italic', color: 'var(--ink-3)', textAlign: 'center', paddingTop: '40px' }}>
                    Parent relationships can be assigned on the Entity Management page
                  </div>
                </div>
              </div>
              
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Child Relationships</label>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '14px', minHeight: '120px' }}>
                  <div style={{ fontStyle: 'italic', color: 'var(--ink-3)', textAlign: 'center', paddingTop: '40px' }}>
                    Child relationships can be assigned on the Entity Management page
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}


      {step === 3 && (
        <div className="builder-card">
          <div className="builder-card-head">
            <div className="builder-step">
              <div className="step-number">3</div>
              <div className="step-title">Source Assignment</div>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
              Select which vendor feeds will populate this entity
            </span>
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
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                      {key === 'bloomberg' && 'Public markets data'}
                      {key === 'wso' && 'Private credit data'}
                      {key === 'dealcloud' && 'Deal pipeline data'}
                      {key === 'allvue' && 'Fund accounting data'}
                      {key === 'spciq' && 'Fundamental data'}
                      {key === 'manual' && 'Manual overrides'}
                      {key === 'derived' && 'Computed values'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="builder-card">
          <div className="builder-card-head">
            <div className="builder-step">
              <div className="step-number">4</div>
              <div className="step-title">Review & Submit</div>
            </div>
          </div>
          <div className="builder-body">
            <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '18px', marginBottom: '18px' }}>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '12px' }}>
                Basic Information
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px', fontSize: '12px' }}>
                <div style={{ color: 'var(--ink-3)' }}>Code:</div>
                <div className="mono" style={{ color: 'var(--ink)', fontWeight: 500 }}>{formData.code || '—'}</div>
                <div style={{ color: 'var(--ink-3)' }}>Name:</div>
                <div style={{ color: 'var(--ink)', fontWeight: 500 }}>{formData.name || '—'}</div>
                <div style={{ color: 'var(--ink-3)' }}>Template:</div>
                <div style={{ color: 'var(--ink)', fontWeight: 500 }}>{formData.template || '—'}</div>
                <div style={{ color: 'var(--ink-3)' }}>Description:</div>
                <div style={{ color: 'var(--ink-2)' }}>{formData.description || '—'}</div>
              </div>
            </div>

            {Object.keys(formData.attributes).length > 0 && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '18px', marginBottom: '18px' }}>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '12px' }}>
                  Template Attributes
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px', fontSize: '12px' }}>
                  {Object.entries(formData.attributes).map(([key, value]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <div style={{ color: 'var(--ink-3)' }}>{key}:</div>
                      <div className="mono" style={{ color: 'var(--ink)', fontWeight: 500 }}>{value || '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {formData.sources.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '18px' }}>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '12px' }}>
                  Assigned Sources ({formData.sources.length})
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {formData.sources.map(srcKey => {
                    const src = sources[srcKey as SourceKey];
                    return (
                      <span
                        key={srcKey}
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
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer Navigation */}
      <div className="builder-footer">
        <div className="left">
          {step > 1 && (
            <button className="btn" onClick={prevStep}>← Previous</button>
          )}
        </div>
        <div className="right">
          <button className="btn" onClick={handleCancel}>Cancel</button>
          {step < totalSteps && (
            <button className="btn btn-primary" onClick={nextStep}>Next →</button>
          )}
          {step === totalSteps && (
            <button className="btn btn-primary" onClick={handleSubmit}>Create Entity</button>
          )}
        </div>
      </div>
    </div>
  );
}
