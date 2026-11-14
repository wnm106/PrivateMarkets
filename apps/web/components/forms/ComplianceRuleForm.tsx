'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  graphqlQuery,
  DOMAIN_TYPES_QUERY,
  RELATIONSHIP_TYPES_QUERY,
  ATTRIBUTE_REGISTER_QUERY,
} from '@/lib/graphql';
import { RelatedAttributePicker, useRelationshipAttributes, attributePathKey, type TreeAttributeOption } from './ComplianceAttributeSelect';
import { LeftOperand, RightOperand } from './ConditionOperands';
import {
  applyLeftText,
  applyRightText,
  leftTextOf,
  rightTextOf,
  type Expr,
  type OperandContext,
  applyMeasureText,
  refKey,
  type PathHop,
  measureTextOf,
} from '@/lib/condition-expression';
import { usePopulationPreview } from './CompliancePopulationPreview';
import { ConditionBuilder, OPERATOR_LABELS, blankCondition } from './ConditionBuilder';
import { alignPathToPicker, columnsFromMeasureLines, domainAfterPath, sameAttributeRoute, stripCompositeMetadata } from '@/lib/measure-lines';

export interface RollupHop {
  relationshipCode: string;
  direction: 'UP' | 'DOWN';
  recursive: boolean;
}

export type ConditionScope = 'BASE' | 'ANCHOR' | 'LINE';

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
  appliesTo: ConditionScope;
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

export type MeasureSide = 'NUMERATOR' | 'DENOMINATOR' | 'LIMIT';

export interface MeasureLineForm {
  key: string;
  side: MeasureSide;
  label: string;
  kind: string;
  sign: 1 | -1;
  attributeCode: string;
  dimension: DimensionState;
  fieldText?: string;
  fieldError?: string;
  expression?: any;
  path: RollupHop[];
  weightAttributeCode: string;
  valuePath: RollupHop[];
  transform: string;
  priceAttributeCode: string;
  pct: string;
  pctAttributeCode: string;
  pctPath: RollupHop[];
  totalPath: RollupHop[];
  required: boolean;
  conditions: ComplianceCondition[];
  totalConditions: ComplianceCondition[];
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
  measureLines: MeasureLineForm[];
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

export { OPERATOR_LABELS };
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
    limitMode: 'UNIFORM',
    softLimitValue: '',
    hardLimitValue: '',
    hardLimitAttributeCode: '',
    softLimitFactor: '',
    defaultSourceScope: 'GOLDEN',
    conditions: [],
    measureLines: [],
  };
}

interface ComplianceRuleFormProps {
  initial?: Partial<ComplianceRuleFormData>;
  lockIdentity?: boolean; // true when authoring a new version of an existing rule
  onSubmit: (data: ComplianceRuleFormData) => void;
  onCancel: () => void;
  submitting?: boolean;
  /** Runs the saved rule as of today. The button sits in the summary bar. */
  onTest?: () => void;
  testing?: boolean;
  testDisabled?: boolean;
  /** Rule name and details, shown at the top of the summary ribbon so they stay in view. */
  ribbonHeader?: React.ReactNode;
}

