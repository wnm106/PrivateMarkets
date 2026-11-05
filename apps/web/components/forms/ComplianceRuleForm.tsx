'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  graphqlQuery,
  DOMAIN_TYPES_QUERY,
  RELATIONSHIP_TYPES_QUERY,
  ATTRIBUTE_REGISTER_QUERY,
} from '@/lib/graphql';
import { AttributePicker } from './AttributePicker';
import { RelatedAttributePicker, useRelationshipAttributes, attributePathKey, type TreeAttributeOption } from './ComplianceAttributeSelect';
import { ExpressionBox } from './ExpressionBox';
import {
  applyLeftText,
  applyRightText,
  leftTextOf,
  rightTextOf,
  type Expr,
  type OperandContext,
} from '@/lib/condition-expression';
import { CompliancePopulationPreview } from './CompliancePopulationPreview';

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
  /** Expression trees used when a side is more than a single field or a literal. */
  leftExpression?: Expr | null;
  rightExpression?: Expr | null;
  /** What is typed in each operand box. Derived from the fields above until first edited. */
  leftText?: string;
  rightText?: string;
  leftError?: string;
  rightError?: string;
  logicOperator: 'AND' | 'OR';
  /** Client-only identity so a line can be reordered without remounting. */
  key?: string;
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
  /** How limits will be set when the rule is assigned to a fund. UNIFORM | RANK | NAMED. */
  limitMode: string;
  /** Other version metadata, preserved when a new version is saved. */
  versionMetadata?: Record<string, unknown> | null;
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
    limitMode: 'UNIFORM',
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

  const handleChange = (field: keyof ComplianceRuleFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  // Picking a measure also decides which entity the values are read from and
  // how that entity connects back to the one the rule applies to.
  const pickMeasure = (o: TreeAttributeOption | null) => {
    setFormData((prev) => {
      const base = o?.domainCode || prev.anchorDomainCode;
      const changed = base !== prev.baseDomainCode;
      return {
        ...prev,
        numeratorAttributeCode: o?.attributeCode || '',
        baseDomainCode: base,
        baseRollupPath: o ? reversePath(o.path) : [],
        ...(changed
          ? { groupByAttributeCode: '', groupByPath: [], conditions: prev.conditions.filter((c) => c.appliesTo !== 'BASE') }
          : {}),
      };
    });
    if (errors.numeratorAttributeCode) setErrors((prev) => ({ ...prev, numeratorAttributeCode: '' }));
  };

  // ---- Conditions helpers ----
  const addCondition = (appliesTo: 'BASE' | 'ANCHOR', group?: number) => {
    setFormData((prev) => {
      const scope = prev.conditions.filter((c) => c.appliesTo === appliesTo);
      const groups = scope.map((c) => c.conditionGroup || 1);
      const conditionGroup = group ?? (groups.length ? Math.max(...groups) : 1);
      const conditionOrder = scope.filter((c) => (c.conditionGroup || 1) === conditionGroup).length + 1;
      return { ...prev, conditions: [...prev.conditions, blankCondition(appliesTo, conditionGroup, conditionOrder)] };
    });
  };
  const replaceScope = (appliesTo: 'BASE' | 'ANCHOR', next: ComplianceCondition[]) => {
    setFormData((prev) => ({
      ...prev,
      conditions: [...prev.conditions.filter((c) => c.appliesTo !== appliesTo), ...next],
    }));
  };

  // ---- Layout state ----
  const [codeTouched, setCodeTouched] = useState(!!initial?.ruleCode);
  const [groupOn, setGroupOn] = useState(!!(initial?.groupByAttributeCode || initial?.groupByPath?.length));

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

  const toggleGroup = (on: boolean) => {
    setGroupOn(on);
    if (!on) setFormData((prev) => ({ ...prev, groupByPath: [], groupByAttributeCode: '', limitMode: 'UNIFORM' }));
  };

  const ERROR_SECTION: Record<string, string> = {
    ruleName: 'rb-rule',
    ruleCode: 'rb-rule',
    anchorDomainCode: 'rb-rule',
    baseDomainCode: 'rb-measure',
    numeratorAttributeCode: 'rb-measure',
    denominatorAttributeCode: 'rb-measure',
    denominatorConstantValue: 'rb-measure',
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!formData.ruleName) e.ruleName = 'Give the rule a name';
    if (!formData.ruleCode) e.ruleCode = 'Rule code is required';
    if (!formData.anchorDomainCode) e.anchorDomainCode = 'Choose what the rule applies to';
    if (!formData.baseDomainCode) e.baseDomainCode = 'Choose where values are read from';
    if (!formData.numeratorAttributeCode) e.numeratorAttributeCode = 'Choose the value to measure';
    if (formData.denominatorScope !== 'CONSTANT' && formData.denominatorScope !== 'NONE' && !formData.denominatorAttributeCode) {
      e.denominatorAttributeCode = 'Choose the value to compare against';
    }
    if (formData.denominatorScope === 'CONSTANT' && !formData.denominatorConstantValue) {
      e.denominatorConstantValue = 'Enter a number';
    }
    const badCondition = formData.conditions.some((c) => c.leftError || c.rightError);
    if (badCondition) e.conditions = 'Fix the highlighted condition';
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first) {
      const target = first === 'conditions' ? document.querySelector('[data-cond-error]') : document.getElementById(ERROR_SECTION[first]);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !first;
  };

  const handleSubmit = () => {
    if (validate()) onSubmit(formData);
  };

  const baseConditions = formData.conditions.filter((c) => c.appliesTo === 'BASE');
  const anchorConditions = formData.conditions.filter((c) => c.appliesTo === 'ANCHOR');

  const domainName = (code: string) => domains.find((d) => d.domainCode === code)?.domainName || code;
  const attrName = (list: AttributeOpt[], code: string) => list.find((a) => a.attributeCode === code)?.attributeName || code;
  const anchorLabel = domainName(formData.anchorDomainCode) || 'entity';
  const baseLabel = domainName(formData.baseDomainCode) || 'record';

  const summary = (() => {
    if (!formData.numeratorAttributeCode || !formData.anchorDomainCode) return '';
    const num = `${AGG_LABELS[formData.numeratorAggregation] || formData.numeratorAggregation} of ${attrName(baseAttributes, formData.numeratorAttributeCode)}`;
    const filters = baseConditions.filter((c) => c.attributeCode).length;
    let rel = '';
    if (formData.denominatorScope === 'CONSTANT') {
      rel = formData.denominatorConstantValue ? ` divided by ${formData.denominatorConstantValue}` : '';
    } else if (formData.denominatorScope !== 'NONE' && formData.denominatorAttributeCode) {
      const denList = formData.denominatorScope === 'ANCHOR' ? anchorAttributes : baseAttributes;
      const den = attrName(denList, formData.denominatorAttributeCode);
      rel = formData.denominatorScope === 'ANCHOR'
        ? ` as a share of the ${anchorLabel.toLowerCase()}'s ${den}`
        : ` as a share of ${formData.denominatorScope === 'SAME_GROUP' ? 'its group\'s' : 'total'} ${den}`;
    }
    const group = groupOn && formData.groupByAttributeCode ? `, for each ${formData.groupByAttributeCode.replace(/_/g, ' ').toLowerCase()}` : '';
    const dir = formData.limitDirection === 'MAX' ? 'above' : 'below';
    const parts = [`For each ${anchorLabel}: ${num}${filters ? ` (${filters} record filter${filters > 1 ? 's' : ''})` : ''}${rel}${group}.`];
    const limitNote = !groupOn || (formData.limitMode !== 'RANK' && formData.limitMode !== 'NAMED')
      ? `the limit set on each ${anchorLabel.toLowerCase()}`
      : formData.limitMode === 'RANK'
      ? `the limit for that rank, set on each ${anchorLabel.toLowerCase()}`
      : `the limit for that named group, set on each ${anchorLabel.toLowerCase()}`;
    parts.push(`Breach when ${dir} ${limitNote}.`);
    return parts.join(' ');
  })();

  const filterCount = baseConditions.filter((c) => c.attributeCode).length;

  const denominatorOptions = [
    { value: 'SAME_GROUP', label: 'Total of its group' },
    { value: 'ANCHOR_TOTAL', label: 'Total of all records' },
    { value: 'ANCHOR', label: `A value on the ${anchorLabel.toLowerCase()}` },
    { value: 'CONSTANT', label: 'Fixed number' },
    { value: 'NONE', label: 'No denominator' },
  ];
  const sharesRecords = formData.denominatorScope === 'SAME_GROUP' || formData.denominatorScope === 'ANCHOR_TOTAL';
  const needsDenominatorAttribute = formData.denominatorScope !== 'CONSTANT' && formData.denominatorScope !== 'NONE';
  const denEntity = formData.denominatorScope === 'ANCHOR' ? anchorLabel : baseLabel;
  const limitHelp = !groupOn
    ? 'One limit applies to the whole result. Limit values are set when the rule is assigned to a fund.'
    : formData.limitMode === 'RANK'
    ? 'A different limit applies by rank, for example the largest group at 15% and the rest at 10%. Ranks are set when the rule is assigned to a fund.'
    : formData.limitMode === 'NAMED'
    ? 'Each named group can have its own limit, for example Energy at 15%. Those limits are set when the rule is assigned to a fund.'
    : 'One limit applies to each group, for example no industry above 10%. Limit values are set when the rule is assigned to a fund.';

  return (
    <div className="rb">
      <section className="rb-block" id="rb-rule">
        <h2 className="rb-block-title">Rule</h2>
        <div className="rb-pad">
          <div className="rb-namegrid">
            <div className="field">
              <label htmlFor="rb-name">Name *</label>
              <input
                id="rb-name"
                className={`text-input ${errors.ruleName ? 'error' : ''}`}
                value={formData.ruleName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Industry concentration"
                autoFocus={!lockIdentity}
              />
              {errors.ruleName && <span className="field-error">{errors.ruleName}</span>}
              {formData.ruleCode && (
                <span className="field-hint rb-code">
                  Code: <span className="mono">{formData.ruleCode}</span>
                  {!lockIdentity && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const next = window.prompt('Rule code', formData.ruleCode);
                        if (next) {
                          setCodeTouched(true);
                          handleChange('ruleCode', next.toUpperCase().replace(/\s+/g, '_'));
                        }
                      }}
                    >
                      Edit code
                    </button>
                  )}
                </span>
              )}
              {errors.ruleCode && <span className="field-error">{errors.ruleCode}</span>}
            </div>
            <div className="field">
              <label htmlFor="rb-category">Category</label>
              <select id="rb-category" className="select" value={formData.ruleCategory} onChange={(e) => handleChange('ruleCategory', e.target.value)}>
                <option value="CONCENTRATION">Concentration</option>
                <option value="EXPOSURE">Exposure</option>
                <option value="DIVERSIFICATION">Diversification</option>
                <option value="ELIGIBILITY">Eligibility</option>
                <option value="LEVERAGE">Leverage</option>
                <option value="LIQUIDITY">Liquidity</option>
                <option value="FORTY_ACT">40 Act</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
          </div>
          <div className="field rb-anchor">
            <label htmlFor="rb-anchor">Applies to *</label>
            <select
              id="rb-anchor"
              className={`select ${errors.anchorDomainCode ? 'error' : ''}`}
              value={formData.anchorDomainCode}
              disabled={lockIdentity}
              onChange={(e) => handleAnchorChange(e.target.value)}
            >
              <option value="">Select what this rule is checked on...</option>
              {domains.map((d) => (
                <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
              ))}
            </select>
            {errors.anchorDomainCode && <span className="field-error">{errors.anchorDomainCode}</span>}
          </div>
          <div className="field">
            <label htmlFor="rb-description">Description</label>
            <textarea
              id="rb-description"
              className="text-input"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
              placeholder="Guideline language this rule enforces"
            />
          </div>
        </div>
      </section>

      <section className="rb-block" id="rb-measure">
        <h2 className="rb-block-title">Measure</h2>
        <div className={`rb-line ${filterCount ? 'top' : ''}`}>
          <div className="rb-line-label">Numerator</div>
          <div className="rb-sentence">
            <select
              className="select rb-agg"
              aria-label="Combine by"
              value={formData.numeratorAggregation}
              onChange={(e) => handleChange('numeratorAggregation', e.target.value)}
            >
              {AGGREGATIONS.filter((a) => a !== 'CONSTANT').map((a) => (
                <option key={a} value={a}>{AGG_LABELS[a] || a}</option>
              ))}
            </select>
            <span className="rb-of">of</span>
            <RelatedAttributePicker
              bare
              ownerLabel
              label="Numerator"
              rootDomainCode={formData.anchorDomainCode}
              relationshipTypes={relationshipTypes}
              domains={domains}
              isSelected={(o) => o.attributeCode === formData.numeratorAttributeCode && o.domainCode === (formData.baseDomainCode || formData.anchorDomainCode)}
              onSelect={pickMeasure}
              placeholder="Position · Market value"
              error={!!errors.numeratorAttributeCode}
            />
          </div>
        </div>
        <div className={`rb-line ${baseConditions.length ? 'top' : ''}`}>
          <div className="rb-line-label">Where</div>
          <div>
            {baseConditions.length === 0 ? (
              <div className="rb-sentence">
                <span className="rb-qualify">All records qualify</span>
                <button type="button" className="btn btn-sm" onClick={() => addCondition('BASE', 1)}>+ Add condition</button>
              </div>
            ) : (
              <ConditionGroup
                appliesTo="BASE"
                conditions={baseConditions}
                rootDomainCode={formData.baseDomainCode}
                domainLabel={baseLabel}
                relationshipTypes={relationshipTypes}
                domains={domains}
                onCommit={(next) => replaceScope('BASE', next)}
              />
            )}
          </div>
        </div>
        <div className="rb-line">
          <div className="rb-line-label">Divided by</div>
          <div className="rb-sentence">
            <select
              className="select rb-scope"
              aria-label="Divided by"
              value={formData.denominatorScope}
              onChange={(e) => handleChange('denominatorScope', e.target.value)}
            >
              {denominatorOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {formData.denominatorScope === 'CONSTANT' && (
              <span className="field" style={{ flex: '0 0 132px' }}>
                <input
                  className={`text-input mono ${errors.denominatorConstantValue ? 'error' : ''}`}
                  type="number"
                  aria-label="Fixed number"
                  value={formData.denominatorConstantValue}
                  onChange={(e) => handleChange('denominatorConstantValue', e.target.value)}
                  placeholder="Number"
                />
                {errors.denominatorConstantValue && <span className="field-error">{errors.denominatorConstantValue}</span>}
              </span>
            )}
            {needsDenominatorAttribute && (
              <>
                <span className="rb-of">{denEntity} ·</span>
                <AttributePicker
                  bare
                  label="Denominator"
                  value={formData.denominatorAttributeCode}
                  onChange={(code) => handleChange('denominatorAttributeCode', code)}
                  attributes={formData.denominatorScope === 'ANCHOR' ? anchorAttributes : baseAttributes}
                  placeholder="Market value"
                  error={!!errors.denominatorAttributeCode}
                />
              </>
            )}
          </div>
        </div>
        {sharesRecords && (
          <div className="rb-line">
            <div className="rb-line-label">Where</div>
            <div className="rb-sentence">
              <span className="rb-qualify">{filterCount === 0 ? 'All records qualify' : 'Same records as the numerator'}</span>
              <button type="button" className="btn btn-sm" onClick={() => addCondition('BASE')}>+ Add condition</button>
            </div>
          </div>
        )}
      </section>

      <section className="rb-block" id="rb-test">
        <h2 className="rb-block-title">Test &amp; limits</h2>
        <div className={`rb-line ${groupOn ? 'top' : ''}`}>
          <div className="rb-line-label">Group by</div>
          <div className="rb-sentence">
            <label className="rb-check">
              <input type="checkbox" checked={groupOn} onChange={(e) => toggleGroup(e.target.checked)} />
              Test each group separately
            </label>
            {groupOn && (
              <RelatedAttributePicker
                bare
                ownerLabel
                clearable
                label="Group by"
                rootDomainCode={formData.baseDomainCode}
                relationshipTypes={relationshipTypes}
                domains={domains}
                isSelected={(o) => o.attributeCode === formData.groupByAttributeCode && attributePathKey(o.path) === attributePathKey(formData.groupByPath)}
                onSelect={(o) =>
                  setFormData((prev) => ({
                    ...prev,
                    groupByAttributeCode: o?.attributeCode || '',
                    groupByPath: (o?.path || []).map((h) => ({ relationshipCode: h.relationshipCode, direction: h.direction, recursive: false })),
                  }))
                }
                placeholder="Issuer · Industry"
              />
            )}
          </div>
        </div>
        <div className="rb-line">
          <div className="rb-line-label">Breach when</div>
          <div className="rb-sentence">
            <Segmented
              value={formData.limitDirection}
              onChange={(v) => handleChange('limitDirection', v)}
              options={[
                { value: 'MAX', label: 'Above limit' },
                { value: 'MIN', label: 'Below limit' },
              ]}
            />
            <span className="rb-of">Show as</span>
            <select
              className="select rb-show"
              aria-label="Show as"
              value={formData.resultUnit}
              onChange={(e) => handleChange('resultUnit', e.target.value)}
            >
              <option value="PERCENTAGE">Percent of denominator</option>
              <option value="RATIO">Ratio</option>
              <option value="CURRENCY">Currency amount</option>
              <option value="COUNT">Count</option>
            </select>
          </div>
        </div>
        <div className="rb-line">
          <div className="rb-line-label">Limit type</div>
          <Segmented
            value={groupOn ? formData.limitMode : 'UNIFORM'}
            onChange={(v) => handleChange('limitMode', v)}
            disabled={groupOn ? undefined : ['RANK', 'NAMED']}
            options={[
              { value: 'UNIFORM', label: 'Same limit for every group' },
              { value: 'RANK', label: 'Limit by rank' },
              { value: 'NAMED', label: 'Limit by named group' },
            ]}
          />
        </div>
        <p className="rb-help">{limitHelp}</p>
        <details className="rb-def">
          <summary>View saved definition</summary>
          <div className="rb-def-body">
            <div className={summary ? 'rb-summary-text' : 'rb-summary-text empty'}>
              {summary || 'Choose what the rule applies to and what to measure. The definition reads here in plain language.'}
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="rb-source">Default source</label>
                <select
                  id="rb-source"
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
                <label htmlFor="rb-transform">Result calculation</label>
                <select
                  id="rb-transform"
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
              </div>
            </div>
            <DimensionPicker
              label="Measured value: source / period"
              value={formData.numeratorDimension}
              onChange={(d) => handleChange('numeratorDimension', d)}
            />
            {needsDenominatorAttribute && (
              <DimensionPicker
                label="Compared value: source / period"
                value={formData.denominatorDimension}
                onChange={(d) => handleChange('denominatorDimension', d)}
              />
            )}
            <div className="rb-sub-title">Only these {anchorLabel.toLowerCase()}s</div>
            <ConditionGroup
              appliesTo="ANCHOR"
              conditions={anchorConditions}
              rootDomainCode={formData.anchorDomainCode}
              domainLabel={anchorLabel}
              relationshipTypes={relationshipTypes}
              domains={domains}
              onCommit={(next) => replaceScope('ANCHOR', next)}
            />
            <div className="form-grid">
              <div className="field">
                <label htmlFor="rb-from">Effective from</label>
                <input
                  id="rb-from"
                  className="text-input mono"
                  type="date"
                  value={formData.validFrom}
                  onChange={(e) => handleChange('validFrom', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="rb-reason">Change reason</label>
                <input
                  id="rb-reason"
                  className="text-input"
                  value={formData.changeReason}
                  onChange={(e) => handleChange('changeReason', e.target.value)}
                  placeholder="Why this version was created"
                />
              </div>
              <div className="field">
                <label htmlFor="rb-coverage">Coverage</label>
                <select
                  id="rb-coverage"
                  className="select"
                  value={formData.appliesToAll ? 'all' : 'specific'}
                  onChange={(e) => handleChange('appliesToAll', e.target.value === 'all')}
                >
                  <option value="all">All entities of this type</option>
                  <option value="specific">Specific entities, assigned after saving</option>
                </select>
              </div>
            </div>
          </div>
        </details>
      </section>

      <div className="builder-footer rb-footer">
        <div className="left" />
        <div className="right">
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving...' : lockIdentity ? 'Save as new version' : initial?.ruleCode ? 'Save rule' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

const AGG_LABELS: Record<string, string> = {
  SUM: 'Sum',
  AVG: 'Average',
  COUNT: 'Count',
  MIN: 'Lowest',
  MAX: 'Highest',
  VALUE: 'Single value',
};

// The rule stores the path from the measured entity back up to the one the rule applies to.
function reversePath(path: Array<{ relationshipCode: string; direction: 'UP' | 'DOWN' }>): RollupHop[] {
  return [...path].reverse().map((h) => ({
    relationshipCode: h.relationshipCode,
    direction: h.direction === 'UP' ? 'DOWN' : 'UP',
    recursive: false,
  }));
}

function Segmented({
  value,
  onChange,
  options,
  small,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  small?: boolean;
  disabled?: string[];
}) {
  return (
    <div className={`rb-seg ${small ? 'small' : ''}`} role="radiogroup">
      {options.map((o) => {
        const off = disabled?.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? 'on' : ''}
            disabled={off}
            onClick={() => { if (!off) onChange(o.value); }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

interface ConditionCluster {
  id: string;
  rows: ComplianceCondition[];
}

const conditionKeys = new WeakMap<object, string>();

function conditionKey(condition: ComplianceCondition) {
  if (condition.key) return condition.key;
  let key = conditionKeys.get(condition);
  if (!key) {
    key = Math.random().toString(36).slice(2, 10);
    conditionKeys.set(condition, key);
  }
  return key;
}

function blankCondition(appliesTo: 'BASE' | 'ANCHOR', conditionGroup: number, conditionOrder: number): ComplianceCondition {
  return {
    key: Math.random().toString(36).slice(2, 10),
    appliesTo,
    conditionGroup,
    conditionOrder,
    attributeCode: '',
    attributePath: [],
    attributeDimension: emptyDimension(),
    operator: 'equals',
    value: '',
    compareAttributeCode: '',
    compareAttributePath: [],
    compareDimension: emptyDimension(),
    leftExpression: null,
    rightExpression: null,
    logicOperator: 'AND',
  };
}

function clusterConditions(conditions: ComplianceCondition[]): ConditionCluster[] {
  const ordered = [...conditions].sort((a, b) => (a.conditionGroup || 1) - (b.conditionGroup || 1) || a.conditionOrder - b.conditionOrder);
  const groups: ConditionCluster[] = [];
  for (const condition of ordered) {
    const id = `g${condition.conditionGroup || 1}`;
    let group = groups.find((item) => item.id === id);
    if (!group) {
      group = { id, rows: [] };
      groups.push(group);
    }
    group.rows.push({ ...condition, key: conditionKey(condition) });
  }
  return groups;
}

function packConditions(groups: ConditionCluster[], appliesTo: 'BASE' | 'ANCHOR'): ComplianceCondition[] {
  return groups.filter((group) => group.rows.length).flatMap((group, gi) => group.rows.map((row, index) => ({
    ...row,
    key: row.key || conditionKey(row),
    appliesTo,
    conditionGroup: gi + 1,
    conditionOrder: index + 1,
    logicOperator: index === 0 ? 'AND' : (row.logicOperator === 'OR' ? 'OR' : 'AND'),
  })));
}

function moveRow(rows: ComplianceCondition[], index: number, dir: number) {
  const next = index + dir;
  if (next < 0 || next >= rows.length) return;
  const joins = rows.map((row) => row.logicOperator);
  const [row] = rows.splice(index, 1);
  rows.splice(next, 0, row);
  rows.forEach((item, i) => { item.logicOperator = i === 0 ? 'AND' : joins[i]; });
}

function groupStory(rows: ComplianceCondition[]) {
  if (rows.length < 2) return { title: 'Match this', hint: 'This line must be true.' };
  const joins = rows.slice(1).map((row) => row.logicOperator);
  if (joins.every((join) => join !== 'OR')) return { title: 'Match all', hint: 'Every line in this group must be true.' };
  if (joins.every((join) => join === 'OR')) return { title: 'Match any', hint: 'Any line in this group can be true.' };
  return { title: 'Match in order', hint: 'Each line joins the ones above it, from the top.' };
}

function ConditionGroup({
  appliesTo,
  conditions,
  rootDomainCode,
  domainLabel,
  relationshipTypes,
  domains,
  onCommit,
}: {
  appliesTo: 'BASE' | 'ANCHOR';
  conditions: ComplianceCondition[];
  rootDomainCode: string;
  domainLabel: string;
  relationshipTypes: RelationshipTypeOpt[];
  domains: Domain[];
  onCommit: (next: ComplianceCondition[]) => void;
}) {
  const { options, loading } = useRelationshipAttributes(rootDomainCode, relationshipTypes, domains);
  const ctx = useMemo<OperandContext>(() => ({ fields: options, relationshipTypes }), [options, relationshipTypes]);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const groups = useMemo(() => clusterConditions(conditions), [conditions]);
  const leftPatch = (text: string) => {
    const r = applyLeftText(text, ctx);
    return { leftError: r.error, attributeCode: r.attributeCode, attributePath: r.attributePath, leftExpression: r.leftExpression };
  };
  const rightPatch = (text: string, operator: string) => {
    const r = applyRightText(text, operator, ctx);
    return {
      rightError: r.error,
      value: r.value,
      compareAttributeCode: r.compareAttributeCode,
      compareAttributePath: r.compareAttributePath,
      rightExpression: r.rightExpression,
    };
  };
  const commit = (next: ConditionCluster[]) => onCommit(packConditions(next, appliesTo));
  const edit = (mutate: (draft: ConditionCluster[]) => void) => {
    const draft = groups.map((group) => ({ id: group.id, rows: group.rows.map((row) => ({ ...row })) }));
    mutate(draft);
    commit(draft.filter((group) => group.rows.length > 0));
  };
  const dropOn = (targetGroupId: string, beforeKey: string | null) => {
    if (!dragKey || dragKey === beforeKey) return;
    edit((draft) => {
      let from: ConditionCluster | null = null;
      let fromIndex = -1;
      for (const group of draft) {
        const at = group.rows.findIndex((row) => row.key === dragKey);
        if (at >= 0) { from = group; fromIndex = at; }
      }
      if (!from || fromIndex < 0) return;
      const dest = draft.find((group) => group.id === targetGroupId);
      if (!dest) return;
      const sameGroup = from === dest;
      const joins = sameGroup ? from.rows.map((row) => row.logicOperator) : null;
      const [moving] = from.rows.splice(fromIndex, 1);
      const index = beforeKey ? dest.rows.findIndex((row) => row.key === beforeKey) : dest.rows.length;
      dest.rows.splice(index < 0 ? dest.rows.length : index, 0, { ...moving, logicOperator: 'AND' });
      if (joins) dest.rows.forEach((row, i) => { row.logicOperator = i === 0 ? 'AND' : joins[i]; });
    });
    setDragKey(null);
    setOverKey(null);
  };

  if (!groups.length) {
    return (
      <div className="cg">
        <div className="rb-sentence">
          <span className="rb-qualify">All records qualify</span>
          <button type="button" className="btn btn-sm" onClick={() => onCommit([blankCondition(appliesTo, 1, 1)])}>+ Add condition</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cg">
      {groups.length > 1 && (
        <p className="cg-note">A record qualifies when any one of these groups matches.</p>
      )}
      {groups.map((group, gi) => {
        const story = groupStory(group.rows);
        return (
          <div key={group.id}>
            {gi > 0 && <div className="cg-or">or</div>}
            <section
              className={`cg-card ${overKey === group.id ? 'over' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setOverKey(group.id); }}
              onDragLeave={() => setOverKey((current) => current === group.id ? null : current)}
              onDrop={(event) => { event.preventDefault(); dropOn(group.id, null); }}
            >
              <header className="cg-head">
                <strong>{story.title}</strong>
                <span>{story.hint}</span>
              </header>
              <div className="cg-body">
                {group.rows.map((cond, ri) => (
                  <div key={cond.key}>
                    {ri > 0 && (
                      <div className="cg-join">
                        <button
                          type="button"
                          className={`cg-op ${cond.logicOperator === 'OR' ? 'or' : ''}`}
                          onClick={() => edit((draft) => {
                            const row = draft[gi].rows[ri];
                            draft[gi].rows[ri] = { ...row, logicOperator: row.logicOperator === 'OR' ? 'AND' : 'OR' };
                          })}
                        >
                          {cond.logicOperator === 'OR' ? 'or' : 'and'}
                        </button>
                      </div>
                    )}
                    <div
                      className={`cg-row ${dragKey === cond.key ? 'drag' : ''} ${overKey === cond.key ? 'over' : ''}`}
                      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setOverKey(cond.key || null); }}
                      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropOn(group.id, cond.key || null); }}
                    >
                      <button
                        type="button"
                        className="cg-grip"
                        draggable
                        aria-label="Drag to another place in the group"
                        title="Drag to reorder or move into another group"
                        onDragStart={(event) => {
                          event.dataTransfer.setData('text/plain', cond.key || '');
                          event.dataTransfer.effectAllowed = 'move';
                          setDragKey(cond.key || null);
                        }}
                        onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                      >
                        ⋮⋮
                      </button>
                      <div className="cg-fields">
                        <ExpressionBox
                          value={cond.leftText ?? leftTextOf(cond, ctx)}
                          onChange={(text) => edit((draft) => { draft[gi].rows[ri] = { ...draft[gi].rows[ri], leftText: text, ...leftPatch(text) }; })}
                          context={ctx}
                          loading={loading}
                          disabled={!rootDomainCode}
                          placeholder={rootDomainCode ? 'Pick a field, or type an expression' : 'Choose an entity type first'}
                          error={cond.leftError}
                        />
                        <select
                          className="select"
                          aria-label="Operator"
                          value={cond.operator}
                          onChange={(event) => edit((draft) => {
                            const row = draft[gi].rows[ri];
                            draft[gi].rows[ri] = { ...row, operator: event.target.value, ...rightPatch(row.rightText ?? rightTextOf(row, ctx), event.target.value) };
                          })}
                        >
                          {OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
                        </select>
                        {cond.operator !== 'is_null' && cond.operator !== 'is_not_null' && (
                          <ExpressionBox
                            value={cond.rightText ?? rightTextOf(cond, ctx)}
                            onChange={(text) => edit((draft) => {
                              const row = draft[gi].rows[ri];
                              draft[gi].rows[ri] = { ...row, rightText: text, ...rightPatch(text, row.operator) };
                            })}
                            context={ctx}
                            loading={loading}
                            plain={cond.operator === 'in' || cond.operator === 'not_in'}
                            placeholder={cond.operator === 'in' || cond.operator === 'not_in' ? 'US, GB' : "A value like 1.5 or 'US', a field, or an expression"}
                            error={cond.rightError}
                          />
                        )}
                        <button type="button" className="cond-remove" aria-label="Remove condition" onClick={() => edit((draft) => { draft[gi].rows.splice(ri, 1); })}>✕</button>
                      </div>
                      <div className="cg-tools">
                        {group.rows.length > 1 && (
                          <>
                            <button type="button" className="btn btn-sm" disabled={ri === 0} onClick={() => edit((draft) => moveRow(draft[gi].rows, ri, -1))}>Move up</button>
                            <button type="button" className="btn btn-sm" disabled={ri === group.rows.length - 1} onClick={() => edit((draft) => moveRow(draft[gi].rows, ri, 1))}>Move down</button>
                            <button type="button" className="btn btn-sm" onClick={() => edit((draft) => {
                              const [row] = draft[gi].rows.splice(ri, 1);
                              draft.push({ id: `new-${row.key}`, rows: [{ ...row, logicOperator: 'AND' }] });
                            })}>Own group</button>
                          </>
                        )}
                        {groups.length > 1 && (
                          <select
                            className="select"
                            aria-label="Move to group"
                            value={group.id}
                            onChange={(event) => edit((draft) => {
                              const dest = draft.find((item) => item.id === event.target.value);
                              if (!dest || dest.id === group.id) return;
                              const [row] = draft[gi].rows.splice(ri, 1);
                              dest.rows.push({ ...row, logicOperator: 'AND' });
                            })}
                          >
                            <option value={group.id}>This group</option>
                            {groups.map((item, index) => item.id === group.id ? null : (
                              <option key={item.id} value={item.id}>Move to group {index + 1}</option>
                          ))}
                        </select>
                        )}
                      </div>
                      <details className="cg-dim">
                        <summary>Where these values are read</summary>
                        <DimensionPicker
                          compact
                          label="This attribute read from"
                          value={cond.attributeDimension}
                          onChange={(dimension) => edit((draft) => { draft[gi].rows[ri] = { ...draft[gi].rows[ri], attributeDimension: dimension }; })}
                        />
                        {cond.compareAttributeCode && cond.compareAttributeCode !== '__PICK__' && (
                          <DimensionPicker
                            compact
                            label={`${cond.compareAttributeCode} read from`}
                            value={cond.compareDimension}
                            onChange={(dimension) => edit((draft) => { draft[gi].rows[ri] = { ...draft[gi].rows[ri], compareDimension: dimension }; })}
                          />
                        )}
                      </details>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cg-actions">
                <button type="button" className="btn btn-sm" onClick={() => edit((draft) => { draft[gi].rows.push(blankCondition(appliesTo, gi + 1, draft[gi].rows.length + 1)); })}>+ Add to this group</button>
              </div>
            </section>
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" onClick={() => edit((draft) => { draft.push({ id: `new-${draft.length}`, rows: [blankCondition(appliesTo, draft.length + 1, 1)] }); })}>+ Add another group</button>
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
  if (c.rightExpression) return undefined;
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
    defaultSourceScope: data.defaultSourceScope,
    metadata: {
      ...(data.versionMetadata || {}),
      limitMode: data.groupByAttributeCode ? data.limitMode || 'UNIFORM' : 'UNIFORM',
    },
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
        leftExpression: c.leftExpression || undefined,
        rightExpression: c.rightExpression || undefined,
        compareAttributeCode: c.compareAttributeCode && c.compareAttributeCode !== '__PICK__' ? c.compareAttributeCode : undefined,
        compareDimension: c.compareAttributeCode && c.compareAttributeCode !== '__PICK__' ? dimensionToInput(c.compareDimension, c.compareAttributePath) : undefined,
        logicOperator: c.logicOperator,
      })),
  };
}