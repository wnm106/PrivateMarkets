'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { graphqlQuery } from '@/lib/graphql';
import { attributeText, RECORD_EXPERIENCES_QUERY, type RecordExperience } from '@/lib/experience';
import { useTemporalStore } from '@/lib/store';

interface DealCard {
  id: string;
  entityCode: string;
  entityName: string;
  createdAt?: string | null;
  attributes: Record<string, unknown>;
}

interface Stage {
  code: string;
  label: string;
}

const FALLBACK_STAGES: Stage[] = [
  { code: 'ORIGINATION', label: 'Origination' },
  { code: 'DILIGENCE', label: 'Diligence' },
  { code: 'COMMITTEE', label: 'IC approved' },
  { code: 'ALLOCATION', label: 'Allocation' },
  { code: 'CLOSING', label: 'Closing' },
  { code: 'CLOSED', label: 'Funded' },
];

const STRATEGY_ORDER = ['DIRECT_LENDING', 'OPPORTUNISTIC_CREDIT', 'ASSET_BASED_FINANCE', 'SPECIAL_SITUATIONS'];
const STRATEGY_LABEL: Record<string, string> = {
  DIRECT_LENDING: 'Direct Lending',
  OPPORTUNISTIC_CREDIT: 'Opportunistic Credit',
  ASSET_BASED_FINANCE: 'Asset-Based Finance',
  SPECIAL_SITUATIONS: 'Special Situations',
};

const ACTIVE_STAGES = new Set(['ALLOCATION', 'CLOSING']);

