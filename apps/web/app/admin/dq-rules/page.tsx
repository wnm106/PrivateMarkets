'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DQ_RULES_QUERY, graphqlQuery } from '@/lib/graphql';
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

const RULE_TYPES = ['COMPLETENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'UNIQUENESS'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export default function DQRulesPage() {
  const router = useRouter();
  const [filterType, setFilterType] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [filterEnabled, setFilterEnabled] = useState('all');
  const [search, setSearch] = useState('');
  const [rules, setRules] = useState<DQRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await graphqlQuery<{ dqRules: DQRule[] }, {}>(DQ_RULES_QUERY, {}, 'network-only');
      if (result.error) setError(result.error.message);
      setRules(result.data?.dqRules || []);
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

  usePublishViewContext(useMemo(() => ({
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
  }), [filteredRules, filterType, filterSeverity, filterEnabled, search]));

  const openRule = (rule: DQRule) => router.push(`/admin/dq-rules/${encodeURIComponent(rule.ruleCode)}`);

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
          <button className="btn btn-primary" onClick={() => router.push('/admin/dq-rules/new')}>+ New Rule</button>
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
          onRowClicked={openRule}
          getRowClass={(params) => (params.data && !params.data.isActive ? 'is-inactive' : '')}
        />
      </div>

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