export function ComplianceRuleForm({ initial, lockIdentity, onSubmit, onCancel, submitting, onTest, testing, testDisabled, ribbonHeader }: ComplianceRuleFormProps) {
  const [formData, setFormData] = useState<ComplianceRuleFormData>({
    ...defaultFormData(),
    ...initial,
    measureLines: initial?.measureLines || [],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [domains, setDomains] = useState<Domain[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<RelationshipTypeOpt[]>([]);
  const [baseAttributes, setBaseAttributes] = useState<AttributeOpt[]>([]);
  const [anchorAttributes, setAnchorAttributes] = useState<AttributeOpt[]>([]);
  // The single-amount layout reads its numerator and denominator the same way a line does.
  const numFields = useRelationshipAttributes(formData.anchorDomainCode, relationshipTypes, domains);
  const numCtx = useMemo<OperandContext>(() => ({ fields: numFields.options, relationshipTypes }), [numFields.options, relationshipTypes]);
  const denDomain = formData.denominatorScope === 'ANCHOR' ? formData.anchorDomainCode : (formData.baseDomainCode || formData.anchorDomainCode);
  const denFields = useRelationshipAttributes(denDomain, relationshipTypes, domains);
  const denCtx = useMemo<OperandContext>(() => ({ fields: denFields.options, relationshipTypes }), [denFields.options, relationshipTypes]);
  const [numText, setNumText] = useState<string | null>(null);
  const [numError, setNumError] = useState('');
  const [denText, setDenText] = useState<string | null>(null);
  const [denError, setDenError] = useState('');

  useEffect(() => {
    graphqlQuery<{ domainTypes: Domain[] }, {}>(DOMAIN_TYPES_QUERY, {}).then((r) => {
      if (r.data?.domainTypes) setDomains(r.data.domainTypes);
    });
    graphqlQuery<{ relationshipTypes: RelationshipTypeOpt[] }, {}>(RELATIONSHIP_TYPES_QUERY, {}).then((r) => {
      if (r.data?.relationshipTypes) setRelationshipTypes(r.data.relationshipTypes);
    });
  }, []);

  // Stored hops can point the opposite way from the picker. Line them up so each
  // filter shows the field it actually reads.
  useEffect(() => {
    if (!relationshipTypes.length) return;
    setFormData((prev) => {
      if (!prev.anchorDomainCode || !prev.measureLines.length) return prev;
      let changed = false;
      const measureLines = prev.measureLines.map((line) => {
        const path = alignPathToPicker(prev.anchorDomainCode, line.path, relationshipTypes);
        const entity = domainAfterPath(prev.anchorDomainCode, path, relationshipTypes);
        const alignConditions = (list: ComplianceCondition[]) => list.map((condition) => {
          const attributePath = alignPathToPicker(entity, condition.attributePath || [], relationshipTypes);
          const compareAttributePath = alignPathToPicker(entity, condition.compareAttributePath || [], relationshipTypes);
          if (attributePathKey(attributePath) !== attributePathKey(condition.attributePath) || attributePathKey(compareAttributePath) !== attributePathKey(condition.compareAttributePath)) changed = true;
          return { ...condition, attributePath, compareAttributePath };
        });
        const valuePath = alignPathToPicker(entity, line.valuePath, relationshipTypes);
        const pctPath = alignPathToPicker(prev.anchorDomainCode, line.pctPath, relationshipTypes);
        const totalPath = alignPathToPicker(prev.anchorDomainCode, line.totalPath, relationshipTypes);
        if (attributePathKey(path) !== attributePathKey(line.path)) changed = true;
        if (attributePathKey(valuePath) !== attributePathKey(line.valuePath)) changed = true;
        if (attributePathKey(pctPath) !== attributePathKey(line.pctPath)) changed = true;
        if (attributePathKey(totalPath) !== attributePathKey(line.totalPath)) changed = true;
        return {
          ...line,
          path,
          valuePath,
          pctPath,
          totalPath,
          conditions: alignConditions(line.conditions),
          totalConditions: alignConditions(line.totalConditions),
        };
      });
      return changed ? { ...prev, measureLines } : prev;
    });
  }, [relationshipTypes]);

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

  const onNumeratorText = (text: string) => {
    setNumText(text);
    const r = applyMeasureText(text, numCtx);
    const bad = r.error || (r.expression ? 'A formula needs the amounts layout. Choose Add another amount' : '');
    setNumError(bad);
    if (bad) return;
    handleChange('numeratorDimension', r.dimension);
    if (!r.attributeCode) { pickMeasure(null); return; }
    const option = numCtx.fields.find((f) => f.valueKey === refKey(r.path, r.attributeCode)) as TreeAttributeOption | undefined;
    if (option) pickMeasure(option);
    else setNumError(`Unknown field ${r.attributeCode}`);
  };
  const onDenominatorText = (text: string) => {
    setDenText(text);
    const r = applyMeasureText(text, denCtx);
    const bad = r.error || (r.expression ? 'A formula needs the amounts layout. Choose Add another amount' : r.path.length ? 'Use a field on the record itself' : '');
    setDenError(bad);
    if (bad) return;
    handleChange('denominatorDimension', r.dimension);
    handleChange('denominatorAttributeCode', r.attributeCode);
  };

  // ---- Conditions helpers ----
  const addCondition = (appliesTo: ConditionScope, group?: number) => {
    setFormData((prev) => {
      const scope = prev.conditions.filter((c) => c.appliesTo === appliesTo);
      const groups = scope.map((c) => c.conditionGroup || 1);
      const conditionGroup = group ?? (groups.length ? Math.max(...groups) : 1);
      const conditionOrder = scope.filter((c) => (c.conditionGroup || 1) === conditionGroup).length + 1;
      return { ...prev, conditions: [...prev.conditions, blankCondition(appliesTo, conditionGroup, conditionOrder)] };
    });
  };
  const replaceScope = (appliesTo: ConditionScope, next: ComplianceCondition[]) => {
    setFormData((prev) => ({
      ...prev,
      conditions: [...prev.conditions.filter((c) => c.appliesTo !== appliesTo), ...next],
    }));
  };

  const patchLine = (key: string, patch: Partial<MeasureLineForm>) => {
    setFormData((prev) => ({
      ...prev,
      measureLines: prev.measureLines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  };
  const removeLine = (key: string) => {
    setFormData((prev) => ({ ...prev, measureLines: prev.measureLines.filter((line) => line.key !== key) }));
  };
  const addMeasureLine = (side: MeasureSide, seed?: Partial<MeasureLineForm>) => {
    setFormData((prev) => ({
      ...prev,
      measureLines: [...prev.measureLines, { ...blankMeasureLine(side), ...seed, side, key: Math.random().toString(36).slice(2, 10) }],
    }));
  };
  // A second amount cannot share one numerator. The current measure becomes line 1,
  // and a denominator that used every record stays a line with no filters of its own.
  const promoteAmounts = (addBlank = true) => {
    setFormData((prev) => {
      if (prev.measureLines.some((line) => line.side === 'NUMERATOR')) {
        return { ...prev, measureLines: [...prev.measureLines, blankMeasureLine('NUMERATOR')] };
      }
      const filters = prev.conditions
        .filter((condition) => condition.appliesTo === 'BASE')
        .map((condition) => ({ ...condition, appliesTo: 'LINE' as const, key: Math.random().toString(36).slice(2, 10) }));
      const first: MeasureLineForm = {
        ...blankMeasureLine('NUMERATOR'),
        label: 'Numerator',
        kind: prev.numeratorAggregation === 'CONSTANT' ? 'SUM' : prev.numeratorAggregation,
        attributeCode: prev.numeratorAttributeCode,
        path: prev.baseRollupPath,
        conditions: filters,
      };
      const lines: MeasureLineForm[] = addBlank ? [first, blankMeasureLine('NUMERATOR')] : [first];
      if (prev.denominatorScope !== 'NONE' && prev.denominatorScope !== 'CONSTANT' && prev.denominatorAttributeCode) {
        lines.push({
          ...blankMeasureLine('DENOMINATOR'),
          label: 'Denominator',
          kind: prev.denominatorAggregation && prev.denominatorAggregation !== 'CONSTANT' ? prev.denominatorAggregation : 'SUM',
          attributeCode: prev.denominatorAttributeCode,
          path: prev.denominatorScope === 'ANCHOR' ? [] : prev.baseRollupPath,
          conditions: prev.denominatorScope === 'ANCHOR_TOTAL'
            ? []
            : filters.map((condition) => ({ ...condition, key: Math.random().toString(36).slice(2, 10) })),
        });
      }
      return { ...prev, measureLines: lines, conditions: prev.conditions.filter((condition) => condition.appliesTo !== 'BASE') };
    });
  };
  const useDifferentRecords = () => {
    setFormData((prev) => {
      const source = prev.measureLines.find((line) => line.side === 'NUMERATOR');
      return {
        ...prev,
        measureLines: [
          ...prev.measureLines,
          {
            ...blankMeasureLine('DENOMINATOR'),
            label: 'Denominator',
            attributeCode: source?.attributeCode || prev.denominatorAttributeCode,
            path: source?.path?.length ? source.path : prev.baseRollupPath,
          },
        ],
      };
    });
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
    const numeratorLines = formData.measureLines.filter((line) => line.side === 'NUMERATOR');
    const denominatorLines = formData.measureLines.filter((line) => line.side === 'DENOMINATOR');
    if (numeratorLines.length) {
      if (!numeratorLines.some((line) => line.attributeCode)) e.numeratorAttributeCode = 'Choose the value to measure';
      if (denominatorLines.some((line) => line.kind !== 'COUNT' && !line.attributeCode)) e.denominatorAttributeCode = 'Choose the value to compare against';
    } else if (!formData.numeratorAttributeCode) e.numeratorAttributeCode = 'Choose the value to measure';
    if (!numeratorLines.length && formData.denominatorScope !== 'CONSTANT' && formData.denominatorScope !== 'NONE' && !formData.denominatorAttributeCode) {
      e.denominatorAttributeCode = 'Choose the value to compare against';
    }
    if (!numeratorLines.length && formData.denominatorScope === 'CONSTANT' && !formData.denominatorConstantValue) {
      e.denominatorConstantValue = 'Enter a number';
    }
    const badCondition = formData.conditions.some((c) => c.leftError || c.rightError)
      || formData.measureLines.some((line) => [...line.conditions, ...line.totalConditions].some((c) => c.leftError || c.rightError));
    if (badCondition) e.conditions = 'Fix the highlighted condition';
    if (formData.measureLines.some((line) => line.expression && !FORMULA_KINDS.has(line.kind))) e.numeratorAttributeCode = 'A formula works with Sum, Count, Min, Max, Average or Value';
    if (numError || denError || formData.measureLines.some((line) => line.fieldError)) e.numeratorAttributeCode = e.numeratorAttributeCode || 'Fix the highlighted amount';
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
  const numeratorLines = formData.measureLines.filter((line) => line.side === 'NUMERATOR');
  const denominatorLines = formData.measureLines.filter((line) => line.side === 'DENOMINATOR');
  const limitLines = formData.measureLines.filter((line) => line.side === 'LIMIT');
  const usesLines = numeratorLines.length > 0;

  const domainName = (code: string) => domains.find((d) => d.domainCode === code)?.domainName || code;
  const attrName = (list: AttributeOpt[], code: string) => list.find((a) => a.attributeCode === code)?.attributeName || code;
  const anchorLabel = domainName(formData.anchorDomainCode) || 'entity';
  const baseLabel = domainName(formData.baseDomainCode) || 'record';

  const { options: treeOptions } = useRelationshipAttributes(formData.anchorDomainCode, relationshipTypes, domains);
  // Group-by paths run from the measured record, not from the entity the rule applies to.
  const { options: baseTree } = useRelationshipAttributes(formData.baseDomainCode, relationshipTypes, domains);
  // Name a field the way the pickers show it: "Issuer · Industry".
  const fieldLabel = (code: string, path: Array<{ relationshipCode: string; direction: string }>, domainCode: string) => {
    const hit = domainCode
      ? treeOptions.find((o) => o.attributeCode === code && o.domainCode === domainCode)
      : baseTree.find((o) => o.attributeCode === code && attributePathKey(o.path) === attributePathKey(path as any));
    if (!hit) return code.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
    const owner = hit.groupLabel.split(" › ").pop() || hit.groupLabel;
    return hit.attributeName.toLowerCase().startsWith(owner.toLowerCase()) ? hit.attributeName : `${owner} · ${hit.attributeName}`;
  };

  const filterCount = baseConditions.filter((c) => c.attributeCode).length;

  // One readable line per scope: conditions in a group are ANDed, groups are ORed.
  const describeCondition = (c: ComplianceCondition) => {
    const domain = c.appliesTo === 'ANCHOR' ? formData.anchorDomainCode : formData.baseDomainCode;
    const left = c.leftText || (c.attributeCode ? fieldLabel(c.attributeCode, c.attributePath, domain) : '');
    if (!left) return '';
    const op = OPERATOR_LABELS[c.operator as keyof typeof OPERATOR_LABELS] || c.operator;
    if (c.operator === 'is_null' || c.operator === 'is_not_null') return `${left} ${op}`;
    const right = c.rightText || (c.compareAttributeCode ? fieldLabel(c.compareAttributeCode, c.compareAttributePath, domain) : c.value);
    return `${left} ${op} ${right || '…'}`;
  };
  const describeScope = (list: ComplianceCondition[]) => {
    const groups = new Map<number, string[]>();
    for (const c of [...list].sort((a, b) => (a.conditionGroup || 1) - (b.conditionGroup || 1) || a.conditionOrder - b.conditionOrder)) {
      const text = describeCondition(c);
      if (!text) continue;
      groups.set(c.conditionGroup || 1, [...(groups.get(c.conditionGroup || 1) || []), text]);
    }
    return [...groups.values()].map((g) => g.join(' and ')).join(' or ');
  };
  const lineConditionText = (line: MeasureLineForm) => describeScope(line.conditions.filter((condition) => condition.attributeCode || condition.leftText));
  // Record filters are the rows on each amount. A fund-level check is separate:
  // it decides which funds are tested, and it is edited under Advanced settings.
  const recordFilterLines = (usesLines
    ? formData.measureLines.map((line) => ({ label: line.label || line.side, text: lineConditionText(line) }))
    : [{ label: `${baseLabel} records`, text: describeScope(baseConditions) }]
  ).filter((line) => line.text);
  const recordFilterCount = (usesLines
    ? formData.measureLines.flatMap((line) => line.conditions)
    : baseConditions
  ).filter((c) => c.attributeCode || c.leftText).length;

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
  const limitSubject = anchorLabel.toLowerCase();
  const limitHelp = !groupOn
    ? `One limit applies to the whole result. Each ${limitSubject} sets that limit as a minimum or a maximum.`
    : formData.limitMode === 'RANK'
    ? `A different limit applies by rank, for example the largest group at 15% and the rest at 10%. Each ${limitSubject} sets those limits as a minimum or a maximum.`
    : formData.limitMode === 'NAMED'
    ? `Each named group can have its own limit, for example Energy at 15%. Each ${limitSubject} sets those limits as a minimum or a maximum.`
    : `One limit applies to each group. Each ${limitSubject} sets that limit as a minimum or a maximum.`;

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const lineTitle = (line: MeasureLineForm) => {
    const kind = MEASURE_KINDS.find((item) => item.value === line.kind)?.label || line.kind;
    if (!line.attributeCode) return line.label || '';
    const owner = domainAfterPath(formData.anchorDomainCode, line.path, relationshipTypes);
    return `${line.sign < 0 ? 'Minus ' : ''}${kind} of ${fieldLabel(line.attributeCode, line.path, owner || formData.anchorDomainCode)}`;
  };
  const hasNum = usesLines ? numeratorLines.some((line) => line.attributeCode) : !!formData.numeratorAttributeCode;
  const isRatio = usesLines ? denominatorLines.length > 0 : formData.denominatorScope !== 'NONE';
  const denReady = usesLines
    ? denominatorLines.every((line) => line.kind === 'COUNT' || !!line.attributeCode)
    : formData.denominatorScope === 'CONSTANT' ? !!formData.denominatorConstantValue : !needsDenominatorAttribute || !!formData.denominatorAttributeCode;
  const denTitle = (() => {
    if (usesLines) return denominatorLines.map((line) => lineTitle(line) || line.label).filter(Boolean).join(', ');
    if (formData.denominatorScope === 'CONSTANT') return formData.denominatorConstantValue ? `Fixed number ${formData.denominatorConstantValue}` : '';
    if (formData.denominatorScope === 'NONE') return '';
    if (!formData.denominatorAttributeCode) return '';
    const n = fieldLabel(formData.denominatorAttributeCode, [], formData.denominatorScope === 'ANCHOR' ? formData.anchorDomainCode : formData.baseDomainCode);
    return n;
  })();
  const numTitle = usesLines
    ? numeratorLines.map((line) => lineTitle(line) || line.label).filter(Boolean).join(', ')
    : hasNum ? `${AGG_LABELS[formData.numeratorAggregation] || formData.numeratorAggregation} of ${fieldLabel(formData.numeratorAttributeCode, [], formData.baseDomainCode)}` : '';
  const groupTitle = groupOn && formData.groupByAttributeCode ? fieldLabel(formData.groupByAttributeCode, formData.groupByPath, '') : '';
  const formulaReady = hasNum && denReady && (!groupOn || !!groupTitle);

  return (
    <div className="rb">
      <aside className={`rf-card ${onTest ? 'has-test' : ''}`} aria-label="How this rule works">
        {ribbonHeader && <div className="rf-ribbon-head">{ribbonHeader}</div>}
        <div className="rf-head">
          <span className="rf-title">How this rule works</span>
          <span className={`rf-status ${formulaReady ? 'ready' : ''}`}>{formulaReady ? 'Complete' : 'Still being defined'}</span>
        </div>
        <div className="rf-formula">
          {usesLines ? numeratorLines.map((line, index) => (
            <span key={line.key} style={{ display: 'contents' }}>
              {index > 0 && <span className="rf-op" aria-hidden>{line.sign < 0 ? '−' : '+'}</span>}
              <button type="button" className="rf-term num" onClick={() => jump('rb-measure')}>
                <span className="rf-k">{line.label || 'Numerator'}</span>
                <span className={`rf-v ${line.attributeCode ? '' : 'rf-empty'}`}>{lineTitle(line) || 'Not chosen yet'}</span>
                <span className="rf-s">{lineConditionText(line) || 'All records'}</span>
              </button>
            </span>
          )) : (
            <button type="button" className="rf-term num" onClick={() => jump('rb-measure')}>
              <span className="rf-k">Numerator</span>
              <span className={`rf-v ${numTitle ? '' : 'rf-empty'}`}>{numTitle || 'Not chosen yet'}</span>
              <span className="rf-s">{filterCount ? `${filterCount} condition${filterCount > 1 ? 's' : ''} apply` : 'All records'}</span>
            </button>
          )}
          {usesLines ? denominatorLines.length > 0 && (
            <>
              <span className="rf-op" aria-hidden>÷</span>
              {denominatorLines.map((line, index) => (
                <span key={line.key} style={{ display: 'contents' }}>
                  {index > 0 && <span className="rf-op" aria-hidden>{line.sign < 0 ? '−' : '+'}</span>}
                  <button type="button" className="rf-term den" onClick={() => jump('rb-compare')}>
                    <span className="rf-k">{line.label || 'Denominator'}</span>
                    <span className={`rf-v ${line.attributeCode ? '' : 'rf-empty'}`}>{lineTitle(line) || 'Not chosen yet'}</span>
                    <span className="rf-s">{lineConditionText(line) || 'All records'}</span>
                  </button>
                </span>
              ))}
            </>
          ) : isRatio && (
            <>
              <span className="rf-op" aria-hidden>÷</span>
              <button type="button" className="rf-term den" onClick={() => jump('rb-compare')}>
                <span className="rf-k">Denominator</span>
                <span className={`rf-v ${denTitle ? '' : 'rf-empty'}`}>{denTitle || 'Not chosen yet'}</span>
                <span className="rf-s">{formData.denominatorScope === 'ANCHOR' ? `Taken from the ${limitSubject}` : formData.denominatorScope === 'CONSTANT' ? 'Same for every result' : formData.denominatorScope === 'SAME_GROUP' ? 'Within each group' : `Across all ${baseLabel.toLowerCase()} records`}</span>
              </button>
            </>
          )}
          <span className="rf-op" aria-hidden>{groupOn ? 'for each' : '→'}</span>
          {groupOn ? (
            <button type="button" className="rf-term grp" onClick={() => jump('rb-group')}>
              <span className="rf-k">Group</span>
              <span className={`rf-v ${groupTitle ? '' : 'rf-empty'}`}>{groupTitle || 'Not chosen yet'}</span>
              <span className="rf-s">One result per group</span>
            </button>
          ) : (
            <button type="button" className="rf-term grp" onClick={() => jump('rb-group')}>
              <span className="rf-k">Group</span>
              <span className="rf-v">None</span>
              <span className="rf-s">One result per {limitSubject}</span>
            </button>
          )}
          <span className="rf-op" aria-hidden>→</span>
          <button type="button" className="rf-term lim" onClick={() => jump('rb-limit')}>
            <span className="rf-k">Limits</span>
            <span className="rf-v">{!groupOn || formData.limitMode === 'UNIFORM' ? (groupOn ? 'Same for every group' : 'One limit') : formData.limitMode === 'RANK' ? 'By rank' : 'By named group'}</span>
            <span className="rf-s">{!groupOn ? 'Set on each fund' : formData.limitMode === 'RANK' ? 'Each rank, largest group first, has its own limit' : formData.limitMode === 'NAMED' ? 'Each named group has its own limit' : 'Set on each fund'}</span>
          </button>
          <span className="rf-op" aria-hidden>→</span>
          <button type="button" className="rf-term flt" onClick={() => jump('rb-measure')}>
            <span className="rf-k">Filters</span>
            <span className={`rf-v ${recordFilterCount ? '' : 'rf-empty'}`}>{recordFilterCount ? `${recordFilterCount} condition${recordFilterCount > 1 ? 's' : ''}` : 'None'}</span>
            <span className="rf-s">{recordFilterLines.length ? recordFilterLines.map((line) => line.text).join(' · ') : 'Every record counts'}</span>
          </button>
        </div>
        {onTest && (
          <button type="button" className="btn btn-primary rf-test" onClick={onTest} disabled={testing || testDisabled} title="Runs the saved rule as of today">
            {testing ? 'Testing…' : 'Test rule'}
          </button>
        )}
      </aside>

      <section className="rb-step tone-id" id="rb-rule">
        <StepHead n={1} title="About this rule" hint="Name it and say what it is checked on" />
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
            </div>
            <div className="field">
              <label htmlFor="rb-code">Code</label>
              <input
                id="rb-code"
                className={`text-input mono ${errors.ruleCode ? 'error' : ''}`}
                value={formData.ruleCode}
                disabled={lockIdentity}
                onChange={(e) => {
                  setCodeTouched(true);
                  handleChange('ruleCode', e.target.value.toUpperCase().replace(/\s+/g, '_'));
                }}
              />
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
                <option value="COVERAGE">Coverage</option>
                <option value="COLLATERAL_QUALITY">Collateral quality</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="rb-anchor">Applies to *</label>
              <select
                id="rb-anchor"
                className={`select ${errors.anchorDomainCode ? 'error' : ''}`}
                value={formData.anchorDomainCode}
                disabled={lockIdentity}
                onChange={(e) => handleAnchorChange(e.target.value)}
              >
                <option value="">Select...</option>
                {domains.map((d) => (
                  <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
                ))}
              </select>
              {errors.anchorDomainCode && <span className="field-error">{errors.anchorDomainCode}</span>}
            </div>
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
            />
          </div>
        </div>
      </section>

      <section className="rb-step tone-num" id="rb-measure">
        <StepHead n={2} title="Numerator" hint="What are we measuring?" tone="num" />
        <div className="rb-body2">
          {usesLines ? (
            <>
              {numeratorLines.map((line, index) => (
                <MeasureLineEditor
                  key={line.key}
                  line={line}
                  index={index}
                  anchorDomainCode={formData.anchorDomainCode}
                  relationshipTypes={relationshipTypes}
                  domains={domains}
                  onChange={(patch) => patchLine(line.key, patch)}
                  onRemove={numeratorLines.length > 1 ? () => removeLine(line.key) : undefined}
                />
              ))}
              <button type="button" className="btn btn-sm" onClick={() => addMeasureLine('NUMERATOR')}>Add another amount</button>
            </>
          ) : (
            <>
              <div className="rb-ask">Measure this value on each record</div>
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
                <LeftOperand
                  text={numText ?? measureTextOf(formData.numeratorAttributeCode, reversePath(formData.baseRollupPath), formData.numeratorDimension, numCtx)}
                  onChange={onNumeratorText}
                  ctx={numCtx}
                  loading={numFields.loading}
                  disabled={!formData.anchorDomainCode}
                  error={numError || errors.numeratorAttributeCode}
                  quiet
                />
              </div>
              <div className="rb-ask" style={{ marginTop: 16 }}>Only count records that match</div>
              <div>
                {baseConditions.length === 0 ? (
                  <div className="rb-sentence">
                    <span className="rb-qualify">Every record counts.</span>
                    <button type="button" className="btn btn-sm" onClick={() => addCondition('BASE', 1)}>+ Add a condition</button>
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
              <button type="button" className="btn btn-sm" onClick={() => promoteAmounts()}>Add another amount</button>
            </>
          )}
        </div>
      </section>

      <section className="rb-step tone-den" id="rb-compare">
        <StepHead n={3} title="Denominator" hint="What is the measure compared against?" tone="den" />
        <div className="rb-body2">
          {usesLines ? (
            <>
              {denominatorLines.length === 0 ? (
                <p className="rb-note">No division. The result is the numerator on its own.</p>
              ) : (
                denominatorLines.map((line, index) => (
                  <MeasureLineEditor
                    key={line.key}
                    line={line}
                    index={index}
                    anchorDomainCode={formData.anchorDomainCode}
                    relationshipTypes={relationshipTypes}
                    domains={domains}
                    onChange={(patch) => patchLine(line.key, patch)}
                    onRemove={() => removeLine(line.key)}
                  />
                ))
              )}
              <div className="rb-sentence">
                <button type="button" className="btn btn-sm" onClick={() => addMeasureLine('DENOMINATOR', { label: 'Denominator' })}>Add a denominator amount</button>
                {denominatorLines.length === 0 && (
                  <button type="button" className="btn btn-sm" onClick={useDifferentRecords}>Use a different set of records</button>
                )}
              </div>
              <p className="rb-note">Each denominator amount chooses its own records. Leave its conditions empty to count every record of that amount.</p>
            </>
          ) : (
          <>
          <Tiles
            value={formData.denominatorScope}
            onChange={(v) => handleChange('denominatorScope', v)}
            options={[
              { value: 'ANCHOR_TOTAL', label: `All ${baseLabel.toLowerCase()} records`, hint: `Share of the whole ${limitSubject}. Ignores grouping, so each group is a slice of the total.` },
              { value: 'ANCHOR', label: `A value on the ${limitSubject}`, hint: `Share of one figure held on the ${limitSubject}, such as its net asset value.` },
              { value: 'SAME_GROUP', label: 'Records in the same group', hint: 'Compare against the same measure for just that group.' },
              { value: 'CONSTANT', label: 'A fixed number', hint: 'Divide by a number you type, the same for everyone.' },
              { value: 'NONE', label: 'No division', hint: 'Test the measured figure itself, such as a count or an amount.' },
            ]}
          />
          {(formData.denominatorScope === 'CONSTANT' || needsDenominatorAttribute) && (
            <div className="rb-sentence" style={{ marginTop: 12 }}>
              {formData.denominatorScope === 'CONSTANT' && (
                <span className="field" style={{ flex: '0 0 160px' }}>
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
                  <span className="rb-of">Use the {formData.denominatorScope === 'ANCHOR' ? anchorLabel : baseLabel} field</span>
                  <LeftOperand
                    text={denText ?? measureTextOf(formData.denominatorAttributeCode, [], formData.denominatorDimension, denCtx)}
                    onChange={onDenominatorText}
                    ctx={denCtx}
                    loading={denFields.loading}
                    error={denError || errors.denominatorAttributeCode}
                    quiet
                  />
                </>
              )}
            </div>
          )}
          {needsDenominatorAttribute && (
            <div className="rb-sentence" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-sm" onClick={() => promoteAmounts(false)}>Choose the denominator's own records</button>
              <span className="rb-qualify">Opens the same conditions builder the numerator uses.</span>
            </div>
          )}
          {sharesRecords && (
            <p className="rb-note">
              {filterCount === 0
                ? 'Every record is included in the denominator.'
                : 'The conditions from step 2 apply to the denominator as well, so both sides use the same records.'}
            </p>
          )}
          </>
          )}
        </div>
      </section>

      <section className="rb-step tone-grp" id="rb-group">
        <StepHead n={4} title="Groups" hint="Test the whole set, or each group on its own?" tone="grp" />
        <div className="rb-body2">
          <Tiles
            value={groupOn ? 'GROUP' : 'ONE'}
            onChange={(v) => toggleGroup(v === 'GROUP')}
            options={[
              { value: 'ONE', label: `One result per ${limitSubject}`, hint: 'The whole set is tested against a single limit.' },
              { value: 'GROUP', label: 'Test each group separately', hint: 'For example each industry, issuer or country gets its own result and limit check.' },
            ]}
          />
          {groupOn && (
            <div className="rb-sentence" style={{ marginTop: 12 }}>
              <span className="rb-of">Group by</span>
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
            </div>
          )}
        </div>
      </section>

      <section className="rb-step tone-lim" id="rb-limit">
        <StepHead n={5} title="Limits" hint="Each fund sets a minimum or a maximum. How do those limits vary?" tone="lim" />
        <div className="rb-body2">
          <div className="rb-ask">Limits</div>
          <Tiles
            value={groupOn ? formData.limitMode : 'UNIFORM'}
            onChange={(v) => handleChange('limitMode', v)}
            disabled={groupOn ? undefined : ['RANK', 'NAMED']}
            options={[
              { value: 'UNIFORM', label: groupOn ? 'Same limit for every group' : 'One limit', hint: groupOn ? 'The same number for every group.' : 'A single limit on the result.' },
              { value: 'RANK', label: 'Limit by rank', hint: groupOn ? 'The largest group may reach 15%, the rest 10%.' : 'Needs grouping (step 4).' },
              { value: 'NAMED', label: 'Limit by named group', hint: groupOn ? 'Energy may reach 15%, others 10%.' : 'Needs grouping (step 4).' },
            ]}
          />
          <p className="rb-note">{limitHelp}</p>
        </div>
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

const MEASURE_KINDS: Array<{ value: string; label: string }> = [
  { value: 'SUM', label: 'Sum' },
  { value: 'COUNT', label: 'Count' },
  { value: 'AVG', label: 'Average' },
  { value: 'MIN', label: 'Lowest' },
  { value: 'MAX', label: 'Highest' },
  { value: 'VALUE', label: 'Single value' },
  { value: 'WAVG', label: 'Weighted average' },
  { value: 'EXCESS_OVER_PCT', label: 'Excess over a percent' },
];

const FORMULA_KINDS = new Set(['SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'VALUE']);

function blankMeasureLine(side: MeasureSide): MeasureLineForm {
  return {
    key: Math.random().toString(36).slice(2, 10),
    side,
    label: side === 'DENOMINATOR' ? 'Denominator' : side === 'LIMIT' ? 'Limit' : 'Amount',
    kind: side === 'LIMIT' ? 'MAX' : 'SUM',
    sign: 1,
    attributeCode: '',
    dimension: emptyDimension(),
    path: [],
    weightAttributeCode: '',
    valuePath: [],
    transform: '',
    priceAttributeCode: '',
    pct: '',
    pctAttributeCode: '',
    pctPath: [],
    totalPath: [],
    required: false,
    conditions: [],
    totalConditions: [],
  };
}

function MeasureLineEditor({
  line,
  index,
  anchorDomainCode,
  relationshipTypes,
  domains,
  onChange,
  onRemove,
}: {
  line: MeasureLineForm;
  index?: number;
  anchorDomainCode: string;
  relationshipTypes: RelationshipTypeOpt[];
  domains: Domain[];
  onChange: (patch: Partial<MeasureLineForm>) => void;
  onRemove?: () => void;
}) {
  const entityDomain = domainAfterPath(anchorDomainCode, line.path, relationshipTypes) || anchorDomainCode;
  const matches = (code: string, path: Array<{ relationshipCode: string; direction: string }>) => (option: TreeAttributeOption) =>
    option.attributeCode === code && sameAttributeRoute(option.path, path);
  const sideName = line.side === 'DENOMINATOR' ? 'Denominator' : line.side === 'LIMIT' ? 'Limit' : 'Amount';
  const lineFields = useRelationshipAttributes(anchorDomainCode, relationshipTypes, domains);
  const lineCtx = useMemo<OperandContext>(() => ({ fields: lineFields.options, relationshipTypes }), [lineFields.options, relationshipTypes]);
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
      <div className="rb-sentence">
        {line.side !== 'LIMIT' && index != null && index > 0 && (
          <select className="select" aria-label="Add or subtract" value={line.sign} onChange={(e) => onChange({ sign: e.target.value === '-1' ? -1 : 1 })}>
            <option value={1}>Add</option>
            <option value={-1}>Subtract</option>
          </select>
        )}
        <select className="select" aria-label="Combine by" value={line.kind} onChange={(e) => onChange({ kind: e.target.value })}>
          {(line.side === 'LIMIT' ? MEASURE_KINDS.filter((kind) => kind.value === 'MAX' || kind.value === 'MIN' || kind.value === 'VALUE') : MEASURE_KINDS).map((kind) => (
            <option key={kind.value} value={kind.value}>{kind.label}</option>
          ))}
        </select>
        <span className="rb-of">of</span>
        <LeftOperand
          text={line.fieldText ?? measureTextOf(line.attributeCode, line.path as PathHop[], line.dimension, lineCtx, line.expression)}
          onChange={(text) => {
            const r = applyMeasureText(text, lineCtx);
            onChange({
              fieldText: text,
              fieldError: r.error || (r.expression && !FORMULA_KINDS.has(line.kind) ? 'A formula works with Sum, Count, Min, Max, Average or Value' : undefined),
              expression: r.expression,
              attributeCode: r.attributeCode,
              path: r.path.map((hop) => ({ relationshipCode: hop.relationshipCode, direction: hop.direction, recursive: false })),
              dimension: r.dimension,
            });
          }}
          ctx={lineCtx}
          loading={lineFields.loading}
          disabled={!anchorDomainCode}
          error={line.fieldError}
          quiet
        />
        <span className="rb-of">Alias</span>
        <input className="text-input" aria-label="Alias" value={line.label} onChange={(e) => onChange({ label: e.target.value })} placeholder={sideName} style={{ flex: '0 0 200px', width: 200 }} />
        {onRemove && <button type="button" className="btn btn-sm" onClick={onRemove}>Remove</button>}
      </div>
      {line.kind === 'WAVG' && (
        <>
          <div className="rb-ask">Weight each record by</div>
          <RelatedAttributePicker
            bare
            ownerLabel
            label="Weight"
            rootDomainCode={entityDomain}
            relationshipTypes={relationshipTypes}
            domains={domains}
            isSelected={(option) => option.attributeCode === line.weightAttributeCode && option.path.length === 0}
            onSelect={(option) => onChange({ weightAttributeCode: option?.attributeCode || '' })}
            placeholder="Funded par"
          />
          <div className="rb-ask">The value being averaged</div>
          <RelatedAttributePicker
            bare
            ownerLabel
            label="Averaged value"
            rootDomainCode={entityDomain}
            relationshipTypes={relationshipTypes}
            domains={domains}
            isSelected={matches(line.attributeCode, line.valuePath)}
            onSelect={(option) => onChange({
              attributeCode: option?.attributeCode || line.attributeCode,
              valuePath: (option?.path || []).map((hop) => ({ relationshipCode: hop.relationshipCode, direction: hop.direction, recursive: false })),
            })}
            placeholder="Rating factor"
          />
          <div className="rb-sentence">
            <span className="rb-of">Turn a date into</span>
            <select className="select" aria-label="Date transform" value={line.transform} onChange={(e) => onChange({ transform: e.target.value })}>
              <option value="">The number itself</option>
              <option value="YEARS_TO_DATE">Years until that date</option>
            </select>
          </div>
        </>
      )}
      {line.kind === 'EXCESS_OVER_PCT' && (
        <>
          <div className="rb-sentence">
            <span className="rb-of">Percent</span>
            <input className="text-input mono" type="number" aria-label="Percent" value={line.pct} onChange={(e) => onChange({ pct: e.target.value })} placeholder="7.5" style={{ maxWidth: 120 }} />
            <span className="rb-of">or read it from</span>
            <RelatedAttributePicker
              bare
              ownerLabel
              label="Percent field"
              rootDomainCode={anchorDomainCode}
              relationshipTypes={relationshipTypes}
              domains={domains}
              isSelected={matches(line.pctAttributeCode, line.pctPath)}
              onSelect={(option) => onChange({
                pctAttributeCode: option?.attributeCode || '',
                pctPath: (option?.path || []).map((hop) => ({ relationshipCode: hop.relationshipCode, direction: hop.direction, recursive: false })),
              })}
              placeholder="Max CCC percent"
            />
          </div>
          <div className="rb-sentence">
            <span className="rb-of">Haircut the excess by the price</span>
            <RelatedAttributePicker
              bare
              ownerLabel
              label="Price"
              rootDomainCode={entityDomain}
              relationshipTypes={relationshipTypes}
              domains={domains}
              isSelected={(option) => option.attributeCode === line.priceAttributeCode && option.path.length === 0}
              onSelect={(option) => onChange({ priceAttributeCode: option?.attributeCode || '' })}
              placeholder="Price"
              clearable
            />
          </div>
          <div className="rb-ask">The total these are a percent of matches</div>
          {line.totalConditions.length === 0 ? (
            <div className="rb-sentence">
              <span className="rb-qualify">The same records, with no extra filter.</span>
              <button type="button" className="btn btn-sm" onClick={() => onChange({ totalConditions: [blankCondition('LINE', 1, 1)] })}>Add a condition</button>
            </div>
          ) : (
            <ConditionGroup
              appliesTo="LINE"
              conditions={line.totalConditions}
              rootDomainCode={entityDomain}
              domainLabel="record"
              relationshipTypes={relationshipTypes}
              domains={domains}
              onCommit={(next) => onChange({ totalConditions: next })}
            />
          )}
        </>
      )}
      {line.side !== 'LIMIT' && (
        <>
          <div className="rb-ask" style={{ marginTop: 16 }}>Only count records that match</div>
          {line.conditions.length === 0 ? (
            <div className="rb-sentence">
              <span className="rb-qualify">Every record counts.</span>
              <button type="button" className="btn btn-sm" onClick={() => onChange({ conditions: [blankCondition('LINE', 1, 1)] })}>Add a condition</button>
            </div>
          ) : (
            <ConditionGroup
              appliesTo="LINE"
              conditions={line.conditions}
              rootDomainCode={entityDomain}
              domainLabel="record"
              relationshipTypes={relationshipTypes}
              domains={domains}
              onCommit={(next) => onChange({ conditions: next })}
            />
          )}
        </>
      )}
    </div>
  );
}

// The rule stores the path from the measured entity back up to the one the rule applies to.
function reversePath(path: Array<{ relationshipCode: string; direction: 'UP' | 'DOWN' }>): RollupHop[] {
  return [...path].reverse().map((h) => ({
    relationshipCode: h.relationshipCode,
    direction: h.direction === 'UP' ? 'DOWN' : 'UP',
    recursive: false,
  }));
}

export function StepHead({ n, title, hint, tone }: { n: number; title: string; hint: string; tone?: string }) {
  return (
    <header className={`rb-stephead ${tone || "id"}`}>
      <span className="rb-stepnum">{n}</span>
      <span className="rb-steptitle">{title}</span>
      <span className="rb-stephint">{hint}</span>
    </header>
  );
}

export function Tiles({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; hint?: string }>;
  disabled?: string[];
}) {
  return (
    <div className="rb-tiles" role="radiogroup">
      {options.map((o) => {
        const off = disabled?.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={`rb-tile ${value === o.value ? "on" : ""}`}
            disabled={off}
            onClick={() => { if (!off) onChange(o.value); }}
          >
            <span className="rb-tile-radio" aria-hidden />
            <span className="rb-tile-label">{o.label}</span>
            {o.hint && <span className="rb-tile-hint">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
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

function ConditionGroup({
  appliesTo,
  conditions,
  rootDomainCode,
  domainLabel,
  relationshipTypes,
  domains,
  onCommit,
}: {
  appliesTo: ConditionScope;
  conditions: ComplianceCondition[];
  rootDomainCode: string;
  domainLabel: string;
  relationshipTypes: RelationshipTypeOpt[];
  domains: Domain[];
  onCommit: (next: ComplianceCondition[]) => void;
}) {
  const { options, loading } = useRelationshipAttributes(rootDomainCode, relationshipTypes, domains);
  const ctx = useMemo<OperandContext>(() => ({ fields: options, relationshipTypes }), [options, relationshipTypes]);
  const preview = usePopulationPreview({ domainCode: rootDomainCode, domainLabel, conditions, options });
  return (
    <ConditionBuilder
      appliesTo={appliesTo}
      conditions={conditions}
      ctx={ctx}
      loading={loading}
      disabled={!rootDomainCode}
      preview={preview}
      onCommit={onCommit}
    />
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
  const lines = data.measureLines || [];
  const columns = lines.some((line) => line.side === 'NUMERATOR') ? columnsFromMeasureLines(lines) : null;
  const packLineConditions = (list: ComplianceCondition[]) =>
    list.filter((condition) => condition.attributeCode).map((condition, index) => ({
      appliesTo: 'LINE' as const,
      conditionGroup: 1,
      conditionOrder: index + 1,
      attributeCode: condition.attributeCode,
      attributeDimension: dimensionToInput(condition.attributeDimension, condition.attributePath),
      operator: condition.operator,
      value: normalizeConditionValue(condition),
      leftExpression: condition.leftExpression || undefined,
      rightExpression: condition.rightExpression || undefined,
      compareAttributeCode: condition.compareAttributeCode && condition.compareAttributeCode !== '__PICK__' ? condition.compareAttributeCode : undefined,
      compareDimension: condition.compareAttributeCode && condition.compareAttributeCode !== '__PICK__' ? dimensionToInput(condition.compareDimension, condition.compareAttributePath) : undefined,
      logicOperator: condition.logicOperator,
    }));
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
    numeratorAttributeCode: columns?.numeratorAttributeCode || data.numeratorAttributeCode,
    numeratorAggregation: columns?.numeratorAggregation || data.numeratorAggregation,
    numeratorDimension: dimensionToInput(data.numeratorDimension),
    denominatorDimension: isConst || noRatio ? undefined : dimensionToInput(data.denominatorDimension),
    resultTransform: data.resultTransform,
    denominatorAttributeCode: columns ? (columns.denominatorAttributeCode || undefined) : isConst || noRatio ? undefined : data.denominatorAttributeCode || undefined,
    denominatorAggregation: columns ? (columns.hasDenominator ? 'SUM' : undefined) : isConst || noRatio ? undefined : data.denominatorAggregation,
    denominatorScope: columns ? (columns.hasDenominator ? 'ANCHOR_TOTAL' : 'SAME_GROUP') : anchorDen || noRatio ? 'SAME_GROUP' : data.denominatorScope,
    denominatorSource: anchorDen ? 'ANCHOR' : 'BASE',
    denominatorConstantValue: data.denominatorConstantValue ? parseFloat(data.denominatorConstantValue) : undefined,
    resultUnit: data.resultUnit,
    defaultSourceScope: data.defaultSourceScope,
    metadata: {
      ...(columns ? stripCompositeMetadata(data.versionMetadata) : (data.versionMetadata || {})),
      limitMode: data.groupByAttributeCode ? data.limitMode || 'UNIFORM' : 'UNIFORM',
    },
    measureLines: columns ? lines.map((line) => ({
      side: line.side,
      label: line.label || undefined,
      kind: line.kind,
      sign: line.sign,
      attributeCode: line.attributeCode || undefined,
      expression: line.expression || undefined,
      dimension: dimensionToInput(line.dimension),
      path: cleanHops(line.path),
      weightAttributeCode: line.weightAttributeCode || undefined,
      valuePath: cleanHops(line.valuePath),
      transform: line.transform || undefined,
      priceAttributeCode: line.priceAttributeCode || undefined,
      pct: line.pct ? parseFloat(line.pct) : undefined,
      pctAttributeCode: line.pctAttributeCode || undefined,
      pctPath: cleanHops(line.pctPath),
      totalPath: cleanHops(line.totalPath),
      // A denominator with no value cannot score the test, so it is always required.
      required: line.side === 'DENOMINATOR' || undefined,
      conditions: packLineConditions(line.conditions),
      totalConditions: packLineConditions(line.totalConditions),
    })) : undefined,
    conditions: data.conditions
      .filter((c) => c.attributeCode && c.appliesTo !== 'ANCHOR')
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