function labelOf(code: string) {
  if (!code) return 'Unassigned';
  return STRATEGY_LABEL[code] || code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function amountOf(raw: unknown): number | null {
  const text = attributeText(raw).replace(/[$,]/g, '');
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function money(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function dateOf(raw: unknown): number | null {
  const text = attributeText(raw);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(ms: number | null): string {
  if (ms == null) return '';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type SortKey = 'name' | 'strategy' | 'stage' | 'facility' | 'hold' | 'close';

function knownBy(knowledgeDate: string, createdAt: string | null | undefined): boolean {
  if (!createdAt) return true;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  const text = knowledgeDate.trim();
  const today = new Date().toISOString().slice(0, 10);
  const known = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? (text >= today ? Date.now() : Date.parse(`${text}T23:59:59.999Z`))
    : Date.parse(text.length === 16 ? `${text}:00` : text);
  return !Number.isFinite(known) || created <= known;
}

export default function DealPipelinePage() {
  const router = useRouter();
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [experience, setExperience] = useState<RecordExperience | null>(null);
  const [deals, setDeals] = useState<DealCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState('all');
  const [stage, setStage] = useState('all');
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [view, setView] = useState<'list' | 'timeline'>('list');
  const [group, setGroup] = useState<'strategy' | 'stage' | 'none'>('strategy');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'stage', dir: 1 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [experiences, entities] = await Promise.all([
      graphqlQuery<{ recordExperiences: RecordExperience[] }, { anchorDomainCode: string; isActive: boolean }>(
        RECORD_EXPERIENCES_QUERY,
        { anchorDomainCode: 'DEAL', isActive: true },
        'network-only',
      ),
      graphqlQuery<{ entities: { edges: Array<{ node: DealCard }> } }, { asOfDate: string; knowledgeDate: string }>(
        `query PipelineDeals($asOfDate: Date, $knowledgeDate: DateTime) {
          entities(filter: { domainCode: "DEAL", isActive: true }, pagination: { first: 200 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
            edges { node { id entityCode entityName createdAt attributes } }
          }
        }`,
        { asOfDate, knowledgeDate },
        'network-only',
      ),
    ]);
    const message = experiences.error?.message || entities.error?.message;
    if (message) {
      setError(message);
      setLoading(false);
      return;
    }
    setExperience((experiences.data?.recordExperiences || []).find((item) => item.pipeline) || null);
    setDeals((entities.data?.entities?.edges || []).map((edge) => edge.node));
    setLoading(false);
  }, [asOfDate, knowledgeDate]);

  useEffect(() => { void load(); }, [load]);

  const stages = experience?.pipeline?.stages?.length ? experience.pipeline.stages : FALLBACK_STAGES;
  const stageAttribute = experience?.pipeline?.stageAttribute || 'DEAL_STAGE';
  const asOfDay = asOfDate.slice(0, 10);
  const rows = useMemo(() => deals.filter((deal) => {
    if (!knownBy(knowledgeDate, deal.createdAt)) return false;
    const opened = attributeText(deal.attributes?.DEAL_DATE).slice(0, 10);
    return !opened || opened <= asOfDay;
  }).map((deal) => {
    let stageCode = attributeText(deal.attributes?.[stageAttribute]);
    const closeDay = attributeText(deal.attributes?.DEAL_TARGET_CLOSE_DATE).slice(0, 10);
    if (stageCode === 'CLOSED' && closeDay && closeDay > asOfDay) stageCode = 'CLOSING';
    const strategyCode = attributeText(deal.attributes?.DEAL_STRATEGY);
    const facility = amountOf(deal.attributes?.DEAL_FACILITY_SIZE) ?? amountOf(deal.attributes?.DEAL_VALUE) ?? 0;
    const hold = amountOf(deal.attributes?.DEAL_TARGET_HOLD);
    const allocated = amountOf(deal.attributes?.DEAL_ALLOCATED_AMOUNT);
    const close = dateOf(deal.attributes?.DEAL_TARGET_CLOSE_DATE) ?? dateOf(deal.attributes?.DEAL_DATE);
    const gap = hold != null && allocated != null ? hold - allocated : null;
    const needsAttention = ACTIVE_STAGES.has(stageCode) && (gap == null || Math.abs(gap) > facility * 0.01);
    return {
      deal,
      stageCode,
      stageIndex: stages.findIndex((item) => item.code === stageCode),
      strategyCode,
      sector: attributeText(deal.attributes?.DEAL_SECTOR) || attributeText(deal.attributes?.DEAL_TYPE),
      facility,
      hold,
      allocated,
      close,
      gap,
      needsAttention,
    };
  }), [asOfDay, deals, knowledgeDate, stageAttribute, stages]);

  const strategies = useMemo(() => {
    const present = new Set(rows.map((row) => row.strategyCode).filter(Boolean));
    const ordered = STRATEGY_ORDER.filter((code) => present.has(code));
    for (const code of present) if (!ordered.includes(code)) ordered.push(code);
    if (rows.some((row) => !row.strategyCode)) ordered.push('');
    return ordered;
  }, [rows]);

  const searched = rows.filter((row) => {
    const haystack = `${row.deal.entityName} ${row.deal.entityCode} ${row.sector} ${labelOf(row.strategyCode)}`.toLowerCase();
    if (query.trim() && !haystack.includes(query.trim().toLowerCase())) return false;
    if (attentionOnly && !row.needsAttention) return false;
    return true;
  });
  const visible = searched.filter((row) => (
    (strategy === 'all' || row.strategyCode === strategy)
    && (stage === 'all' || row.stageCode === stage)
  ));

  const open = visible.filter((row) => row.stageCode !== 'CLOSED');
  const facility = open.reduce((total, row) => total + row.facility, 0);
  const holdTotal = open.reduce((total, row) => total + (row.hold || 0), 0);
  const allocatedTotal = open.reduce((total, row) => total + (row.allocated || 0), 0);
  const attention = open.filter((row) => row.needsAttention).length;

  const maxCount = Math.max(1, ...strategies.flatMap((code) => stages.map((item) => (
    searched.filter((row) => row.strategyCode === code && row.stageCode === item.code).length
  ))));

  const toggleSort = (key: SortKey) => {
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

  const sorted = (list: typeof visible) => [...list].sort((left, right) => {
    const value = (row: typeof left) => {
      if (sort.key === 'name') return row.deal.entityName;
      if (sort.key === 'strategy') return labelOf(row.strategyCode);
      if (sort.key === 'stage') return row.stageIndex;
      if (sort.key === 'facility') return row.facility;
      if (sort.key === 'hold') return row.hold || 0;
      return row.close || 0;
    };
    const a = value(left);
    const b = value(right);
    const compared = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
    return compared * sort.dir || left.deal.entityName.localeCompare(right.deal.entityName);
  });

  const openDeal = (id: string) => router.push(`/deals/${id}/allocation`);

  const groups = group === 'strategy'
    ? strategies.map((code) => ({ id: code || 'none', label: labelOf(code), rows: visible.filter((row) => row.strategyCode === code) }))
    : group === 'stage'
      ? stages.map((item) => ({ id: item.code, label: item.label, rows: visible.filter((row) => row.stageCode === item.code) }))
      : [{ id: 'all', label: 'All', rows: visible }];

  return (
    <div className="view-fade da pipe">
      <div className="da-crumbs">
        <Link href="/">Home</Link>
        <span>/</span>
        <strong>Deal pipeline</strong>
      </div>

      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Pipeline</span>
          <h1>Deal pipeline</h1>
          <p>Where every deal sits in its life cycle, across strategies. Pick a cell to filter the list, then open a deal.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Open deals</span><strong>{open.length}</strong></div>
          <div className="da-fact"><span>Facility size</span><strong>{money(facility)}</strong></div>
          <div className="da-fact"><span>Our target hold</span><strong>{holdTotal ? money(holdTotal) : '—'}</strong></div>
          <div className="da-fact"><span>Allocated</span><strong>{allocatedTotal ? money(allocatedTotal) : '—'}</strong></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>Need attention</span><b>{attention}</b></div>
          <div className="da-bar"><i style={{ width: `${open.length ? Math.min(100, (attention / open.length) * 100) : 0}%` }} /></div>
          <p>{attention ? `${attention} of ${open.length} open deals need a look.` : 'No open deal needs attention.'}</p>
        </div>
      </header>

      {loading && <div className="xp-empty">Loading pipeline…</div>}
      {error && <div className="xp-error">{error}</div>}

      {!loading && (
        <>
          <div className="pipe-board">
            <table className="pipe-mx" aria-label="Deals by strategy and stage">
              <thead>
                <tr>
                  <th>
                    <button type="button" className="hb" aria-pressed={strategy === 'all' && stage === 'all'} onClick={() => { setStrategy('all'); setStage('all'); }}>
                      Strategy<span className="sx">All stages</span>
                    </button>
                  </th>
                  {stages.map((item) => {
                    const count = searched.filter((row) => row.stageCode === item.code).length;
                    const dollars = searched.filter((row) => row.stageCode === item.code).reduce((total, row) => total + row.facility, 0);
                    return (
                      <th key={item.code}>
                        <button type="button" className="hb" aria-pressed={strategy === 'all' && stage === item.code} onClick={() => { setStrategy('all'); setStage(stage === item.code ? 'all' : item.code); }}>
                          {item.label}
                          <span className="sx">{count} deal{count === 1 ? '' : 's'}, {money(dollars)}</span>
                        </button>
                      </th>
                    );
                  })}
                  <th>All stages</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((code) => {
                  const inStrategy = searched.filter((row) => row.strategyCode === code);
                  return (
                    <tr key={code || 'none'}>
                      <th>
                        <button type="button" className="hb" aria-pressed={strategy === code && stage === 'all'} onClick={() => { setStrategy(strategy === code ? 'all' : code); setStage('all'); }}>
                          {labelOf(code)}
                          <span className="sx">{inStrategy.length} deal{inStrategy.length === 1 ? '' : 's'}, {money(inStrategy.reduce((total, row) => total + row.facility, 0))}</span>
                        </button>
                      </th>
                      {stages.map((item) => {
                        const cell = inStrategy.filter((row) => row.stageCode === item.code);
                        const attn = cell.filter((row) => row.needsAttention).length;
                        const pressed = strategy === code && stage === item.code;
                        return (
                          <td key={item.code}>
                            <button
                              type="button"
                              className={`cb ${cell.length ? '' : 'zero'}`}
                              style={{ ['--t' as string]: cell.length / maxCount }}
                              aria-pressed={pressed}
                              onClick={() => {
                                if (pressed) { setStrategy('all'); setStage('all'); }
                                else { setStrategy(code); setStage(item.code); }
                              }}
                            >
                              <span className="n">{cell.length}</span>
                              <span className="d">{cell.length ? money(cell.reduce((total, row) => total + row.facility, 0)) : 'none'}</span>
                              {attn > 0 && <span className="at" title={`${attn} need attention`}>{attn}</span>}
                            </button>
                          </td>
                        );
                      })}
                      <td className="tc">
                        <button type="button" className="cb" aria-pressed={strategy === code && stage === 'all'} onClick={() => { setStrategy(strategy === code && stage === 'all' ? 'all' : code); setStage('all'); }}>
                          <span className="n">{inStrategy.length}</span>
                          <span className="d">{money(inStrategy.reduce((total, row) => total + row.facility, 0))}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pipe-tools">
            <div className="l">
              <input className="pipe-search" type="search" placeholder="Search deal, sponsor or sector" aria-label="Search deals" value={query} onChange={(event) => setQuery(event.target.value)} />
              <button type="button" className="pipe-chip" aria-pressed={attentionOnly} onClick={() => setAttentionOnly((value) => !value)}>Needs attention</button>
              {strategy !== 'all' && <button type="button" className="pipe-chip on" onClick={() => setStrategy('all')}>{labelOf(strategy)} ×</button>}
              {stage !== 'all' && <button type="button" className="pipe-chip on" onClick={() => setStage('all')}>{stages.find((item) => item.code === stage)?.label} ×</button>}
            </div>
            <div className="r">
              <div className="pipe-seg" role="group" aria-label="View">
                <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
                <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</button>
              </div>
              <span className="lbl">Group by</span>
              <div className="pipe-seg" role="group" aria-label="Group by">
                {(['strategy', 'stage', 'none'] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={group === option} onClick={() => setGroup(option)}>
                    {option === 'strategy' ? 'Strategy' : option === 'stage' ? 'Stage' : 'None'}
                  </button>
                ))}
              </div>
              <button type="button" className="btn" onClick={() => setCollapsed(new Set())}>Expand all</button>
              <button type="button" className="btn" onClick={() => setCollapsed(new Set(groups.map((item) => item.id)))}>Collapse all</button>
            </div>
          </div>
          <div className="pipe-count">Showing {visible.length} of {rows.length} deals</div>

          {view === 'list' ? (
            <div className="pipe-tablewrap">
              <table className="pipe-tab">
                <thead>
                  <tr>
                    {([
                      ['name', 'Deal', ''],
                      ...(group === 'strategy' ? [] : [['strategy', 'Strategy', '']] as const),
                      ...(group === 'stage' ? [] : [['stage', 'Stage', '']] as const),
                      ['facility', 'Facility', 'r'],
                      ['hold', 'Our hold', 'r'],
                      ['alloc', 'Allocated', ''],
                      ['flags', 'Flags', ''],
                      ['close', 'Close', ''],
                    ] as Array<[string, string, string]>).map(([key, label, align]) => (
                      <th key={key} className={align}>
                        {key === 'flags' || key === 'alloc' ? label : (
                          <button type="button" onClick={() => toggleSort(key as SortKey)}>
                            {label}{sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                          </button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((item) => {
                    if (!item.rows.length) return null;
                    const openGroup = !collapsed.has(item.id);
                    const list = sorted(item.rows);
                    const columns = 6 + (group === 'strategy' ? 0 : 1) + (group === 'stage' ? 0 : 1);
                    return (
                      <Fragment key={item.id}>
                        {group !== 'none' && (
                          <tr className="grp" onClick={() => setCollapsed((current) => {
                            const next = new Set(current);
                            if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                            return next;
                          })}>
                            <td colSpan={columns}>
                              <span style={{ display: 'inline-block', width: 14, transform: `rotate(${openGroup ? 90 : 0}deg)` }}>▸</span>
                              {item.label}
                              <span className="gs">{list.length} deal{list.length === 1 ? '' : 's'}, {money(list.reduce((total, row) => total + row.facility, 0))} facility</span>
                            </td>
                          </tr>
                        )}
                        {(group === 'none' || openGroup) && list.map((row) => {
                          const ratio = row.hold ? (row.allocated || 0) / row.hold : 0;
                          return (
                            <tr key={row.deal.id} className={`deal ${group === 'none' ? '' : 'in'}`} onClick={() => openDeal(row.deal.id)}>
                              <td><span className="pipe-name">{row.deal.entityName}</span><span className="sm2">{row.sector}</span></td>
                              {group !== 'strategy' && <td>{labelOf(row.strategyCode)}</td>}
                              {group !== 'stage' && (
                                <td>
                                  <span className="pipe-stg">
                                    <span className="pipe-trk">{stages.map((itemStage, index) => <i key={itemStage.code} className={index <= row.stageIndex ? 'on' : ''} />)}</span>
                                    {stages[row.stageIndex]?.label || 'Unstaged'}
                                  </span>
                                </td>
                              )}
                              <td className="r">{money(row.facility)}</td>
                              <td className="r">{row.hold != null ? money(row.hold) : '—'}</td>
                              <td>
                                {row.hold != null && (
                                  <span className="pipe-prog"><i style={{ width: `${Math.min(100, ratio * 100)}%` }} /></span>
                                )}
                                {row.allocated != null ? `${Math.round(ratio * 100)}%` : '—'}
                              </td>
                              <td>
                                {row.needsAttention && <span className="pipe-pill bad">needs attention</span>}
                                {row.gap != null && row.gap > row.facility * 0.01 && <span className="pipe-pill">{money(row.gap)} unallocated</span>}
                              </td>
                              <td>{formatDate(row.close)}</td>
                            </tr>
                          );
                        }                        )}
                      </Fragment>
                    );
                  })}
                  {!visible.length && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--ink-3)', padding: 28 }}>No deals match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <PipelineTimeline
              groups={group === 'none' ? [{ id: 'all', label: 'All', rows: sorted(visible) }] : groups.map((item) => ({ ...item, rows: sorted(item.rows) }))}
              stages={stages}
              collapsed={collapsed}
              grouped={group !== 'none'}
              onToggle={(id) => setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })}
              onOpen={openDeal}
            />
          )}
          <div className="page-meta" style={{ marginTop: 10 }}>
            <Link href="/deals" className="crumb-link">All deals</Link>
          </div>
        </>
      )}
    </div>
  );
}

function PipelineTimeline({
  groups,
  stages,
  collapsed,
  grouped,
  onToggle,
  onOpen,
}: {
  groups: Array<{ id: string; label: string; rows: Array<{ deal: DealCard; stageIndex: number; close: number | null; needsAttention: boolean; sector: string; strategyCode: string }> }>;
  stages: Stage[];
  collapsed: Set<string>;
  grouped: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const DAY = 86400000;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const bars = stages.slice(0, Math.max(1, stages.length - 1));
  const points = groups.flatMap((group) => group.rows.map((row) => row.close || today + 60 * DAY));
  const min = Math.min(today - 80 * DAY, ...(points.length ? points : [today]));
  const max = Math.max(today + 40 * DAY, ...(points.length ? points : [today]));
  const width = Math.ceil((max - min) / DAY) * 3;
  const x = (time: number) => ((time - min) / DAY) * 3;
  const colors = ['color-mix(in srgb, var(--accent) 22%, white)', 'color-mix(in srgb, var(--accent) 40%, white)', 'color-mix(in srgb, var(--accent) 58%, white)', 'color-mix(in srgb, var(--accent) 78%, white)', 'var(--accent)'];

  const rowBar = (row: { deal: DealCard; stageIndex: number; close: number | null; needsAttention: boolean; sector: string }) => {
    const close = row.close || today + 45 * DAY;
    const index = Math.max(0, row.stageIndex);
    return (
      <div key={row.deal.id} className="pipe-tl-row" onClick={() => onOpen(row.deal.id)}>
        <div className="pipe-tl-label" style={{ paddingLeft: grouped ? 28 : 12 }}>
          <span className="pipe-name">{row.deal.entityName}</span>
          <span className="sm2">{row.sector}</span>
          {row.needsAttention && <span className="pipe-pill bad">!</span>}
        </div>
        <div className="pipe-tl-bar" style={{ width }}>
          {bars.map((stage, stageIndex) => {
            const start = close - (bars.length - stageIndex) * 18 * DAY;
            const end = start + 18 * DAY;
            return (
              <span
                key={stage.code}
                className={`pipe-segbar ${stageIndex === index ? 'cur' : ''} ${stageIndex > index ? 'fut' : ''}`}
                style={{ left: x(start), width: Math.max(8, x(end) - x(start)), background: colors[stageIndex % colors.length], color: stageIndex >= 3 ? '#fff' : 'inherit' }}
                title={stage.label}
              >
                {stageIndex === index ? stage.label : ''}
              </span>
            );
          })}
          <span className={`pipe-mark ${index >= bars.length ? 'done' : ''}`} style={{ left: x(close) }} title="Target close" />
          <span className="pipe-today" style={{ left: x(today) }} />
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="pipe-leg">
        {bars.map((stage, index) => (
          <span key={stage.code}><span className="sw" style={{ background: colors[index % colors.length] }} />{stage.label}</span>
        ))}
        <span><span className="sw pipe-mark" style={{ position: 'static', display: 'inline-block', transform: 'rotate(45deg)', width: 8, height: 8 }} />Target close</span>
      </div>
      <div className="pipe-tl">
        <div className="pipe-tl-head">
          <div className="pipe-tl-label">Deal</div>
          <div className="pipe-tl-bar" style={{ width }}>
            <span className="pipe-today" style={{ left: x(today) }} />
          </div>
        </div>
        {groups.map((group) => {
          if (!group.rows.length) return null;
          const open = !collapsed.has(group.id);
          return (
            <div key={group.id}>
              {grouped && (
                <div className="pipe-tl-grp" onClick={() => onToggle(group.id)}>
                  <div className="pipe-tl-label">{open ? '▾' : '▸'} {group.label}<span className="sm2">{group.rows.length}</span></div>
                  <div className="pipe-tl-bar" style={{ width }} />
                </div>
              )}
              {(open || !grouped) && group.rows.map(rowBar)}
            </div>
          );
        })}
      </div>
    </>
  );
}
