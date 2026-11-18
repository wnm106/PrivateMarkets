'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ATTRIBUTE_REGISTER_QUERY,
  DOMAIN_TYPES_QUERY,
  graphqlQuery,
} from '@/lib/graphql';
import { DqConditionBuilder } from '@/components/quality/DqConditionBuilder';
import { useDqRulePreview } from '@/components/quality/DqRulePreview';
import { columnsFromExpression, dqOperandContext } from '@/lib/dq-conditions';
import { StepHead } from './ComplianceRuleForm';
import { describeRule, parseExpression } from '@/lib/dq-expression';

export interface DqRuleFormData {
  ruleCode: string;
  ruleName: string;
  domainCode: string;
  attributeCode: string;
  ruleType: string;
  severity: string;
  ruleExpression: string;
  ruleDescription: string;
  isActive: boolean;
}

interface DomainOption {
  domainCode: string;
  domainName: string;
}

interface AttributeOption {
  attributeCode: string;
  attributeName: string;
  domainCode: string | null;
  dataType: string | null;
}

export const DQ_RULE_TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'COMPLETENESS', label: 'Completeness', hint: 'A required value is present.' },
  { value: 'VALIDITY', label: 'Validity', hint: 'A value has the right format or range.' },
  { value: 'CONSISTENCY', label: 'Consistency', hint: 'Values agree with each other.' },
  { value: 'TIMELINESS', label: 'Timeliness', hint: 'A value is recent enough.' },
  { value: 'UNIQUENESS', label: 'Uniqueness', hint: 'A value is not duplicated.' },
];

export const DQ_SEVERITIES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'CRITICAL', label: 'Critical', hint: 'Blocks use of the record.' },
  { value: 'HIGH', label: 'High', hint: 'Fix as soon as possible.' },
  { value: 'MEDIUM', label: 'Medium', hint: 'Review in the normal course.' },
  { value: 'LOW', label: 'Low', hint: 'Informational.' },
];

const EMPTY: DqRuleFormData = {
  ruleCode: '',
  ruleName: '',
  domainCode: '',
  attributeCode: '',
  ruleType: 'VALIDITY',
  severity: 'HIGH',
  ruleExpression: '',
  ruleDescription: '',
  isActive: true,
};

const toCode = (name: string) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

interface DqRuleFormProps {
  initial?: Partial<DqRuleFormData>;
  /** True when editing an existing rule: the code cannot change. */
  lockIdentity?: boolean;
  onSubmit: (data: DqRuleFormData) => void;
  onCancel: () => void;
  submitting?: boolean;
  error?: string | null;
  ribbonHeader?: React.ReactNode;
  /** Reports the live form so the page can describe it to the assistant. */
  onChange?: (data: DqRuleFormData) => void;
}

