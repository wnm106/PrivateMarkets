'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  graphqlQuery,
  graphqlMutation,
  COMPLIANCE_RULES_QUERY,
  CREATE_COMPLIANCE_RULE_MUTATION,
  CREATE_COMPLIANCE_RULE_VERSION_MUTATION,
} from '@/lib/graphql';
import { ComplianceRuleForm, ComplianceRuleFormData, buildComplianceVersionInput } from '@/components/forms/ComplianceRuleForm';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

interface ComplianceRuleRow {
  id: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  anchorDomainCode: string;
  appliesToAll: boolean;
  isActive: boolean;
  description: string;
  currentVersion?: {
    limitDirection: string;
    softLimitValue: number | null;
    hardLimitValue: number | null;
    resultUnit: string;
    versionNumber: number;
  } | null;
}

const CATEGORY_COLORS: Record<string, { bg: string; fg: string }> = {
  CONCENTRATION: { bg: '#fde9d7', fg: '#c2410c' },
  EXPOSURE: { bg: '#e8eef2', fg: '#1b3a4b' },
  DIVERSIFICATION: { bg: '#f3eafd', fg: '#6d28d9' },
  ELIGIBILITY: { bg: '#e1f1e7', fg: '#047857' },
  LEVERAGE: { bg: '#fdecec', fg: '#b91c1c' },
  LIQUIDITY: { bg: '#e0f2fe', fg: '#0369a1' },
  OTHER: { bg: 'var(--bg-alt)', fg: 'var(--ink-3)' },
};

