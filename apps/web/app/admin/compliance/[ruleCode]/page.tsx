'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  graphqlQuery,
  graphqlMutation,
  COMPLIANCE_RULE_QUERY,
  CREATE_COMPLIANCE_RULE_VERSION_MUTATION,
  UPDATE_COMPLIANCE_RULE_MUTATION,
  CREATE_COMPLIANCE_SCOPE_ASSIGNMENT_MUTATION,
  DELETE_COMPLIANCE_SCOPE_ASSIGNMENT_MUTATION,
  EVALUATE_COMPLIANCE_RULE_MUTATION,
  COMPLIANCE_EVALUATION_RUN_QUERY,
  COMPLIANCE_EVALUATION_RUNS_QUERY,
  ENTITIES_QUERY,
} from '@/lib/graphql';
import { ComplianceRuleForm, ComplianceRuleFormData, buildComplianceVersionInput, dimensionFromDto, describeDimension, emptyDimension } from '@/components/forms/ComplianceRuleForm';

interface RollupHopDto {
  relationshipCode: string;
  direction: string;
  recursive: boolean;
}

interface VersionDto {
  id: string;
  versionNumber: number;
  validFrom: string;
  validTo: string;
  ruleName: string;
  description?: string;
  changeReason?: string;
  baseDomainCode: string;
  baseRollupPath: RollupHopDto[];
  groupByPath: RollupHopDto[];
  groupByAttributeCode?: string;
  numeratorAttributeCode: string;
  numeratorAggregation: string;
  numeratorDimension?: any;
  denominatorDimension?: any;
  resultTransform: string;
  denominatorAttributeCode?: string;
  denominatorAggregation?: string;
  denominatorScope: string;
  denominatorConstantValue?: number;
  resultUnit: string;
  limitDirection: string;
  softLimitValue?: number;
  hardLimitValue?: number;
  defaultSourceScope: string;
  conditions: Array<{
    appliesTo: string;
    conditionOrder: number;
    attributeCode: string;
    attributeDimension?: any;
    operator: string;
    value?: string;
    compareAttributeCode?: string;
    compareDimension?: any;
    logicOperator: string;
  }>;
}

interface ScopeAssignmentDto {
  id: string;
  scopeType: string;
  entityId: string;
  entityCode?: string;
  entityName?: string;
  includeChildren: boolean;
  notes?: string;
}

interface RuleDto {
  id: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  anchorDomainCode: string;
  appliesToAll: boolean;
  isActive: boolean;
  description?: string;
  versions: VersionDto[];
  currentVersion?: VersionDto | null;
  scopeAssignments: ScopeAssignmentDto[];
}

interface RunDto {
  id: string;
  asOfDate: string;
  knowledgeDate: string;
  sourceScope: string;
  runStatus: string;
  errorMessage?: string;
  resultCount?: number;
  breachCount?: number;
  startedAt: string;
  completedAt?: string;
}

interface ResultDto {
  id: string;
  anchorEntityId: string;
  anchorEntityCode?: string;
  anchorEntityName?: string;
  groupByValue?: string;
  numeratorValue?: number;
  denominatorValue?: number;
  computedValue?: number;
  limitDirection?: string;
  softLimitValue?: number;
  hardLimitValue?: number;
  status: string;
  breachAmount?: number;
  contributingCount?: number;
}

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  PASS: { bg: '#e1f1e7', fg: 'var(--green)' },
  SOFT_BREACH: { bg: '#fdf3d7', fg: 'var(--amber)' },
  HARD_BREACH: { bg: '#fdecec', fg: 'var(--red)' },
  NO_DATA: { bg: 'var(--bg-alt)', fg: 'var(--ink-3)' },
  ERROR: { bg: 'var(--bg-alt)', fg: 'var(--ink-3)' },
};