export function DqRuleForm({ initial, lockIdentity, onSubmit, onCancel, submitting, error, ribbonHeader, onChange }: DqRuleFormProps) {
  const [form, setForm] = useState<DqRuleFormData>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expressionIssue, setExpressionIssue] = useState<string | null>(null);
  const [codeTouched, setCodeTouched] = useState(!!initial?.ruleCode);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [attributes, setAttributes] = useState<AttributeOption[]>([]);
  // Conditions are checked against the field list, so they wait for it.
  const [catalogReady, setCatalogReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      graphqlQuery<{ domainTypes: DomainOption[] }, {}>(DOMAIN_TYPES_QUERY, {}).then((r) => {
        if (!cancelled && r.data?.domainTypes) setDomains(r.data.domainTypes);
      }),
      graphqlQuery<{ attributeRegister: AttributeOption[] }, {}>(ATTRIBUTE_REGISTER_QUERY, {}).then((r) => {
        if (!cancelled && r.data?.attributeRegister) setAttributes(r.data.attributeRegister);
      }),
    ]).then(() => {
      if (!cancelled) setCatalogReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { onChange?.(form); }, [form]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (next: Partial<DqRuleFormData>) => {
    setForm((prev) => ({ ...prev, ...next }));
    setErrors((prev) => {
      const copy = { ...prev };
      for (const key of Object.keys(next)) delete copy[key];
      return copy;
    });
  };

  const attributeChoices = useMemo(
    () => attributes.filter((attribute) => !form.domainCode || attribute.domainCode === form.domainCode),
    [attributes, form.domainCode],
  );
  const nameFor = (code: string) => attributes.find((attribute) => attribute.attributeCode === code)?.attributeName || code;
  const domainName = (code: string) => domains.find((domain) => domain.domainCode === code)?.domainName || code;

  // The attribute a rule is filed under is the first one its conditions read.
  const checkedAttribute = useMemo(() => columnsFromExpression(form.ruleExpression)[0] || '', [form.ruleExpression]);

  const operandFields = useMemo(() => dqOperandContext(attributeChoices, domainName).fields, [attributeChoices, domains]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useDqRulePreview({
    domainCode: form.domainCode,
    domainLabel: form.domainCode ? domainName(form.domainCode) : '',
    attributeCode: checkedAttribute,
    expression: form.ruleExpression,
    issue: expressionIssue,
    columns: useMemo(() => columnsFromExpression(form.ruleExpression), [form.ruleExpression]),
    fields: operandFields,
  });

  const parsed = parseExpression(form.ruleExpression);
  const conditionText = !form.ruleExpression.trim()
    ? ''
    : parsed.raw ? 'Custom expression' : describeRule(parsed.clauses, nameFor);
  const conditionCount = parsed.raw ? (form.ruleExpression.trim() ? 1 : 0) : parsed.clauses.filter((clause) => clause.attribute).length;
  const typeLabel = DQ_RULE_TYPES.find((type) => type.value === form.ruleType)?.label || form.ruleType;
  const severityLabel = DQ_SEVERITIES.find((severity) => severity.value === form.severity)?.label || form.severity;
  const ready = !!form.ruleName.trim() && !!form.ruleCode.trim() && !!form.ruleExpression.trim() && !expressionIssue;

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.ruleName.trim()) e.ruleName = 'Give the rule a name';
    if (!form.ruleCode.trim()) e.ruleCode = 'Rule code is required';
    if (!form.ruleExpression.trim()) e.ruleExpression = 'Add at least one condition';
    else if (expressionIssue) e.ruleExpression = expressionIssue;
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first) {
      const section = first === 'ruleExpression' ? 'rb-conditions' : 'rb-rule';
      document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !first;
  };

  const submit = () => {
    if (validate()) onSubmit({ ...form, attributeCode: checkedAttribute, ruleName: form.ruleName.trim(), ruleExpression: form.ruleExpression.trim(), ruleDescription: form.ruleDescription.trim() });
  };

  return (
    <div className="rb">
      <aside className="rf-card has-test" aria-label="How this rule works">
        {ribbonHeader && <div className="rf-ribbon-head">{ribbonHeader}</div>}
        <div className="rf-head">
          <span className="rf-title">How this rule works</span>
          <span className={`rf-status ${ready ? 'ready' : ''}`}>{ready ? 'Complete' : 'Still being defined'}</span>
        </div>
        <div className="rf-formula">
          <button type="button" className="rf-term grp" onClick={() => jump('rb-conditions')}>
            <span className="rf-k">Checks</span>
            <span className="rf-v">{checkedAttribute ? nameFor(checkedAttribute) : 'Not chosen yet'}</span>
            <span className="rf-s">{form.domainCode ? domainName(form.domainCode) : 'All domains'}</span>
          </button>
          <span className="rf-op" aria-hidden>→</span>
          <button type="button" className="rf-term num" onClick={() => jump('rb-conditions')}>
            <span className="rf-k">A record passes when</span>
            <span className={`rf-v ${conditionText ? '' : 'rf-empty'}`}>{conditionText || 'Not defined yet'}</span>
            <span className="rf-s">{conditionCount ? `${conditionCount} condition${conditionCount > 1 ? 's' : ''}` : 'No conditions'}</span>
          </button>
          <span className="rf-op" aria-hidden>→</span>
          <button type="button" className="rf-term den" onClick={() => jump('rb-rule')}>
            <span className="rf-k">Type</span>
            <span className="rf-v">{typeLabel}</span>
            <span className="rf-s">{form.isActive ? 'Active' : 'Inactive'}</span>
          </button>
          <span className="rf-op" aria-hidden>→</span>
          <button type="button" className="rf-term lim" onClick={() => jump('rb-rule')}>
            <span className="rf-k">Failure severity</span>
            <span className="rf-v">{severityLabel}</span>
            <span className="rf-s">Raised when a record fails</span>
          </button>
        </div>
        <button
          type="button"
          className="btn btn-primary rf-test"
          onClick={preview.run}
          disabled={!preview.ready || preview.loading}
          title={preview.ready ? 'Runs this rule on current records without saving it' : 'Finish the conditions first'}
        >
          {preview.loading ? 'Testing…' : 'Test rule'}
        </button>
      </aside>

      {(preview.isOpen || preview.loading) && preview.isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Test results"
          onClick={preview.close}
          style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3vh 16px', overflow: 'hidden' }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 20px 50px rgba(15, 23, 42, 0.3)', width: 'min(1100px, 100%)', maxHeight: '94vh', display: 'flex', flexDirection: 'column', padding: '18px 22px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div className="section-kicker">Test results · {form.ruleName || 'New rule'}</div>
                <div className="field-hint" style={{ marginTop: 4 }}>Run as of today on current records, as it is written now. Nothing is saved.</div>
              </div>
              <button type="button" className="btn btn-sm" aria-label="Close test results" onClick={preview.close}>Close</button>
            </div>
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14, flex: 1, minHeight: 0, overflowY: 'auto' }}>{preview.panel}</div>
          </div>
        </div>
      )}

      <section className="rb-step tone-id" id="rb-rule">
        <StepHead n={1} title="About this rule" hint="Name it, say which records it covers, and classify it" />
        <div className="rb-pad">
          <div className="rb-namegrid six">
            <div className="field">
              <label htmlFor="dq-name">Name *</label>
              <input
                id="dq-name"
                className={`text-input ${errors.ruleName ? 'error' : ''}`}
                value={form.ruleName}
                autoFocus={!lockIdentity}
                placeholder="ISIN format validation"
                onChange={(event) => patch({
                  ruleName: event.target.value,
                  ...(lockIdentity || codeTouched ? {} : { ruleCode: toCode(event.target.value) }),
                })}
              />
              {errors.ruleName && <span className="field-error">{errors.ruleName}</span>}
            </div>
            <div className="field">
              <label htmlFor="dq-code">Code *</label>
              <input
                id="dq-code"
                className={`text-input mono ${errors.ruleCode ? 'error' : ''}`}
                value={form.ruleCode}
                disabled={lockIdentity}
                placeholder="SECURITY_ISIN_FORMAT"
                onChange={(event) => {
                  setCodeTouched(true);
                  patch({ ruleCode: event.target.value.toUpperCase().replace(/\s+/g, '_') });
                }}
              />
              {errors.ruleCode && <span className="field-error">{errors.ruleCode}</span>}
            </div>
            <div className="field">
              <label htmlFor="dq-domain">Domain</label>
              <select id="dq-domain" className="select" value={form.domainCode} onChange={(event) => patch({ domainCode: event.target.value })}>
                <option value="">All domains</option>
                {domains.map((domain) => <option key={domain.domainCode} value={domain.domainCode}>{domain.domainName}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dq-type">Type</label>
              <select id="dq-type" className="select" value={form.ruleType} onChange={(event) => patch({ ruleType: event.target.value })}>
                {DQ_RULE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dq-severity">Severity</label>
              <select id="dq-severity" className="select" value={form.severity} onChange={(event) => patch({ severity: event.target.value })}>
                {DQ_SEVERITIES.map((severity) => <option key={severity.value} value={severity.value}>{severity.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dq-status">Status</label>
              <select id="dq-status" className="select" value={form.isActive ? 'true' : 'false'} onChange={(event) => patch({ isActive: event.target.value === 'true' })}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="dq-description">Description</label>
            <textarea
              id="dq-description"
              className="text-input"
              rows={3}
              style={{ resize: 'vertical' }}
              value={form.ruleDescription}
              placeholder="What this rule checks, and when a blank value should pass"
              onChange={(event) => patch({ ruleDescription: event.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="rb-step tone-num" id="rb-conditions" data-cond-error={errors.ruleExpression ? '' : undefined}>
        <StepHead n={2} title="Conditions" hint="When does a record pass?" tone="num" />
        <div className="rb-body2">
          {!catalogReady ? (
            <div aria-busy="true" style={{ padding: '16px 4px', color: 'var(--ink-3)', fontSize: '13px' }}>Loading…</div>
          ) : (
          <DqConditionBuilder
            expression={form.ruleExpression}
            attributes={attributeChoices}
            domains={domains}
            preview={{ button: preview.button, panel: null }}
            onChange={(ruleExpression, issue) => {
              setForm((current) => (current.ruleExpression === ruleExpression ? current : { ...current, ruleExpression }));
              setExpressionIssue(issue);
              if (ruleExpression.trim() && !issue) setErrors((prev) => ({ ...prev, ruleExpression: '' }));
            }}
          />
          )}
          {errors.ruleExpression && <span className="field-error">{errors.ruleExpression}</span>}
        </div>
      </section>

      {error && <p className="field-error" role="alert">{error}</p>}

      <div className="builder-footer rb-footer">
        <div className="left" />
        <div className="right">
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Saving...' : lockIdentity ? 'Save rule' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
}
