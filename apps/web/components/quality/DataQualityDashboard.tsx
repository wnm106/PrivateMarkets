'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DATA_QUALITY_DASHBOARD_QUERY, graphqlQuery } from '@/lib/graphql';

type Section = 'availability' | 'quality' | 'trajectory';
type Period = 'day' | 'week' | 'month' | 'quarter' | 'custom';

interface EntityRef {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
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
  };
  availability: Array<{
    attributeCode: string;
    attributeName: string;
    domainCode: string | null;
    requiredCount: number;
    missingCount: number;
    availabilityPercent: number | null;
    missingEntities: EntityRef[];
  }>;
  quality: Array<{
    ruleId: string;
    ruleCode: string;
    ruleName: string;
    ruleType: string;
    severity: string;
    domainCode: string | null;
    ruleExpression: string;
    evaluated: boolean;
    evaluationMessage: string | null;
    entityCount: number;
    failingCount: number;
    passingCount: number;
    failingEntities: Array<EntityRef & { message: string | null; actualValue: string | null }>;
  }>;
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
      message: string | null;
      actualValue: string | null;
    }>;
    changeCount: number;
    changes: Array<{
      attributeCode: string;
      attributeName: string;
      previousValue: string | null;
      currentValue: string | null;
    }>;
  }>;
}

