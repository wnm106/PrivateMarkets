'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { CLEAR_MANUAL_OVERRIDE_MUTATION, DATA_QUALITY_DASHBOARD_QUERY, FIELD_LINEAGE_QUERY, STALE_ATTRIBUTES_QUERY, graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { STALE_AFTER_DAYS, formatReceipt } from '@/lib/receipt-freshness';
import { domainHref } from '@/lib/domain-routes';
import { AttributeValueInput, listDisplayLabel, useAttributeDisplay, useAttributeListOptions } from '@/components/forms/AttributeValueInput';
import { attributeDisplayKind, formatAttributeDisplay } from '@/lib/attribute-display';

type Section = 'availability' | 'quality' | 'trajectory' | 'handoff' | 'freshness';
type Period = 'day' | 'week' | 'month' | 'quarter' | 'custom';

interface EntityRef {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

interface AvailabilityEntity extends EntityRef {
  value: string | null;
}

interface MeasureShift extends EntityRef {
  previousValue: string | null;
  currentValue: string | null;
}

interface StaleAttribute {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  attributeCode: string;
  attributeName: string;
  sourceCode: string;
  sourceName: string;
  value: string | null;
  receivedAt: string;
  ageDays: number;
}

interface StaleReport {
  olderThanDays: number;
  asOfDate: string;
  count: number;
  attributes: StaleAttribute[];
}

interface OverrideMatch extends EntityRef {
  attributeCode: string;
  attributeName: string;
  overrideValue: string;
  overrideReason: string | null;
  prioritySourceCode: string;
  prioritySourceName: string;
  priorityValue: string;
}

interface Dashboard {
  fromDate: string;
  toDate: string;
  domains: string[];
  summary: {
    entityCount: number;
    requiredSlots: number;
    populatedSlots: number;
    missingSlots: number;
    entitiesMissingRequired: number;
    availabilityPercent: number | null;
    rulesEvaluated: number;
    passingChecks: number;
    failingChecks: number;
    entitiesFailingRules: number;
    qualityPercent: number | null;
    changedAttributeCount: number;
    changedEntityCount: number;
    attributeChangeCount: number;
    clearEntityCount: number;
    availabilityResolvedCount: number;
    availabilityIntroducedCount: number;
    qualityResolvedCount: number;
    qualityIntroducedCount: number;
    overrideMatchCount: number;
  };
  availability: Array<{
    attributeCode: string;
    attributeName: string;
    domainCode: string | null;
    requiredCount: number;
    missingCount: number;
    availabilityPercent: number | null;
    resolvedCount: number;
    introducedCount: number;
    missingEntities: EntityRef[];
    resolvedEntities: MeasureShift[];
    introducedEntities: MeasureShift[];
    entities?: AvailabilityEntity[] | null;
  }>;
  quality: Array<{
    ruleId: string;
    ruleCode: string;
    ruleName: string;
    ruleType: string;
    severity: string;
    domainCode: string | null;
    ruleExpression: string;
    ruleDescription: string | null;
    attributeCode: string | null;
    attributeName: string | null;
    evaluated: boolean;
    evaluationMessage: string | null;
    entityCount: number;
    failingCount: number;
    passingCount: number;
    acceptedCount: number;
    failingEntities: Array<EntityRef & { attributeCode: string | null; attributeName: string | null; message: string | null; actualValue: string | null }>;
    acceptedEntities: Array<EntityRef & { status: string; notes: string | null }>;
    resolvedCount: number;
    introducedCount: number;
    resolvedEntities: MeasureShift[];
    introducedEntities: MeasureShift[];
  }>;
  overrideMatches: OverrideMatch[];
  trajectory: Array<{
    attributeCode: string;
    attributeName: string;
    domainCode: string | null;
    changeCount: number;
    changes: Array<EntityRef & { previousValue: string | null; currentValue: string | null }>;
  }>;
  entities: Array<{
    id: string;
    entityCode: string;
    entityName: string;
    domainCode: string;
    requiredCount: number;
    missingCount: number;
    availabilityPercent: number | null;
    missingAttributes: Array<{ attributeCode: string; attributeName: string }>;
    ruleCount: number;
    failingRuleCount: number;
    qualityPercent: number | null;
    failingRules: Array<{
      ruleId: string;
      ruleCode: string;
      ruleName: string;
      severity: string;
      attributeCode: string | null;
      attributeName: string | null;
      message: string | null;
      actualValue: string | null;
    }>;
    acceptedRules: Array<{
      ruleId: string;
      ruleCode: string;
      ruleName: string;
      severity: string;
      attributeCode: string | null;
      attributeName: string | null;
      status: string;
      notes: string | null;
    }>;
    changeCount: number;
    changes: Array<{
      attributeCode: string;
      attributeName: string;
      previousValue: string | null;
      currentValue: string | null;
    }>;
    availabilityResolvedCount: number;
    availabilityIntroducedCount: number;
    qualityResolvedCount: number;
    qualityIntroducedCount: number;
    overrideMatchCount: number;
  }>;
}

const PAGE_SIZE = 40;
const DETAIL_PAGE = 25;

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseIso(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function shiftBack(toIso: string, period: Exclude<Period, 'custom'>) {
  const date = parseIso(toIso);
  if (period === 'day') date.setDate(date.getDate() - 1);
  if (period === 'week') date.setDate(date.getDate() - 7);
  if (period === 'month') date.setMonth(date.getMonth() - 1);
  if (period === 'quarter') date.setMonth(date.getMonth() - 3);
  return isoDate(date);
}

function formatDay(iso: string) {
  return parseIso(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—';
  if (value > 0 && value < 100 && value >= 99.95) return '99.9%';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function barColor(value: number | null) {
  if (value == null) return 'var(--ink-3)';
  if (value >= 95) return 'var(--green)';
  if (value >= 80) return 'var(--accent-2)';
  return 'var(--amber)';
}

function entityHref(domainCode: string, id: string) {
  return `${domainHref(domainCode)}/${id}`;
}

function displayValue(value: string | null | undefined) {
  if (value == null || value === '') return '—';
  return value;
}

function severityClass(severity: string) {
  const key = severity.toLowerCase();
  if (key === 'critical' || key === 'high') return 'sev-high';
  if (key === 'medium' || key === 'med') return 'sev-med';
  return 'sev-low';
}

export function DataQualityDashboard() {
  const today = useMemo(() => isoDate(new Date()), []);
  const [period, setPeriod] = useState<Period>('day');
  const [toDate, setToDate] = useState(today);
  const [fromDate, setFromDate] = useState(shiftBack(today, 'day'));
  const [domainCode, setDomainCode] = useState('');
  const [knownDomains, setKnownDomains] = useState<string[]>([]);
  const [section, setSection] = useState<Section>('availability');
  const [view, setView] = useState<'measures' | 'entities'>('measures');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detailLimit, setDetailLimit] = useState(DETAIL_PAGE);
  const [entityQuery, setEntityQuery] = useState('');
  const [entityPage, setEntityPage] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [staleDays, setStaleDays] = useState(STALE_AFTER_DAYS);
  const [staleReport, setStaleReport] = useState<StaleReport | null>(null);
  const openRule = openKey?.startsWith('rule-')
    ? dashboard?.quality.find((rule) => `rule-${rule.ruleId}` === openKey)
    : undefined;

  usePublishViewContext({
    activity: 'viewing',
    kind: 'data-quality',
    label: openRule?.ruleName || (domainCode ? `${domainCode} data quality` : 'Data quality'),
    domainCode: domainCode || undefined,
    summary: `${section}, ${view}, ${fromDate} to ${toDate}`,
    snapshot: {
      section,
      view,
      period,
      fromDate,
      toDate,
      domainCode: domainCode || null,
      openRule: openRule
        ? {
            ruleCode: openRule.ruleCode,
            ruleName: openRule.ruleName,
            severity: openRule.severity,
            domainCode: openRule.domainCode,
            entityCount: openRule.entityCount,
            failingCount: openRule.failingCount,
          }
        : null,
    },
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      graphqlQuery<{ dataQualityDashboard: Dashboard }, { domainCode: string | null; fromDate: string; toDate: string }>(
        DATA_QUALITY_DASHBOARD_QUERY,
        {
          domainCode: domainCode || null,
          fromDate,
          toDate,
        },
        'network-only'
      ),
      graphqlQuery<{ staleAttributes: StaleReport }, { domainCode: string | null; olderThanDays: number; asOfDate: string }>(
        STALE_ATTRIBUTES_QUERY,
        {
          domainCode: domainCode || null,
          olderThanDays: staleDays,
          asOfDate: toDate,
        },
        'network-only'
      ),
    ]).then(([dashboardResult, staleResult]) => {
      if (cancelled) return;
      if (dashboardResult.error || !dashboardResult.data?.dataQualityDashboard) {
        setError(dashboardResult.error?.message || 'Could not load the data quality dashboard.');
        setDashboard(null);
      } else {
        setDashboard(dashboardResult.data.dataQualityDashboard);
        setKnownDomains(dashboardResult.data.dataQualityDashboard.domains || []);
      }
      if (staleResult.error || !staleResult.data?.staleAttributes) {
        setStaleReport(null);
        if (!dashboardResult.error) setError(staleResult.error?.message || 'Could not load stale attributes.');
      } else {
        setStaleReport(staleResult.data.staleAttributes);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [domainCode, fromDate, toDate, refreshToken, staleDays]);

  useEffect(() => {
    setOpenKey(null);
    setDetailLimit(DETAIL_PAGE);
    setEntityPage(0);
  }, [domainCode, fromDate, toDate, section, view]);

  const choosePeriod = (next: Period) => {
    setPeriod(next);
    if (next === 'custom') return;
    const end = isoDate(new Date());
    setToDate(end);
    setFromDate(shiftBack(end, next));
  };

  const summary = dashboard?.summary;
  const filteredEntities = useMemo(() => {
    const rows = (dashboard?.entities ?? []).filter((entity) => {
      if (section === 'availability') return entity.missingCount > 0 || entity.availabilityResolvedCount > 0 || entity.availabilityIntroducedCount > 0;
      if (section === 'quality') return entity.failingRuleCount > 0 || entity.qualityResolvedCount > 0 || entity.qualityIntroducedCount > 0;
      if (section === 'handoff') return entity.overrideMatchCount > 0;
      return entity.changeCount > 0;
    });
    const query = entityQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((entity) =>
      entity.entityName.toLowerCase().includes(query) ||
      entity.entityCode.toLowerCase().includes(query) ||
      entity.domainCode.toLowerCase().includes(query)
    );
  }, [dashboard, entityQuery, section]);

  const entitySlice = filteredEntities.slice(entityPage * PAGE_SIZE, (entityPage + 1) * PAGE_SIZE);
  const entityPageCount = Math.max(1, Math.ceil(filteredEntities.length / PAGE_SIZE));

  const toggle = (key: string) => {
    setDetailLimit(DETAIL_PAGE);
    setOpenKey((current) => (current === key ? null : key));
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Data Quality</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">Data Quality</div>
          <div className="page-meta">
            Availability, rule results, and how those measures moved since the prior date. Overrides that now match a priority source can be cleared.
          </div>
        </div>
        <div className="page-actions">
          <Link href="/admin/dq-rules" className="btn">Rules</Link>
        </div>
      </div>

      <div className="dq-toolbar">
        <div className="dq-field">
          <label htmlFor="dq-domain">Domain</label>
          <select id="dq-domain" className="select" value={domainCode} onChange={(event) => setDomainCode(event.target.value)}>
            <option value="">All domains</option>
            {knownDomains.map((domain) => (
              <option key={domain} value={domain}>{domain}</option>
            ))}
          </select>
        </div>
        <div className="dq-field">
          <label>Period</label>
          <div className="dq-seg" role="group" aria-label="Comparison period">
            {([
              ['day', 'Day'],
              ['week', 'Week'],
              ['month', 'Month'],
              ['quarter', 'Quarter'],
              ['custom', 'Custom'],
            ] as Array<[Period, string]>).map(([value, label]) => (
              <button key={value} type="button" className={period === value ? 'active' : ''} onClick={() => choosePeriod(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="dq-field">
          <label htmlFor="dq-from">From</label>
          <input
            id="dq-from"
            className="select"
            type="date"
            value={fromDate}
            onChange={(event) => {
              setPeriod('custom');
              setFromDate(event.target.value);
            }}
          />
        </div>
        <div className="dq-field">
          <label htmlFor="dq-to">To</label>
          <input
            id="dq-to"
            className="select"
            type="date"
            value={toDate}
            onChange={(event) => {
              setPeriod('custom');
              setToDate(event.target.value);
            }}
          />
        </div>
        <div className="dq-field">
          <label>View</label>
          <div className="dq-seg" role="group" aria-label="Dashboard view">
            <button type="button" className={view === 'measures' ? 'active' : ''} onClick={() => setView('measures')}>By measure</button>
            <button type="button" className={view === 'entities' ? 'active' : ''} onClick={() => setView('entities')}>By entity</button>
          </div>
        </div>
      </div>

      {error && <div className="dq-error">{error}</div>}

      <div className="pillar-grid">
        <button
          type="button"
          className={`pillar ${section === 'availability' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--accent-2)' } as React.CSSProperties}
          aria-pressed={section === 'availability'}
          onClick={() => setSection('availability')}
        >
          <div className="pillar-lbl">Availability</div>
          <div className="pillar-val">
            {loading && !summary ? '…' : formatPercent(summary?.availabilityPercent)}
          </div>
          <div className="pillar-sub">required attributes populated</div>
          <div className="pillar-det">
            {summary ? `${summary.populatedSlots.toLocaleString()} of ${summary.requiredSlots.toLocaleString()} required values · ${summary.availabilityResolvedCount.toLocaleString()} resolved · ${summary.availabilityIntroducedCount.toLocaleString()} introduced` : 'Loading required attributes'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'quality' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--green)' } as React.CSSProperties}
          aria-pressed={section === 'quality'}
          onClick={() => setSection('quality')}
        >
          <div className="pillar-lbl">Quality</div>
          <div className="pillar-val">
            {loading && !summary ? '…' : formatPercent(summary?.qualityPercent)}
          </div>
          <div className="pillar-sub">rule checks passing</div>
          <div className="pillar-det">
            {summary ? `${summary.failingChecks.toLocaleString()} failing · ${summary.qualityResolvedCount.toLocaleString()} resolved · ${summary.qualityIntroducedCount.toLocaleString()} introduced` : 'Loading rules'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'trajectory' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--accent)' } as React.CSSProperties}
          aria-pressed={section === 'trajectory'}
          onClick={() => setSection('trajectory')}
        >
          <div className="pillar-lbl">Trajectory</div>
          <div className="pillar-val">
            {loading && !summary ? '…' : (summary?.attributeChangeCount ?? 0).toLocaleString()}
          </div>
          <div className="pillar-sub">attribute values changed</div>
          <div className="pillar-det">
            {summary ? `${summary.changedEntityCount.toLocaleString()} entities · ${summary.changedAttributeCount.toLocaleString()} attributes · ${formatDay(fromDate)} to ${formatDay(toDate)}` : 'Comparing periods'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'handoff' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--amber)' } as React.CSSProperties}
          aria-pressed={section === 'handoff'}
          onClick={() => setSection('handoff')}
        >
          <div className="pillar-lbl">Handoff</div>
          <div className="pillar-val">
            {loading && !summary ? '…' : (summary?.overrideMatchCount ?? 0).toLocaleString()}
          </div>
          <div className="pillar-sub">overrides ready to release</div>
          <div className="pillar-det">
            {summary ? `Priority source matches the manual value as of ${formatDay(toDate)}` : 'Comparing overrides'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'freshness' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--amber)' } as React.CSSProperties}
          aria-pressed={section === 'freshness'}
          onClick={() => setSection('freshness')}
        >
          <div className="pillar-lbl">Freshness</div>
          <div className="pillar-val">
            {loading && !staleReport ? '…' : (staleReport?.count ?? 0).toLocaleString()}
          </div>
          <div className="pillar-sub">stale prevailing values</div>
          <div className="pillar-det">
            {staleReport
              ? `Not received in ${staleReport.olderThanDays} days as of ${formatDay(staleReport.asOfDate)}`
              : 'Checking last receipt'}
          </div>
        </button>
      </div>

      {view === 'measures' && section === 'availability' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data availability by attribute</div>
              <p>Required attributes come from the entity template. Resolved means a gap on {formatDay(fromDate)} now has a value. Introduced means a value then is missing on {formatDay(toDate)}.</p>
            </div>
          </div>
          <div className="dq-grid dq-avail">
            <div />
            <div>Attribute</div>
            <div>Domain</div>
            <div>Required</div>
            <div>Missing</div>
            <div>Availability</div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Loading availability…</div>}
          {dashboard && dashboard.availability.length === 0 && (
            <div className="dq-empty">No required attributes are defined for this selection. Mark attributes required on the template or the attribute register.</div>
          )}
          {dashboard?.availability.map((row) => {
            const key = `avail-${row.attributeCode}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-avail" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {row.attributeName}
                    <span className="dq-sub">{row.attributeCode} · {movementLabel(row.resolvedCount, row.introducedCount)}</span>
                  </span>
                  <span>{row.domainCode || '—'}</span>
                  <span className="dq-num">{row.requiredCount.toLocaleString()}</span>
                  <span className="dq-num" style={{ color: row.missingCount ? 'var(--red)' : 'var(--green)' }}>{row.missingCount.toLocaleString()}</span>
                  <span className="qm-bar-wrap">
                    <span className="qm-bar"><span style={{ background: barColor(row.availabilityPercent), width: `${row.availabilityPercent ?? 0}%` }} /></span>
                    <span className="qm-pct">{formatPercent(row.availabilityPercent)}</span>
                  </span>
                </button>
                {open && (
                  <div className="dq-detail">
                    {row.entities && row.entities.length > 0 ? (
                      <AvailabilityTable
                        rows={row.entities.slice(0, detailLimit)}
                        total={row.entities.length}
                        missingCount={row.missingCount}
                        attributeCode={row.attributeCode}
                        attributeName={row.attributeName}
                        asOf={toDate}
                        onDone={() => setRefreshToken((token) => token + 1)}
                        onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                      />
                    ) : row.missingEntities.length === 0 ? (
                      <div className="dq-empty">Every entity that requires this attribute has a value.</div>
                    ) : (
                      <EntityTable
                        rows={row.missingEntities.slice(0, detailLimit)}
                        total={row.missingEntities.length}
                        attributeCode={row.attributeCode}
                        attributeName={row.attributeName}
                        asOf={toDate}
                        onDone={() => setRefreshToken((token) => token + 1)}
                        onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                      />
                    )}
                    <ShiftTables
                      resolved={row.resolvedEntities}
                      introduced={row.introducedEntities}
                      fromDate={fromDate}
                      toDate={toDate}
                      limit={detailLimit}
                      onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {view === 'measures' && section === 'quality' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data quality by rule</div>
              <p>Each active rule is checked as of {formatDay(toDate)}. Resolved means it failed on {formatDay(fromDate)} and passes now. Introduced means it passed then and fails now. Waived results stay off the failing list.</p>
            </div>
          </div>
          <div className="dq-grid dq-qual">
            <div />
            <div>Rule</div>
            <div>Severity</div>
            <div>Domain</div>
            <div>Checked</div>
            <div>Failing</div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Loading rules…</div>}
          {dashboard && dashboard.quality.length === 0 && <div className="dq-empty">No active data quality rules match this selection.</div>}
          {dashboard?.quality.map((rule) => {
            const key = `rule-${rule.ruleId}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-qual" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {rule.ruleName}
                    <span className="dq-sub">{rule.ruleCode} · {rule.ruleType} · {movementLabel(rule.resolvedCount, rule.introducedCount)}</span>
                  </span>
                  <span><span className={`sev-dot ${severityClass(rule.severity)}`} />{rule.severity}</span>
                  <span>{rule.domainCode || 'All'}</span>
                  <span className="dq-num">{rule.entityCount.toLocaleString()}</span>
                  <span className="dq-num" style={{ color: rule.failingCount ? 'var(--red)' : 'var(--green)' }}>
                    {rule.evaluated ? rule.failingCount.toLocaleString() : '—'}
                  </span>
                </button>
                {open && (
                  <div className="dq-detail">
                    {rule.ruleDescription && <p>{rule.ruleDescription}</p>}
                    {!rule.evaluated && <div className="dq-empty">{rule.evaluationMessage || 'This expression is not evaluated automatically.'}</div>}
                    {rule.evaluated && rule.failingEntities.length === 0 && rule.acceptedEntities.length === 0 && (
                      <div className="dq-empty">No entities are failing this rule.</div>
                    )}
                    {(rule.failingEntities.length > 0 || rule.acceptedEntities.length > 0) && (
                      <div className="ex-card">
                        <div className="ex-grid ex-grid-head">
                          <div>Entity</div>
                          <div>Expected</div>
                          <div>Actual</div>
                          <div>Corrected value</div>
                        </div>
                        {rule.failingEntities.slice(0, detailLimit).map((entity) => (
                          <ExceptionRow
                            key={entity.id}
                            entityId={entity.id}
                            ruleId={rule.ruleId}
                            ruleName={entity.entityName}
                            ruleCode={`${entity.entityCode} · ${entity.domainCode}`}
                            severity={rule.severity}
                            attributeCode={entity.attributeCode || rule.attributeCode}
                            expected={expectedFrom(entity.message)}
                            actualValue={entity.actualValue}
                            asOf={toDate}
                            href={entityHref(entity.domainCode, entity.id)}
                            onDone={() => setRefreshToken((token) => token + 1)}
                          />
                        ))}
                        {rule.acceptedEntities.map((entity) => (
                          <div className="ex-grid ex-row" key={entity.id}>
                            <div>
                              <Link href={entityHref(entity.domainCode, entity.id)} className="ex-rule">{entity.entityName}</Link>
                              <div className="dq-sub">{entity.entityCode} · {entity.status === 'FALSE_POSITIVE' ? 'Not an issue' : 'Waived'}</div>
                            </div>
                            <div className="dq-sub">{entity.notes || '—'}</div>
                            <div />
                            <div>
                              <button type="button" className="btn btn-sm" onClick={() => reopenRule(entity.id, rule.ruleId, toDate, () => setRefreshToken((token) => token + 1))}>Reopen</button>
                            </div>
                          </div>
                        ))}
                        {rule.failingEntities.length > detailLimit && (
                          <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
                            Show more ({rule.failingEntities.length - detailLimit} remaining)
                          </button>
                        )}
                        <div className="ex-foot">Edits stay in the row until you save. Waive and Not an issue ask for a short reason and are kept with the exception.</div>
                      </div>
                    )}
                    <ShiftTables
                      resolved={rule.resolvedEntities}
                      introduced={rule.introducedEntities}
                      fromDate={fromDate}
                      toDate={toDate}
                      limit={detailLimit}
                      onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {view === 'measures' && section === 'trajectory' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data trajectory by attribute</div>
              <p>Golden values that differ between {formatDay(fromDate)} and {formatDay(toDate)}. The count is the number of entities whose value changed.</p>
            </div>
          </div>
          <div className="dq-grid dq-traj">
            <div />
            <div>Attribute</div>
            <div>Domain</div>
            <div>Entities changed</div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Comparing periods…</div>}
          {dashboard && dashboard.trajectory.length === 0 && <div className="dq-empty">No attribute values changed in this period.</div>}
          {dashboard?.trajectory.map((row) => {
            const key = `traj-${row.attributeCode}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-traj" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {row.attributeName}
                    <span className="dq-sub">{row.attributeCode}</span>
                  </span>
                  <span>{row.domainCode || '—'}</span>
                  <span className="dq-num">{row.changeCount.toLocaleString()}</span>
                </button>
                {open && (
                  <div className="dq-detail">
                    <table>
                      <thead>
                        <tr><th>Entity</th><th>Domain</th><th>{formatDay(fromDate)}</th><th>{formatDay(toDate)}</th></tr>
                      </thead>
                      <tbody>
                        {row.changes.slice(0, detailLimit).map((change) => (
                          <tr key={change.id}>
                            <td><Link href={entityHref(change.domainCode, change.id)}>{change.entityName}</Link><div className="dq-sub">{change.entityCode}</div></td>
                            <td>{change.domainCode}</td>
                            <td className="dq-num">{displayValue(change.previousValue)}</td>
                            <td className="dq-num">{displayValue(change.currentValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {row.changes.length > detailLimit && (
                      <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
                        Show more ({row.changes.length - detailLimit} remaining)
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {view === 'measures' && section === 'handoff' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Overrides the priority source can own</div>
              <p>The highest-ranked system source now has the same value as the manual override. Clearing the override keeps it on earlier as-of dates and lets that source own the value from {formatDay(toDate)} forward.</p>
            </div>
          </div>
          <div className="dq-grid dq-hand">
            <div />
            <div>Entity</div>
            <div>Attribute</div>
            <div>Priority source</div>
            <div>Value</div>
            <div />
          </div>
          {loading && !dashboard && <div className="dq-empty">Comparing overrides…</div>}
          {dashboard && dashboard.overrideMatches.length === 0 && (
            <div className="dq-empty">No manual override currently matches its priority source.</div>
          )}
          {dashboard?.overrideMatches.slice(0, detailLimit).map((match) => {
            const key = `hand-${match.id}-${match.attributeCode}`;
            return (
              <HandoffMatch
                key={key}
                match={match}
                open={openKey === key}
                asOf={toDate}
                onToggle={() => toggle(key)}
                onDone={() => setRefreshToken((token) => token + 1)}
              />
            );
          })}
          {(dashboard?.overrideMatches.length || 0) > detailLimit && (
            <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
              Show more ({dashboard!.overrideMatches.length - detailLimit} remaining)
            </button>
          )}
        </section>
      )}

      {section === 'freshness' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Prevailing values not restated recently</div>
              <p>
                The winning source last delivered these values more than {staleDays} days ago. Reloading the same value still counts as received. Calculated values are left out.
                {staleReport && staleReport.count > staleReport.attributes.length
                  ? ` Showing the ${staleReport.attributes.length} oldest of ${staleReport.count.toLocaleString()}.`
                  : ''}
              </p>
            </div>
            <div className="dq-field">
              <label htmlFor="stale-days">Older than</label>
              <select id="stale-days" className="select" value={staleDays} onChange={(event) => setStaleDays(Number(event.target.value))}>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
              </select>
            </div>
          </div>
          {loading && !staleReport && <div className="dq-empty">Checking receipts…</div>}
          {staleReport && staleReport.attributes.length === 0 && (
            <div className="dq-empty">No prevailing value is older than {staleDays} days.</div>
          )}
          {staleReport && staleReport.attributes.length > 0 && (
            <div className="dq-detail">
            <table>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Attribute</th>
                  <th>Source</th>
                  <th>Value</th>
                  <th>Last received</th>
                </tr>
              </thead>
              <tbody>
                {staleReport.attributes.slice(0, detailLimit).map((row) => (
                  <tr key={`${row.entityId}-${row.attributeCode}`}>
                    <td>
                      <Link href={entityHref(row.domainCode, row.entityId)}>{row.entityName}</Link>
                      <div className="dq-sub">{row.entityCode}</div>
                    </td>
                    <td>{row.attributeName}<div className="dq-sub">{row.attributeCode}</div></td>
                    <td>{row.sourceName}</td>
                    <td className="dq-num">{displayValue(row.value)}</td>
                    <td>
                      {formatReceipt(row.receivedAt)}
                      <div className="dq-sub">{row.ageDays}d ago</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {(staleReport?.attributes.length || 0) > detailLimit && (
            <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
              Show more ({staleReport!.attributes.length - detailLimit} remaining)
            </button>
          )}
        </section>
      )}

      {view === 'entities' && section !== 'freshness' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Results by entity</div>
              <p>
                {section === 'availability' && `Entities with a required-attribute gap, or a gap that was resolved or introduced between ${formatDay(fromDate)} and ${formatDay(toDate)}.`}
                {section === 'quality' && `Entities failing a rule, or whose rule result was resolved or introduced between ${formatDay(fromDate)} and ${formatDay(toDate)}.`}
                {section === 'trajectory' && `Entities whose values changed between ${formatDay(fromDate)} and ${formatDay(toDate)}.`}
                {section === 'handoff' && `Entities whose manual override matches the priority source as of ${formatDay(toDate)}.`}
                {summary ? ` ${filteredEntities.length.toLocaleString()} shown.` : ''}
              </p>
            </div>
            <input
              className="text-input"
              placeholder="Search entities"
              value={entityQuery}
              onChange={(event) => { setEntityQuery(event.target.value); setEntityPage(0); }}
              aria-label="Search entities"
            />
          </div>
          <div className="dq-grid dq-ent">
            <div />
            <div>Entity</div>
            <div>Domain</div>
            <div>Availability</div>
            <div>Quality</div>
            <div>Changes</div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Loading entities…</div>}
          {dashboard && filteredEntities.length === 0 && (
            <div className="dq-empty">
              {section === 'availability' && 'No required-attribute gaps opened or closed in this period.'}
              {section === 'quality' && 'No rule results opened or closed in this period.'}
              {section === 'trajectory' && 'No entity values changed in this period.'}
              {section === 'handoff' && 'No manual override matches its priority source.'}
            </div>
          )}
          {entitySlice.map((entity) => {
            const key = `ent-${entity.id}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-ent" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {entity.entityName}
                    <span className="dq-sub">{entity.entityCode}</span>
                  </span>
                  <span>{entity.domainCode}</span>
                  <span className="dq-num">{entity.requiredCount === 0 ? '—' : `${entity.missingCount} missing`}</span>
                  <span className="dq-num">{entity.ruleCount === 0 ? '—' : `${entity.failingRuleCount} failing`}</span>
                  <span className="dq-num">
                    {section === 'handoff' ? `${entity.overrideMatchCount} ready` : entity.changeCount.toLocaleString()}
                  </span>
                </button>
                {open && section === 'handoff' && (
                  <div className="dq-detail">
                    {(dashboard?.overrideMatches || []).filter((match) => match.id === entity.id).map((match) => (
                      <div className="dq-case" key={match.attributeCode}>
                        <div>
                          <strong>{match.attributeName}</strong>
                          <span className="dq-sub">{match.attributeCode} · {match.prioritySourceName} ({match.prioritySourceCode}) has {displayValue(match.priorityValue)}</span>
                        </div>
                        <HandoffSources
                          entityId={match.id}
                          attributeCode={match.attributeCode}
                          asOf={toDate}
                          prioritySourceCode={match.prioritySourceCode}
                        />
                        <ClearOverrideButton
                          entityId={match.id}
                          attributeCode={match.attributeCode}
                          asOf={toDate}
                          onDone={() => setRefreshToken((token) => token + 1)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {open && section === 'quality' && (
                  <ExceptionBoard
                    entity={entity}
                    asOf={toDate}
                    onDone={() => setRefreshToken((token) => token + 1)}
                  />
                )}
                {open && section !== 'quality' && section !== 'handoff' && (
                  <div className="dq-detail dq-sections">
                    <div>
                      <div className="dq-section-title">Availability</div>
                      {entity.missingAttributes.length === 0 ? (
                        <div className="dq-sub">{entity.requiredCount === 0 ? 'No required attributes for this entity.' : 'All required attributes are populated.'}</div>
                      ) : (
                        <ul>
                          {entity.missingAttributes.map((attribute) => (
                            <li key={attribute.attributeCode}>
                              {attribute.attributeName} <span className="dq-sub">{attribute.attributeCode}</span>
                              <ResolveForm
                                entityId={entity.id}
                                attributeCode={attribute.attributeCode}
                                attributeName={attribute.attributeName}
                                actualValue=""
                                asOf={toDate}
                                onDone={() => setRefreshToken((token) => token + 1)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <div className="dq-section-title">Quality</div>
                      {entity.failingRules.length === 0 ? (
                        <div className="dq-sub">{entity.ruleCount === 0 ? 'No rules apply to this entity.' : 'All applicable rules pass.'}</div>
                      ) : (
                        <ul>
                          {entity.failingRules.map((rule) => (
                            <li key={rule.ruleId}>
                              <span className={`sev-dot ${severityClass(rule.severity)}`} />
                              {rule.ruleName}
                              <span className="dq-sub">{rule.message || rule.ruleCode}{rule.actualValue ? ` · actual ${rule.actualValue}` : ''}</span>
                              <ResolveForm
                                entityId={entity.id}
                                ruleId={rule.ruleId}
                                attributeCode={rule.attributeCode}
                                attributeName={rule.attributeName}
                                actualValue={rule.actualValue}
                                asOf={toDate}
                                onDone={() => setRefreshToken((token) => token + 1)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <div className="dq-section-title">Trajectory</div>
                      {entity.changes.length === 0 ? (
                        <div className="dq-sub">No attribute values changed between {formatDay(fromDate)} and {formatDay(toDate)}.</div>
                      ) : (
                        <table>
                          <thead>
                            <tr><th>Attribute</th><th>{formatDay(fromDate)}</th><th>{formatDay(toDate)}</th></tr>
                          </thead>
                          <tbody>
                            {entity.changes.map((change) => (
                              <tr key={change.attributeCode}>
                                <td>{change.attributeName}</td>
                                <td className="dq-num">{displayValue(change.previousValue)}</td>
                                <td className="dq-num">{displayValue(change.currentValue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                    <div><Link href={entityHref(entity.domainCode, entity.id)}>Open entity</Link></div>
                  </div>
                )}
              </div>
            );
          })}
          {filteredEntities.length > PAGE_SIZE && (
            <div className="dq-head">
              <span className="dq-sub">Page {entityPage + 1} of {entityPageCount}</span>
              <div className="dq-seg">
                <button type="button" disabled={entityPage === 0} onClick={() => setEntityPage((page) => Math.max(0, page - 1))}>Previous</button>
                <button type="button" disabled={entityPage + 1 >= entityPageCount} onClick={() => setEntityPage((page) => page + 1)}>Next</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function movementLabel(resolved: number, introduced: number) {
  if (!resolved && !introduced) return 'unchanged since the prior date';
  const parts: string[] = [];
  if (resolved) parts.push(`${resolved.toLocaleString()} resolved`);
  if (introduced) parts.push(`${introduced.toLocaleString()} introduced`);
  return parts.join(' · ');
}

function ShiftTables({
  resolved,
  introduced,
  fromDate,
  toDate,
  limit,
  onMore,
}: {
  resolved: MeasureShift[];
  introduced: MeasureShift[];
  fromDate: string;
  toDate: string;
  limit: number;
  onMore: () => void;
}) {
  if (resolved.length === 0 && introduced.length === 0) return null;
  const rows = [
    ...resolved.map((row) => ({ ...row, kind: 'Resolved' as const })),
    ...introduced.map((row) => ({ ...row, kind: 'Introduced' as const })),
  ];
  return (
    <div>
      <div className="dq-section-title">Since {formatDay(fromDate)}</div>
      <table>
        <thead>
          <tr><th>Movement</th><th>Entity</th><th>{formatDay(fromDate)}</th><th>{formatDay(toDate)}</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row) => (
            <tr key={`${row.kind}-${row.id}`}>
              <td style={{ color: row.kind === 'Resolved' ? 'var(--green)' : 'var(--amber)' }}>{row.kind}</td>
              <td>
                <Link href={entityHref(row.domainCode, row.id)}>{row.entityName}</Link>
                <div className="dq-sub">{row.entityCode}</div>
              </td>
              <td className="dq-num">{displayValue(row.previousValue)}</td>
              <td className="dq-num">{displayValue(row.currentValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <button type="button" className="dq-more" onClick={onMore}>
          Show more ({rows.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function HandoffMatch({
  match,
  open,
  asOf,
  onToggle,
  onDone,
}: {
  match: OverrideMatch;
  open: boolean;
  asOf: string;
  onToggle: () => void;
  onDone: () => void;
}) {
  return (
    <div className="dq-line">
      <div
        className="dq-open dq-hand dq-hand-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span className="dq-name">
          <Link href={entityHref(match.domainCode, match.id)} onClick={(event) => event.stopPropagation()}>{match.entityName}</Link>
          <span className="dq-sub">{match.entityCode} · {match.domainCode}</span>
        </span>
        <span className="dq-name">
          {match.attributeName}
          <span className="dq-sub">{match.attributeCode}{match.overrideReason ? ` · ${match.overrideReason}` : ''}</span>
        </span>
        <span>{match.prioritySourceName}<span className="dq-sub">{match.prioritySourceCode}</span></span>
        <span className="dq-num">{displayValue(match.priorityValue)}</span>
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <ClearOverrideButton
            entityId={match.id}
            attributeCode={match.attributeCode}
            asOf={asOf}
            onDone={onDone}
          />
        </span>
      </div>
      {open && (
        <div className="dq-detail">
          <HandoffSources
            entityId={match.id}
            attributeCode={match.attributeCode}
            asOf={asOf}
            prioritySourceCode={match.prioritySourceCode}
          />
        </div>
      )}
    </div>
  );
}

interface LineageSource {
  source: string;
  sourceName: string;
  value: string | null;
  precedenceRank: number;
  validFrom: string;
  validTo: string;
  confidenceScore: number | null;
}

function HandoffSources({
  entityId,
  attributeCode,
  asOf,
  prioritySourceCode,
}: {
  entityId: string;
  attributeCode: string;
  asOf: string;
  prioritySourceCode: string;
}) {
  const [rows, setRows] = useState<LineageSource[] | null>(null);
  const [rule, setRule] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    graphqlQuery<{
      fieldLineage: Array<{
        attributeCode: string;
        resolutionRule: string | null;
        competingValues: LineageSource[];
      }>;
    }>(FIELD_LINEAGE_QUERY, { entityId, asOfDate: asOf, knowledgeDate: null }, 'network-only')
      .then(({ data, error: queryError }) => {
        if (cancelled) return;
        if (queryError || !data?.fieldLineage) {
          setError(queryError?.message || 'Could not load source values.');
          setRows([]);
          return;
        }
        const field = data.fieldLineage.find((item) => item.attributeCode === attributeCode);
        const sources = [...(field?.competingValues || [])].sort((a, b) => a.precedenceRank - b.precedenceRank);
        setRule(field?.resolutionRule || null);
        setRows(sources);
      });
    return () => { cancelled = true; };
  }, [entityId, attributeCode, asOf]);

  if (error) return <div className="dq-empty">{error}</div>;
  if (!rows) return <div className="dq-empty">Loading source values…</div>;
  if (rows.length === 0) return <div className="dq-empty">No source values are stored for this attribute.</div>;

  return (
    <div className="sa-drilldown">
      {rule && <p className="dq-sub">{rule}</p>}
      <div className="sa-drill-table dq-source-table">
        <div className="sa-drill-thead">
          <div className="sa-drill-th" />
          <div className="sa-drill-th">Source</div>
          <div className="sa-drill-th">Value</div>
          <div className="sa-drill-th">Precedence</div>
          <div className="sa-drill-th">Valid from</div>
          <div className="sa-drill-th">Status</div>
        </div>
        {rows.map((row, index) => {
          const manual = row.source.toUpperCase() === 'MANUAL';
          const priority = row.source.toUpperCase() === prioritySourceCode.toUpperCase();
          const hasValue = row.value != null && row.value !== '';
          return (
            <div key={`${row.source}-${index}`} className={`sa-drill-trow ${manual ? 'winner' : 'eligible'}`}>
              <div className="sa-drill-td sa-drill-row-num">{index + 1}</div>
              <div className="sa-drill-td">{row.sourceName || row.source}</div>
              <div className="sa-drill-td sa-drill-value">{hasValue ? displayValue(row.value) : '—'}</div>
              <div className="sa-drill-td">{row.precedenceRank}</div>
              <div className="sa-drill-td">{row.validFrom || '—'}</div>
              <div className="sa-drill-td sa-drill-status">
                {manual && <span className="sa-status-badge winner">Override</span>}
                {priority && <span className="sa-status-badge eligible">Priority source</span>}
                {!manual && !priority && hasValue && <span className="sa-status-badge no-data">Other source</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ClearOverrideButton({
  entityId,
  attributeCode,
  asOf,
  onDone,
}: {
  entityId: string;
  attributeCode: string;
  asOf: string;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setBusy(true);
    setError(null);
    const { data, error: mutationError } = await graphqlMutation<{ clearManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      CLEAR_MANUAL_OVERRIDE_MUTATION,
      { input: { entityId, attributeCode, asOf } }
    );
    const result = data?.clearManualOverride;
    if (mutationError || !result?.success) {
      setError(mutationError?.message || result?.errors?.[0]?.message || 'Could not clear the override.');
      setBusy(false);
      return;
    }
    setBusy(false);
    setConfirming(false);
    onDone();
  }

  return (
    <span className="dq-resolve">
      {confirming ? (
        <>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={clear}>{busy ? 'Clearing…' : 'Confirm clear'}</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>Clear override</button>
      )}
      {error && <span className="dq-sub" style={{ color: 'var(--red)' }}>{error}</span>}
    </span>
  );
}

function expectedFrom(message: string | null) {
  if (!message) return 'a valid value';
  const failed = message.match(/failed\s+(.+)$/i);
  if (failed) return failed[1].replace(/CURRENT_DATE/i, 'today');
  if (/allowed value/i.test(message)) return 'an allowed value';
  if (/format/i.test(message)) return 'the expected format';
  if (/missing/i.test(message)) return 'a value';
  if (/not a number/i.test(message)) return 'a number';
  if (/not a date/i.test(message)) return 'a date';
  return 'a valid value';
}

function severityRank(severity: string) {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const index = order.indexOf(severity.toUpperCase());
  return index === -1 ? order.length : index;
}

function isCritical(severity: string) {
  const key = severity.toUpperCase();
  return key === 'CRITICAL' || key === 'HIGH';
}

type QualityEntity = Dashboard['entities'][number];

function ExceptionBoard({ entity, asOf, onDone }: { entity: QualityEntity; asOf: string; onDone: () => void }) {
  const [tab, setTab] = useState<'open' | 'resolved' | 'all'>('open');
  const openRules = [...entity.failingRules].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.ruleName.localeCompare(b.ruleName));
  const resolvedRules = entity.acceptedRules ?? [];
  const critical = openRules.filter((rule) => isCritical(rule.severity)).length;
  const warning = openRules.length - critical;
  const rows = tab === 'resolved' ? [] : openRules;
  const resolved = tab === 'open' ? [] : resolvedRules;

  return (
    <div className="ex-card">
      <div className="ex-head">
        <div>
          <div className="ex-title">{entity.entityName}</div>
          <div className="dq-sub">{entity.entityCode} · {entity.domainCode}</div>
        </div>
        <div className="ex-pills">
          <span className="ex-pill critical">{critical} critical</span>
          <span className="ex-pill warning">{warning} warning</span>
          <span className="ex-pill resolved">{resolvedRules.length} resolved</span>
        </div>
      </div>
      <div className={entity.missingCount === 0 ? 'ex-avail ok' : 'ex-avail warn'}>
        {entity.missingCount === 0
          ? 'Availability: all required attributes populated'
          : `Availability: ${entity.missingCount} required ${entity.missingCount === 1 ? 'attribute is' : 'attributes are'} missing`}
      </div>
      <div className="ex-tabs">
        <div className="dq-seg" role="group" aria-label="Exception status">
          <button type="button" className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Needs action</button>
          <button type="button" className={tab === 'resolved' ? 'active' : ''} onClick={() => setTab('resolved')}>Resolved</button>
          <button type="button" className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>All</button>
        </div>
        <span className="dq-sub">Sorted by severity</span>
      </div>
      <div className="ex-grid ex-grid-head">
        <div>Rule</div>
        <div>Expected</div>
        <div>Actual</div>
        <div>Corrected value</div>
      </div>
      {rows.length === 0 && resolved.length === 0 && (
        <div className="dq-empty">{tab === 'resolved' ? 'Nothing has been waived or marked as not an issue.' : 'Nothing needs action.'}</div>
      )}
      {rows.map((rule) => (
        <ExceptionRow
          key={rule.ruleId}
          entityId={entity.id}
          ruleId={rule.ruleId}
          ruleName={rule.ruleName}
          ruleCode={rule.ruleCode}
          severity={rule.severity}
          attributeCode={rule.attributeCode}
          expected={expectedFrom(rule.message)}
          actualValue={rule.actualValue}
          asOf={asOf}
          onDone={onDone}
        />
      ))}
      {resolved.map((rule) => (
        <div className="ex-grid ex-row" key={rule.ruleId}>
          <div>
            <span className={`sev-dot ${isCritical(rule.severity) ? 'sev-high' : 'sev-med'}`} />
            <span className="ex-rule">{rule.ruleName}</span>
            <div className="dq-sub">{rule.ruleCode}</div>
          </div>
          <div className="dq-sub">{rule.status === 'FALSE_POSITIVE' ? 'Not an issue' : 'Waived'}</div>
          <div className="dq-sub">{rule.notes || '—'}</div>
          <div>
            <button type="button" className="btn btn-sm" onClick={() => reopenRule(entity.id, rule.ruleId, asOf, onDone)}>Reopen</button>
          </div>
        </div>
      ))}
      <div className="ex-foot">Edits stay in the row until you save. Waive and Not an issue ask for a short reason and are kept with the exception.</div>
    </div>
  );
}

async function reopenRule(entityId: string, ruleId: string, asOf: string, onDone: () => void) {
  await graphqlMutation(
    `mutation RecordDQDisposition($input: RecordDQDispositionInput!) {
      recordDQDisposition(input: $input) { success errors { message } }
    }`,
    { input: { ruleId, entityId, status: 'OPEN', resolutionNotes: 'Reopened from the exception grid.', asOf } }
  );
  onDone();
}

function ExceptionRow({ entityId, ruleId, ruleName, ruleCode, severity, attributeCode, expected, actualValue, asOf, href, onDone }: {
  entityId: string;
  ruleId: string;
  ruleName: string;
  ruleCode: string;
  severity: string;
  attributeCode: string | null;
  expected: string;
  actualValue: string | null;
  asOf: string;
  href?: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState('');
  const [prompt, setPrompt] = useState<'WAIVED' | 'FALSE_POSITIVE' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    if (!attributeCode || !value.trim()) {
      setMessage('Enter a corrected value.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await graphqlMutation<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation CorrectQualityValue($input: ManualOverrideInput!) {
        submitManualOverride(input: $input) { success errors { message } }
      }`,
      {
        input: {
          entityId,
          attributeCode,
          value: value.trim(),
          validFrom: asOf,
          overrideReason: 'Corrected from the data quality review',
        },
      }
    );
    const error = result.error?.message || result.data?.submitManualOverride?.errors?.[0]?.message;
    setBusy(false);
    if (error || !result.data?.submitManualOverride?.success) {
      setMessage(error || 'The correction was not saved.');
      return;
    }
    onDone();
  };

  const confirm = async () => {
    if (!prompt) return;
    if (!note.trim()) {
      setMessage('Add a short reason.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await graphqlMutation<{ recordDQDisposition: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation RecordDQDisposition($input: RecordDQDispositionInput!) {
        recordDQDisposition(input: $input) { success errors { message } }
      }`,
      { input: { ruleId, entityId, status: prompt, resolutionNotes: note.trim(), asOf } }
    );
    const error = result.error?.message || result.data?.recordDQDisposition?.errors?.[0]?.message;
    setBusy(false);
    if (error || !result.data?.recordDQDisposition?.success) {
      setMessage(error || 'That decision was not saved.');
      return;
    }
    onDone();
  };

  return (
    <div className="ex-grid ex-row">
      <div>
        <span className={`sev-dot ${isCritical(severity) ? 'sev-high' : 'sev-med'}`} />
        {href ? <Link href={href} className="ex-rule">{ruleName}</Link> : <span className="ex-rule">{ruleName}</span>}
        <div className="dq-sub">{ruleCode}</div>
      </div>
      <div className="ex-expected">{expected}</div>
      <div className="ex-actual">{displayValue(actualValue)}</div>
      <div className="ex-edit">
        {prompt ? (
          <>
            <input
              className="text-input"
              value={note}
              placeholder={prompt === 'WAIVED' ? 'Why waive this?' : 'Why is this not an issue?'}
              onChange={(event) => setNote(event.target.value)}
              aria-label="Reason"
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={confirm}>Confirm</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPrompt(null); setMessage(null); }}>Cancel</button>
          </>
        ) : (
          <>
            <AttributeValueInput
              attributeCode={attributeCode}
              className="text-input"
              value={value}
              placeholder={/^(>=|<=|>|<)/.test(expected) ? `Enter ${expected} value` : `Enter ${expected}`}
              onChange={setValue}
              ariaLabel={`Corrected value for ${ruleName}`}
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPrompt('WAIVED'); setMessage(null); }}>Waive</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPrompt('FALSE_POSITIVE'); setMessage(null); }}>Not an issue</button>
          </>
        )}
        {message && <div className="dq-sub">{message}</div>}
      </div>
    </div>
  );
}

function AvailabilityTable({ rows, total, missingCount, attributeCode, attributeName, asOf, onDone, onMore }: {
  rows: AvailabilityEntity[];
  total: number;
  missingCount: number;
  attributeCode: string;
  attributeName: string;
  asOf: string;
  onDone: () => void;
  onMore: () => void;
}) {
  const display = useAttributeDisplay(attributeCode);
  const listOptions = useAttributeListOptions(attributeCode);
  const numeric = ['number', 'integer', 'currency', 'percentage'].includes(attributeDisplayKind(display));
  return (
    <>
      <div className="dq-sub">
        {missingCount === 0
          ? `${total.toLocaleString()} ${total === 1 ? 'entity requires' : 'entities require'} ${attributeName}, and each one has a value.`
          : `${missingCount.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'entity is' : 'entities are'} missing ${attributeName}.`}
      </div>
      <table>
        <thead>
          <tr><th>Entity</th><th>Domain</th><th>Value</th></tr>
        </thead>
        <tbody>
          {rows.map((entity) => (
            <tr key={entity.id}>
              <td>
                <Link href={entityHref(entity.domainCode, entity.id)}>{entity.entityName}</Link>
                <div className="dq-sub">{entity.entityCode}</div>
              </td>
              <td>{entity.domainCode}</td>
              <td>
                {entity.value ? (
                  <span className={numeric ? 'dq-num' : undefined}>{listDisplayLabel(entity.value, listOptions) || formatAttributeDisplay(entity.value, display)}</span>
                ) : (
                  <ResolveForm
                    entityId={entity.id}
                    attributeCode={attributeCode}
                    attributeName={attributeName}
                    actualValue=""
                    asOf={asOf}
                    onDone={onDone}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > rows.length && (
        <button type="button" className="dq-more" onClick={onMore}>Show more ({total - rows.length} remaining)</button>
      )}
    </>
  );
}

function EntityTable({ rows, total, attributeCode, attributeName, asOf, onDone, onMore }: {
  rows: EntityRef[];
  total: number;
  attributeCode: string;
  attributeName: string;
  asOf: string;
  onDone: () => void;
  onMore: () => void;
}) {
  return (
    <>
      {rows.map((entity) => (
        <div className="dq-case" key={entity.id}>
          <div>
            <Link href={entityHref(entity.domainCode, entity.id)}>{entity.entityName}</Link>
            <div className="dq-sub">{entity.entityCode} · {entity.domainCode} · {attributeName} is required and blank</div>
          </div>
          <ResolveForm
            entityId={entity.id}
            attributeCode={attributeCode}
            attributeName={attributeName}
            actualValue=""
            asOf={asOf}
            onDone={onDone}
          />
        </div>
      ))}
      {total > rows.length && (
        <button type="button" className="dq-more" onClick={onMore}>Show more ({total - rows.length} remaining)</button>
      )}
    </>
  );
}

function ResolveForm({ entityId, ruleId, attributeCode, attributeName, actualValue, asOf, reopenOnly, onDone }: {
  entityId: string;
  ruleId?: string;
  attributeCode: string | null;
  attributeName: string | null;
  actualValue: string | null;
  asOf: string;
  reopenOnly?: boolean;
  onDone: () => void;
}) {
  const [value, setValue] = useState(actualValue || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const correct = async () => {
    if (!attributeCode) return;
    setBusy('save');
    setMessage(null);
    const result = await graphqlMutation<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation CorrectQualityValue($input: ManualOverrideInput!) {
        submitManualOverride(input: $input) { success errors { message } }
      }`,
      {
        input: {
          entityId,
          attributeCode,
          value,
          validFrom: asOf,
          overrideReason: 'Corrected from the data quality review',
        },
      }
    );
    const error = result.error?.message || result.data?.submitManualOverride?.errors?.[0]?.message;
    setBusy(null);
    if (error || !result.data?.submitManualOverride?.success) {
      setMessage(error || 'The correction was not saved.');
      return;
    }
    onDone();
  };

  const dispose = async (status: 'WAIVED' | 'FALSE_POSITIVE' | 'OPEN') => {
    if (!ruleId) return;
    if (status !== 'OPEN' && !note.trim()) {
      setMessage('Add a short note so the next person knows why this was accepted.');
      return;
    }
    setBusy(status);
    setMessage(null);
    const result = await graphqlMutation<{ recordDQDisposition: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation RecordDQDisposition($input: RecordDQDispositionInput!) {
        recordDQDisposition(input: $input) { success errors { message } }
      }`,
      { input: { ruleId, entityId, status, resolutionNotes: note.trim() || null, asOf } }
    );
    const error = result.error?.message || result.data?.recordDQDisposition?.errors?.[0]?.message;
    setBusy(null);
    if (error || !result.data?.recordDQDisposition?.success) {
      setMessage(error || 'That decision was not saved.');
      return;
    }
    onDone();
  };

  if (reopenOnly) {
    return (
      <div className="dq-resolve">
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => dispose('OPEN')}>Reopen</button>
        {message && <span className="dq-sub">{message}</span>}
      </div>
    );
  }

  return (
    <div className="dq-resolve">
      {attributeCode && (
        <label>
          Corrected {attributeName || attributeCode}
          <AttributeValueInput
            attributeCode={attributeCode}
            className="select"
            value={value}
            onChange={setValue}
            ariaLabel={`Corrected ${attributeName || attributeCode}`}
          />
        </label>
      )}
      <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || !attributeCode} onClick={correct}>
        {busy === 'save' ? 'Saving…' : 'Save correction'}
      </button>
      {ruleId && (
        <>
          <label>
            Note
            <input className="select" value={note} placeholder="Why this is acceptable" onChange={(event) => setNote(event.target.value)} />
          </label>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => dispose('WAIVED')}>Waive</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => dispose('FALSE_POSITIVE')}>Not an issue</button>
        </>
      )}
      {message && <span className="dq-sub">{message}</span>}
    </div>
  );
}
