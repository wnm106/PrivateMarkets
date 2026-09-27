'use client';

import { useState } from 'react';
import { DomainKey, DataType } from '@/lib/mock-data'; // Only keeping types
import { graphqlQuery, DOMAIN_TYPES_QUERY } from '@/lib/graphql';

interface AttributeFormProps {
  mode: 'create' | 'edit';
  initialData?: Partial<Attribute>;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

export function AttributeForm({ mode, initialData, onSubmit, onCancel }: AttributeFormProps) {
  const [formData, setFormData] = useState<Partial<Attribute>>(initialData || {
    code: '',
    name: '',
    description: '',
    domain: 'securities',
    dataType: 'STRING',
    validationRules: { required: false },
    isUDF: false,
    isDerived: false,
    derivationType: '',
    derivationFormula: '',
    derivationDependencies: [],
    formulaLanguage: 'SQL',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const handleChange = (field: string, value: any) => {
    setFormData({ ...formData, [field]: value });
    if (errors[field]) {
      setErrors({ ...errors, [field]: '' });
    }
  };

  const handleValidationChange = (field: string, value: any) => {
    setFormData({
      ...formData,
      validationRules: { ...formData.validationRules, [field]: value }
    });
  };

  const handleTestFormula = async () => {
    if (!formData.derivationFormula) {
      setTestResult({ success: false, message: 'Please enter a formula first' });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      // Simulate formula testing - in production this would call the API
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Basic validation
      if (!formData.derivationFormula.toUpperCase().includes('SELECT')) {
        throw new Error('Formula must be a SELECT statement');
      }

      setTestResult({ 
        success: true, 
        message: 'Formula syntax is valid. In production, this would execute against test data.' 
      });
    } catch (error) {
      setTestResult({ 
        success: false, 
        message: error instanceof Error ? error.message : 'Formula validation failed' 
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleDependencyToggle = (dep: string) => {
    const current = formData.derivationDependencies || [];
    const updated = current.includes(dep)
      ? current.filter(d => d !== dep)
      : [...current, dep];
    handleChange('derivationDependencies', updated);
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.code) newErrors.code = 'Attribute code is required';
    if (!formData.name) newErrors.name = 'Attribute name is required';
    if (!formData.domain) newErrors.domain = 'Domain is required';
    if (!formData.dataType) newErrors.dataType = 'Data type is required';
    
    // Validate derived attribute requirements
    if (formData.isDerived) {
      if (!formData.derivationType) {
        newErrors.derivationType = 'Derivation type is required for derived attributes';
      }
      if (!formData.derivationFormula) {
        newErrors.derivationFormula = 'Formula is required for derived attributes';
      }
      if (!formData.derivationDependencies || formData.derivationDependencies.length === 0) {
        newErrors.derivationDependencies = 'At least one dependency is required for derived attributes';
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

  return (
    <div className="builder-card">
      <div className="builder-card-head">
        <div className="builder-step">
          <div className="step-number">{mode === 'create' ? 'A' : 'E'}</div>
          <div className="step-title">{mode === 'create' ? 'New Attribute' : 'Edit Attribute'}</div>
        </div>
      </div>
      <div className="builder-body">
        <div className="form-grid">
          <div className="field">
            <label>Attribute Code *</label>
            <input
              className={`text-input mono ${errors.code ? 'error' : ''}`}
              value={formData.code}
              onChange={(e) => handleChange('code', e.target.value.toUpperCase())}
              placeholder="ATTRIBUTE_CODE"
              disabled={mode === 'edit'}
            />
            {errors.code && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.code}</span>}
          </div>
          <div className="field">
            <label>Attribute Name *</label>
            <input
              className={`text-input ${errors.name ? 'error' : ''}`}
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Display name"
            />
            {errors.name && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.name}</span>}
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Description</label>
            <textarea
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Brief description of this attribute"
              rows={2}
              style={{ resize: 'vertical' }}
            />
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
          <div className="field">
            <label>Data Type *</label>
            <select
              className={`select ${errors.dataType ? 'error' : ''}`}
              value={formData.dataType}
              onChange={(e) => handleChange('dataType', e.target.value)}
            >
              <option value="STRING">String</option>
              <option value="FLOAT">Float</option>
              <option value="INTEGER">Integer</option>
              <option value="DATE">Date</option>
              <option value="TIMESTAMP">Timestamp</option>
              <option value="REFERENCE_LIST">Reference List</option>
            </select>
            {errors.dataType && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.dataType}</span>}
          </div>
          <div className="field">
            <label>Unit of Measure</label>
            <input
              className="text-input"
              value={formData.unitOfMeasure || ''}
              onChange={(e) => handleChange('unitOfMeasure', e.target.value)}
              placeholder="e.g., USD, bps, %"
            />
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={formData.isUDF || false}
                onChange={(e) => handleChange('isUDF', e.target.checked)}
                style={{ width: '16px', height: '16px' }}
              />
              User-Defined Field (UDF)
            </label>
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={formData.isDerived || false}
                onChange={(e) => handleChange('isDerived', e.target.checked)}
                style={{ width: '16px', height: '16px' }}
              />
              Derived Attribute (calculated from formula)
            </label>
          </div>
        </div>

        {formData.isDerived && (
          <div style={{ marginTop: '18px', padding: '14px', background: '#fef6ec', border: '1px solid var(--accent)' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--accent)', fontWeight: 600, marginBottom: '10px' }}>
              Derived Attribute Configuration
            </div>
            <div className="form-grid">
              <div className="field">
                <label>Derivation Type *</label>
                <select
                  className="select"
                  value={formData.derivationType || ''}
                  onChange={(e) => handleChange('derivationType', e.target.value)}
                >
                  <option value="">Select type...</option>
                  <option value="SIMPLE">Simple - Direct calculation from other attributes</option>
                  <option value="AGGREGATE">Aggregate - Sum/avg/count across entities</option>
                  <option value="LOOKUP">Lookup - Fetch from related entity</option>
                  <option value="CUSTOM">Custom - Complex formula</option>
                </select>
              </div>
              <div className="field">
                <label>Formula Language</label>
                <select
                  className="select"
                  value={formData.formulaLanguage || 'SQL'}
                  onChange={(e) => handleChange('formulaLanguage', e.target.value)}
                >
                  <option value="SQL">SQL</option>
                  <option value="JS">JavaScript</option>
                  <option value="DSL">Custom DSL</option>
                </select>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Formula *</label>
                <textarea
                  className="text-input mono"
                  value={formData.derivationFormula || ''}
                  onChange={(e) => handleChange('derivationFormula', e.target.value)}
                  placeholder="SELECT (annual_interest / NULLIF(current_price, 0) * 100) FROM ..."
                  rows={4}
                  style={{ resize: 'vertical', fontSize: '11px', lineHeight: '1.5' }}
                />
                <button
                  type="button"
                  onClick={handleTestFormula}
                  disabled={isTesting || !formData.derivationFormula}
                  style={{
                    marginTop: '8px',
                    padding: '6px 12px',
                    fontSize: '11px',
                    background: 'var(--ink)',
                    color: 'var(--bg)',
                    border: 'none',
                    cursor: isTesting ? 'wait' : 'pointer',
                  }}
                >
                  {isTesting ? 'Testing...' : 'Test Formula'}
                </button>
                {testResult && (
                  <div style={{
                    marginTop: '8px',
                    padding: '8px',
                    fontSize: '11px',
                    background: testResult.success ? '#dcfce7' : '#fee2e2',
                    color: testResult.success ? '#166534' : '#991b1b',
                    border: `1px solid ${testResult.success ? '#86efac' : '#fca5a5'}`,
                  }}>
                    {testResult.message}
                  </div>
                )}
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Dependencies (attributes this formula depends on)</label>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px',
                  marginTop: '6px',
                }}>
                  {(formData.derivationDependencies || []).map(dep => (
                    <span
                      key={dep}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 8px',
                        fontSize: '11px',
                        background: 'var(--ink)',
                        color: 'var(--bg)',
                      }}
                    >
                      {dep}
                      <button
                        type="button"
                        onClick={() => handleDependencyToggle(dep)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--bg)',
                          cursor: 'pointer',
                          padding: '0 2px',
                          fontSize: '14px',
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                {mockAttributes.length > 0 && (
                  <select
                    className="select"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) handleDependencyToggle(e.target.value);
                    }}
                    style={{ marginTop: '8px' }}
                  >
                    <option value="">Add dependency...</option>
                    {mockAttributes
                      .filter(a => a.code !== formData.code && !formData.derivationDependencies?.includes(a.code))
                      .map(attr => (
                        <option key={attr.code} value={attr.code}>
                          {attr.code} - {attr.name}
                        </option>
                      ))}
                  </select>
                )}
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: '18px', padding: '14px', background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
            Validation Rules
          </div>
          <div className="form-grid">
            <div className="field">
              <label>Required</label>
              <select
                className="select"
                value={formData.validationRules?.required ? 'true' : 'false'}
                onChange={(e) => handleValidationChange('required', e.target.value === 'true')}
              >
                <option value="false">Optional</option>
                <option value="true">Required</option>
              </select>
            </div>
            <div className="field">
              <label>Regex Pattern</label>
              <input
                className="text-input mono"
                value={formData.validationRules?.regex || ''}
                onChange={(e) => handleValidationChange('regex', e.target.value)}
                placeholder="^[A-Z0-9]+$"
                style={{ fontSize: '11px' }}
              />
            </div>
            <div className="field">
              <label>Minimum Value</label>
              <input
                className="text-input mono"
                type="number"
                value={formData.validationRules?.min ?? ''}
                onChange={(e) => handleValidationChange('min', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="Min"
              />
            </div>
            <div className="field">
              <label>Maximum Value</label>
              <input
                className="text-input mono"
                type="number"
                value={formData.validationRules?.max ?? ''}
                onChange={(e) => handleValidationChange('max', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="Max"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
