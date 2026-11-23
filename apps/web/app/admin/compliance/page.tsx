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
  COMPLIANCE_DASHBOARD_QUERY,
} from '@/lib/graphql';
import { ComplianceDashboard } from '@/components/compliance/ComplianceDashboard';
import { dashboardTabData, type ComplianceDashboardData } from '@/lib/compliance-dashboard';
import { useTemporalStore } from '@/lib/store';
import { usePublishTabs } from '@/lib/view-context';
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
  const [tab, setTab] = useState<'dashboard' | 'rules'>('dashboard');
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [board, setBoard] = useState<ComplianceDashboardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(true);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [domainCode, setDomainCode] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tab') === 'rules') setTab('rules');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBoardLoading(true);
    setBoardError(null);
    graphqlQuery<{ complianceDashboard: ComplianceDashboardData }, { asOfDate: string | null; knowledgeDate: string | null }>(
      COMPLIANCE_DASHBOARD_QUERY,
      { asOfDate: asOfDate || null, knowledgeDate: knowledgeDate || null },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const next = result.data?.complianceDashboard;
      if (result.error || !next) {
        setBoardError(result.error?.message || 'The compliance results could not be loaded.');
        setBoard(null);
        return;
      }
      setBoard(next);
      setDomainCode((current) => (
        current && next.domains.some((item) => item.domainCode === current)
          ? current
          : [...next.domains].sort((a, b) => b.resultCount - a.resultCount)[0]?.domainCode || null
      ));
    }).catch((err) => {
      if (!cancelled) setBoardError(err instanceof Error ? err.message : 'The compliance results could not be loaded.');
    }).finally(() => {
      if (!cancelled) setBoardLoading(false);
    });
    return () => { cancelled = true; };
  }, [asOfDate, knowledgeDate]);

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

  const totals = useMemo(() => {
    const domains = board?.domains || [];
    return {
      types: domains.length,
      tests: domains.reduce((sum, item) => sum + item.resultCount, 0),
      hard: domains.reduce((sum, item) => sum + item.hardBreachCount, 0),
      soft: domains.reduce((sum, item) => sum + item.softBreachCount, 0),
    };
  }, [board]);

  usePublishTabs({
    dashboard: {
      label: 'Dashboard',
      purpose: 'Which entity types have compliance results, and for the selected type where each rule stands against its limit and how much cushion is left.',
      howToRead: 'Results are the newest score for each rule, entity, group and rank at the As Of and Knowledge dates. Warning is the soft limit and Limit is the hard limit; a Maximum is breached above the limit and a Minimum below it. Cushion is the room left before the hard limit (the warning level when there is no hard limit), in the result unit; percentage results are in percentage points, and cushionPctOfLimit is that room as a share of the limit. A negative cushion is past the limit. Not scored means the rule has no result at these dates. Rows are sorted breaches first, then by least cushion.',
      data: board ? dashboardTabData(board, domainCode) : null,
    },
    rules: {
      label: 'Rules',
      purpose: 'The rule book: every compliance rule, its category, anchor entity type, result unit and whether it is active.',
      data: loading ? null : {
        ruleCount: rules.length,
        activeCount: rules.filter((rule) => rule.isActive).length,
        rules: rules.slice(0, 120).map((rule) => ({
          rule: rule.ruleName,
          code: rule.ruleCode,
          category: CATEGORY[rule.ruleCategory] || rule.ruleCategory,
          anchor: plainCode(rule.anchorDomainCode),
          result: rule.currentVersion ? unitLabel(rule.currentVersion.resultUnit) : 'No version',
          active: rule.isActive,
        })),
      },
    },
    thresholds: {
      label: 'Thresholds by fund',
      purpose: 'Set the limit each fund applies for each rule.',
      data: { note: 'This tab opens its own page, where the fund limits are edited. Its figures are read when that page is open.' },
    },
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
        <div className="da-facts">
          <div className="da-fact big"><span>Hard breaches</span><strong className={totals.hard ? 'dn' : ''}>{board ? totals.hard : '—'}</strong></div>
          <div className="da-fact"><span>Warnings</span><strong>{board ? totals.soft : '—'}</strong></div>
          <div className="da-fact"><span>Tests</span><strong>{board ? totals.tests.toLocaleString() : '—'}</strong><small>{board ? `${totals.types} entity type${totals.types === 1 ? '' : 's'}` : ''}</small></div>
          <div className="da-fact"><span>As of</span><strong>{asOfDate}</strong><small>Known by {knowledgeDate}</small></div>
        </div>
      </header>

      <div className="da-tabs" role="tablist">
        <button type="button" className={tab === 'dashboard' ? 'on' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button type="button" className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules</button>
        <button type="button" onClick={() => router.push('/admin/compliance/funds')}>Thresholds by fund</button>
      </div>

      {tab === 'dashboard' ? (
        <ComplianceDashboard
          data={board}
          loading={boardLoading}
          error={boardError}
          selectedCode={domainCode}
          onSelect={setDomainCode}
        />
      ) : showCreateForm ? (
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
