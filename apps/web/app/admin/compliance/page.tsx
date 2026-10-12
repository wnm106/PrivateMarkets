'use client';

import { useEffect, useState } from 'react';
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

          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div className="loader">Loading compliance rules...</div>
            </div>
          )}

          {!loading && (
            <div className="data-table">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.6fr 130px 140px 110px 120px 90px',
                  gap: '14px',
                  padding: '12px 18px',
                  background: 'var(--bg)',
                  borderBottom: '1px solid var(--line)',
                  fontSize: '10px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '1.2px',
                  color: 'var(--ink-3)',
                }}
              >
                <div>Rule</div>
                <div>Category</div>
                <div>Anchor Domain</div>
                <div style={{ textAlign: 'center' }}>Direction</div>
                <div style={{ textAlign: 'center' }}>Limits</div>
                <div style={{ textAlign: 'center' }}>Status</div>
              </div>
              {filteredRules.map((rule) => {
                const cat = CATEGORY_COLORS[rule.ruleCategory] || CATEGORY_COLORS.OTHER;
                const v = rule.currentVersion;
                return (
                  <div
                    key={rule.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.6fr 130px 140px 110px 120px 90px',
                      gap: '14px',
                      padding: '14px 18px',
                      borderBottom: '1px solid var(--line)',
                      fontSize: '12px',
                      alignItems: 'center',
                      cursor: 'pointer',
                      opacity: rule.isActive ? 1 : 0.6,
                    }}
                    onClick={() => router.push(`/admin/compliance/${rule.ruleCode}`)}
                    onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div>
                      <div style={{ color: 'var(--ink)', fontWeight: 500, marginBottom: '2px' }}>{rule.ruleName}</div>
                      <div className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{rule.ruleCode}</div>
                    </div>
                    <div>
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '3px 8px',
                          background: cat.bg,
                          color: cat.fg,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}
                      >
                        {rule.ruleCategory}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                      {rule.anchorDomainCode}
                      {rule.appliesToAll ? (
                        <div style={{ fontSize: '10px', color: 'var(--ink-3)' }}>All entities</div>
                      ) : (
                        <div style={{ fontSize: '10px', color: 'var(--ink-3)' }}>Specific entities</div>
                      )}
                    </div>
                    <div style={{ textAlign: 'center', fontSize: '11px' }}>{v?.limitDirection || '—'}</div>
                    <div className="mono" style={{ textAlign: 'center', fontSize: '11px' }}>
                      {v ? (
                        <>
                          {v.softLimitValue != null && <div style={{ color: 'var(--amber)' }}>Soft: {v.softLimitValue}</div>}
                          {v.hardLimitValue != null && <div style={{ color: 'var(--red)' }}>Hard: {v.hardLimitValue}</div>}
                        </>
                      ) : (
                        <span style={{ color: 'var(--ink-3)' }}>No version</span>
                      )}
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      {rule.isActive ? (
                        <span style={{ fontSize: '10px', padding: '3px 8px', background: '#e1f1e7', color: 'var(--green)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Active
                        </span>
                      ) : (
                        <span style={{ fontSize: '10px', padding: '3px 8px', background: 'var(--bg-alt)', color: 'var(--ink-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Disabled
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {filteredRules.length === 0 && !loading && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>No compliance rules found</div>
                  <div style={{ fontSize: '14px', maxWidth: '420px', margin: '0 auto' }}>
                    Create a rule to evaluate concentration, exposure, leverage, or eligibility limits across any entity level.
                  </div>
                  <div style={{ marginTop: '16px' }}>
                    <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>+ Create Rule</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