const DOMAIN_PATH: Record<string, string> = {
  FUND: 'funds',
  ISSUER: 'issuers',
  SECURITY: 'securities',
  DEAL: 'deals',
  INVESTOR: 'investors',
  POSITION: 'positions',
  CASH_FLOW: 'cash-flows',
  PRICE: 'prices',
};

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
  return `/${DOMAIN_PATH[domainCode] ?? domainCode.toLowerCase()}/${id}`;
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    graphqlQuery<{ dataQualityDashboard: Dashboard }>(
      DATA_QUALITY_DASHBOARD_QUERY,
      {
        domainCode: domainCode || null,
        fromDate,
        toDate,
      },
      'network-only'
    ).then(({ data, error: queryError }) => {
      if (cancelled) return;
      if (queryError || !data?.dataQualityDashboard) {
        setError(queryError?.message || 'Could not load the data quality dashboard.');
        setDashboard(null);
      } else {
        setDashboard(data.dataQualityDashboard);
        setKnownDomains(data.dataQualityDashboard.domains || []);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [domainCode, fromDate, toDate]);

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
    const rows = dashboard?.entities ?? [];
    const query = entityQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((entity) =>
      entity.entityName.toLowerCase().includes(query) ||
      entity.entityCode.toLowerCase().includes(query) ||
      entity.domainCode.toLowerCase().includes(query)
    );
  }, [dashboard, entityQuery]);

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
            Availability of required attributes, rule failures, and values that changed between two as-of dates.
          </div>
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
          className={`pillar ${view === 'measures' && section === 'availability' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--accent-2)' } as React.CSSProperties}
          onClick={() => { setView('measures'); setSection('availability'); }}
        >
          <div className="pillar-lbl">Availability</div>
          <div className="pillar-val">
            {loading && !summary ? '…' : formatPercent(summary?.availabilityPercent)}
          </div>
          <div className="pillar-sub">required attributes populated</div>
          <div className="pillar-det">
            {summary ? `${summary.populatedSlots.toLocaleString()} of ${summary.requiredSlots.toLocaleString()} required values · ${summary.entitiesMissingRequired.toLocaleString()} entities incomplete` : 'Loading required attributes'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${view === 'measures' && section === 'quality' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--green)' } as React.CSSProperties}
          onClick={() => { setView('measures'); setSection('quality'); }}
        >
          <div className="pillar-lbl">Quality</div>
          <div className="pillar-val">
            {loading && !summary ? '…' : formatPercent(summary?.qualityPercent)}
          </div>
          <div className="pillar-sub">rule checks passing</div>
          <div className="pillar-det">
            {summary ? `${summary.failingChecks.toLocaleString()} failing checks across ${summary.entitiesFailingRules.toLocaleString()} entities · ${summary.rulesEvaluated.toLocaleString()} rules` : 'Loading rules'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${view === 'measures' && section === 'trajectory' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--accent)' } as React.CSSProperties}
          onClick={() => { setView('measures'); setSection('trajectory'); }}
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
      </div>

      {view === 'measures' && section === 'availability' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data availability by attribute</div>
              <p>Required attributes come from the entity template. Entities without a template use attributes marked required for their domain. As of {formatDay(toDate)}.</p>
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
                    <span className="dq-sub">{row.attributeCode}</span>
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
                    {row.missingEntities.length === 0 ? (
                      <div className="dq-empty">Every entity that requires this attribute has a value.</div>
                    ) : (
                      <EntityTable
                        rows={row.missingEntities.slice(0, detailLimit)}
                        total={row.missingEntities.length}
                        onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                      />
                    )}
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
              <p>Each active rule is evaluated against entities in its domain as of {formatDay(toDate)}. Expand a rule to see the entities that fail.</p>
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
                    <span className="dq-sub">{rule.ruleCode} · {rule.ruleType}</span>
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
                    <div className="dq-sub" style={{ marginBottom: 8 }}>{rule.ruleExpression}</div>
                    {!rule.evaluated && <div className="dq-empty">{rule.evaluationMessage || 'This expression is not evaluated automatically.'}</div>}
                    {rule.evaluated && rule.failingEntities.length === 0 && <div className="dq-empty">No entities are failing this rule.</div>}
                    {rule.evaluated && rule.failingEntities.length > 0 && (
                      <table>
                        <thead>
                          <tr><th>Entity</th><th>Domain</th><th>Actual</th><th>Result</th></tr>
                        </thead>
                        <tbody>
                          {rule.failingEntities.slice(0, detailLimit).map((entity) => (
                            <tr key={entity.id}>
                              <td><Link href={entityHref(entity.domainCode, entity.id)}>{entity.entityName}</Link><div className="dq-sub">{entity.entityCode}</div></td>
                              <td>{entity.domainCode}</td>
                              <td className="dq-num">{displayValue(entity.actualValue)}</td>
                              <td>{entity.message || 'Failed'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {rule.failingEntities.length > detailLimit && (
                      <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
                        Show more ({rule.failingEntities.length - detailLimit} remaining)
                      </button>
                    )}
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

      {view === 'entities' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Results by entity</div>
              <p>
                {summary
                  ? `${filteredEntities.length.toLocaleString()} entities with a gap, a failing rule, or a value change. ${summary.clearEntityCount.toLocaleString()} entities are clear.`
                  : 'Entities with findings in any of the three measures.'}
              </p>
            </div>
            <input
              className="select"
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
          {dashboard && filteredEntities.length === 0 && <div className="dq-empty">No entities have findings for this selection.</div>}
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
                  <span className="dq-num">{entity.changeCount.toLocaleString()}</span>
                </button>
                {open && (
                  <div className="dq-detail dq-sections">
                    <div>
                      <div className="dq-section-title">Availability</div>
                      {entity.missingAttributes.length === 0 ? (
                        <div className="dq-sub">{entity.requiredCount === 0 ? 'No required attributes for this entity.' : 'All required attributes are populated.'}</div>
                      ) : (
                        <ul>
                          {entity.missingAttributes.map((attribute) => (
                            <li key={attribute.attributeCode}>{attribute.attributeName} <span className="dq-sub">{attribute.attributeCode}</span></li>
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

function EntityTable({ rows, total, onMore }: { rows: EntityRef[]; total: number; onMore: () => void }) {
  return (
    <>
      <table>
        <thead>
          <tr><th>Entity</th><th>Code</th><th>Domain</th></tr>
        </thead>
        <tbody>
          {rows.map((entity) => (
            <tr key={entity.id}>
              <td><Link href={entityHref(entity.domainCode, entity.id)}>{entity.entityName}</Link></td>
              <td className="dq-num">{entity.entityCode}</td>
              <td>{entity.domainCode}</td>
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
