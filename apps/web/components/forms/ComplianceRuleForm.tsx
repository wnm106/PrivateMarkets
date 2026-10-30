'use client';

import { useEffect, useState } from 'react';
import {
  graphqlQuery,
  DOMAIN_TYPES_QUERY,
  RELATIONSHIP_TYPES_QUERY,
  ATTRIBUTE_REGISTER_QUERY,
} from '@/lib/graphql';
import { AttributePicker } from './AttributePicker';
import { EntityAttributeTree } from './EntityAttributeTree';
import { ComplianceAttributeSelect, useRelationshipAttributes } from './ComplianceAttributeSelect';
import { CompliancePopulationPreview } from './CompliancePopulationPreview';
import { AS_OF_PERIODS, comparisonFields, comparisonText, describeComparisonExpression, DQ_DATE_FNS } from '@/lib/expression-library';

export interface RollupHop {
  relationshipCode: string;
  direction: 'UP' | 'DOWN';
  recursive: boolean;
}

// Source / time dimension of an attribute reference. Empty = golden, run as-of date.
export interface DimensionState {
  sourceScope: string;
  offsetAmount: string; // negative = past, e.g. -1 with MONTH = one month prior
  offsetUnit: string;
  snapTo: string;
  knowledgeMode: string;
}

export const emptyDimension = (): DimensionState => ({
  sourceScope: '',
  offsetAmount: '',
  offsetUnit: 'DAY',
  snapTo: '',
  knowledgeMode: 'RUN',
});

export function dimensionToInput(d?: DimensionState | null, path?: Array<{ relationshipCode: string; direction: string }> | null) {
  const out: Record<string, any> = {};
  if (d) {
    const hasOffset = d.offsetAmount !== '' && Number(d.offsetAmount) !== 0;
    if (d.sourceScope) out.sourceScope = d.sourceScope;
    if (hasOffset) {
      out.offsetAmount = parseInt(d.offsetAmount, 10);
      out.offsetUnit = d.offsetUnit;
    }
    if (d.snapTo) out.snapTo = d.snapTo;
    if (d.knowledgeMode && d.knowledgeMode !== 'RUN') out.knowledgeMode = d.knowledgeMode;
  }
  const hops = (path || []).filter((hop) => hop.relationshipCode);
  if (hops.length) {
    out.relationshipPath = hops.map((hop) => ({
      relationshipCode: hop.relationshipCode,
      direction: hop.direction,
      recursive: false,
    }));
  }
  return Object.keys(out).length ? out : undefined;
}

export function dimensionFromDto(d: any): DimensionState {
  if (!d) return emptyDimension();
  return {
    sourceScope: d.sourceScope || '',
    offsetAmount: d.offsetAmount != null ? String(d.offsetAmount) : '',
    offsetUnit: d.offsetUnit || 'DAY',
    snapTo: d.snapTo || '',
    knowledgeMode: d.knowledgeMode || 'RUN',
  };
}

export function describeDimension(d: any): string {
  const s = dimensionFromDto(d);
  const parts: string[] = [];
  parts.push(s.sourceScope || 'run source');
  if (s.offsetAmount !== '' && Number(s.offsetAmount) !== 0) parts.push(`${s.offsetAmount} ${s.offsetUnit.toLowerCase()}`);
  else parts.push('as-of');
  if (s.snapTo) parts.push(s.snapTo.replace('_', ' ').toLowerCase());
  if (s.knowledgeMode === 'AT_OFFSET_DATE') parts.push('as known then');
  return parts.join(' / ');
}

export interface ComplianceCondition {
  appliesTo: 'BASE' | 'ANCHOR';
  conditionGroup: number;
  conditionOrder: number;
  attributeCode: string;
  attributePath: Array<{ relationshipCode: string; direction: 'UP' | 'DOWN' }>;
  attributeDimension: DimensionState;
  operator: string;
  value: string;
  compareAttributeCode: string; // when set, compare to this attribute instead of the literal value
  compareAttributePath: Array<{ relationshipCode: string; direction: 'UP' | 'DOWN' }>;
  compareDimension: DimensionState;
  logicOperator: 'AND' | 'OR';
}

export interface ComplianceRuleFormData {
  // Rule identity
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  anchorDomainCode: string;
  appliesToAll: boolean;
  description: string;
  // Version
  validFrom: string;
  changeReason: string;
  baseDomainCode: string;
  baseRollupPath: RollupHop[];
  groupByPath: RollupHop[];
  groupByAttributeCode: string;
  numeratorAttributeCode: string;
  numeratorAggregation: string;
  numeratorDimension: DimensionState;
  denominatorDimension: DimensionState;
  resultTransform: string;
  denominatorAttributeCode: string;
  denominatorAggregation: string;
  denominatorScope: string;
  denominatorConstantValue: string;
  resultUnit: string;
  limitDirection: string;
  softLimitValue: string;
  hardLimitValue: string;
  hardLimitAttributeCode: string;
  softLimitFactor: string;
  defaultSourceScope: string;
  conditions: ComplianceCondition[];
}

interface Domain {
  domainCode: string;
  domainName: string;
}

interface RelationshipTypeOpt {
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode: string;
  childDomainCode: string;
}

interface AttributeOpt {
  attributeCode: string;
  attributeName: string;
  dataType: string;
}

const OPERATORS = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'] as const;
const OPERATOR_LABELS: Record<(typeof OPERATORS)[number], string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  not_in: 'is not one of',
  is_null: 'is blank',
  is_not_null: 'is present',
};
const AGGREGATIONS = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'VALUE', 'CONSTANT'];

