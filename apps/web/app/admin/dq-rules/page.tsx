'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import Link from 'next/link';
import {
  ATTRIBUTE_REGISTER_QUERY,
  CREATE_DQ_RULE_MUTATION,
  DOMAIN_TYPES_QUERY,
  DQ_RULES_QUERY,
  UPDATE_DQ_RULE_MUTATION,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { DqExpressionEditor } from '@/components/quality/DqExpressionEditor';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

interface DQRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  domainCode: string | null;
  attributeCode: string | null;
  ruleType: string;
  severity: string;
  ruleExpression: string;
  ruleDescription: string | null;
  isActive: boolean;
  updatedAt: string;
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

interface RuleForm {
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

const RULE_TYPES = ['COMPLETENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'UNIQUENESS'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const EMPTY_FORM: RuleForm = {
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

export default function DQRulesPage() {
  const [filterType, setFilterType] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [filterEnabled, setFilterEnabled] = useState('all');
  const [search, setSearch] = useState('');
  const [rules, setRules] = useState<DQRule[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [attributes, setAttributes] = useState<AttributeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [expressionIssue, setExpressionIssue] = useState<string | null>(null);
  const [editing, setEditing] = useState<DQRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rulesResult, domainsResult, attributesResult] = await Promise.all([
        graphqlQuery<{ dqRules: DQRule[] }>(DQ_RULES_QUERY, {}, 'network-only'),
        graphqlQuery<{ domainTypes: DomainOption[] }>(DOMAIN_TYPES_QUERY, {}, 'network-only'),
        graphqlQuery<{ attributeRegister: AttributeOption[] }>(ATTRIBUTE_REGISTER_QUERY, {}, 'network-only'),
      ]);
      const message = rulesResult.error?.message || domainsResult.error?.message || attributesResult.error?.message;
      if (message) setError(message);
      setRules(rulesResult.data?.dqRules || []);
      setDomains(domainsResult.data?.domainTypes || []);
      setAttributes(attributesResult.data?.attributeRegister || []);
    } catch (err: any) {
      setError(err.message || 'Could not load data quality rules.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rules.filter((rule) => {
      if (filterType !== 'all' && rule.ruleType !== filterType) return false;
      if (filterSeverity !== 'all' && rule.severity !== filterSeverity) return false;
      if (filterEnabled === 'enabled' && !rule.isActive) return false;
      if (filterEnabled === 'disabled' && rule.isActive) return false;
      if (!query) return true;
      return [rule.ruleCode, rule.ruleName, rule.ruleDescription, rule.domainCode, rule.attributeCode, rule.ruleExpression]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }, [rules, filterType, filterSeverity, filterEnabled, search]);

  const attributeChoices = attributes.filter((attribute) => !form.domainCode || attribute.domainCode === form.domainCode);

  usePublishViewContext(useMemo(() => {
    if (creating || editing) {
      return {
        activity: creating ? 'creating' as const : 'editing' as const,
        kind: 'dq-rule',
        label: form.ruleName || form.ruleCode || 'Data quality rule',
        id: editing?.id,
        domainCode: form.domainCode || undefined,
        summary: form.ruleDescription || undefined,
        snapshot: {
          ruleCode: form.ruleCode,
          ruleName: form.ruleName,
          domainCode: form.domainCode || null,
          attributeCode: form.attributeCode || null,
          ruleType: form.ruleType,
          severity: form.severity,
          isActive: form.isActive,
          ruleExpression: form.ruleExpression,
          ruleDescription: form.ruleDescription,
        },
      };
    }
    return {
      activity: 'viewing' as const,
      kind: 'dq-rules',
      label: 'Data quality rules',
      summary: `${filteredRules.length} rules shown`,
      snapshot: {
        filters: { type: filterType, severity: filterSeverity, enabled: filterEnabled, search },
        rules: filteredRules.slice(0, 40).map((rule) => ({
          ruleCode: rule.ruleCode,
          ruleName: rule.ruleName,
          domainCode: rule.domainCode,
          attributeCode: rule.attributeCode,
          ruleType: rule.ruleType,
          severity: rule.severity,
          isActive: rule.isActive,
        })),
      },
    };
  }, [creating, editing, form, filteredRules, filterType, filterSeverity, filterEnabled, search]));

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const openEdit = (rule: DQRule) => {
    setCreating(false);
    setEditing(rule);
    setForm({
      ruleCode: rule.ruleCode,
      ruleName: rule.ruleName,
      domainCode: rule.domainCode || '',
      attributeCode: rule.attributeCode || '',
      ruleType: rule.ruleType,
      severity: rule.severity,
      ruleExpression: rule.ruleExpression,
      ruleDescription: rule.ruleDescription || '',
      isActive: rule.isActive,
    });
    setFormError(null);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setFormError(null);
  };

  const save = async () => {
    if (!form.ruleName.trim() || !form.ruleExpression.trim() || (creating && !form.ruleCode.trim())) {
      setFormError('Rule code, name, and expression are required.');
      return;
    }
    if (expressionIssue) {
      setFormError(expressionIssue);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const shared = {
        ruleName: form.ruleName.trim(),
        domainCode: form.domainCode || null,
        attributeCode: form.attributeCode,
        ruleType: form.ruleType,
        severity: form.severity,
        ruleExpression: form.ruleExpression.trim(),
        ruleDescription: form.ruleDescription.trim() || null,
      };
      const result = creating
        ? await graphqlMutation<{ createDQRule: { rule: DQRule | null; errors: Array<{ message: string }> } }>(
            CREATE_DQ_RULE_MUTATION,
            { input: { ...shared, ruleCode: form.ruleCode.trim() } },
          )
        : await graphqlMutation<{ updateDQRule: { rule: DQRule | null; errors: Array<{ message: string }> } }>(
            UPDATE_DQ_RULE_MUTATION,
            { input: { ...shared, id: editing?.id, isActive: form.isActive } },
          );
      const payload = creating ? result.data?.createDQRule : result.data?.updateDQRule;
      const message = result.error?.message || payload?.errors?.[0]?.message;
      if (message || !payload?.rule) {
        setFormError(message || 'The rule was not saved.');
        return;
      }
      closeForm();
      await load();
    } catch (err: any) {
      setFormError(err.message || 'The rule was not saved.');
    } finally {
      setSaving(false);
    }
  };

  const activeCount = rules.filter((rule) => rule.isActive).length;
  const columns = useMemo<ColDef<DQRule>[]>(() => [
    { field: 'ruleCode', headerName: 'Code', minWidth: 180, flex: 1, cellClass: 'mono' },
    {
      colId: 'rule',
      headerName: 'Rule',
      minWidth: 260,
      flex: 1.6,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? `${params.data.ruleName} ${params.data.ruleDescription || params.data.ruleExpression || ''}` : '',
      cellRenderer: (params) => {
        const rule = params.data;
        if (!rule) return params.value || '';
        return (
          <div>
            <div style={{ fontWeight: 500, marginBottom: 2 }}>{rule.ruleName}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.4 }}>{rule.ruleDescription || rule.ruleExpression}</div>
          </div>
        );
      },
    },
    {
      field: 'ruleType',
      headerName: 'Type',
      minWidth: 140,
      cellRenderer: (params) => params.value ? <span style={typeChip(String(params.value))}>{params.value}</span> : null,
    },
    {
      colId: 'applies',
      headerName: 'Applies to',
      minWidth: 180,
      flex: 1,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? `${params.data.domainCode || 'All domains'} ${params.data.attributeCode || 'Any attribute'}` : '',
      cellRenderer: (params) => {
        const rule = params.data;
        if (!rule) return params.value || '';
        return (
          <div>
            <div>{rule.domainCode || 'All domains'}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{rule.attributeCode || 'Any attribute'}</div>
          </div>
        );
      },
    },
    {
      field: 'severity',
      headerName: 'Severity',
      minWidth: 130,
      cellRenderer: (params) => params.value ? (
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: severityColor(String(params.value)), marginRight: 6 }} />
          {params.value}
        </span>
      ) : null,
    },
    {
      colId: 'status',
      headerName: 'Status',
      minWidth: 120,
      valueGetter: (params) => params.data ? (params.data.isActive ? 'Active' : 'Inactive') : '',
      cellRenderer: (params) => {
        if (!params.value) return null;
        const active = params.value === 'Active';
        return <span style={active ? activeChip : inactiveChip}>{params.value}</span>;
      },
    },
  ], []);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/quality" className="crumb-link">Data Quality</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Rules</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">Data Quality Rules</div>
          <div className="page-meta">
            {loading
              ? 'Loading...'
              : `${rules.length} rules defined · ${activeCount} active. These are the checks behind the quality results.`}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openCreate}>+ New Rule</button>
        </div>
      </div>

      {error && (
        <div className="dq-empty" style={{ marginBottom: 16 }}>{error}</div>
      )}

      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <input
          className="text-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search code, name, or expression"
          style={{ minWidth: 220 }}
        />
        <select className="select" style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }} value={filterType} onChange={(event) => setFilterType(event.target.value)}>
          <option value="all">All Types</option>
          {RULE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select className="select" style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }} value={filterSeverity} onChange={(event) => setFilterSeverity(event.target.value)}>
          <option value="all">All Severities</option>
          {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
        </select>
        <select className="select" style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }} value={filterEnabled} onChange={(event) => setFilterEnabled(event.target.value)}>
          <option value="all">All Status</option>
          <option value="enabled">Active</option>
          <option value="disabled">Inactive</option>
        </select>
        <div className="filter-count">
          Showing <strong>{filteredRules.length}</strong> of {rules.length}
        </div>
      </div>

      <div className="data-table">
        <AppGrid
          rows={filteredRules}
          columns={columns}
          getRowId={(rule) => rule.id}
          autoHeight={false}
          height="100%"
          loading={loading}
          emptyMessage="No data quality rules match this selection."
          onRowClicked={openEdit}
          getRowClass={(params) => (params.data && !params.data.isActive ? 'is-inactive' : '')}
        />
      </div>

      {(creating || editing) && (
        <div style={modalBackdrop}>
          <div style={modalCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0, color: 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>
                  {creating ? 'Create' : 'Edit'}
                </div>
                <div style={{ fontFamily: 'var(--font-ibm-plex-serif), serif', fontSize: 18, fontWeight: 600 }}>
                  Data Quality Rule
                </div>
              </div>
              <button className="btn btn-sm" onClick={closeForm}>✕ Close</button>
            </div>

            <div className="form-grid">
              <div className="field">
                <label>Rule code</label>
                <input
                  className="text-input mono"
                  value={form.ruleCode}
                  disabled={!creating}
                  onChange={(event) => setForm({ ...form, ruleCode: event.target.value.toUpperCase() })}
                  placeholder="SECURITY_ISIN_FORMAT"
                />
              </div>
              <div className="field">
                <label>Rule name</label>
                <input
                  className="text-input"
                  value={form.ruleName}
                  onChange={(event) => setForm({ ...form, ruleName: event.target.value })}
                  placeholder="ISIN Format Validation"
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={form.ruleDescription}
                  onChange={(event) => setForm({ ...form, ruleDescription: event.target.value })}
                  placeholder="What this rule checks, and when a blank value should pass"
                  rows={2}
                  style={{ resize: 'vertical' }}
                />
              </div>
              <div className="field">
                <label>Domain</label>
                <select className="select" value={form.domainCode} onChange={(event) => setForm({ ...form, domainCode: event.target.value, attributeCode: '' })}>
                  <option value="">All domains</option>
                  {domains.map((domain) => <option key={domain.domainCode} value={domain.domainCode}>{domain.domainName}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Attribute</label>
                <select className="select" value={form.attributeCode} onChange={(event) => setForm({ ...form, attributeCode: event.target.value })}>
                  <option value="">Any attribute named in the expression</option>
                  {attributeChoices.map((attribute) => (
                    <option key={attribute.attributeCode} value={attribute.attributeCode}>
                      {attribute.attributeCode} — {attribute.attributeName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Type</label>
                <select className="select" value={form.ruleType} onChange={(event) => setForm({ ...form, ruleType: event.target.value })}>
                  {RULE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Severity</label>
                <select className="select" value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })}>
                  {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                </select>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Conditions</label>
                <DqExpressionEditor
                  key={editing?.id || 'new'}
                  expression={form.ruleExpression}
                  attributes={attributeChoices}
                  domains={domains}
                  onChange={(ruleExpression, issue) => {
                    setForm((current) => current.ruleExpression === ruleExpression ? current : { ...current, ruleExpression });
                    setExpressionIssue(issue);
                  }}
                />
              </div>
              <div className="field">
                <label>Status</label>
                <select className="select" value={form.isActive ? 'true' : 'false'} onChange={(event) => setForm({ ...form, isActive: event.target.value === 'true' })}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
            </div>

            {formError && <div className="dq-empty" style={{ marginTop: 16 }}>{formError}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn" onClick={closeForm} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : creating ? 'Create Rule' : 'Save Changes'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const activeChip: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: '#e1f1e7',
  color: 'var(--green)',
  fontWeight: 600,
  textTransform: 'none',
  letterSpacing: 0,
};

const inactiveChip: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: 'var(--bg-alt)',
  color: 'var(--ink-3)',
  fontWeight: 600,
  textTransform: 'none',
  letterSpacing: 0,
};

const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modalCard: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  padding: 24,
  maxWidth: 920,
  width: '92%',
  maxHeight: '92vh',
  overflowY: 'auto',
};

function typeChip(type: string): React.CSSProperties {
  const palette: Record<string, { background: string; color: string }> = {
    COMPLETENESS: { background: '#e8eef2', color: 'var(--accent-2)' },
    VALIDITY: { background: '#fde9d7', color: '#c2410c' },
    CONSISTENCY: { background: '#f3eafd', color: '#6d28d9' },
    TIMELINESS: { background: '#e7f3ea', color: '#166534' },
    UNIQUENESS: { background: '#e8f1fb', color: '#1d4ed8' },
  };
  const tone = palette[type] || { background: 'var(--bg-alt)', color: 'var(--ink-2)' };
  return {
    fontSize: 11,
    padding: '3px 8px',
    background: tone.background,
    color: tone.color,
    fontWeight: 600,
    letterSpacing: 0,
    whiteSpace: 'nowrap',
  };
}

function severityColor(severity: string) {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'var(--red)';
  if (severity === 'MEDIUM') return 'var(--amber)';
  return 'var(--ink-4)';
}