export default function ComplianceRulesPage() {
  const router = useRouter();
  const [rules, setRules] = useState<ComplianceRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterActive, setFilterActive] = useState('all');

  const fetchRules = async () => {
    setLoading(true);
    try {
      const result = await graphqlQuery<{ complianceRules: ComplianceRuleRow[] }, {}>(
        COMPLIANCE_RULES_QUERY,
        {},
        'network-only'
      );
      if (result.data?.complianceRules) setRules(result.data.complianceRules);
    } catch (error) {
      console.error('Error fetching compliance rules:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const filteredRules = rules.filter((rule) => {
    if (filterCategory !== 'all' && rule.ruleCategory !== filterCategory) return false;
    if (filterActive === 'enabled' && !rule.isActive) return false;
    if (filterActive === 'disabled' && rule.isActive) return false;
    return true;
  });

  const handleCreate = async (data: ComplianceRuleFormData) => {
    setSubmitting(true);
    try {
      const ruleResult = await graphqlMutation<{ createComplianceRule: { rule: { id: string } | null; errors: any[] } }, any>(
        CREATE_COMPLIANCE_RULE_MUTATION,
        {
          input: {
            ruleCode: data.ruleCode,
            ruleName: data.ruleName,
            ruleCategory: data.ruleCategory,
            anchorDomainCode: data.anchorDomainCode,
            appliesToAll: data.appliesToAll,
            description: data.description || undefined,
          },
        }
      );

      const ruleErrors = ruleResult.data?.createComplianceRule?.errors || [];
      const ruleId = ruleResult.data?.createComplianceRule?.rule?.id;
      if (!ruleId || ruleErrors.length > 0) {
        alert(`Failed to create rule: ${ruleErrors.map((e: any) => e.message).join(', ') || 'Unknown error'}`);
        return;
      }

      const versionResult = await graphqlMutation<{ createComplianceRuleVersion: { version: any; errors: any[] } }, any>(
        CREATE_COMPLIANCE_RULE_VERSION_MUTATION,
        { input: buildComplianceVersionInput(ruleId, data) }
      );

      const versionErrors = versionResult.data?.createComplianceRuleVersion?.errors || [];
      if (versionErrors.length > 0) {
        alert(`Rule created, but version failed: ${versionErrors.map((e: any) => e.message).join(', ')}`);
      }

      setShowCreateForm(false);
      await fetchRules();
      router.push(`/admin/compliance/${data.ruleCode}`);
    } catch (error: any) {
      console.error('Error creating compliance rule:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const columns = useMemo<ColDef<ComplianceRuleRow>[]>(() => [
    {
      colId: 'rule',
      headerName: 'Rule',
      minWidth: 240,
      flex: 1.6,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? `${params.data.ruleName} ${params.data.ruleCode}` : '',
      cellRenderer: (params) => {
        const rule = params.data;
        if (!rule) return params.value || '';
        return (
          <div>
            <div style={{ fontWeight: 500 }}>{rule.ruleName}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{rule.ruleCode}</div>
          </div>
        );
      },
    },
    {
      field: 'ruleCategory',
      headerName: 'Category',
      minWidth: 150,
      cellRenderer: (params) => {
        if (!params.value) return null;
        const cat = CATEGORY_COLORS[String(params.value)] || CATEGORY_COLORS.OTHER;
        return <span style={{ fontSize: 10, padding: '3px 8px', background: cat.bg, color: cat.fg, fontWeight: 600 }}>{params.value}</span>;
      },
    },
    {
      colId: 'anchor',
      headerName: 'Anchor Domain',
      minWidth: 160,
      valueGetter: (params) => params.data ? `${params.data.anchorDomainCode} ${params.data.appliesToAll ? 'All entities' : 'Specific entities'}` : '',
      cellRenderer: (params) => {
        const rule = params.data;
        if (!rule) return params.value || '';
        return (
          <div>
            <div>{rule.anchorDomainCode}</div>
            <div style={{ fontSize: 10, color: 'var(--ink-3)' }}>{rule.appliesToAll ? 'All entities' : 'Specific entities'}</div>
          </div>
        );
      },
    },
    {
      colId: 'direction',
      headerName: 'Direction',
      minWidth: 120,
      valueGetter: (params) => params.data?.currentVersion?.limitDirection || '',
    },
    {
      colId: 'limits',
      headerName: 'Limits',
      minWidth: 130,
      autoHeight: true,
      valueGetter: (params) => {
        const version = params.data?.currentVersion;
        if (!version) return '';
        return [version.softLimitValue != null ? `Soft ${version.softLimitValue}` : '', version.hardLimitValue != null ? `Hard ${version.hardLimitValue}` : ''].filter(Boolean).join(' ');
      },
      cellRenderer: (params) => {
        const version = params.data?.currentVersion;
        if (!params.data) return params.value || '';
        if (!version) return <span style={{ color: 'var(--ink-3)' }}>No version</span>;
        return (
          <div className="mono">
            {version.softLimitValue != null && <div style={{ color: 'var(--amber)' }}>Soft: {version.softLimitValue}</div>}
            {version.hardLimitValue != null && <div style={{ color: 'var(--red)' }}>Hard: {version.hardLimitValue}</div>}
          </div>
        );
      },
    },
    {
      colId: 'status',
      headerName: 'Status',
      minWidth: 120,
      valueGetter: (params) => params.data ? (params.data.isActive ? 'Active' : 'Disabled') : '',
      cellRenderer: (params) => {
        if (!params.value) return null;
        const active = params.value === 'Active';
        return (
          <span style={{ fontSize: 10, padding: '3px 8px', background: active ? '#e1f1e7' : 'var(--bg-alt)', color: active ? 'var(--green)' : 'var(--ink-3)', fontWeight: 600 }}>
            {params.value}
          </span>
        );
      },
    },
  ], []);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Compliance Rules</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">Compliance Rules</div>
          <div className="page-meta">
            {loading ? 'Loading...' : `${rules.length} rules defined · ${rules.filter((r) => r.isActive).length} active`}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>+ New Rule</button>
        </div>
      </div>

      {showCreateForm ? (
        <ComplianceRuleForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreateForm(false)}
          submitting={submitting}
        />
      ) : (
        <>
          <div className="filter-bar">
            <div className="filter-label">Filter</div>
            <select
              className="select"
              style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
            >
              <option value="all">All Categories</option>
              <option value="CONCENTRATION">Concentration</option>
              <option value="EXPOSURE">Exposure</option>
              <option value="DIVERSIFICATION">Diversification</option>
              <option value="ELIGIBILITY">Eligibility</option>
              <option value="LEVERAGE">Leverage</option>
              <option value="LIQUIDITY">Liquidity</option>
              <option value="OTHER">Other</option>
            </select>
            <select
              className="select"
              style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
              value={filterActive}
              onChange={(e) => setFilterActive(e.target.value)}
            >
              <option value="all">All Status</option>
              <option value="enabled">Active</option>
              <option value="disabled">Disabled</option>
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
              autoRowHeight
              loading={loading}
              emptyMessage="No compliance rules found."
              onRowClicked={(rule) => router.push(`/admin/compliance/${rule.ruleCode}`)}
              getRowClass={(params) => (params.data && !params.data.isActive ? 'is-inactive' : '')}
            />
          </div>
        </>
      )}
    </div>
  );
}