function defaultFormData(): ComplianceRuleFormData {
  return {
    ruleCode: '',
    ruleName: '',
    ruleCategory: 'CONCENTRATION',
    anchorDomainCode: '',
    appliesToAll: true,
    description: '',
    validFrom: new Date().toISOString().slice(0, 10),
    changeReason: 'Initial version',
    baseDomainCode: '',
    baseRollupPath: [],
    groupByPath: [],
    groupByAttributeCode: '',
    numeratorAttributeCode: '',
    numeratorAggregation: 'SUM',
    numeratorDimension: emptyDimension(),
    denominatorDimension: emptyDimension(),
    resultTransform: 'NONE',
    denominatorAttributeCode: '',
    denominatorAggregation: 'SUM',
    denominatorScope: 'ANCHOR_TOTAL',
    denominatorConstantValue: '',
    resultUnit: 'PERCENTAGE',
    limitDirection: 'MAX',
    softLimitValue: '',
    hardLimitValue: '',
    hardLimitAttributeCode: '',
    softLimitFactor: '',
    defaultSourceScope: 'GOLDEN',
    conditions: [],
  };
}

interface ComplianceRuleFormProps {
  initial?: Partial<ComplianceRuleFormData>;
  lockIdentity?: boolean; // true when authoring a new version of an existing rule
  onSubmit: (data: ComplianceRuleFormData) => void;
  onCancel: () => void;
  submitting?: boolean;
}

