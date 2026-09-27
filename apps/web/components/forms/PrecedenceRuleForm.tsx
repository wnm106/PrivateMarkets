'use client';

import { useState } from 'react';
import { sources, SourceKey } from '@/lib/data';

interface PrecedenceRuleFormProps {
  templateCode?: string;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

export function PrecedenceRuleForm({ templateCode, onSubmit, onCancel }: PrecedenceRuleFormProps) {
  const [formData, setFormData] = useState({
    domain: 'Securities',
    field: '',
    ruleName: '',
    priorityTier: 'Field-specific',
    conditions: [{ field: 'Instrument Type', operator: 'is one of', value: '' }],
    chain: ['wso', 'manual', 'bloomberg'] as SourceKey[],
    tieBreaker: 'most_recent',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (field: string, value: any) => {
    setFormData({ ...formData, [field]: value });
    if (errors[field]) {
      setErrors({ ...errors, [field]: '' });
    }
  };

  const addCondition = () => {
    setFormData({
      ...formData,
      conditions: [...formData.conditions, { field: '', operator: 'equals', value: '' }]
    });
  };

  const removeCondition = (idx: number) => {
    setFormData({
      ...formData,
      conditions: formData.conditions.filter((_, i) => i !== idx)
    });
  };

  const updateCondition = (idx: number, field: string, value: string) => {
    const newConditions = [...formData.conditions];
    newConditions[idx] = { ...newConditions[idx], [field]: value };
    setFormData({ ...formData, conditions: newConditions });
  };

  const moveSourceInChain = (idx: number, direction: 'up' | 'down') => {
    const newChain = [...formData.chain];
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= newChain.length) return;
    [newChain[idx], newChain[targetIdx]] = [newChain[targetIdx], newChain[idx]];
    setFormData({ ...formData, chain: newChain });
  };

  const removeSourceFromChain = (idx: number) => {
    setFormData({
      ...formData,
      chain: formData.chain.filter((_, i) => i !== idx)
    });
  };

  const addSourceToChain = (sourceKey: SourceKey) => {
    if (!formData.chain.includes(sourceKey)) {
      setFormData({ ...formData, chain: [...formData.chain, sourceKey] });
    }
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.field) newErrors.field = 'Field is required';
    if (!formData.ruleName) newErrors.ruleName = 'Rule name is required';
    if (formData.chain.length === 0) newErrors.chain = 'At least one source is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(formData);
    }
  };

  const availableSources = (Object.keys(sources) as SourceKey[]).filter(
    key => !formData.chain.includes(key)
  );

  return (
    <div>
      {/* Rule Scope */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">1</div>
            <div className="step-title">Rule Scope</div>
          </div>
        </div>
        <div className="builder-body">
          <div className="form-grid">
            <div className="field">
              <label>Entity Domain</label>
              <select
                className="select"
                value={formData.domain}
                onChange={(e) => handleChange('domain', e.target.value)}
              >
                <option>Securities</option>
                <option>Issuers</option>
                <option>Funds</option>
                <option>Deals</option>
                <option>Investors</option>
              </select>
            </div>
            <div className="field">
              <label>Field *</label>
              <select
                className={`select ${errors.field ? 'error' : ''}`}
                value={formData.field}
                onChange={(e) => handleChange('field', e.target.value)}
              >
                <option value="">Select field...</option>
                <option>Spread (bps)</option>
                <option>Maturity Date</option>
                <option>Notional</option>
                <option>Reference Rate</option>
                <option>Issuer Name</option>
              </select>
              {errors.field && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.field}</span>}
            </div>
            <div className="field">
              <label>Rule Name *</label>
              <input
                className={`text-input ${errors.ruleName ? 'error' : ''}`}
                value={formData.ruleName}
                onChange={(e) => handleChange('ruleName', e.target.value)}
                placeholder="Descriptive rule name"
              />
              {errors.ruleName && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.ruleName}</span>}
            </div>
            <div className="field">
              <label>Priority Tier</label>
              <select
                className="select"
                value={formData.priorityTier}
                onChange={(e) => handleChange('priorityTier', e.target.value)}
              >
                <option>Field-specific (overrides domain default)</option>
                <option>Domain default</option>
                <option>Fallback only</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Conditions */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">2</div>
            <div className="step-title">When This Rule Applies</div>
          </div>
        </div>
        <div className="builder-body">
          <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '16px', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--accent)', marginBottom: '12px' }}>
              IF ALL (AND)
            </div>
            {formData.conditions.map((cond, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 1.5fr 30px', gap: '10px', alignItems: 'center', marginBottom: '8px' }}>
                <select
                  className="select"
                  value={cond.field}
                  onChange={(e) => updateCondition(idx, 'field', e.target.value)}
                >
                  <option>Instrument Type</option>
                  <option>Currency</option>
                  <option>Seniority</option>
                </select>
                <select
                  className="select"
                  value={cond.operator}
                  onChange={(e) => updateCondition(idx, 'operator', e.target.value)}
                >
                  <option>is one of</option>
                  <option>equals</option>
                  <option>is not</option>
                </select>
                <input
                  className="text-input"
                  value={cond.value}
                  onChange={(e) => updateCondition(idx, 'value', e.target.value)}
                  placeholder="Enter values..."
                />
                <button
                  className="cond-remove"
                  onClick={() => removeCondition(idx)}
                  style={{ width: '30px', height: '30px' }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="add-cond" onClick={addCondition}>
              + Add condition
            </button>
          </div>
        </div>
      </div>

      {/* Precedence Chain */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">3</div>
            <div className="step-title">Source Precedence Chain</div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Drag to reorder · top wins</span>
        </div>
        <div className="builder-body">
          <div className="precedence-builder">
            {formData.chain.map((srcKey, idx) => {
              const src = sources[srcKey];
              return (
                <div key={srcKey} className="prec-source-item">
                  <span className="drag-handle">⋮⋮</span>
                  <div className="prec-rank">{idx + 1}</div>
                  <div className="prec-source-name">
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
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => moveSourceInChain(idx, 'up')}
                      disabled={idx === 0}
                      style={{ padding: '4px 8px', fontSize: '10px' }}
                    >
                      ↑
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => moveSourceInChain(idx, 'down')}
                      disabled={idx === formData.chain.length - 1}
                      style={{ padding: '4px 8px', fontSize: '10px' }}
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    className="cond-remove"
                    onClick={() => removeSourceFromChain(idx)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          {availableSources.length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <select
                className="select"
                onChange={(e) => addSourceToChain(e.target.value as SourceKey)}
                value=""
              >
                <option value="">+ Add source to chain...</option>
                {availableSources.map(key => (
                  <option key={key} value={key}>{sources[key].name}</option>
                ))}
              </select>
            </div>
          )}
          {errors.chain && <span style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>{errors.chain}</span>}

          <div style={{ marginTop: '18px', padding: '14px', background: 'var(--bg)', borderLeft: '3px solid var(--accent-2)' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--accent-2)', fontWeight: 700, marginBottom: '6px' }}>
              Tie-Breaking Rule
            </div>
            <select
              className="select"
              value={formData.tieBreaker}
              onChange={(e) => handleChange('tieBreaker', e.target.value)}
              style={{ width: '280px' }}
            >
              <option value="most_recent">Most recently updated (timestamp)</option>
              <option value="highest_reliability">Highest source reliability score</option>
              <option value="flag_conflict">Always flag as conflict</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
