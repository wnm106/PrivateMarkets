'use client';

import type { ICellRendererParams } from 'ag-grid-community';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { useParams, useRouter } from 'next/navigation';
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
  COMPLIANCE_RESULT_CONTRIBUTORS_QUERY,
  ENTITIES_QUERY,
} from '@/lib/graphql';
import { printExpression, type OperandContext } from '@/lib/condition-expression';
import { ComplianceRuleForm, ComplianceRuleFormData, MeasureLineForm, OPERATOR_LABELS, buildComplianceVersionInput, dimensionFromDto, describeDimension, emptyDimension } from '@/components/forms/ComplianceRuleForm';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

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
  denominatorSource?: string;
  denominatorConstantValue?: number;
  resultUnit: string;
  limitDirection: string;
  softLimitValue?: number;
  hardLimitValue?: number;
  hardLimitAttributeCode?: string;
  softLimitFactor?: number;
  defaultSourceScope: string;
  metadata?: Record<string, any> | null;
  conditions: Array<{
    appliesTo: string;
    conditionGroup?: number;
    conditionOrder: number;
    attributeCode: string;
    attributeDimension?: any;
    operator: string;
    value?: string;
    compareAttributeCode?: string;
    compareDimension?: any;
    leftExpression?: any;
    rightExpression?: any;
    logicOperator: string;
  }>;
  measureLines?: Array<{
    side: MeasureLineForm['side'];
    lineOrder: number;
    label?: string | null;
    kind: string;
    sign: number;
    attributeCode?: string | null;
    dimension?: any;
    expression?: any;
    path?: RollupHopDto[];
    weightAttributeCode?: string | null;
    valuePath?: RollupHopDto[];
    transform?: string | null;
    priceAttributeCode?: string | null;
    pct?: number | null;
    pctAttributeCode?: string | null;
    pctPath?: RollupHopDto[];
    totalPath?: RollupHopDto[];
    required?: boolean | null;
    conditions?: VersionDto['conditions'];
    totalConditions?: VersionDto['conditions'];
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
  const router = useRouter();

  const [rule, setRule] = useState<RuleDto | null>(null);
  const [loading, setLoading] = useState(true);

  const [evaluating, setEvaluating] = useState(false);
  const [drillResult, setDrillResult] = useState<ResultDto | null>(null);

  const [activeRun, setActiveRun] = useState<RunDto | null>(null);
  const [results, setResults] = useState<ResultDto[]>([]);

  const [newEntityCode, setNewEntityCode] = useState('');
  const [addingScope, setAddingScope] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  usePublishViewContext(
    rule
      ? {
          activity: 'editing',
          kind: 'compliance-rule',
          label: rule.ruleName || rule.ruleCode,
          id: rule.id,
          domainCode: rule.anchorDomainCode,
          summary: rule.description,
          snapshot: {
            ruleCode: rule.ruleCode,
            ruleCategory: rule.ruleCategory,
            anchorDomainCode: rule.anchorDomainCode,
            isActive: rule.isActive,
            appliesToAll: rule.appliesToAll,
            currentVersion: rule.currentVersion
              ? {
                  versionNumber: rule.currentVersion.versionNumber,
                  baseDomainCode: rule.currentVersion.baseDomainCode,
                  numeratorAttributeCode: rule.currentVersion.numeratorAttributeCode,
                  numeratorAggregation: rule.currentVersion.numeratorAggregation,
                  denominatorAttributeCode: rule.currentVersion.denominatorAttributeCode,
                  denominatorAggregation: rule.currentVersion.denominatorAggregation,
                  resultUnit: rule.currentVersion.resultUnit,
                  resultTransform: rule.currentVersion.resultTransform,
                  softLimitValue: rule.currentVersion.softLimitValue,
                  hardLimitValue: rule.currentVersion.hardLimitValue,
                  groupByAttributeCode: rule.currentVersion.groupByAttributeCode,
                }
              : null,
            scopes: (rule.scopeAssignments || []).slice(0, 20).map((scope) => ({
              scopeType: scope.scopeType,
              entityCode: scope.entityCode,
              entityName: scope.entityName,
            })),
          },
        }
      : null
  );

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

  useEffect(() => {
    fetchRule();
  }, [ruleCode]);

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
          },
        }
      );
      const errors = result.data?.updateComplianceRule?.errors || [];
      if (errors.length > 0) {
        alert(`Failed to update rule: ${errors.map((e: any) => e.message).join(', ')}`);
        return;
      }
      const versionResult = await graphqlMutation<{ createComplianceRuleVersion: { version: any; errors: any[] } }, any>(
        CREATE_COMPLIANCE_RULE_VERSION_MUTATION,
        { input: buildComplianceVersionInput(rule.id, { ...data, changeReason: data.changeReason || 'Updated definition' }) }
      );
      const versionErrors = versionResult.data?.createComplianceRuleVersion?.errors || [];
      if (versionErrors.length > 0) {
        alert(`The name was saved, but the measure was not: ${versionErrors.map((e: any) => e.message).join(', ')}`);
        return;
      }
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
            // A test always runs as of today, on the sources the rule is set to read.
            asOfDate: new Date().toISOString().slice(0, 10),
            // No thresholds may exist yet while a rule is being built, so a test covers every fund.
            allFunds: true,
          },
        }
      );
      const errors = result.data?.evaluateComplianceRule?.errors || [];
      const run = result.data?.evaluateComplianceRule?.run;
      if (errors.length > 0 || !run) {
        alert(`Evaluation failed: ${errors.map((e: any) => e.message).join(', ') || 'Unknown error'}`);
        return;
      }
      setDrillResult(null);
      await loadRunResults(run.id);
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
      <nav className="subnav" aria-label="Navigation">
        <Link href="/admin/compliance" className="subnav-back">← Back to compliance rules</Link>
        <span className="subnav-trail">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href="/admin/compliance" className="crumb-link">Compliance Rules</Link>
          <span className="sep">›</span>
          <span className="crumb-current">{rule.ruleCode}</span>
        </span>
      </nav>

      <ComplianceRuleForm
        key={v?.id || rule.id}
        initial={versionToFormData(rule, v || rule.versions[0])}
        onSubmit={handleSaveEdit}
        onCancel={() => router.push('/admin/compliance')}
        submitting={savingEdit}
        onTest={handleEvaluate}
        testing={evaluating}
        testDisabled={!v}
        ribbonHeader={(
          <>
            <div>
              <div className="page-title">{rule.ruleName}</div>
              <div className="page-meta">
                <span className="mono">{rule.ruleCode}</span> · {rule.ruleCategory} · Anchor: {rule.anchorDomainCode}
                {v ? ` · Version ${v.versionNumber}` : ' · No active version'}
              </div>
            </div>
          </>
        )}
      />

      <div style={{ height: 18 }} />
      {(
        <>
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
                      <span style={{ fontSize: '11px', padding: '2px 7px', background: sa.scopeType === 'INCLUDE' ? '#e1f1e7' : '#fdecec', color: sa.scopeType === 'INCLUDE' ? 'var(--green)' : 'var(--red)', fontWeight: 600, marginRight: '8px' }}>
                        {sa.scopeType}
                      </span>
                      <span className="mono">{sa.entityCode || sa.entityId}</span>
                      {sa.entityName && <span style={{ color: 'var(--ink-3)', marginLeft: '8px' }}>{sa.entityName}</span>}
                      {sa.includeChildren && <span style={{ color: 'var(--ink-3)', marginLeft: '8px', fontSize: '11px' }}>(+ children)</span>}
                    </div>
                    <button className="btn btn-sm" onClick={() => handleRemoveScope(sa.id)}>Remove</button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Test results pop-up */}
          {activeRun && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Test results"
              onClick={() => { setActiveRun(null); setDrillResult(null); }}
              style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3vh 16px', overflow: 'hidden' }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 20px 50px rgba(15, 23, 42, 0.3)', width: 'min(1100px, 100%)', height: '94vh', display: 'flex', flexDirection: 'column', padding: '18px 22px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div className="section-kicker">Test results · {rule.ruleName}</div>
                    <div className="field-hint" style={{ marginTop: 4 }}>Run as of today for every fund, whether or not it has a threshold yet. Click a fund to see the records behind its number.</div>
                  </div>
                  <button type="button" className="btn btn-sm" aria-label="Close test results" onClick={() => { setActiveRun(null); setDrillResult(null); }}>Close</button>
                </div>
                <div style={{ marginTop: '14px', borderTop: '1px solid var(--line)', paddingTop: '14px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
                  <div style={{ display: 'flex', gap: '20px', fontSize: '12px', marginBottom: '12px' }}>
                    <span>Status: <strong>{activeRun.runStatus}</strong></span>
                    <span>Results: <strong className="mono">{activeRun.resultCount ?? results.length}</strong></span>
                    <span>Breaches: <strong className="mono" style={{ color: (activeRun.breachCount ?? 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{activeRun.breachCount ?? results.filter((r) => r.status !== 'PASS').length}</strong></span>
                  </div>
                  {activeRun.errorMessage && <div style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '10px' }}>{activeRun.errorMessage}</div>}
                  {results.length > 0 ? (
                    <div style={{ maxHeight: '30vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
                      <ResultsTable results={results} resultUnit={v?.resultUnit} onOpen={setDrillResult} />
                    </div>
                  ) : (
                    <div className="field-hint">No funds were scored.</div>
                  )}
                  {drillResult && results.some((r) => r.id === drillResult.id) && (
                    <ContributorsPanel result={drillResult} resultUnit={v?.resultUnit} onClose={() => setDrillResult(null)} />
                  )}
                </div>
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}

function conditionSentence(c: VersionDto['conditions'][number]) {
  const left = c.leftExpression ? printExpression(c.leftExpression, NO_CONTEXT) : `${pathPrefix(c.attributeDimension)}${words(c.attributeCode)}`;
  const right = c.rightExpression
    ? printExpression(c.rightExpression, NO_CONTEXT)
    : c.compareAttributeCode
    ? `${pathPrefix(c.compareDimension)}${words(c.compareAttributeCode)}`
    : displayConditionValue(c.operator, c.value);
  const nullary = c.operator === 'is_null' || c.operator === 'is_not_null';
  return (
    <>
      <b>{left}</b> {OPERATOR_LABELS[c.operator as keyof typeof OPERATOR_LABELS] || c.operator}
      {!nullary && <> <b>{right || '…'}</b></>}
    </>
  );
}

function words(code?: string | null) {
  if (!code) return '—';
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function aggWord(code?: string | null) {
  return ({ SUM: 'Sum', AVG: 'Average', COUNT: 'Count', MIN: 'Lowest', MAX: 'Highest', VALUE: 'Value' } as Record<string, string>)[code || ''] || words(code);
}

function unitWord(code?: string | null) {
  return ({ PERCENTAGE: 'Percent of denominator', RATIO: 'Ratio', CURRENCY: 'Currency amount', COUNT: 'Count' } as Record<string, string>)[code || ''] || words(code);
}

function denominatorText(version: VersionDto) {
  if (version.denominatorScope === 'CONSTANT') return `Fixed number ${version.denominatorConstantValue ?? ''}`.trim();
  if (version.denominatorSource === 'ANCHOR' && version.denominatorAttributeCode) return `A value on the fund · ${words(version.denominatorAttributeCode)}`;
  if (!version.denominatorAttributeCode) return 'No denominator';
  const scope = version.denominatorScope === 'ANCHOR_TOTAL' ? 'Total of all records' : 'Total of its group';
  return `${scope} · ${words(version.baseDomainCode)} · ${words(version.denominatorAttributeCode)}`;
}

function conditionText(c: VersionDto['conditions'][number]) {
  const left = c.leftExpression ? printExpression(c.leftExpression, NO_CONTEXT) : `${pathPrefix(c.attributeDimension)}${c.attributeCode}`;
  const right = c.rightExpression
    ? printExpression(c.rightExpression, NO_CONTEXT)
    : c.compareAttributeCode
    ? `${pathPrefix(c.compareDimension)}${c.compareAttributeCode}`
    : (c.value || '');
  return `${left} ${c.operator} ${right}`.trim();
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '12px' }}>
      <span style={{ color: 'var(--ink-3)' }}>{label}</span>
      <span className="mono" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ResultsTable({ results, resultUnit, onOpen }: { results: ResultDto[]; resultUnit?: string; onOpen?: (row: ResultDto) => void }) {
  const columns = useMemo<ColDef<ResultDto>[]>(() => [
    {
      colId: 'anchor',
      headerName: 'Fund',
      minWidth: 160,
      flex: 1.4,
      cellClass: 'mono',
      valueGetter: (params) => params.data?.anchorEntityName || params.data?.anchorEntityCode || params.data?.anchorEntityId || '',
    },
    {
      field: 'groupByValue',
      headerName: 'Group',
      minWidth: 140,
      flex: 1,
      valueFormatter: (params) => params.value || '—',
    },
    { field: 'numeratorValue', headerName: 'Numerator', minWidth: 120, valueFormatter: (params) => formatNum(params.value) },
    { field: 'denominatorValue', headerName: 'Denominator', minWidth: 130, valueFormatter: (params) => formatNum(params.value) },
    { field: 'contributingCount', headerName: 'Records', minWidth: 100, valueFormatter: (params) => (params.value == null ? '—' : String(params.value)) },
    { field: 'computedValue', headerName: 'Value', minWidth: 130, valueFormatter: (params) => formatNum(params.value, resultUnit) },
    {
      field: 'status',
      headerName: 'Status',
      minWidth: 140,
      cellRenderer: (params: ICellRendererParams<ResultDto>) => {
        if (!params.value) return null;
        const style = STATUS_STYLE[String(params.value)] || STATUS_STYLE.NO_DATA;
        return <span style={{ fontSize: 11, padding: '3px 8px', background: style.bg, color: style.fg, fontWeight: 600 }}>{String(params.value).replace('_', ' ')}</span>;
      },
    },
  ], [resultUnit]);
  return (
    <AppGrid
      rows={results}
      columns={columns}
      getRowId={(row) => row.id}
      autoHeight
      emptyMessage="No results."
      onRowClicked={onOpen}
    />
  );
}

interface ContributorRow {
  entityId: string;
  entityCode: string;
  entityName?: string | null;
  numeratorValue?: number | null;
  sharePercent?: number | null;
  values: Record<string, string | null>;
  amountLabel?: string | null;
  amountSide?: string | null;
}

interface ContributorsDto {
  baseDomainCode?: string | null;
  numeratorAggregation?: string | null;
  total: number;
  columns: Array<{ code: string; label: string; role: string }>;
  rows: ContributorRow[];
}

function ContributorsPanel({ result, resultUnit, onClose }: { result: ResultDto; resultUnit?: string; onClose: () => void }) {
  const [data, setData] = useState<ContributorsDto | null>(null);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // The fund list can be long, so bring the records into view when a fund is picked.
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [result.id]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    graphqlQuery<{ complianceResultContributors: ContributorsDto }, { resultId: string }>(
      COMPLIANCE_RESULT_CONTRIBUTORS_QUERY,
      { resultId: result.id },
      'network-only',
    ).then((res) => {
      if (cancelled) return;
      if (res.error || !res.data?.complianceResultContributors) setError(res.error?.message || 'Could not load the records.');
      else setData(res.data.complianceResultContributors);
    });
    return () => { cancelled = true; };
  }, [result.id]);

  const columns = useMemo<ColDef<ContributorRow>[]>(() => {
    const cols: ColDef<ContributorRow>[] = [
      ...(data?.rows.some((row) => row.amountLabel) ? [{ colId: 'amount', headerName: 'Amount', minWidth: 170, flex: 1, valueGetter: (p: any) => p.data?.amountLabel || '' }] : []),
      { colId: 'record', headerName: 'Record', minWidth: 200, flex: 1.4, valueGetter: (p) => (p.data ? `${p.data.entityName || p.data.entityCode}` : '') },
      { colId: 'code', headerName: 'Code', minWidth: 140, cellClass: 'mono', valueGetter: (p) => p.data?.entityCode || '' },
    ];
    for (const col of data?.columns || []) {
      cols.push({ colId: `v-${col.code}`, headerName: `${col.label} (${col.role.toLowerCase()})`, minWidth: 150, flex: 1, valueGetter: (p) => p.data?.values?.[col.code] ?? '—' });
    }
    cols.push(
      { colId: 'contribution', headerName: data?.numeratorAggregation?.startsWith('COUNT') ? 'Count' : 'Contribution', minWidth: 130, valueGetter: (p) => p.data?.numeratorValue, valueFormatter: (p) => formatNum(p.value) },
      { colId: 'share', headerName: 'Share', minWidth: 100, valueGetter: (p) => p.data?.sharePercent, valueFormatter: (p) => (p.value == null ? '—' : `${Number(p.value).toFixed(1)}%`) },
    );
    return cols;
  }, [data]);

  return (
    <div ref={panelRef} style={{ marginTop: '18px', border: '2px solid var(--accent)', borderRadius: 6, padding: '14px 16px', background: 'var(--bg)', scrollMarginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div>
          <strong>{result.anchorEntityName || result.anchorEntityCode || 'Fund'}</strong>
          {result.groupByValue && <span style={{ color: 'var(--ink-3)' }}> · {result.groupByValue}</span>}
          <span style={{ color: 'var(--ink-3)', fontSize: 12 }}> · result {formatNum(result.computedValue, resultUnit)} = {formatNum(result.numeratorValue)} ÷ {result.denominatorValue == null ? '—' : formatNum(result.denominatorValue)}</span>
        </div>
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Loading records…</div>}
      {data && (
        <>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
            {data.total} {data.baseDomainCode ? `${data.baseDomainCode.toLowerCase()} ` : ''}record{data.total === 1 ? '' : 's'} contributed to this result.
          </div>
          {data.rows.some((row) => row.amountSide) ? (
            (['NUMERATOR', 'DENOMINATOR'] as const).map((side) => {
              const sideRows = data.rows.filter((row) => row.amountSide === side);
              if (!sideRows.length) return null;
              const total = sideRows.reduce((sum, row) => sum + (row.numeratorValue ?? 0), 0);
              return (
                <div key={side} style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <strong>{side === 'NUMERATOR' ? 'Numerator' : 'Denominator'}</strong>
                    <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{sideRows.length} record{sideRows.length === 1 ? '' : 's'} · total {formatNum(total)}</span>
                  </div>
                  <div style={{ maxHeight: '40vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
                    <AppGrid rows={sideRows} columns={columns} getRowId={(row) => `${row.amountSide || ''}:${row.amountLabel || ''}:${row.entityId}`} autoHeight emptyMessage="No records contributed." />
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ maxHeight: '40vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
              <AppGrid rows={data.rows} columns={columns} getRowId={(row) => row.entityId} autoHeight emptyMessage="No records contributed." />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatNum(n?: number | null, unit?: string) {
  if (n == null) return '—';
  if (unit === 'PERCENTAGE') return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  if (unit === 'CURRENCY') return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  if (unit === 'COUNT') return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
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

const NO_CONTEXT: OperandContext = { fields: [], relationshipTypes: [] };

function hopToForm(hop: RollupHopDto) {
  return { relationshipCode: hop.relationshipCode, direction: hop.direction as 'UP' | 'DOWN', recursive: Boolean(hop.recursive) };
}

function conditionToForm(c: VersionDto['conditions'][number], index: number) {
  return {
    appliesTo: 'LINE' as const,
    conditionGroup: c.conditionGroup || 1,
    conditionOrder: c.conditionOrder || index + 1,
    attributeCode: c.attributeCode,
    attributePath: (c.attributeDimension?.relationshipPath || []).map((h: RollupHopDto) => ({ relationshipCode: h.relationshipCode, direction: h.direction as 'UP' | 'DOWN' })),
    attributeDimension: dimensionFromDto(c.attributeDimension),
    operator: c.operator,
    value: displayConditionValue(c.operator, c.value),
    compareAttributeCode: c.compareAttributeCode || '',
    compareAttributePath: (c.compareDimension?.relationshipPath || []).map((h: RollupHopDto) => ({ relationshipCode: h.relationshipCode, direction: h.direction as 'UP' | 'DOWN' })),
    compareDimension: dimensionFromDto(c.compareDimension),
    leftExpression: c.leftExpression || null,
    rightExpression: c.rightExpression || null,
    logicOperator: c.logicOperator as 'AND' | 'OR',
  };
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
    denominatorScope: v.denominatorSource === 'ANCHOR'
      ? 'ANCHOR'
      : (!v.denominatorAttributeCode && v.denominatorScope !== 'CONSTANT' ? 'NONE' : v.denominatorScope),
    denominatorConstantValue: v.denominatorConstantValue != null ? String(v.denominatorConstantValue) : '',
    resultUnit: v.resultUnit,
    softLimitValue: v.softLimitValue != null ? String(v.softLimitValue) : '',
    hardLimitValue: v.hardLimitValue != null ? String(v.hardLimitValue) : '',
    hardLimitAttributeCode: v.hardLimitAttributeCode || '',
    softLimitFactor: v.softLimitFactor != null ? String(v.softLimitFactor) : '',
    defaultSourceScope: v.defaultSourceScope,
    limitMode: v.metadata?.limitMode === 'RANK' || v.metadata?.limitMode === 'NAMED' ? v.metadata.limitMode : 'UNIFORM',
    versionMetadata: v.metadata && typeof v.metadata === 'object' ? v.metadata : undefined,
    measureLines: (v.measureLines || []).map((line) => ({
      key: `${line.side}-${line.lineOrder}`,
      side: line.side,
      label: line.label || '',
      kind: line.kind,
      sign: line.sign === -1 ? -1 as const : 1 as const,
      attributeCode: line.attributeCode || '',
      dimension: dimensionFromDto(line.dimension),
      expression: line.expression || undefined,
      path: (line.path || []).map(hopToForm),
      weightAttributeCode: line.weightAttributeCode || '',
      valuePath: (line.valuePath || []).map(hopToForm),
      transform: line.transform || '',
      priceAttributeCode: line.priceAttributeCode || '',
      pct: line.pct == null ? '' : String(line.pct),
      pctAttributeCode: line.pctAttributeCode || '',
      pctPath: (line.pctPath || []).map(hopToForm),
      totalPath: (line.totalPath || []).map(hopToForm),
      required: Boolean(line.required),
      conditions: (line.conditions || []).map((c, index) => conditionToForm(c, index)),
      totalConditions: (line.totalConditions || []).map((c, index) => conditionToForm(c, index)),
    })),
    conditions: v.conditions.map((c) => ({
      appliesTo: c.appliesTo as 'BASE' | 'ANCHOR',
      conditionGroup: c.conditionGroup || 1,
      conditionOrder: c.conditionOrder,
      attributeCode: c.attributeCode,
      attributePath: (c.attributeDimension?.relationshipPath || []).map((h: any) => ({ relationshipCode: h.relationshipCode, direction: h.direction })),
      attributeDimension: dimensionFromDto(c.attributeDimension),
      operator: c.operator,
      value: displayConditionValue(c.operator, c.value),
      compareAttributeCode: c.compareAttributeCode || '',
      compareAttributePath: (c.compareDimension?.relationshipPath || []).map((h: any) => ({ relationshipCode: h.relationshipCode, direction: h.direction })),
      compareDimension: dimensionFromDto(c.compareDimension),
      leftExpression: c.leftExpression || null,
      rightExpression: c.rightExpression || null,
      logicOperator: c.logicOperator as 'AND' | 'OR',
    })),
  };
}
