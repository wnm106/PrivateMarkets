'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';
import {
  CATEGORY_LABEL,
  dashboardRows,
  formatCushion,
  formatValue,
  statusLabel,
  statusTone,
  summarize,
  watchlist,
  type ComplianceDashboardData,
  type DashboardDomain,
  type DashboardRow,
  type RowStatus,
} from '@/lib/compliance-dashboard';

type StatusFilter = 'ALL' | 'BREACH' | 'WARNING' | 'PASS' | 'OTHER';

const FILTERS: Array<{ id: StatusFilter; label: string; match: (status: RowStatus) => boolean }> = [
  { id: 'ALL', label: 'All', match: () => true },
  { id: 'BREACH', label: 'Breaches', match: (status) => status === 'HARD_BREACH' || status === 'ERROR' },
  { id: 'WARNING', label: 'Warnings', match: (status) => status === 'SOFT_BREACH' },
  { id: 'PASS', label: 'Within limit', match: (status) => status === 'PASS' },
  { id: 'OTHER', label: 'No data or not scored', match: (status) => status === 'NO_DATA' || status === 'NOT_SCORED' },
];

function pct(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

function StatusBar({ hard, soft, pass, other }: { hard: number; soft: number; pass: number; other: number }) {
  const total = hard + soft + pass + other;
  if (!total) return <div className="cd-stack empty" />;
  const part = (count: number) => `${(count / total) * 100}%`;
  return (
    <div className="cd-stack" role="img" aria-label={`${hard} breaches, ${soft} warnings, ${pass} within limit, ${other} no data`}>
      {hard > 0 && <i className="breach" style={{ width: part(hard) }} />}
      {soft > 0 && <i className="near" style={{ width: part(soft) }} />}
      {pass > 0 && <i className="ok" style={{ width: part(pass) }} />}
      {other > 0 && <i className="na" style={{ width: part(other) }} />}
    </div>
  );
}

/** How much of the limit the result uses. The marker at 100% is the limit. */
function UsageGauge({ row }: { row: DashboardRow }) {
  if (row.usedPct == null) return null;
  const used = Math.max(0, Math.min(row.usedPct, 130));
  return (
    <div className={`cd-usage ${statusTone(row.status)}`} title={`${pct(row.usedPct, 1)} of the limit used`}>
      <i style={{ width: `${(used / 130) * 100}%` }} />
      <b style={{ left: `${(100 / 130) * 100}%` }} />
    </div>
  );
}

function TypeCard({ domain, selected, onSelect }: { domain: DashboardDomain; selected: boolean; onSelect: () => void }) {
  const judged = domain.passCount + domain.softBreachCount + domain.hardBreachCount;
  const rate = judged ? (domain.passCount / judged) * 100 : null;
  return (
    <button type="button" className={selected ? 'cd-type on' : 'cd-type'} onClick={onSelect} aria-pressed={selected}>
      <div className="cd-type-head">
        <h3>{domain.domainName}</h3>
        {domain.hardBreachCount > 0
          ? <span className="da-st breach">{domain.hardBreachCount} breach{domain.hardBreachCount === 1 ? '' : 'es'}</span>
          : domain.softBreachCount > 0
            ? <span className="da-st near">{domain.softBreachCount} warning{domain.softBreachCount === 1 ? '' : 's'}</span>
            : <span className="da-st ok">Clean</span>}
      </div>
      <div className="cd-type-rate"><strong>{pct(rate)}</strong><span>within limit</span></div>
      <StatusBar hard={domain.hardBreachCount} soft={domain.softBreachCount} pass={domain.passCount} other={domain.noDataCount} />
      <div className="cd-type-meta">
        <span>{domain.entityCount} entit{domain.entityCount === 1 ? 'y' : 'ies'}</span>
        <span>{domain.ruleCount} rule{domain.ruleCount === 1 ? '' : 's'}</span>
        <span>{domain.resultCount} test{domain.resultCount === 1 ? '' : 's'}</span>
      </div>
    </button>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: string }) {
  return (
    <div className={`cd-kpi ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function ComplianceDashboard({ data, loading, error, selectedCode, onSelect }: {
  data: ComplianceDashboardData | null;
  loading: boolean;
  error: string | null;
  selectedCode: string | null;
  onSelect: (code: string) => void;
}) {
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [entityId, setEntityId] = useState<string>('');

  const domain = data?.domains.find((item) => item.domainCode === selectedCode) || null;
  const rows = useMemo(() => (data && domain ? dashboardRows(data, domain.domainCode) : []), [data, domain]);
  const summary = useMemo(() => summarize(rows), [rows]);
  const attention = useMemo(() => watchlist(rows, 8), [rows]);
  const entities = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) if (row.entityId) seen.set(row.entityId, row.entityName || 'Unnamed');
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filterDef = FILTERS.find((item) => item.id === filter) || FILTERS[0];
  const shown = useMemo(
    () => rows.filter((row) => filterDef.match(row.status) && (!entityId || row.entityId === entityId || row.entityId == null)),
    [rows, filterDef, entityId],
  );
  const filterCount = (item: typeof FILTERS[number]) => rows.filter((row) => item.match(row.status)).length;

  const columns = useMemo<ColDef<DashboardRow>[]>(() => [
    {
      colId: 'status',
      headerName: 'Status',
      width: 140,
      pinned: 'left',
      valueGetter: (params) => (params.data ? statusLabel(params.data.status, params.data.direction) : ''),
      comparator: (_a: string, _b: string, nodeA: any, nodeB: any) => {
        const order = ['HARD_BREACH', 'SOFT_BREACH', 'ERROR', 'PASS', 'NO_DATA', 'NOT_SCORED'];
        return order.indexOf(nodeA?.data?.status) - order.indexOf(nodeB?.data?.status);
      },
      cellRenderer: (params: { data?: DashboardRow }) => (
        params.data ? <span className={`da-st ${statusTone(params.data.status)}`}>{statusLabel(params.data.status, params.data.direction)}</span> : null
      ),
    },
    {
      colId: 'rule',
      headerName: 'Rule',
      minWidth: 240,
      flex: 2,
      valueGetter: (params) => params.data?.ruleName || '',
      cellRenderer: (params: { data?: DashboardRow }) => (
        params.data ? (
          <Link href={`/admin/compliance/${encodeURIComponent(params.data.ruleCode)}`} style={{ fontWeight: 600 }}>
            {params.data.ruleName}
          </Link>
        ) : null
      ),
    },
    {
      colId: 'category',
      headerName: 'Category',
      width: 150,
      valueGetter: (params) => (params.data ? CATEGORY_LABEL[params.data.ruleCategory] || params.data.ruleCategory : ''),
    },
    {
      colId: 'entity',
      headerName: 'Entity',
      minWidth: 180,
      flex: 1.4,
      valueGetter: (params) => params.data?.entityName || (params.data?.status === 'NOT_SCORED' ? 'No result' : ''),
    },
    {
      colId: 'group',
      headerName: 'Group',
      minWidth: 150,
      flex: 1,
      valueGetter: (params) => {
        const row = params.data;
        if (!row) return '';
        if (row.group) return row.rank != null ? `#${row.rank} ${row.group}` : row.group;
        if (row.rank != null) return `Rank ${row.rank}`;
        return row.status === 'NOT_SCORED' ? '' : 'Total';
      },
    },
    {
      colId: 'direction',
      headerName: 'Test',
      width: 96,
      valueGetter: (params) => (params.data ? (params.data.direction === 'MIN' ? 'Minimum' : 'Maximum') : ''),
    },
    {
      colId: 'soft',
      headerName: 'Warning',
      width: 110,
      type: 'numericColumn',
      valueGetter: (params) => params.data?.soft ?? null,
      valueFormatter: (params: any) => formatValue(params.value, params.data?.resultUnit),
    },
    {
      colId: 'hard',
      headerName: 'Limit',
      width: 110,
      type: 'numericColumn',
      valueGetter: (params) => params.data?.hard ?? null,
      valueFormatter: (params: any) => formatValue(params.value, params.data?.resultUnit),
    },
    {
      colId: 'value',
      headerName: 'Result',
      width: 120,
      type: 'numericColumn',
      valueGetter: (params) => params.data?.value ?? null,
      valueFormatter: (params: any) => formatValue(params.value, params.data?.resultUnit),
      cellClass: 'cd-strong',
    },
    {
      colId: 'cushion',
      headerName: 'Cushion',
      width: 190,
      type: 'numericColumn',
      valueGetter: (params) => params.data?.cushionPct ?? null,
      cellRenderer: (params: { data?: DashboardRow }) => {
        const row = params.data;
        if (!row || row.cushion == null) return <span className="cd-dim">—</span>;
        return (
          <div className="cd-cushion">
            <span className={row.cushion < 0 ? 'neg' : row.status === 'SOFT_BREACH' ? 'warn' : ''}>
              {formatCushion(row.cushion, row.resultUnit)}
              <small>{row.cushionPct != null ? ` ${row.cushionPct >= 0 ? '' : '−'}${Math.abs(row.cushionPct).toFixed(0)}%` : ''}</small>
            </span>
            <UsageGauge row={row} />
          </div>
        );
      },
    },
    {
      colId: 'asOf',
      headerName: 'As of',
      width: 110,
      valueGetter: (params) => params.data?.asOfDate || '',
    },
  ], []);

  if (error) return <div className="xp-error">{error}</div>;
  if (loading && !data) return <div className="xp-empty">Loading compliance results…</div>;
  if (!data) return null;
  if (!data.domains.length) {
    return <div className="xp-empty">No compliance results at these dates. Run a rule to score its entities.</div>;
  }

  return (
    <div className="cd">
      <section>
        <div className="da-sechead">
          <div>
            <h2>Entity types with results</h2>
            <p>Select a type to see its rules, limits, results and cushion.</p>
          </div>
        </div>
        <div className="cd-types">
          {data.domains.map((item) => (
            <TypeCard key={item.domainCode} domain={item} selected={item.domainCode === selectedCode} onSelect={() => onSelect(item.domainCode)} />
          ))}
        </div>
      </section>

      {domain && (
        <>
          <section className="cd-kpis" aria-label={`${domain.domainName} compliance summary`}>
            <div className="cd-kpi lead">
              <span>Within limit</span>
              <strong>{pct(summary.passRate, 1)}</strong>
              <div className="cd-meter"><i style={{ width: `${summary.passRate ?? 0}%` }} /></div>
              <small>{summary.pass} of {summary.pass + summary.soft + summary.hard} judged tests</small>
            </div>
            <Kpi label="Hard breaches" value={summary.hard} tone={summary.hard ? 'breach' : ''} note="Past the limit" />
            <Kpi label="Warnings" value={summary.soft} tone={summary.soft ? 'near' : ''} note="Past the warning level" />
            <Kpi label="Rules scored" value={`${summary.rulesScored} / ${summary.rules}`} note={summary.notScored ? `${summary.notScored} with no result` : 'Every rule has a result'} />
            <Kpi label="Entities scored" value={summary.entities} note={`${summary.tests} tests · ${summary.noData} no data`} />
            <Kpi
              label="Tightest cushion"
              value={summary.tightest ? formatCushion(summary.tightest.cushion, summary.tightest.resultUnit) : '—'}
              note={summary.tightest ? `${summary.tightest.ruleName} · ${summary.tightest.entityName || ''}${summary.tightest.group ? ` · ${summary.tightest.group}` : ''}` : 'No passing test with a limit'}
            />
          </section>

          <section className="cd-split">
            <div className="cd-panel">
              <div className="cd-panelhead">
                <h3>Needs attention</h3>
                <small>Breaches and warnings, then the least cushion</small>
              </div>
              {attention.length === 0 ? <p className="da-note">No test with a limit.</p> : (
                <ul className="cd-watch">
                  {attention.map((row) => (
                    <li key={row.key}>
                      <div className="cd-watch-main">
                        <span className={`da-st ${statusTone(row.status)}`}>{statusLabel(row.status, row.direction)}</span>
                        <div>
                          <b>{row.ruleName}</b>
                          <small>{row.entityName}{row.group ? ` · ${row.group}` : ''}</small>
                        </div>
                      </div>
                      <div className="cd-watch-fig">
                        <span>{formatValue(row.value, row.resultUnit)} <em>vs {row.direction === 'MIN' ? 'min' : 'max'} {formatValue(row.hard ?? row.soft, row.resultUnit)}</em></span>
                        <UsageGauge row={row} />
                        <small className={row.cushion != null && row.cushion < 0 ? 'neg' : ''}>{formatCushion(row.cushion, row.resultUnit)} cushion</small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="cd-panel">
              <div className="cd-panelhead">
                <h3>By category</h3>
                <small>Tests and outcomes for each kind of rule</small>
              </div>
              {summary.byCategory.length === 0 ? <p className="da-note">No scored tests.</p> : (
                <table className="cd-cats">
                  <tbody>
                    {summary.byCategory.map((item) => (
                      <tr key={item.category}>
                        <td><b>{item.label}</b><small>{item.tests} test{item.tests === 1 ? '' : 's'}</small></td>
                        <td className="bar"><StatusBar hard={item.hard} soft={item.soft} pass={item.pass} other={item.tests - item.hard - item.soft - item.pass} /></td>
                        <td className="num">
                          {item.hard > 0 && <span className="cd-count breach">{item.hard}</span>}
                          {item.soft > 0 && <span className="cd-count near">{item.soft}</span>}
                          <span className="cd-count ok">{item.pass}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="cd-legend">
                <span><i className="breach" />Breach</span>
                <span><i className="near" />Warning</span>
                <span><i className="ok" />Within limit</span>
                <span><i className="na" />No data</span>
              </div>
            </div>
          </section>

          <section>
            <div className="da-sechead">
              <div>
                <h2>{domain.domainName} rules</h2>
                <p>Every active rule for this type with its warning level, limit, newest result and cushion. Breaches and the least cushion come first.</p>
              </div>
            </div>
            <div className="cd-toolbar">
              <div className="cd-seg" role="group" aria-label="Filter by status">
                {FILTERS.map((item) => (
                  <button key={item.id} type="button" className={filter === item.id ? 'on' : ''} onClick={() => setFilter(item.id)}>
                    {item.label}<span>{filterCount(item)}</span>
                  </button>
                ))}
              </div>
              <select className="select" aria-label="Entity" value={entityId} onChange={(event) => setEntityId(event.target.value)}>
                <option value="">All entities</option>
                {entities.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
            <AppGrid
              rows={shown}
              columns={columns}
              getRowId={(row) => row.key}
              autoHeight={false}
              height={560}
              rowGroupPanelShow="never"
              emptyMessage="No tests match the filter."
            />
          </section>
        </>
      )}
    </div>
  );
}
