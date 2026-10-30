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

const CATEGORY: Record<string, string> = {
  CONCENTRATION: 'Concentration',
  EXPOSURE: 'Exposure',
  DIVERSIFICATION: 'Diversification',
  ELIGIBILITY: 'Eligibility',
  LEVERAGE: 'Leverage',
  LIQUIDITY: 'Liquidity',
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
  return unit || '';
}

function limitText(value: number | null | undefined, unit?: string | null) {
  if (value == null) return '—';
  if (unit === 'CURRENCY' && Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  }
  return String(value);
}

export default function ComplianceRulesPage() {
  const router = useRouter();
  const [rules, setRules] = useState<ComplianceRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterActive, setFilterActive] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const selected = filteredRules.find((rule) => rule.id === selectedId) || filteredRules[0] || null;
  const activeCount = rules.filter((rule) => rule.isActive).length;
  const activeShare = rules.length ? Math.round((activeCount / rules.length) * 100) : 0;

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
          <div className="da-fact big"><span>Rules defined</span><strong>{loading ? '—' : rules.length}</strong></div>
          <div className="da-fact"><span>Active</span><strong>{loading ? '—' : activeCount}</strong></div>
          <div className="da-fact"><span>Disabled</span><strong>{loading ? '—' : rules.length - activeCount}</strong></div>
          <div className="da-fact"><span>Showing</span><strong>{loading ? '—' : filteredRules.length}</strong></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>Active share of the book</span><b>{loading ? '—' : `${activeShare}%`}</b></div>
          <div className="da-bar"><i style={{ width: `${activeShare}%` }} /></div>
          <p>{loading ? 'Loading the rule book.' : `${activeCount} of ${rules.length} rules are scoring positions.`}</p>
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
              <p>Select a rule to read its limits. Open it to edit the definition.</p>
            </div>
            <div className="page-actions">
              <select className="select" value={filterCategory} onChange={(event) => setFilterCategory(event.target.value)} aria-label="Category">
                <option value="all">All categories</option>
                {Object.entries(CATEGORY).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
              <select className="select" value={filterActive} onChange={(event) => setFilterActive(event.target.value)} aria-label="Status">
                <option value="all">All status</option>
                <option value="enabled">Active</option>
                <option value="disabled">Disabled</option>
              </select>
              <button type="button" className="btn btn-primary" onClick={() => setShowCreateForm(true)}>New rule</button>
            </div>
          </div>

          <div className="da-main">
            <div className="da-gridwrap">
              <table className="da-grid" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Category</th>
                    <th>Anchor</th>
                    <th>Direction</th>
                    <th className="num">Limits</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr><td colSpan={6}>Loading the rule book…</td></tr>
                  )}
                  {!loading && filteredRules.length === 0 && (
                    <tr><td colSpan={6}>No compliance rules found.</td></tr>
                  )}
                  {filteredRules.map((rule) => {
                    const version = rule.currentVersion;
                    return (
                      <tr key={rule.id} className={selected?.id === rule.id ? 'sel' : ''} onClick={() => setSelectedId(rule.id)}>
                        <td><b>{rule.ruleName}</b></td>
                        <td>{CATEGORY[rule.ruleCategory] || rule.ruleCategory}</td>
                        <td>
                          <b>{plainCode(rule.anchorDomainCode)}</b>
                          <small>{rule.appliesToAll ? 'All entities' : 'Specific entities'}</small>
                        </td>
                        <td>{version?.limitDirection || '—'}</td>
                        <td className="num">
                          {version ? (
                            <>
                              {version.softLimitValue != null && <span className="da-st near">Soft {limitText(version.softLimitValue, version.resultUnit)}</span>}
                              {' '}
                              {version.hardLimitValue != null && <span className="da-st breach">Hard {limitText(version.hardLimitValue, version.resultUnit)}</span>}
                              <small>{unitLabel(version.resultUnit)}</small>
                            </>
                          ) : <small>No version</small>}
                        </td>
                        <td><span className={`da-st ${rule.isActive ? 'ok' : 'na'}`}>{rule.isActive ? 'Active' : 'Disabled'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <aside className="da-panel">
              {selected ? <RulePanel rule={selected} onOpen={() => router.push(`/admin/compliance/${selected.ruleCode}`)} /> : <p className="da-note" style={{ padding: 16 }}>Select a rule to see its limits.</p>}
            </aside>
          </div>
        </section>
      )}
    </div>
  );
}

function RulePanel({ rule, onOpen }: { rule: ComplianceRuleRow; onOpen: () => void }) {
  const version = rule.currentVersion;
  const headline = version?.hardLimitValue ?? version?.softLimitValue;
  return (
    <>
      <div className="da-ph">
        <small>{CATEGORY[rule.ruleCategory] || rule.ruleCategory}</small>
        <h3>{rule.ruleName}</h3>
        <div className="da-big">{limitText(headline, version?.resultUnit)}</div>
        <p className="da-note">{version ? `${unitLabel(version.resultUnit)} · ${version.limitDirection || 'limit'}` : 'No version yet'}</p>
        <span className={`da-st ${rule.isActive ? 'ok' : 'na'}`}>{rule.isActive ? 'Active' : 'Disabled'}</span>
      </div>
      <section>
        <h4>Definition</h4>
        <table>
          <tbody>
            <tr><td>Anchor</td><td>{plainCode(rule.anchorDomainCode)}</td></tr>
            <tr><td>Applies to</td><td>{rule.appliesToAll ? 'All entities' : 'Specific entities'}</td></tr>
            <tr><td>Soft limit</td><td>{limitText(version?.softLimitValue, version?.resultUnit)}</td></tr>
            <tr><td>Hard limit</td><td>{limitText(version?.hardLimitValue, version?.resultUnit)}</td></tr>
            <tr><td>Version</td><td>{version?.versionNumber ?? '—'}</td></tr>
          </tbody>
        </table>
        {rule.description && <p className="da-note" style={{ marginTop: 8 }}>{rule.description}</p>}
        <div className="page-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={onOpen}>Open rule</button>
        </div>
      </section>
    </>
  );
}
