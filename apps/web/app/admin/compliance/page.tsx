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

const CATEGORY: Record<string, string> = {
  CONCENTRATION: 'Concentration',
  EXPOSURE: 'Exposure',
  DIVERSIFICATION: 'Diversification',
  ELIGIBILITY: 'Eligibility',
  LEVERAGE: 'Leverage',
  LIQUIDITY: 'Liquidity',
  FORTY_ACT: '40 Act',
  COVERAGE: 'Coverage',
  COLLATERAL_QUALITY: 'Collateral quality',
  OTHER: 'Other',
};

function plainCode(code?: string | null) {
  if (!code) return '—';
  return code.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unitLabel(unit?: string | null) {
  if (unit === 'PERCENTAGE') return 'Percentage';
  if (unit === 'CURRENCY') return 'Currency';
  if (unit === 'COUNT') return 'Count';
  if (unit === 'RATIO') return 'Ratio';
  return unit || '';
}

export default function ComplianceRulesPage() {
  const router = useRouter();
  const [rules, setRules] = useState<ComplianceRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchRules = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await graphqlQuery<{ complianceRules: ComplianceRuleRow[] }, {}>(
        COMPLIANCE_RULES_QUERY,
        {},
        'network-only'
      );
      if (result.error || !result.data?.complianceRules) {
        const message = result.error?.message || 'The rule book could not be loaded.';
        setLoadError(message);
        setRules([]);
        return;
      }
      setRules(result.data.complianceRules);
    } catch (error) {
      console.error('Error fetching compliance rules:', error);
      setLoadError(error instanceof Error ? error.message : 'The rule book could not be loaded.');
      setRules([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const columns = useMemo<ColDef<ComplianceRuleRow>[]>(() => [
    {
      colId: 'ruleName',
      headerName: 'Rule',
      minWidth: 260,
      flex: 2,
      sort: 'asc',
      valueGetter: (params) => params.data?.ruleName || '',
      comparator: (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }),
      cellRenderer: (params: { data?: ComplianceRuleRow }) => (
        params.data ? (
          <Link href={`/admin/compliance/${encodeURIComponent(params.data.ruleCode)}`} style={{ fontWeight: 600 }}>
            {params.data.ruleName}
          </Link>
        ) : null
      ),
    },
    { colId: 'ruleCode', headerName: 'Code', minWidth: 170, flex: 1, cellClass: 'mono', valueGetter: (params) => params.data?.ruleCode || '' },
    { colId: 'category', headerName: 'Category', minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? CATEGORY[params.data.ruleCategory] || params.data.ruleCategory : '') },
    { colId: 'anchor', headerName: 'Anchor', minWidth: 140, flex: 1, valueGetter: (params) => plainCode(params.data?.anchorDomainCode) },
    { colId: 'appliesTo', headerName: 'Applies to', minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? (params.data.appliesToAll ? 'All entities' : 'Specific entities') : '') },
    { colId: 'unit', headerName: 'Result', minWidth: 120, flex: 1, valueGetter: (params) => (params.data?.currentVersion ? unitLabel(params.data.currentVersion.resultUnit) : 'No version') },
    {
      colId: 'status',
      headerName: 'Status',
      minWidth: 120,
      valueGetter: (params) => (params.data ? (params.data.isActive ? 'Active' : 'Disabled') : ''),
      cellRenderer: (params: { data?: ComplianceRuleRow }) => (
        params.data ? <span className={`da-st ${params.data.isActive ? 'ok' : 'na'}`}>{params.data.isActive ? 'Active' : 'Disabled'}</span> : null
      ),
    },
  ], []);

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

  return (
    <div className="view-fade da">
      <div className="da-crumbs">
        <Link href="/">Master Data</Link>
        <span>/</span>
        <strong>Compliance</strong>
      </div>

      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Rule book</span>
          <h1>Compliance</h1>
          <p>Limits that score a fund, an issuer, or a book. A fund can keep the book limit or set its own.</p>
        </div>
      </header>

      <div className="da-tabs" role="tablist">
        <button type="button" className="on">Rules</button>
        <button type="button" onClick={() => router.push('/admin/compliance/funds')}>Thresholds by fund</button>
      </div>

      {showCreateForm ? (
        <section className="da-sec">
          <div className="da-sechead">
            <h2>New rule</h2>
            <p>The rule is saved with its first version, then opened for review.</p>
          </div>
          <ComplianceRuleForm
            onSubmit={handleCreate}
            onCancel={() => setShowCreateForm(false)}
            submitting={submitting}
          />
        </section>
      ) : (
        <section className="da-sec">
          <div className="da-sechead">
            <div>
              <h2>Rules</h2>
              <p>Select a rule name to open and edit it. Use the column filters to search.</p>
            </div>
            <div className="page-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowCreateForm(true)}>New rule</button>
            </div>
          </div>

          {loadError && <p className="da-note" style={{ color: 'var(--red)' }}>{loadError}</p>}
          <AppGrid
            rows={rules}
            columns={columns}
            getRowId={(row) => row.id}
            loading={loading}
            autoHeight
            emptyMessage="No compliance rules found."
          />
        </section>
      )}
    </div>
  );
}