export function ComplianceRuleForm({ initial, lockIdentity, onSubmit, onCancel, submitting }: ComplianceRuleFormProps) {
  const [formData, setFormData] = useState<ComplianceRuleFormData>({ ...defaultFormData(), ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [domains, setDomains] = useState<Domain[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<RelationshipTypeOpt[]>([]);
  const [baseAttributes, setBaseAttributes] = useState<AttributeOpt[]>([]);
  const [anchorAttributes, setAnchorAttributes] = useState<AttributeOpt[]>([]);
  const [groupByAttributes, setGroupByAttributes] = useState<AttributeOpt[]>([]);

  useEffect(() => {
    graphqlQuery<{ domainTypes: Domain[] }, {}>(DOMAIN_TYPES_QUERY, {}).then((r) => {
      if (r.data?.domainTypes) setDomains(r.data.domainTypes);
    });
    graphqlQuery<{ relationshipTypes: RelationshipTypeOpt[] }, {}>(RELATIONSHIP_TYPES_QUERY, {}).then((r) => {
      if (r.data?.relationshipTypes) setRelationshipTypes(r.data.relationshipTypes);
    });
  }, []);

  useEffect(() => {
    if (!formData.baseDomainCode) {
      setBaseAttributes([]);
      return;
    }
    graphqlQuery<{ attributeRegister: AttributeOpt[] }, { domainCode: string }>(
      ATTRIBUTE_REGISTER_QUERY,
      { domainCode: formData.baseDomainCode }
    ).then((r) => {
      if (r.data?.attributeRegister) setBaseAttributes(r.data.attributeRegister);
    });
  }, [formData.baseDomainCode]);

  useEffect(() => {
    if (!formData.anchorDomainCode) {
      setAnchorAttributes([]);
      return;
    }
    graphqlQuery<{ attributeRegister: AttributeOpt[] }, { domainCode: string }>(
      ATTRIBUTE_REGISTER_QUERY,
      { domainCode: formData.anchorDomainCode }
    ).then((r) => {
      if (r.data?.attributeRegister) setAnchorAttributes(r.data.attributeRegister);
    });
  }, [formData.anchorDomainCode]);

  // Attribute list for the group-by attribute: the domain at the far end of
  // groupByPath (or the base domain itself if there's no group-by path).
  useEffect(() => {
    const lastHop = formData.groupByPath[formData.groupByPath.length - 1];
    const relType = relationshipTypes.find((r) => r.relationshipCode === lastHop?.relationshipCode);
    const targetDomain = lastHop
      ? (lastHop.direction === 'UP' ? relType?.parentDomainCode : relType?.childDomainCode)
      : formData.baseDomainCode;

    if (!targetDomain) {
      setGroupByAttributes([]);
      return;
    }
    graphqlQuery<{ attributeRegister: AttributeOpt[] }, { domainCode: string }>(
      ATTRIBUTE_REGISTER_QUERY,
      { domainCode: targetDomain }
    ).then((r) => {
      if (r.data?.attributeRegister) setGroupByAttributes(r.data.attributeRegister);
    });
  }, [formData.groupByPath, formData.baseDomainCode, relationshipTypes]);

  const handleChange = (field: keyof ComplianceRuleFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  // ---- Rollup path (hierarchy) helpers ----
  const addHop = (pathField: 'baseRollupPath' | 'groupByPath') => {
    setFormData((prev) => ({
      ...prev,
      [pathField]: [...prev[pathField], { relationshipCode: '', direction: 'UP', recursive: false }],
    }));
  };
  const updateHop = (pathField: 'baseRollupPath' | 'groupByPath', idx: number, patch: Partial<RollupHop>) => {
    setFormData((prev) => {
      const path = [...prev[pathField]];
      path[idx] = { ...path[idx], ...patch };
      return { ...prev, [pathField]: path };
    });
  };
  const removeHop = (pathField: 'baseRollupPath' | 'groupByPath', idx: number) => {
    setFormData((prev) => ({ ...prev, [pathField]: prev[pathField].filter((_, i) => i !== idx) }));
  };

  // ---- Conditions helpers ----
  const addCondition = (appliesTo: 'BASE' | 'ANCHOR') => {
    setFormData((prev) => ({
      ...prev,
      conditions: [
        ...prev.conditions,
        {
          appliesTo,
          conditionGroup: 1,
          conditionOrder: prev.conditions.filter((c) => c.appliesTo === appliesTo).length + 1,
          attributeCode: '',
          attributePath: [],
          attributeDimension: emptyDimension(),
          operator: 'equals',
          value: '',
          compareAttributeCode: '',
          compareAttributePath: [],
          compareDimension: emptyDimension(),
          logicOperator: 'AND',
        },
      ],
    }));
  };
  const updateCondition = (idx: number, patch: Partial<ComplianceCondition>) => {
    setFormData((prev) => {
      const conditions = [...prev.conditions];
      conditions[idx] = { ...conditions[idx], ...patch };
      return { ...prev, conditions };
    });
  };
  const removeCondition = (idx: number) => {
    setFormData((prev) => ({ ...prev, conditions: prev.conditions.filter((_, i) => i !== idx) }));
  };

  // ---- Wizard state ----
  const STEPS = ['Define', 'Measure & limit', 'Refine (optional)'];
  const [step, setStep] = useState(0);
  const [codeTouched, setCodeTouched] = useState(!!initial?.ruleCode);

  const toCode = (name: string) =>
    name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  const handleNameChange = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      ruleName: name,
      ruleCode: lockIdentity || codeTouched ? prev.ruleCode : toCode(name),
    }));
    if (errors.ruleName) setErrors((prev) => ({ ...prev, ruleName: '' }));
  };

  const handleAnchorChange = (code: string) => {
    setFormData((prev) => ({
      ...prev,
      anchorDomainCode: code,
      // Most rules aggregate the anchor itself; default base to the anchor until changed.
      baseDomainCode: prev.baseDomainCode && prev.baseDomainCode !== prev.anchorDomainCode ? prev.baseDomainCode : code,
    }));
    if (errors.anchorDomainCode) setErrors((prev) => ({ ...prev, anchorDomainCode: '' }));
  };

  const validateStep = (s: number) => {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (!formData.ruleName) e.ruleName = 'Give the rule a name';
      if (!formData.ruleCode) e.ruleCode = 'Rule code is required';
      if (!formData.anchorDomainCode) e.anchorDomainCode = 'Choose what the rule applies to';
    }
    if (s === 1) {
      if (!formData.baseDomainCode) e.baseDomainCode = 'Choose where values are read from';
      if (!formData.numeratorAttributeCode) e.numeratorAttributeCode = 'Choose the value to measure';
      if (formData.denominatorScope !== 'CONSTANT' && formData.denominatorScope !== 'NONE' && !formData.denominatorAttributeCode) {
        e.denominatorAttributeCode = 'Choose the value to compare against';
      }
      if (formData.denominatorScope === 'CONSTANT' && !formData.denominatorConstantValue) {
        e.denominatorConstantValue = 'Enter a number';
      }
      if (!formData.softLimitValue && !formData.hardLimitValue && !formData.hardLimitAttributeCode) {
        e.hardLimitValue = 'Set a limit, or read it from the fund';
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const goNext = () => {
    if (validateStep(step)) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleSubmit = () => {
    for (const s of [0, 1]) {
      if (!validateStep(s)) {
        setStep(s);
        return;
      }
    }
    onSubmit(formData);
  };

  const baseConditions = formData.conditions.filter((c) => c.appliesTo === 'BASE');
  const anchorConditions = formData.conditions.filter((c) => c.appliesTo === 'ANCHOR');

  const domainName = (code: string) => domains.find((d) => d.domainCode === code)?.domainName || code;
  const attrName = (list: AttributeOpt[], code: string) => list.find((a) => a.attributeCode === code)?.attributeName || code;

  const summary = (() => {
    if (!formData.numeratorAttributeCode || !formData.anchorDomainCode) return '';
    const agg = formData.numeratorAggregation.toLowerCase();
    const num = `${agg} of ${attrName(baseAttributes, formData.numeratorAttributeCode)}`;
    let rel = '';
    if (formData.denominatorScope === 'CONSTANT') {
      rel = formData.denominatorConstantValue ? ` ÷ ${formData.denominatorConstantValue}` : '';
    } else if (formData.denominatorScope === 'NONE') {
      rel = '';
    } else if (formData.denominatorAttributeCode) {
      const denList = formData.denominatorScope === 'ANCHOR' ? anchorAttributes : baseAttributes;
      const den = attrName(denList, formData.denominatorAttributeCode);
      rel = formData.denominatorScope === 'ANCHOR'
        ? ` as a percent of the fund's ${den}`
        : ` as a share of ${formData.denominatorScope === 'SAME_GROUP' ? 'group' : 'total'} ${den}`;
    }
    const limit = formData.hardLimitAttributeCode
      ? `the fund's ${formData.hardLimitAttributeCode}`
      : (formData.hardLimitValue || formData.softLimitValue);
    const dir = formData.limitDirection === 'MAX' ? 'above' : 'below';
    return `For each ${domainName(formData.anchorDomainCode)}: ${num}${rel}. Breach when ${dir} ${limit || '…'}.`;
  })();

  const advancedCount = {
    scope: formData.conditions.filter((c) => c.attributeCode).length,
    structure:
      formData.baseRollupPath.filter((h) => h.relationshipCode).length +
      formData.groupByPath.filter((h) => h.relationshipCode).length +
      (formData.groupByAttributeCode ? 1 : 0),
    period:
      [formData.numeratorDimension, formData.denominatorDimension].filter(
        (d) => dimensionToInput(d) !== undefined
      ).length + (formData.defaultSourceScope !== 'GOLDEN' ? 1 : 0),
  };

  const panel = { background: 'var(--bg)', border: '1px solid var(--line)', padding: '16px', marginTop: '10px' } as const;
  const badge = (n: number) => (n > 0 ? ` · ${n} configured` : '');

  return (
    <div>
      {/* Stepper */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              // Allow going back freely; going forward requires the current step to be valid.
              if (i <= step || validateStep(step)) setStep(i);
            }}
            style={{
              flex: 1,
              textAlign: 'left',
              padding: '10px 12px',
              border: '1px solid var(--line)',
              borderBottom: i === step ? '2px solid var(--accent)' : '1px solid var(--line)',
              background: i === step ? 'var(--bg)' : 'transparent',
              color: i === step ? 'var(--ink)' : 'var(--ink-3)',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: i === step ? 700 : 500,
            }}
          >
            <span style={{ marginRight: '8px', color: 'var(--accent)' }}>{i < step ? '✓' : i + 1}</span>
            {label}
          </button>
        ))}
      </div>

      {/* Step 1: Define */}
      {step === 0 && (
        <div className="builder-card">
          <div className="builder-body">
            <div className="form-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Rule name *</label>
                <input
                  className={`text-input ${errors.ruleName ? 'error' : ''}`}
                  value={formData.ruleName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="e.g. Single industry concentration"
                  autoFocus
                />
                {errors.ruleName && <span className="field-error">{errors.ruleName}</span>}
                {formData.ruleCode && (
                  <span className="field-hint">
                    Code: <span className="mono">{formData.ruleCode}</span>
                    {!lockIdentity && (
                      <>
                        {' · '}
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            const next = window.prompt('Rule code', formData.ruleCode);
                            if (next) {
                              setCodeTouched(true);
                              handleChange('ruleCode', next.toUpperCase().replace(/\s+/g, '_'));
                            }
                          }}
                        >
                          edit
                        </a>
                      </>
                    )}
                  </span>
                )}
                {errors.ruleCode && <span className="field-error">{errors.ruleCode}</span>}
              </div>
              <div className="field">
                <label>Applies to *</label>
                <select
                  className={`select ${errors.anchorDomainCode ? 'error' : ''}`}
                  value={formData.anchorDomainCode}
                  disabled={lockIdentity}
                  onChange={(e) => handleAnchorChange(e.target.value)}
                >
                  <option value="">Select entity type...</option>
                  {domains.map((d) => (
                    <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
                  ))}
                </select>
                <span className="field-hint">The rule is evaluated once per entity of this type (e.g. each Fund)</span>
                {errors.anchorDomainCode && <span className="field-error">{errors.anchorDomainCode}</span>}
              </div>
              <div className="field">
                <label>Category</label>
                <select
                  className="select"
                  value={formData.ruleCategory}
                  onChange={(e) => handleChange('ruleCategory', e.target.value)}
                >
                  <option value="CONCENTRATION">Concentration</option>
                  <option value="EXPOSURE">Exposure</option>
                  <option value="DIVERSIFICATION">Diversification</option>
                  <option value="ELIGIBILITY">Eligibility</option>
                  <option value="LEVERAGE">Leverage</option>
                  <option value="LIQUIDITY">Liquidity</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Measure & limit */}
      {step === 1 && (
        <div className="builder-card">
          <div className="builder-body">
            <div className="form-grid">
              <AttributePicker
                label="Measure *"
                rootDomainCode={formData.baseDomainCode}
                value={formData.numeratorAttributeCode}
                onChange={(code) => handleChange('numeratorAttributeCode', code)}
                attributes={baseAttributes}
                placeholder="Select value..."
                error={!!errors.numeratorAttributeCode}
              />
              {errors.numeratorAttributeCode && <span className="field-error">{errors.numeratorAttributeCode}</span>}
              <div className="field">
                <label>How to combine</label>
                <select
                  className="select"
                  value={formData.numeratorAggregation}
                  onChange={(e) => handleChange('numeratorAggregation', e.target.value)}
                >
                  {AGGREGATIONS.filter((a) => a !== 'CONSTANT').map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>

              <div className="field">
                <label>Compare against</label>
                <select
                  className="select"
                  value={formData.denominatorScope}
                  onChange={(e) => handleChange('denominatorScope', e.target.value)}
                >
                  <option value="NONE">The measure itself (count or total exposure)</option>
                  <option value="ANCHOR">A value on the fund (for example NAV)</option>
                  <option value="ANCHOR_TOTAL">Total of the positions in the fund</option>
                  <option value="SAME_GROUP">Total within the same group</option>
                  <option value="CONSTANT">A fixed number</option>
                </select>
              </div>
              {formData.denominatorScope === 'NONE' ? null : formData.denominatorScope === 'CONSTANT' ? (
                <div className="field">
                  <label>Number *</label>
                  <input
                    className={`text-input mono ${errors.denominatorConstantValue ? 'error' : ''}`}
                    type="number"
                    value={formData.denominatorConstantValue}
                    onChange={(e) => handleChange('denominatorConstantValue', e.target.value)}
                  />
                  {errors.denominatorConstantValue && <span className="field-error">{errors.denominatorConstantValue}</span>}
                </div>
              ) : (
                <AttributePicker
                  label={formData.denominatorScope === 'ANCHOR' ? 'Fund value *' : 'Total of *'}
                  rootDomainCode={formData.denominatorScope === 'ANCHOR' ? formData.anchorDomainCode : formData.baseDomainCode}
                  value={formData.denominatorAttributeCode}
                  onChange={(code) => handleChange('denominatorAttributeCode', code)}
                  attributes={formData.denominatorScope === 'ANCHOR' ? anchorAttributes : baseAttributes}
                  placeholder="Select value..."
                  error={!!errors.denominatorAttributeCode}
                />
              )}

              <div className="field">
                <label>Limit type</label>
                <select
                  className="select"
                  value={formData.limitDirection}
                  onChange={(e) => handleChange('limitDirection', e.target.value)}
                >
                  <option value="MAX">Maximum (breach if above)</option>
                  <option value="MIN">Minimum (breach if below)</option>
                </select>
              </div>
              <div className="field">
                <label>Hard limit (breach)</label>
                <input
                  className={`text-input mono ${errors.hardLimitValue ? 'error' : ''}`}
                  type="number"
                  value={formData.hardLimitValue}
                  onChange={(e) => handleChange('hardLimitValue', e.target.value)}
                />
                {errors.hardLimitValue && <span className="field-error">{errors.hardLimitValue}</span>}
              </div>
              <div className="field">
                <label>Soft limit (warning)</label>
                <input
                  className="text-input mono"
                  type="number"
                  value={formData.softLimitValue}
                  onChange={(e) => handleChange('softLimitValue', e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <AttributePicker
                label="Or read the hard limit from the fund"
                rootDomainCode={formData.anchorDomainCode}
                value={formData.hardLimitAttributeCode}
                onChange={(code) => handleChange('hardLimitAttributeCode', code)}
                attributes={anchorAttributes}
                placeholder="Optional"
              />
              <div className="field">
                <label>Warning as a fraction of that limit</label>
                <input
                  className="text-input mono"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={formData.softLimitFactor}
                  onChange={(e) => handleChange('softLimitFactor', e.target.value)}
                  placeholder="0.80 = warn at 80%"
                />
              </div>
            </div>

            {summary && (
              <div style={{ ...panel, fontSize: '13px', color: 'var(--ink-2, var(--ink))' }}>
                <div className="section-kicker">In plain English</div>
                {summary}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Refine — everything optional, collapsed by default */}
      {step === 2 && (
        <div className="builder-card">
          <div className="builder-body">
            <div className="field-hint" style={{ marginBottom: '10px' }}>
              Everything here is optional. The rule is ready to create as it is.
            </div>

            <details style={panel}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Only include certain records{badge(advancedCount.scope)}
              </summary>
              <div style={{ marginTop: '12px' }}>
                <ConditionGroup
                  title="Filter the records being measured"
                  conditions={baseConditions}
                  allConditions={formData.conditions}
                  rootDomainCode={formData.baseDomainCode}
                  domainLabel={domainName(formData.baseDomainCode)}
                  relationshipTypes={relationshipTypes}
                  domains={domains}
                  onAdd={() => addCondition('BASE')}
                  onUpdate={updateCondition}
                  onRemove={removeCondition}
                />
                <div style={{ height: '14px' }} />
                <ConditionGroup
                  title="Only run for certain entities"
                  conditions={anchorConditions}
                  allConditions={formData.conditions}
                  rootDomainCode={formData.anchorDomainCode}
                  domainLabel={domainName(formData.anchorDomainCode)}
                  relationshipTypes={relationshipTypes}
                  domains={domains}
                  onAdd={() => addCondition('ANCHOR')}
                  onUpdate={updateCondition}
                  onRemove={removeCondition}
                />
              </div>
            </details>

            <details style={panel}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Where values come from &amp; grouping{badge(advancedCount.structure)}
              </summary>
              <div style={{ marginTop: '12px' }}>
                <div className="form-grid">
                  <div className="field">
                    <label>Read values from</label>
                    <select
                      className={`select ${errors.baseDomainCode ? 'error' : ''}`}
                      value={formData.baseDomainCode}
                      onChange={(e) => handleChange('baseDomainCode', e.target.value)}
                    >
                      <option value="">Select entity type...</option>
                      {domains.map((d) => (
                        <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
                      ))}
                    </select>
                    <span className="field-hint">Defaults to the entity the rule applies to (e.g. read Position values for a Fund)</span>
                  </div>
                </div>

                <div style={panel}>
                  <div className="section-kicker">Hierarchy path (from the entity to where values are read)</div>
                  <div className="field-hint" style={{ marginBottom: '10px' }}>
                    Leave empty if the entity itself holds the values.
                  </div>
                  <HopList
                    hops={formData.baseRollupPath}
                    relationshipTypes={relationshipTypes}
                    onAdd={() => addHop('baseRollupPath')}
                    onUpdate={(idx, patch) => updateHop('baseRollupPath', idx, patch)}
                    onRemove={(idx) => removeHop('baseRollupPath', idx)}
                  />
                </div>

                <div style={panel}>
                  <div className="section-kicker">Group results by</div>
                  <div className="field-hint" style={{ marginBottom: '10px' }}>
                    Check the limit per group (e.g. per Industry) instead of one overall figure.
                  </div>
                  <HopList
                    hops={formData.groupByPath}
                    relationshipTypes={relationshipTypes}
                    onAdd={() => addHop('groupByPath')}
                    onUpdate={(idx, patch) => updateHop('groupByPath', idx, patch)}
                    onRemove={(idx) => removeHop('groupByPath', idx)}
                  />
                  <div style={{ marginTop: '12px' }}>
                    <AttributePicker
                      label="Group-by attribute"
                      rootDomainCode={formData.baseDomainCode}
                      value={formData.groupByAttributeCode}
                      onChange={(code) => handleChange('groupByAttributeCode', code)}
                      attributes={groupByAttributes}
                      placeholder="No grouping"
                    />
                  </div>
                </div>
              </div>
            </details>

            <details style={panel}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Data source &amp; time period{badge(advancedCount.period)}
              </summary>
              <div style={{ marginTop: '12px' }}>
                <div className="form-grid">
                  <div className="field">
                    <label>Default source</label>
                    <select
                      className="select"
                      value={formData.defaultSourceScope}
                      onChange={(e) => handleChange('defaultSourceScope', e.target.value)}
                    >
                      <option value="GOLDEN">Golden master (resolved)</option>
                      <option value="WSO">WSO (single source)</option>
                      <option value="BLOOMBERG">Bloomberg (single source)</option>
                      <option value="MANUAL">Manual overrides only</option>
                    </select>
                    <span className="field-hint">Can be overridden at run time</span>
                  </div>
                  <div className="field">
                    <label>Result calculation</label>
                    <select
                      className="select"
                      value={formData.resultTransform}
                      onChange={(e) => handleChange('resultTransform', e.target.value)}
                    >
                      <option value="NONE">Ratio (measure ÷ compare)</option>
                      <option value="DIFFERENCE">Difference</option>
                      <option value="ABS_DIFFERENCE">Absolute difference</option>
                      <option value="PCT_CHANGE">% change</option>
                      <option value="ABS_PCT_CHANGE">Absolute % change</option>
                    </select>
                    <span className="field-hint">Use a different period or source on each side to compare them</span>
                  </div>
                  <div className="field">
                    <label>Result unit</label>
                    <select
                      className="select"
                      value={formData.resultUnit}
                      onChange={(e) => handleChange('resultUnit', e.target.value)}
                    >
                      <option value="RATIO">Ratio</option>
                      <option value="PERCENTAGE">Percentage</option>
                      <option value="CURRENCY">Currency</option>
                      <option value="COUNT">Count</option>
                    </select>
                  </div>
                </div>
                <DimensionPicker
                  label="Measure: source / period"
                  value={formData.numeratorDimension}
                  onChange={(d) => handleChange('numeratorDimension', d)}
                />
                {formData.denominatorScope !== 'CONSTANT' && formData.denominatorScope !== 'NONE' && (
                  <DimensionPicker
                    label="Compare against: source / period"
                    value={formData.denominatorDimension}
                    onChange={(d) => handleChange('denominatorDimension', d)}
                  />
                )}
              </div>
            </details>

            <details style={panel}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Description &amp; versioning</summary>
              <div className="form-grid" style={{ marginTop: '12px' }}>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Description</label>
                  <textarea
                    className="text-input"
                    value={formData.description}
                    onChange={(e) => handleChange('description', e.target.value)}
                    rows={2}
                    style={{ resize: 'vertical' }}
                    placeholder="What this rule tests and why"
                  />
                </div>
                <div className="field">
                  <label>Effective from</label>
                  <input
                    className="text-input mono"
                    type="date"
                    value={formData.validFrom}
                    onChange={(e) => handleChange('validFrom', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Change reason</label>
                  <input
                    className="text-input"
                    value={formData.changeReason}
                    onChange={(e) => handleChange('changeReason', e.target.value)}
                    placeholder="Why this version was created"
                  />
                </div>
                <div className="field">
                  <label>Applies to</label>
                  <select
                    className="select"
                    value={formData.appliesToAll ? 'all' : 'specific'}
                    onChange={(e) => handleChange('appliesToAll', e.target.value === 'all')}
                  >
                    <option value="all">All entities of this type</option>
                    <option value="specific">Specific entities (assign after creating)</option>
                  </select>
                </div>
              </div>
            </details>
          </div>
        </div>
      )}

      <div className="builder-footer">
        <div className="left">
          {step > 0 && (
            <button className="btn" onClick={() => setStep((s) => s - 1)} disabled={submitting}>← Back</button>
          )}
        </div>
        <div className="right">
          <button className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>
          {step === 1 && (
            <button className="btn" onClick={goNext} disabled={submitting}>Refine…</button>
          )}
          {step === 0 ? (
            <button className="btn btn-primary" onClick={goNext}>Next →</button>
          ) : (
            <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving...' : lockIdentity ? 'Create New Version' : 'Create Rule'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function HopList({
  hops,
  relationshipTypes,
  onAdd,
  onUpdate,
  onRemove,
}: {
  hops: RollupHop[];
  relationshipTypes: RelationshipTypeOpt[];
  onAdd: () => void;
  onUpdate: (idx: number, patch: Partial<RollupHop>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div>
      {hops.map((hop, idx) => (
        <div
          key={idx}
          style={{ display: 'grid', gridTemplateColumns: '1.6fr 110px 110px 30px', gap: '10px', alignItems: 'center', marginBottom: '8px' }}
        >
          <select
            className="select"
            value={hop.relationshipCode}
            onChange={(e) => onUpdate(idx, { relationshipCode: e.target.value })}
          >
            <option value="">Select relationship...</option>
            {relationshipTypes.map((rt) => (
              <option key={rt.relationshipCode} value={rt.relationshipCode}>
                {rt.relationshipName} ({rt.parentDomainCode} → {rt.childDomainCode})
              </option>
            ))}
          </select>
          <select
            className="select"
            value={hop.direction}
            onChange={(e) => onUpdate(idx, { direction: e.target.value as 'UP' | 'DOWN' })}
          >
            <option value="UP">UP (to parent)</option>
            <option value="DOWN">DOWN (to children)</option>
          </select>
          <select
            className="select"
            value={hop.recursive ? 'true' : 'false'}
            onChange={(e) => onUpdate(idx, { recursive: e.target.value === 'true' })}
          >
            <option value="false">Single hop</option>
            <option value="true">Recursive</option>
          </select>
          <button className="cond-remove" onClick={() => onRemove(idx)} style={{ width: '30px', height: '30px' }}>✕</button>
        </div>
      ))}
      <button className="add-cond" onClick={onAdd}>+ Add hop</button>
    </div>
  );
}

function ConditionGroup({
  title,
  conditions,
  allConditions,
  rootDomainCode,
  domainLabel,
  relationshipTypes,
  domains,
  onAdd,
  onUpdate,
  onRemove,
}: {
  title: string;
  conditions: ComplianceCondition[];
  allConditions: ComplianceCondition[];
  rootDomainCode: string;
  domainLabel: string;
  relationshipTypes: RelationshipTypeOpt[];
  domains: Domain[];
  onAdd: () => void;
  onUpdate: (idx: number, patch: Partial<ComplianceCondition>) => void;
  onRemove: (idx: number) => void;
}) {
  const { options } = useRelationshipAttributes(rootDomainCode, relationshipTypes, domains);
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '16px' }}>
      <div className="section-kicker">{title}</div>
      {conditions.length === 0 && (
        <div className="field-hint" style={{ marginBottom: '10px' }}>No conditions — applies unconditionally (ALWAYS).</div>
      )}
      {conditions.map((cond) => {
        const idx = allConditions.indexOf(cond);
        return (
          <div key={idx}>
          <div style={{ marginBottom: '8px', border: '1px solid var(--line)', borderRadius: '6px', padding: '10px', background: 'var(--surface)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 130px 1fr 30px', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
            {idx === allConditions.findIndex((c) => c.appliesTo === cond.appliesTo) ? (
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent)' }}>IF</span>
            ) : (
              <select
                className="select"
                value={cond.logicOperator}
                onChange={(e) => onUpdate(idx, { logicOperator: e.target.value as 'AND' | 'OR' })}
              >
                <option value="AND">AND</option>
                <option value="OR">OR</option>
              </select>
            )}
            <ComplianceAttributeSelect
              rootDomainCode={rootDomainCode}
              relationshipTypes={relationshipTypes}
              domains={domains}
              attributeCode={cond.attributeCode}
              path={cond.attributePath}
              onChange={(attributeCode, attributePath) => onUpdate(idx, { attributeCode, attributePath })}
            />
            <select
              className="select"
              value={cond.operator}
              onChange={(e) => onUpdate(idx, { operator: e.target.value })}
            >
              {OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
            </select>
            {cond.operator === 'is_null' || cond.operator === 'is_not_null' ? <span /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    className="text-input"
                    aria-label="Comparison expression"
                    value={cond.operator === 'in' || cond.operator === 'not_in' ? cond.value : comparisonText(cond.value, cond.compareAttributeCode)}
                    onChange={(e) => onUpdate(idx, cond.operator === 'in' || cond.operator === 'not_in'
                      ? { value: e.target.value, compareAttributeCode: '' }
                      : comparisonFields(e.target.value))}
                    placeholder={cond.operator === 'in' || cond.operator === 'not_in' ? 'US, GB' : "1.5, 'US', OTHER_FIELD, END_OF_MONTH(CURRENT_DATE)"}
                  />
                  {cond.operator !== 'in' && cond.operator !== 'not_in' && (
                    <select
                      className="select"
                      aria-label="Insert date function"
                      value=""
                      style={{ flex: '0 0 132px' }}
                      onChange={(e) => {
                        const token = e.target.value;
                        if (!token) return;
                        const current = comparisonText(cond.value, cond.compareAttributeCode).trim();
                        if (AS_OF_PERIODS.some((period) => period.code === token)) {
                          const field = current.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] || '';
                          if (field && field !== 'AS') onUpdate(idx, comparisonFields(`${token}(${field})`));
                          return;
                        }
                        const argument = /^[A-Za-z_][A-Za-z0-9_]*$/.test(current) ? current : 'CURRENT_DATE';
                        onUpdate(idx, comparisonFields(token === 'CURRENT_DATE' ? 'CURRENT_DATE' : `${token}(${argument})`));
                      }}
                    >
                      <option value="">Function</option>
                      {DQ_DATE_FNS.map((fn) => <option key={fn.token} value={fn.token}>{fn.label}</option>)}
                      {AS_OF_PERIODS.map((period) => <option key={period.code} value={period.code}>{period.name}</option>)}
                    </select>
                  )}
                </div>
                {cond.operator !== 'in' && cond.operator !== 'not_in' && (
                  <span className="field-hint">{describeComparisonExpression(comparisonText(cond.value, cond.compareAttributeCode))}</span>
                )}
              </div>
            )}
            <button className="cond-remove" onClick={() => onRemove(idx)} style={{ width: '30px', height: '30px' }}>✕</button>
          </div>
          {rootDomainCode && (
            <div style={{ marginBottom: '6px' }}>
              <button
                type="button"
                onClick={() => {
                  const el = document.getElementById(`tree-${idx}`);
                  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
                }}
                style={{ fontSize: '11px', padding: '2px 8px', background: 'var(--accent-light)', border: '1px solid var(--accent)', borderRadius: '3px', cursor: 'pointer', color: 'var(--accent)' }}
              >
                🌳 Browse entity tree
              </button>
              <div id={`tree-${idx}`} style={{ display: 'none', marginTop: '6px' }}>
                <EntityAttributeTree
                  rootDomainCode={rootDomainCode}
                  onSelect={(sel) => onUpdate(idx, { attributeCode: sel.attribute.attributeCode, attributePath: sel.path })}
                  selectedCode={cond.attributeCode}
                  maxHeight="300px"
                />
              </div>
            </div>
          )}
          <details style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--ink-3)' }}>
            <summary style={{ cursor: 'pointer' }}>Where these values are read</summary>
            <div style={{ padding: '10px 0 0 12px' }}>
              <DimensionPicker
                compact
                label="This attribute read from"
                value={cond.attributeDimension}
                onChange={(d) => onUpdate(idx, { attributeDimension: d })}
              />
              {cond.compareAttributeCode && cond.compareAttributeCode !== '__PICK__' && (
                <DimensionPicker
                  compact
                  label={`${cond.compareAttributeCode} read from`}
                  value={cond.compareDimension}
                  onChange={(d) => onUpdate(idx, { compareDimension: d })}
                />
              )}
            </div>
          </details>
          </div>
          </div>
        );
      })}
      <button className="add-cond" onClick={onAdd}>+ Add condition</button>
      <CompliancePopulationPreview
        domainCode={rootDomainCode}
        domainLabel={domainLabel}
        conditions={conditions}
        options={options}
      />
    </div>
  );
}

const OFFSET_UNITS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'];

// Source / time "dimension" of an attribute reference. Blank = golden source at
// the evaluation's as-of date (the default).
export function DimensionPicker({
  label,
  value,
  onChange,
  compact,
}: {
  label: string;
  value: DimensionState;
  onChange: (d: DimensionState) => void;
  compact?: boolean;
}) {
  const patch = (p: Partial<DimensionState>) => onChange({ ...value, ...p });
  const hasOffset = value.offsetAmount !== '' && Number(value.offsetAmount) !== 0;
  return (
    <div style={{ background: compact ? 'transparent' : 'var(--bg)', border: compact ? 'none' : '1px solid var(--line)', padding: compact ? 0 : '16px', marginTop: '10px' }}>
      <div className="section-kicker">{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 90px 110px 130px 1.3fr', gap: '10px', alignItems: 'end' }}>
        <div className="field">
          <label>Source</label>
          <input
            className="text-input"
            value={value.sourceScope}
            onChange={(e) => patch({ sourceScope: e.target.value.toUpperCase() })}
            placeholder="Default (run source / GOLDEN)"
          />
        </div>
        <div className="field">
          <label>Offset</label>
          <input
            className="text-input mono"
            type="number"
            value={value.offsetAmount}
            onChange={(e) => patch({ offsetAmount: e.target.value })}
            placeholder="0 (today)"
          />
        </div>
        <div className="field">
          <label>Unit</label>
          <select className="select" value={value.offsetUnit} onChange={(e) => patch({ offsetUnit: e.target.value })} disabled={!hasOffset}>
            {OFFSET_UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}s</option>)}
          </select>
        </div>
        <div className="field">
          <label>Snap to</label>
          <select className="select" value={value.snapTo} onChange={(e) => patch({ snapTo: e.target.value })}>
            <option value="">None</option>
            <option value="MONTH_END">Month end</option>
            <option value="QUARTER_END">Quarter end</option>
            <option value="YEAR_END">Year end</option>
          </select>
        </div>
        <div className="field">
          <label>Knowledge</label>
          <select className="select" value={value.knowledgeMode} onChange={(e) => patch({ knowledgeMode: e.target.value })}>
            <option value="RUN">As known at run</option>
            <option value="AT_OFFSET_DATE">As known at that date</option>
          </select>
        </div>
      </div>
      <span className="field-hint">Reads: {describeDimension(value)}. Negative offset = past (e.g. -1 month).</span>
    </div>
  );
}

function normalizeConditionValue(c: ComplianceCondition): string | undefined {
  if (c.compareAttributeCode && c.compareAttributeCode !== '__PICK__') return undefined;
  if (c.operator === 'is_null' || c.operator === 'is_not_null') return undefined;
  const value = (c.value || '').trim();
  if (!value) return undefined;
  if (c.operator === 'in' || c.operator === 'not_in') {
    if (value.startsWith('[')) return value;
    return JSON.stringify(value.split(',').map((part) => part.trim()).filter(Boolean));
  }
  return c.value;
}

// Shared by the create-rule and new-version flows.
export function buildComplianceVersionInput(ruleId: string, data: ComplianceRuleFormData) {
  const cleanHops = (hops: RollupHop[]) =>
    hops
      .filter((h) => h.relationshipCode)
      .map((h) => ({ relationshipCode: h.relationshipCode, direction: h.direction, recursive: h.recursive }));
  const isConst = data.denominatorScope === 'CONSTANT';
  const noRatio = data.denominatorScope === 'NONE';
  const anchorDen = data.denominatorScope === 'ANCHOR';
  return {
    ruleId,
    validFrom: data.validFrom,
    ruleName: data.ruleName,
    description: data.description || undefined,
    changeReason: data.changeReason || undefined,
    baseDomainCode: data.baseDomainCode,
    baseRollupPath: cleanHops(data.baseRollupPath),
    groupByPath: cleanHops(data.groupByPath),
    groupByAttributeCode: data.groupByAttributeCode || undefined,
    numeratorAttributeCode: data.numeratorAttributeCode,
    numeratorAggregation: data.numeratorAggregation,
    numeratorDimension: dimensionToInput(data.numeratorDimension),
    denominatorDimension: isConst || noRatio ? undefined : dimensionToInput(data.denominatorDimension),
    resultTransform: data.resultTransform,
    denominatorAttributeCode: isConst || noRatio ? undefined : data.denominatorAttributeCode || undefined,
    denominatorAggregation: isConst || noRatio ? undefined : data.denominatorAggregation,
    denominatorScope: anchorDen || noRatio ? 'SAME_GROUP' : data.denominatorScope,
    denominatorSource: anchorDen ? 'ANCHOR' : 'BASE',
    denominatorConstantValue: data.denominatorConstantValue ? parseFloat(data.denominatorConstantValue) : undefined,
    resultUnit: data.resultUnit,
    limitDirection: data.limitDirection,
    softLimitValue: data.softLimitValue ? parseFloat(data.softLimitValue) : undefined,
    hardLimitValue: data.hardLimitValue ? parseFloat(data.hardLimitValue) : undefined,
    hardLimitAttributeCode: data.hardLimitAttributeCode || undefined,
    softLimitFactor: data.softLimitFactor ? parseFloat(data.softLimitFactor) : undefined,
    defaultSourceScope: data.defaultSourceScope,
    conditions: data.conditions
      .filter((c) => c.attributeCode)
      .map((c, idx) => ({
        appliesTo: c.appliesTo,
        conditionGroup: c.conditionGroup,
        conditionOrder: idx + 1,
        attributeCode: c.attributeCode,
        attributeDimension: dimensionToInput(c.attributeDimension, c.attributePath),
        operator: c.operator,
        value: normalizeConditionValue(c),
        compareAttributeCode: c.compareAttributeCode && c.compareAttributeCode !== '__PICK__' ? c.compareAttributeCode : undefined,
        compareDimension: c.compareAttributeCode && c.compareAttributeCode !== '__PICK__' ? dimensionToInput(c.compareDimension, c.compareAttributePath) : undefined,
        logicOperator: c.logicOperator,
      })),
  };
}