export default function ComplianceRuleDetailPage() {
  const params = useParams();
  const ruleCode = params.ruleCode as string;

  const [rule, setRule] = useState<RuleDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);

  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [knowledgeDate, setKnowledgeDate] = useState('');
  const [sourceScope, setSourceScope] = useState('');
  const [evaluating, setEvaluating] = useState(false);

  const [runs, setRuns] = useState<RunDto[]>([]);
  const [activeRun, setActiveRun] = useState<RunDto | null>(null);
  const [results, setResults] = useState<ResultDto[]>([]);

  const [newEntityCode, setNewEntityCode] = useState('');
  const [addingScope, setAddingScope] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editData, setEditData] = useState<Partial<ComplianceRuleFormData>>({});
  const [savingEdit, setSavingEdit] = useState(false);

  const fetchRule = async () => {
    setLoading(true);
    try {
      const result = await graphqlQuery<{ complianceRule: RuleDto | null }, { ruleCode: string }>(
        COMPLIANCE_RULE_QUERY,
        { ruleCode },
        'network-only'
      );
      setRule(result.data?.complianceRule || null);
    } catch (error) {
      console.error('Error fetching compliance rule:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchRuns = async (ruleId: string) => {
    const result = await graphqlQuery<{ complianceEvaluationRuns: RunDto[] }, { ruleId: string; first: number }>(
      COMPLIANCE_EVALUATION_RUNS_QUERY,
      { ruleId, first: 10 },
      'network-only'
    );
    if (result.data?.complianceEvaluationRuns) setRuns(result.data.complianceEvaluationRuns);
  };

  useEffect(() => {
    fetchRule();
  }, [ruleCode]);

  useEffect(() => {
    if (rule?.id) fetchRuns(rule.id);
  }, [rule?.id]);

  const handleCreateVersion = async (data: ComplianceRuleFormData) => {
    if (!rule) return;
    setSavingVersion(true);
    try {
      const result = await graphqlMutation<{ createComplianceRuleVersion: { version: any; errors: any[] } }, any>(
        CREATE_COMPLIANCE_RULE_VERSION_MUTATION,
        { input: buildComplianceVersionInput(rule.id, data) }
      );
      const errors = result.data?.createComplianceRuleVersion?.errors || [];
      if (errors.length > 0) {
        alert(`Failed to create version: ${errors.map((e: any) => e.message).join(', ')}`);
        return;
      }
      setShowNewVersion(false);
      await fetchRule();
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setSavingVersion(false);
    }
  };

  const handleSaveEdit = async (data: ComplianceRuleFormData) => {
    if (!rule) return;
    setSavingEdit(true);
    try {
      const result = await graphqlMutation<{ updateComplianceRule: { rule: any; errors: any[] } }, any>(
        UPDATE_COMPLIANCE_RULE_MUTATION,
        {
          id: rule.id,
          input: {
            ruleName: data.ruleName,
            ruleCategory: data.ruleCategory,
            appliesToAll: data.appliesToAll,
            description: data.description || undefined,
            isActive: true,
          },
        }
      );
      const errors = result.data?.updateComplianceRule?.errors || [];
      if (errors.length > 0) {
        alert(`Failed to update rule: ${errors.map((e: any) => e.message).join(', ')}`);
        return;
      }
      setEditMode(false);
      await fetchRule();
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAddScope = async () => {
    if (!rule || !newEntityCode) return;
    setAddingScope(true);
    try {
      const lookup = await graphqlQuery<{ entities: { edges: Array<{ node: { id: string; entityCode: string } }> } }, any>(
        ENTITIES_QUERY,
        { filter: { domainCode: rule.anchorDomainCode, entityCode: newEntityCode }, pagination: { first: 1 } },
        'network-only'
      );
      const entity = lookup.data?.entities?.edges?.[0]?.node;
      if (!entity) {
        alert(`No ${rule.anchorDomainCode} entity found with code "${newEntityCode}"`);
        return;
      }
      const result = await graphqlMutation<{ createComplianceScopeAssignment: { errors: any[] } }, any>(
        CREATE_COMPLIANCE_SCOPE_ASSIGNMENT_MUTATION,
        { input: { ruleId: rule.id, scopeType: 'INCLUDE', entityId: entity.id, includeChildren: false } }
      );
      const errors = result.data?.createComplianceScopeAssignment?.errors || [];
      if (errors.length > 0) {
        alert(`Failed to add entity: ${errors.map((e: any) => e.message).join(', ')}`);
        return;
      }
      setNewEntityCode('');
      await fetchRule();
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setAddingScope(false);
    }
  };

  const handleRemoveScope = async (id: string) => {
    await graphqlMutation(DELETE_COMPLIANCE_SCOPE_ASSIGNMENT_MUTATION, { id });
    await fetchRule();
  };

  const handleEvaluate = async () => {
    if (!rule) return;
    setEvaluating(true);
    try {
      const result = await graphqlMutation<{ evaluateComplianceRule: { run: RunDto; errors: any[] } }, any>(
        EVALUATE_COMPLIANCE_RULE_MUTATION,
        {
          input: {
            ruleCode: rule.ruleCode,
            asOfDate,
            knowledgeDate: knowledgeDate || undefined,
            sourceScope: sourceScope || undefined,
          },
        }
      );
      const errors = result.data?.evaluateComplianceRule?.errors || [];
      const run = result.data?.evaluateComplianceRule?.run;
      if (errors.length > 0 || !run) {
        alert(`Evaluation failed: ${errors.map((e: any) => e.message).join(', ') || 'Unknown error'}`);
        return;
      }
      await loadRunResults(run.id);
      await fetchRuns(rule.id);
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setEvaluating(false);
    }
  };

  const loadRunResults = async (runId: string) => {
    const result = await graphqlQuery<{ complianceEvaluationRun: { run: RunDto } & RunDto & { results: ResultDto[] } }, { id: string }>(
      COMPLIANCE_EVALUATION_RUN_QUERY,
      { id: runId },
      'network-only'
    );
    const run = result.data?.complianceEvaluationRun as any;
    if (run) {
      setActiveRun(run);
      setResults(run.results || []);
    }
  };

  if (loading) {
    return (
      <div className="view-fade">
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div className="loader">Loading rule...</div>
        </div>
      </div>
    );
  }

  if (!rule) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href="/admin/compliance" className="crumb-link">Compliance Rules</Link>
          <span className="sep">›</span>
          <span className="crumb-current">Not Found</span>
        </div>
        <div className="page-header">
          <div>
            <div className="page-title">Rule Not Found</div>
            <div className="page-meta">No compliance rule with code "{ruleCode}" exists.</div>
          </div>
        </div>
      </div>
    );
  }

  const v = rule.currentVersion;

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/admin/compliance" className="crumb-link">Compliance Rules</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{rule.ruleCode}</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{rule.ruleName}</div>
          <div className="page-meta">
            <span className="mono">{rule.ruleCode}</span> · {rule.ruleCategory} · Anchor: {rule.anchorDomainCode}
            {v ? ` · Version ${v.versionNumber}` : ' · No active version'}
          </div>
        </div>
        <div className="page-actions">
          <Link href="/admin/compliance"><button className="btn">← Back</button></Link>
          <button className="btn" onClick={() => {
            if (editMode) {
              setEditMode(false);
            } else {
              setEditData(versionToFormData(rule, rule.currentVersion || rule.versions[0]));
              setEditMode(true);
            }
          }}>
            {editMode ? '✕ Cancel' : '✎ Edit Rule'}
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewVersion(true)}>+ New Version</button>
        </div>
      </div>

      {rule.description && !editMode && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '14px 18px', marginBottom: '18px', fontSize: '13px', color: 'var(--ink-2)' }}>
          {rule.description}
        </div>
      )}

      {editMode ? (
        <ComplianceRuleForm
          initial={editData}
          onSubmit={handleSaveEdit}
          onCancel={() => setEditMode(false)}
          submitting={savingEdit}
        />
      ) : showNewVersion ? (
        <ComplianceRuleForm
          initial={v ? versionToFormData(rule, v) : { ruleCode: rule.ruleCode, ruleName: rule.ruleName, ruleCategory: rule.ruleCategory, anchorDomainCode: rule.anchorDomainCode, appliesToAll: rule.appliesToAll, description: rule.description || '' }}
          lockIdentity
          onSubmit={handleCreateVersion}
          onCancel={() => setShowNewVersion(false)}
          submitting={savingVersion}
        />
      ) : (
        <>
          {/* Current Version Detail */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 22px', marginBottom: '18px' }}>
            <div className="section-kicker">Current Version Logic</div>
            {!v ? (
              <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>No version defined yet. Click "+ New Version" to define the rule's logic.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '10px' }}>
                <div>
                  <DetailRow label="Base entity domain" value={v.baseDomainCode} />
                  <DetailRow label="Hierarchy rollup path" value={formatHops(v.baseRollupPath)} />
                  <DetailRow label="Group-by path" value={formatHops(v.groupByPath)} />
                  <DetailRow label="Group-by attribute" value={v.groupByAttributeCode || '—'} />
                  <DetailRow label="Default source scope" value={v.defaultSourceScope} />
                  <DetailRow label="Effective" value={`${v.validFrom} → ${v.validTo === '9999-12-31' ? 'present' : v.validTo}`} />
                </div>
                <div>
                  <DetailRow label="Numerator" value={`${v.numeratorAggregation}(${v.numeratorAttributeCode})`} />`n                  <DetailRow label="Numerator reads" value={describeDimension(v.numeratorDimension)} />
                  <DetailRow
                    label="Denominator"
                    value={
                      v.denominatorScope === 'CONSTANT'
                        ? `Constant: ${v.denominatorConstantValue}`
                        : v.denominatorAttributeCode
                        ? `${v.denominatorAggregation}(${v.denominatorAttributeCode}) — ${v.denominatorScope}`
                        : '—'
                    }
                  />
                  <DetailRow label="Denominator reads" value={v.denominatorAttributeCode ? describeDimension(v.denominatorDimension) : "—"} />`n                  <DetailRow label="Result calculation" value={v.resultTransform || "NONE"} />`n                  <DetailRow label="Result unit" value={v.resultUnit} />
                  <DetailRow label="Limit direction" value={v.limitDirection} />
                  <DetailRow
                    label="Limits"
                    value={
                      <>
                        {v.softLimitValue != null && <span style={{ color: 'var(--amber)', marginRight: '12px' }}>Soft: {v.softLimitValue}</span>}
                        {v.hardLimitValue != null && <span style={{ color: 'var(--red)' }}>Hard: {v.hardLimitValue}</span>}
                        {v.softLimitValue == null && v.hardLimitValue == null && '—'}
                      </>
                    }
                  />
                </div>
                {v.conditions.length > 0 && (
                  <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--line)', paddingTop: '12px' }}>
                    <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '8px' }}>
                      Conditions
                    </div>
                    {['BASE', 'ANCHOR'].map((scope) => {
                      const scopeConds = v.conditions.filter((c) => c.appliesTo === scope).sort((a, b) => a.conditionOrder - b.conditionOrder);
                      if (scopeConds.length === 0) return null;
                      return (
                        <div key={scope} style={{ marginBottom: '8px', fontSize: '12px' }}>
                          <span style={{ color: 'var(--ink-3)', fontWeight: 600 }}>{scope}: </span>
                          {scopeConds.map((c, i) => (
                            <span key={i} className="mono">
                              {i > 0 && <span style={{ color: 'var(--accent)' }}> {c.logicOperator} </span>}
                              {pathPrefix(c.attributeDimension)}{c.attributeCode}{c.attributeDimension ? ` [${describeDimension(c.attributeDimension)}]` : ""} {c.operator} {c.compareAttributeCode ? `${pathPrefix(c.compareDimension)}${c.compareAttributeCode}${c.compareDimension ? ` [${describeDimension(c.compareDimension)}]` : ""}` : (c.value || "")}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Scope Assignments */}
          {!rule.appliesToAll && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 22px', marginBottom: '18px' }}>
              <div className="section-kicker">Entity Scope ({rule.anchorDomainCode})</div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px', marginBottom: '12px' }}>
                <input
                  className="text-input"
                  style={{ maxWidth: '240px' }}
                  value={newEntityCode}
                  onChange={(e) => setNewEntityCode(e.target.value)}
                  placeholder={`${rule.anchorDomainCode} entity code...`}
                />
                <button className="btn" onClick={handleAddScope} disabled={addingScope || !newEntityCode}>
                  {addingScope ? 'Adding...' : '+ Add Entity'}
                </button>
              </div>
              {rule.scopeAssignments.length === 0 ? (
                <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>No entities assigned yet.</div>
              ) : (
                rule.scopeAssignments.map((sa) => (
                  <div key={sa.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: '12px' }}>
                    <div>
                      <span style={{ fontSize: '10px', padding: '2px 7px', background: sa.scopeType === 'INCLUDE' ? '#e1f1e7' : '#fdecec', color: sa.scopeType === 'INCLUDE' ? 'var(--green)' : 'var(--red)', fontWeight: 600, marginRight: '8px' }}>
                        {sa.scopeType}
                      </span>
                      <span className="mono">{sa.entityCode || sa.entityId}</span>
                      {sa.entityName && <span style={{ color: 'var(--ink-3)', marginLeft: '8px' }}>{sa.entityName}</span>}
                      {sa.includeChildren && <span style={{ color: 'var(--ink-3)', marginLeft: '8px', fontSize: '10px' }}>(+ children)</span>}
                    </div>
                    <button className="btn btn-sm" onClick={() => handleRemoveScope(sa.id)}>Remove</button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Evaluate */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 22px', marginBottom: '18px' }}>
            <div className="section-kicker">Evaluate</div>
            <div className="form-grid" style={{ marginTop: '10px' }}>
              <div className="field">
                <label>As-Of Date</label>
                <input className="text-input mono" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Knowledge Date (optional)</label>
                <input className="text-input mono" type="datetime-local" value={knowledgeDate} onChange={(e) => setKnowledgeDate(e.target.value)} />
                <span className="field-hint">Reproduces historical rule behavior — leave blank for "as known now"</span>
              </div>
              <div className="field">
                <label>Source Scope Override (optional)</label>
                <input className="text-input" value={sourceScope} onChange={(e) => setSourceScope(e.target.value)} placeholder={v?.defaultSourceScope || 'GOLDEN'} />
              </div>
            </div>
            <button className="btn btn-primary" onClick={handleEvaluate} disabled={evaluating || !v} style={{ marginTop: '8px' }}>
              {evaluating ? 'Evaluating...' : 'Run Evaluation'}
            </button>

            {activeRun && (
              <div style={{ marginTop: '18px', borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
                <div style={{ display: 'flex', gap: '20px', fontSize: '12px', marginBottom: '12px' }}>
                  <span>Status: <strong>{activeRun.runStatus}</strong></span>
                  <span>Results: <strong className="mono">{activeRun.resultCount ?? results.length}</strong></span>
                  <span>Breaches: <strong className="mono" style={{ color: (activeRun.breachCount ?? 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{activeRun.breachCount ?? results.filter((r) => r.status !== 'PASS').length}</strong></span>
                </div>
                {activeRun.errorMessage && <div style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '10px' }}>{activeRun.errorMessage}</div>}
                {results.length > 0 && (
                  <ResultsTable results={results} />
                )}
              </div>
            )}
          </div>

          {/* Run History */}
          {runs.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 22px' }}>
              <div className="section-kicker">Evaluation History</div>
              {runs.map((run) => (
                <div
                  key={run.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: '12px', cursor: 'pointer' }}
                  onClick={() => loadRunResults(run.id)}
                >
                  <span className="mono">{run.asOfDate} · {new Date(run.startedAt).toLocaleString()}</span>
                  <span>{run.sourceScope}</span>
                  <span>{run.runStatus}</span>
                  <span className="mono">{run.resultCount ?? 0} results</span>
                  <span className="mono" style={{ color: (run.breachCount ?? 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{run.breachCount ?? 0} breaches</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '12px' }}>
      <span style={{ color: 'var(--ink-3)' }}>{label}</span>
      <span className="mono" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ResultsTable({ results }: { results: ResultDto[] }) {
  return (
    <div className="data-table">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 90px 90px 90px 110px',
          gap: '10px',
          padding: '10px 14px',
          background: 'var(--bg)',
          borderBottom: '1px solid var(--line)',
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          color: 'var(--ink-3)',
        }}
      >
        <div>Anchor Entity</div>
        <div>Group</div>
        <div style={{ textAlign: 'right' }}>Numerator</div>
        <div style={{ textAlign: 'right' }}>Denominator</div>
        <div style={{ textAlign: 'right' }}>Value</div>
        <div style={{ textAlign: 'center' }}>Status</div>
      </div>
      {results.map((r) => {
        const style = STATUS_STYLE[r.status] || STATUS_STYLE.NO_DATA;
        return (
          <div
            key={r.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1fr 90px 90px 90px 110px',
              gap: '10px',
              padding: '10px 14px',
              borderBottom: '1px solid var(--line)',
              fontSize: '12px',
              alignItems: 'center',
            }}
          >
            <div className="mono">{r.anchorEntityCode || r.anchorEntityId}</div>
            <div className="mono" style={{ fontSize: '11px' }}>{r.groupByValue || '—'}</div>
            <div className="mono" style={{ textAlign: 'right' }}>{formatNum(r.numeratorValue)}</div>
            <div className="mono" style={{ textAlign: 'right' }}>{formatNum(r.denominatorValue)}</div>
            <div className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{formatNum(r.computedValue)}</div>
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontSize: '10px', padding: '3px 8px', background: style.bg, color: style.fg, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {r.status.replace('_', ' ')}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatNum(n?: number | null) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function displayConditionValue(operator: string, value?: string | null): string {
  if (!value) return '';
  if ((operator === 'in' || operator === 'not_in') && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.join(', ');
    } catch {
      return value;
    }
  }
  return value;
}

function pathPrefix(dim: any): string {
  const hops = dim?.relationshipPath || [];
  if (!hops.length) return '';
  return `${hops.map((h: any) => h.relationshipCode).join(' → ')} · `;
}

function formatHops(hops: RollupHopDto[]) {
  if (!hops || hops.length === 0) return '—';
  return hops.map((h) => `${h.direction}${h.recursive ? '*' : ''}:${h.relationshipCode}`).join(' → ');
}

function versionToFormData(rule: RuleDto, v: VersionDto): Partial<ComplianceRuleFormData> {
  return {
    ruleCode: rule.ruleCode,
    ruleName: v.ruleName,
    ruleCategory: rule.ruleCategory,
    anchorDomainCode: rule.anchorDomainCode,
    appliesToAll: rule.appliesToAll,
    description: rule.description || '',
    validFrom: new Date().toISOString().slice(0, 10),
    changeReason: '',
    baseDomainCode: v.baseDomainCode,
    baseRollupPath: v.baseRollupPath.map((h) => ({ relationshipCode: h.relationshipCode, direction: h.direction as 'UP' | 'DOWN', recursive: h.recursive })),
    groupByPath: v.groupByPath.map((h) => ({ relationshipCode: h.relationshipCode, direction: h.direction as 'UP' | 'DOWN', recursive: h.recursive })),
    groupByAttributeCode: v.groupByAttributeCode || '',
    numeratorAttributeCode: v.numeratorAttributeCode,
    numeratorAggregation: v.numeratorAggregation,
    numeratorDimension: dimensionFromDto(v.numeratorDimension),
    denominatorDimension: dimensionFromDto(v.denominatorDimension),
    resultTransform: v.resultTransform || 'NONE',
    denominatorAttributeCode: v.denominatorAttributeCode || '',
    denominatorAggregation: v.denominatorAggregation || 'SUM',
    denominatorScope: v.denominatorScope,
    denominatorConstantValue: v.denominatorConstantValue != null ? String(v.denominatorConstantValue) : '',
    resultUnit: v.resultUnit,
    limitDirection: v.limitDirection,
    softLimitValue: v.softLimitValue != null ? String(v.softLimitValue) : '',
    hardLimitValue: v.hardLimitValue != null ? String(v.hardLimitValue) : '',
    defaultSourceScope: v.defaultSourceScope,
    conditions: v.conditions.map((c) => ({
      appliesTo: c.appliesTo as 'BASE' | 'ANCHOR',
      conditionGroup: 1,
      conditionOrder: c.conditionOrder,
      attributeCode: c.attributeCode,
      attributePath: (c.attributeDimension?.relationshipPath || []).map((h: any) => ({ relationshipCode: h.relationshipCode, direction: h.direction })),
      attributeDimension: dimensionFromDto(c.attributeDimension),
      operator: c.operator,
      value: displayConditionValue(c.operator, c.value),
      compareAttributeCode: c.compareAttributeCode || '',
      compareAttributePath: (c.compareDimension?.relationshipPath || []).map((h: any) => ({ relationshipCode: h.relationshipCode, direction: h.direction })),
      compareDimension: dimensionFromDto(c.compareDimension),
      logicOperator: c.logicOperator as 'AND' | 'OR',
    })),
  };
}
