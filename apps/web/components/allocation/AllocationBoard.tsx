'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation, graphqlQuery, UPDATE_ENTITY_MUTATION } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';
import { IcMemo } from './IcMemo';
import { DealCompliance } from './DealCompliance';

const REASONS = [
  ['LIQ', 'Liquidity or reserve constraint'],
  ['CONC', 'Concentration or exposure limit'],
  ['MAND', 'Mandate or guideline restriction'],
  ['TAX', 'Tax or regulatory'],
  ['CONF', 'Conflict of interest or affiliate'],
  ['PORT', 'Portfolio construction or diversification'],
  ['IC', 'Investment committee directive'],
  ['CLNT', 'Client instruction'],
  ['OTH', 'Other (note required)'],
] as const;

const STAGES = ['ORIGINATION', 'DILIGENCE', 'COMMITTEE', 'ALLOCATION', 'CLOSING', 'CLOSED'];
const STAGE_LABEL: Record<string, string> = {
  ORIGINATION: 'Origination',
  DILIGENCE: 'Diligence',
  COMMITTEE: 'IC approved',
  ALLOCATION: 'Allocation',
  CLOSING: 'Closing',
  CLOSED: 'Funded',
};
const STRATEGY_LABEL: Record<string, string> = {
  DIRECT_LENDING: 'Direct Lending',
  OPPORTUNISTIC_CREDIT: 'Opportunistic Credit',
  ASSET_BASED_FINANCE: 'Asset-Based Finance',
  SPECIAL_SITUATIONS: 'Special Situations',
};
const COLOR: Record<string, string> = {
  LOAN: '#0B5D73',
  DELAYED_DRAW_TERM_LOAN: '#4A84AE',
  REVOLVING_CREDIT: '#2F8F7A',
  SECOND_LIEN_LOAN: '#5663B4',
  MEZZANINE: '#B5517A',
  WARRANT: '#7452A6',
  PREFERRED_EQUITY: '#9A5B2E',
};

interface Cell {
  trancheId: string;
  eligible: boolean;
  amount: number;
  systemAmount: number;
  capReason?: string | null;
  exclusionKind?: string | null;
  exclusionText?: string | null;
  overridden: boolean;
  reasonCode?: string | null;
}

interface Row {
  fundId: string;
  fundName: string;
  parentFundId?: string | null;
  level: string;
  availableCapital: number;
  nav: number;
  total: number;
  cash?: number;
  undrawn?: number;
  line?: number;
  reserve?: number;
  issuerLimit?: number | null;
  sponsorLimit?: number | null;
  unfundedLimit?: number | null;
  cells: Cell[];
}

interface Tranche {
  id: string;
  name: string;
  label?: string | null;
  size: number;
  holdPct: number;
  targetAmount: number;
  allocated: number;
  unfunded: boolean;
  instrumentType: string;
  rank?: number | null;
  pricing?: string | null;
  callProtection?: string | null;
  equityLinked?: boolean | null;
  coverage?: string | null;
  tickingFee?: string | null;
  status?: string | null;
  securityId?: string | null;
}

interface Adjustment {
  fundId: string;
  trancheId: string;
  type: string;
  amount?: number | null;
  reason?: string | null;
  note?: string | null;
}

interface Preview {
  dealName: string;
  description?: string | null;
  stage?: string | null;
  strategy?: string | null;
  borrower?: string | null;
  borrowerId?: string | null;
  sponsor?: string | null;
  sponsorId?: string | null;
  pricing?: string | null;
  oid?: string | null;
  leverage?: string | null;
  maturity?: string | null;
  closeDate?: string | null;
  facilitySize: number;
  targetHold: number;
  allocated: number;
  unallocated: number;
  tranches: Tranche[];
  rows: Row[];
  adjustments: Adjustment[];
  errors: Array<{ message: string }>;
}

const PREVIEW = `
  query PreviewAllocation($dealId: ID!, $asOfDate: Date, $holds: [AllocationHoldInput!], $adjustments: [AllocationAdjustmentInput!]) {
    previewAllocation(dealId: $dealId, asOfDate: $asOfDate, holds: $holds, adjustments: $adjustments) {
      dealName description stage strategy borrower borrowerId sponsor sponsorId pricing oid leverage maturity closeDate
      facilitySize targetHold allocated unallocated
      tranches { id name label size holdPct targetAmount allocated unfunded instrumentType rank pricing callProtection equityLinked coverage tickingFee status securityId }
      rows {
        fundId fundName parentFundId level availableCapital nav total cash undrawn line reserve issuerLimit sponsorLimit unfundedLimit
        cells { trancheId eligible amount systemAmount capReason exclusionKind exclusionText overridden reasonCode }
      }
      adjustments { fundId trancheId type amount reason note }
      errors { message }
    }
  }
`;

const COMMIT = `
  mutation CommitAllocation($dealId: ID!, $asOfDate: Date, $holds: [AllocationHoldInput!], $adjustments: [AllocationAdjustmentInput!]) {
    commitAllocation(dealId: $dealId, asOfDate: $asOfDate, holds: $holds, adjustments: $adjustments) {
      dealName allocated unallocated
      errors { message }
    }
  }
`;

function millions(amount: number): string {
  const millionsValue = amount / 1_000_000;
  const digits = Math.abs(millionsValue) >= 100 ? 1 : 2;
  return `$${millionsValue.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}M`;
}

function plain(amount: number): string {
  return (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function when(value?: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function isoDate(value?: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function applySavedFact(preview: Preview, code: string, value: string): Preview {
  if (code === 'DEAL_DESCRIPTION') return { ...preview, description: value };
  if (code === 'DEAL_PRICING_SUMMARY') return { ...preview, pricing: value };
  if (code === 'DEAL_OID_PRICE') return { ...preview, oid: value };
  if (code === 'DEAL_MATURITY_DATE') return { ...preview, maturity: value };
  if (code === 'DEAL_TARGET_CLOSE_DATE') return { ...preview, closeDate: value };
  if (code === 'DEAL_LEVERAGE_SENIOR' || code === 'DEAL_LEVERAGE_TOTAL') {
    const parts = (preview.leverage || '').split('/').map((part) => part.replace(/x/gi, '').trim());
    if (code === 'DEAL_LEVERAGE_SENIOR') parts[0] = value;
    else parts[1] = value;
    return { ...preview, leverage: [parts[0], parts[1]].filter(Boolean).map((part) => `${part}x`).join(' / ') };
  }
  return preview;
}

function EditableValue({
  value,
  display,
  kind,
  label,
  onSave,
}: {
  value: string;
  display?: string;
  kind: 'text' | 'number' | 'date';
  label: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <button type="button" className="field-edit" onClick={() => setEditing(true)} aria-label={`Edit ${label}`}>
        {display || (kind === 'date' ? when(value) : value) || '—'}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type={kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'}
      step={kind === 'number' ? '0.1' : undefined}
      aria-label={label}
      value={kind === 'date' ? isoDate(draft) : draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => { setEditing(false); if (event.target.value !== value) void onSave(event.target.value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { setDraft(value); setEditing(false); }
      }}
    />
  );
}

export function AllocationBoard({ dealId, dealName }: { dealId: string; dealName?: string }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [holds, setHolds] = useState<Record<string, number>>({});
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ fundId: string; trancheId: string; amount: string; reason: string; note: string; type: 'override' | 'exclude' } | null>(null);
  const [tab, setTab] = useState<'capital' | 'memo' | 'compliance'>('capital');

  const load = useCallback(async (local: { holds: Record<string, number>; adjustments: Adjustment[] } | null) => {
    setLoading(true);
    const variables: Record<string, unknown> = { dealId, asOfDate };
    if (local) {
      variables.holds = Object.entries(local.holds).map(([trancheId, holdPct]) => ({ trancheId, holdPct }));
      variables.adjustments = local.adjustments.map((item) => ({
        fundId: item.fundId,
        trancheId: item.trancheId,
        type: item.type,
        amount: item.amount,
        reasonCode: item.reason,
        note: item.note,
      }));
    }
    const result = await graphqlQuery<{ previewAllocation: Preview }>(PREVIEW, variables, 'network-only');
    const message = result.error?.message;
    const data = result.data?.previewAllocation;
    if (message || !data) {
      setError(message || 'Could not preview the allocation');
      setLoading(false);
      return;
    }
    setPreview(data);
    setError(data.errors?.[0]?.message || null);
    if (!local) {
      const nextHolds: Record<string, number> = {};
      for (const tranche of data.tranches) nextHolds[tranche.id] = tranche.holdPct;
      setHolds(nextHolds);
      setAdjustments(data.adjustments || []);
      setExpanded(new Set(data.rows.filter((row) => row.level === 'PORTFOLIO').map((row) => row.fundId)));
      setSelected(data.rows[0]?.fundId || null);
      setSeeded(true);
    }
    setLoading(false);
  }, [asOfDate, dealId]);

  useEffect(() => { void load(null); }, [load]);

  useEffect(() => {
    if (!seeded) return;
    const timer = window.setTimeout(() => { void load({ holds, adjustments }); }, 250);
    return () => window.clearTimeout(timer);
  }, [adjustments, holds, load, seeded]);

  const commit = async () => {
    setSaving(true);
    setNotice(null);
    const result = await graphqlMutation<{ commitAllocation: { errors: Array<{ message: string }> } }>(COMMIT, {
      dealId,
      asOfDate,
      holds: Object.entries(holds).map(([trancheId, holdPct]) => ({ trancheId, holdPct })),
      adjustments: adjustments.map((item) => ({
        fundId: item.fundId,
        trancheId: item.trancheId,
        type: item.type,
        amount: item.amount,
        reasonCode: item.reason,
        note: item.note,
      })),
    });
    const message = result.error?.message || result.data?.commitAllocation?.errors?.[0]?.message;
    setSaving(false);
    if (message) {
      setError(message);
      return;
    }
    setNotice('Allocation saved.');
  };

  const title = preview?.dealName || dealName || 'Allocation';
  const tranches = preview?.tranches || [];
  const facility = preview?.facilitySize || 0;
  const blended = facility ? tranches.reduce((total, tranche) => total + tranche.size * (holds[tranche.id] ?? tranche.holdPct), 0) / facility : 0;
  const stageIndex = STAGES.indexOf(preview?.stage || '');
  const selectedRow = preview?.rows.find((row) => row.fundId === selected) || null;

  const setAllHolds = (percent: number) => {
    setHolds(Object.fromEntries(tranches.map((tranche) => [tranche.id, percent])));
  };

  const saveAttribute = async (code: string, value: string) => {
    const previous = preview;
    setPreview((current) => current ? applySavedFact(current, code, value) : current);
    setError(null);
    const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }>(UPDATE_ENTITY_MUTATION, {
      input: { id: dealId, attributes: { [code]: value }, asOfDate },
    });
    const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    if (message) {
      setPreview(previous);
      setError(message);
    }
  };

  const leverageParts = (preview?.leverage || '').split('/').map((part) => part.replace(/x/gi, '').trim());

  return (
    <div className="da">
      <div className="da-crumbs">
        <Link href="/pipeline">Pipeline</Link>
        <span>/</span>
        <span>{STRATEGY_LABEL[preview?.strategy || ''] || 'Deal'}</span>
        <span>/</span>
        <strong>{title}</strong>
      </div>

      {(tab === 'capital' || tab === 'compliance') && <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">{STAGE_LABEL[preview?.stage || ''] || preview?.stage || 'Deal'}</span>
          <h1><Link href={`${domainHref('DEAL')}/${dealId}`}>{title}</Link></h1>
          <p>
            <EditableValue label="Description" kind="text" value={preview?.description || ''} onSave={(value) => saveAttribute('DEAL_DESCRIPTION', value)} />
          </p>
          <span className="da-track">{STAGES.map((stage, index) => <i key={stage} className={index <= stageIndex ? 'on' : ''} />)}</span>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Total facility</span><strong>{millions(facility)}</strong></div>
          <div className="da-fact">
            <span>Borrower</span>
            <strong>{preview?.borrowerId ? <Link href={`${domainHref('ISSUER')}/${preview.borrowerId}`}>{preview.borrower}</Link> : '—'}</strong>
          </div>
          <div className="da-fact">
            <span>Sponsor</span>
            <strong>{preview?.sponsorId ? <Link href={`${domainHref('SPONSOR')}/${preview.sponsorId}`}>{preview.sponsor}</Link> : '—'}</strong>
          </div>
          <div className="da-fact">
            <span>Pricing</span>
            <strong><EditableValue label="Pricing" kind="text" value={preview?.pricing || ''} onSave={(value) => saveAttribute('DEAL_PRICING_SUMMARY', value)} /></strong>
          </div>
          <div className="da-fact">
            <span>OID</span>
            <strong><EditableValue label="OID" kind="number" value={preview?.oid || ''} onSave={(value) => saveAttribute('DEAL_OID_PRICE', value)} /></strong>
          </div>
          <div className="da-fact">
            <span>Leverage (senior / total)</span>
            <strong className="da-pair">
              <EditableValue label="Senior leverage" kind="number" value={leverageParts[0] || ''} display={leverageParts[0] ? `${leverageParts[0]}x` : ''} onSave={(value) => saveAttribute('DEAL_LEVERAGE_SENIOR', value)} />
              <span>/</span>
              <EditableValue label="Total leverage" kind="number" value={leverageParts[1] || ''} display={leverageParts[1] ? `${leverageParts[1]}x` : ''} onSave={(value) => saveAttribute('DEAL_LEVERAGE_TOTAL', value)} />
            </strong>
          </div>
          <div className="da-fact">
            <span>Maturity</span>
            <strong><EditableValue label="Maturity" kind="date" value={preview?.maturity || ''} onSave={(value) => saveAttribute('DEAL_MATURITY_DATE', value)} /></strong>
          </div>
          <div className="da-fact">
            <span>Close</span>
            <strong><EditableValue label="Close" kind="date" value={preview?.closeDate || ''} onSave={(value) => saveAttribute('DEAL_TARGET_CLOSE_DATE', value)} /></strong>
          </div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>Our hold, blended across tranches</span><b>{Math.round(blended)}%</b></div>
          <input type="range" min={0} max={100} value={Math.round(blended)} aria-label="Set our hold for every tranche" onChange={(event) => setAllHolds(Number(event.target.value))} />
          <p>Drag to set every tranche at once. Set each tranche on its own in the cards below.</p>
          <div className="da-bar"><i style={{ width: `${facility && preview ? Math.min(100, preview.allocated / preview.targetHold * 100) : 0}%` }} /></div>
          <p>{preview ? `Allocated ${millions(preview.allocated)} of ${millions(preview.targetHold)}` : ''}</p>
        </div>
      </header>}

      <div className="da-tabs" role="tablist">
        <button type="button" className={tab === 'capital' ? 'on' : ''} onClick={() => setTab('capital')}>Capital structure</button>
        <button type="button" className={tab === 'memo' ? 'on' : ''} onClick={() => setTab('memo')}>IC memo</button>
        <button type="button" className={tab === 'compliance' ? 'on' : ''} onClick={() => setTab('compliance')}>Compliance</button>
        {['Syndicate', 'Funding', 'Closing', 'Servicing'].map((name) => (
          <button key={name} type="button" disabled title="Not on the ledger yet">{name}</button>
        ))}
      </div>

      {error && <div className="xp-error">{error}</div>}
      {notice && <p className="da-note">{notice}</p>}
      {loading && !preview && <div className="xp-empty">Loading allocation…</div>}

      {tab === 'memo' && (
        <IcMemo
          dealId={dealId}
          asOfDate={asOfDate}
          preview={preview}
          onOpenCapital={() => setTab('capital')}
          onChanged={() => { void load({ holds, adjustments }); }}
        />
      )}

      {tab === 'compliance' && preview && (
        <DealCompliance
          dealId={dealId}
          asOfDate={asOfDate}
          holds={holds}
          adjustments={adjustments}
          funds={preview.rows.map((row) => ({
            fundId: row.fundId,
            fundName: row.fundName,
            parentFundId: row.parentFundId,
            level: row.level,
          }))}
        />
      )}

      {tab === 'capital' && preview && (
        <>
          <section className="da-sec">
            <div className="da-sechead">
              <h2>Capital structure</h2>
              <p>Securities in order of seniority. A striped segment is unfunded at close and drawn on demand.</p>
            </div>
            <div className="da-axis"><span>Most senior</span><span>Least senior</span></div>
            <div className="da-stack">
              {tranches.map((tranche) => {
                const segment = (
                  <>
                    <b>{tranche.label || tranche.name}</b>
                    <span>{millions(tranche.size)}{tranche.equityLinked ? ', Equity-linked' : ''}</span>
                  </>
                );
                return tranche.securityId ? (
                  <Link key={tranche.id} href={`${domainHref('SECURITY')}/${tranche.securityId}`} className={`da-seg ${tranche.unfunded ? 'unf' : ''}`} style={{ flex: tranche.size, background: COLOR[tranche.instrumentType] || '#0B5D73' }}>
                    {segment}
                  </Link>
                ) : (
                  <div key={tranche.id} className={`da-seg ${tranche.unfunded ? 'unf' : ''}`} style={{ flex: tranche.size, background: COLOR[tranche.instrumentType] || '#0B5D73' }}>
                    {segment}
                  </div>
                );
              })}
            </div>
            <div className="da-cards">
              {tranches.map((tranche) => {
                const hold = holds[tranche.id] ?? tranche.holdPct;
                const target = tranche.size * hold / 100;
                const placed = preview.rows.filter((row) => row.level === 'PORTFOLIO' && (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0) > 1000).length;
                return (
                  <article key={tranche.id} className="da-card" style={{ borderTopColor: COLOR[tranche.instrumentType] || '#0B5D73' }}>
                    <h3>{tranche.securityId ? <Link href={`${domainHref('SECURITY')}/${tranche.securityId}`}>{tranche.name}</Link> : tranche.name}</h3>
                    <div className="da-rank">{tranche.equityLinked ? 'Equity-linked, junior to all debt' : tranche.unfunded ? '1st lien senior secured' : '1st lien senior secured'}</div>
                    <div className="da-size">{millions(tranche.size)} <small>{tranche.status}</small></div>
                    <dl>
                      {tranche.pricing && <><dt>Pricing</dt><dd>{tranche.pricing}</dd></>}
                      {tranche.tickingFee && <><dt>Ticking fee</dt><dd>{tranche.tickingFee}</dd></>}
                      {tranche.coverage && <><dt>Coverage</dt><dd>{tranche.coverage}</dd></>}
                      {tranche.callProtection && <><dt>Call protection</dt><dd>{tranche.callProtection}</dd></>}
                    </dl>
                    <div className="da-holdblock">
                    <label>
                      Our hold of this tranche
                      <span><input type="number" min={0} max={tranche.size / 1_000_000} step={0.25} value={(target / 1_000_000).toFixed(2)} onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) setHolds((current) => ({ ...current, [tranche.id]: Math.min(100, Math.max(0, next * 1_000_000 / tranche.size * 100)) }));
                      }} /> $M</span>
                    </label>
                    <input type="range" min={0} max={100} value={Math.round(hold)} aria-label={`Our hold of the ${tranche.name}`} onChange={(event) => setHolds((current) => ({ ...current, [tranche.id]: Number(event.target.value) }))} />
                    <div className="da-cardmeta"><span>{hold.toFixed(0)}% of tranche</span><span>{tranche.targetAmount ? `${Math.round(tranche.allocated / tranche.targetAmount * 100)}% allocated` : ''}</span></div>
                    <div className="da-bar"><i style={{ width: `${tranche.targetAmount ? Math.min(100, tranche.allocated / tranche.targetAmount * 100) : 0}%`, background: COLOR[tranche.instrumentType] || '#0B5D73' }} /></div>
                    <p>{millions(tranche.allocated)} placed across {placed} portfolios</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="da-sec">
            <div className="da-sechead">
              <h2>Allocation grid</h2>
              <div className="page-actions">
                <button type="button" className="btn" onClick={() => setExpanded(new Set(preview.rows.filter((row) => row.level === 'PORTFOLIO').map((row) => row.fundId)))}>Expand all</button>
                <button type="button" className="btn" onClick={() => setExpanded(new Set())}>Collapse all</button>
                <button type="button" className="btn" disabled={!adjustments.length} onClick={() => setAdjustments([])}>Clear adjustments</button>
                <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void commit(); }}>{saving ? 'Saving…' : 'Commit allocation'}</button>
              </div>
            </div>
            <div className="da-main">
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Portfolio</th>
                      <th rowSpan={2} className="num">Available capital</th>
                      {tranches.map((tranche) => (
                        <th key={tranche.id} className="num da-tcol" style={{ borderTopColor: COLOR[tranche.instrumentType] || '#0B5D73' }}>
                          <span>{tranche.label || tranche.name}</span>
                          <span className="da-colhold">
                            <input type="number" min={0} step={0.25} value={((tranche.size * (holds[tranche.id] ?? tranche.holdPct) / 100) / 1_000_000).toFixed(2)} aria-label={`Our hold of the ${tranche.name}`} onChange={(event) => {
                              const next = Number(event.target.value);
                              if (Number.isFinite(next)) setHolds((current) => ({ ...current, [tranche.id]: Math.min(100, next * 1_000_000 / tranche.size * 100) }));
                            }} />
                            of {plain(tranche.size)}
                          </span>
                          <input type="range" min={0} max={100} value={Math.round(holds[tranche.id] ?? tranche.holdPct)} onChange={(event) => setHolds((current) => ({ ...current, [tranche.id]: Number(event.target.value) }))} />
                        </th>
                      ))}
                      <th rowSpan={2} className="num">Total allocation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => {
                      if (row.level === 'SLEEVE' && row.parentFundId && !expanded.has(row.parentFundId)) return null;
                      const sleeves = preview.rows.filter((item) => item.parentFundId === row.fundId).length;
                      return (
                        <tr key={row.fundId} className={`${row.level === 'PORTFOLIO' ? 'par' : 'sub'} ${selected === row.fundId ? 'sel' : ''}`} onClick={() => { setSelected(row.fundId); setEdit(null); }}>
                          <td>
                            <div className="da-name">
                            {row.level === 'PORTFOLIO' && (
                              <button type="button" className="da-caret" aria-expanded={expanded.has(row.fundId)} onClick={(event) => {
                                event.stopPropagation();
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(row.fundId)) next.delete(row.fundId); else next.add(row.fundId);
                                  return next;
                                });
                              }}>{expanded.has(row.fundId) ? '▾' : '▸'}</button>
                            )}
                            <span>
                              <b><Link href={`${domainHref('FUND')}/${row.fundId}`} onClick={(event) => event.stopPropagation()}>{row.fundName}</Link></b>
                              <small>{row.level === 'PORTFOLIO' ? `${sleeves} sub-portfolios` : `NAV ${millions(row.nav)}`}</small>
                            </span>
                            </div>
                          </td>
                          <td className="num"><b>{plain(row.availableCapital)}</b><small>{row.availableCapital ? `${Math.round(row.total / row.availableCapital * 100)}% used` : ''}</small></td>
                          {row.cells.map((cell) => (
                            <td key={cell.trancheId} className={`num ${cell.eligible ? 'act' : 'na'} ${cell.overridden ? 'ovr' : ''}`} onClick={(event) => {
                              event.stopPropagation();
                              setSelected(row.fundId);
                              setEdit({
                                fundId: row.fundId,
                                trancheId: cell.trancheId,
                                amount: ((cell.amount || 0) / 1_000_000).toFixed(2),
                                reason: cell.reasonCode || '',
                                note: '',
                                type: cell.exclusionText?.toLowerCase().includes('exclud') ? 'exclude' : 'override',
                              });
                            }}>
                              {cell.eligible ? (
                                <>
                                  <b>{cell.capReason ? <em>capped</em> : ''}{plain(cell.amount)}</b>
                                  <small>{cell.overridden ? `Override ${cell.reasonCode || ''}` : `${preview.targetHold ? (cell.amount / (tranches.find((tranche) => tranche.id === cell.trancheId)?.targetAmount || 1) * 100).toFixed(1) : 0}% of hold`}</small>
                                </>
                              ) : (
                                <span className="da-natag" title={cell.exclusionText || undefined}>{ineligibleLabel(cell.exclusionKind)}</span>
                              )}
                            </td>
                          ))}
                          <td className="num"><b>{plain(row.total)}</b><small>{facility ? `${(row.total / facility * 100).toFixed(1)}% of facility` : ''}</small></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Allocated</td>
                      <td />
                      {tranches.map((tranche) => <td key={tranche.id} className="num">{plain(tranche.allocated)}</td>)}
                      <td className="num">{plain(preview.allocated)}</td>
                    </tr>
                    <tr>
                      <td>Target hold</td>
                      <td />
                      {tranches.map((tranche) => <td key={tranche.id} className="num">{plain(tranche.targetAmount)}</td>)}
                      <td className="num">{plain(preview.targetHold)}</td>
                    </tr>
                    <tr>
                      <td>Unallocated</td>
                      <td />
                      {tranches.map((tranche) => <td key={tranche.id} className="num">{plain(tranche.targetAmount - tranche.allocated)}</td>)}
                      <td className="num">{plain(preview.unallocated)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <aside className="da-panel">
                {selectedRow ? (
                  <FundPanel
                    row={selectedRow}
                    parentName={preview.rows.find((item) => item.fundId === selectedRow.parentFundId)?.fundName}
                    tranches={tranches}
                    rows={preview.rows}
                    allocated={preview.allocated}
                    facility={facility}
                    edit={edit}
                    onEdit={(trancheId, cell) => setEdit({
                      fundId: selectedRow.fundId,
                      trancheId,
                      amount: ((cell?.amount || 0) / 1_000_000).toFixed(2),
                      reason: cell?.reasonCode || '',
                      note: '',
                      type: trancheId === '*' ? 'exclude' : 'override',
                    })}
                    onChange={setEdit}
                    onCancel={() => setEdit(null)}
                    onApply={() => {
                      if (!edit) return;
                      const sleeve = selectedRow.level === 'SLEEVE';
                      if (!sleeve && !edit.reason) { setError('Choose a reason code.'); return; }
                      if (edit.reason === 'OTH' && edit.note.trim().length < 3) { setError('Add a note when the reason is Other.'); return; }
                      const amount = Number(edit.amount) * 1_000_000;
                      if (edit.type === 'override' && !Number.isFinite(amount)) { setError('Enter an amount.'); return; }
                      setError(null);
                      setAdjustments((current) => [
                        ...current.filter((item) => !(item.fundId === edit.fundId && item.trancheId === edit.trancheId)),
                        { fundId: edit.fundId, trancheId: edit.trancheId, type: edit.type, amount: edit.type === 'override' ? amount : null, reason: edit.reason || null, note: edit.note },
                      ]);
                      setEdit(null);
                    }}
                  />
                ) : <p className="da-note">Select a portfolio to see its allocation, liquidity, and limits.</p>}
              </aside>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ineligibleLabel(kind?: string | null): string {
  if (kind === 'mandate') return 'Mandate';
  if (kind === 'guideline') return 'Guideline';
  if (kind === 'manual') return 'Excluded';
  if (kind === 'sub') return 'No eligible sub';
  return 'Not eligible';
}

function proRata(row: Row, trancheId: string, rows: Row[], tranches: Tranche[]): number {
  if (row.level === 'PORTFOLIO') {
    const peers = rows.filter((item) => item.level === 'PORTFOLIO');
    const available = peers.reduce((total, item) => total + item.availableCapital, 0);
    const target = tranches.find((tranche) => tranche.id === trancheId)?.targetAmount || 0;
    return available ? target * row.availableCapital / available : 0;
  }
  const siblings = rows.filter((item) => item.parentFundId === row.parentFundId);
  const available = siblings.reduce((total, item) => total + item.availableCapital, 0);
  const parentAmount = rows.find((item) => item.fundId === row.parentFundId)?.cells.find((cell) => cell.trancheId === trancheId)?.amount || 0;
  return available ? parentAmount * row.availableCapital / available : 0;
}

function splitNote(cell: Cell, delta: number, sleeve: boolean): string {
  if (!cell.eligible) return cell.exclusionText || 'Not eligible';
  if (cell.overridden) return sleeve ? 'Manager split' : `Manual override${cell.reasonCode ? `, ${cell.reasonCode}` : ''}`;
  if (cell.capReason) return `Capped by ${cell.capReason}`;
  if (delta > 50_000) return sleeve ? 'Takes on share released by excluded or capped sub-portfolios' : 'Takes on share released by excluded or capped portfolios';
  if (delta < -50_000) return 'Share moved to other eligible entities';
  return 'In proportion to available capital';
}

function limitStatus(value: number, limit: number): { kind: string; label: string; ratio: number } {
  if (!(limit > 0)) return { kind: 'na', label: 'No limit', ratio: 0 };
  const ratio = value / limit;
  if (ratio > 1.0005) return { kind: 'breach', label: 'Over limit', ratio };
  if (ratio >= 0.995) return { kind: 'bind', label: 'At limit', ratio };
  if (ratio >= 0.85) return { kind: 'near', label: 'Near limit', ratio };
  return { kind: 'ok', label: 'Within limit', ratio };
}

function FundPanel({
  row,
  parentName,
  tranches,
  rows,
  allocated,
  facility,
  edit,
  onEdit,
  onChange,
  onCancel,
  onApply,
}: {
  row: Row;
  parentName?: string;
  tranches: Tranche[];
  rows: Row[];
  allocated: number;
  facility: number;
  edit: { fundId: string; trancheId: string; amount: string; reason: string; note: string; type: 'override' | 'exclude' } | null;
  onEdit: (trancheId: string, cell: Cell | undefined) => void;
  onChange: (next: { fundId: string; trancheId: string; amount: string; reason: string; note: string; type: 'override' | 'exclude' }) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const sleeve = row.level === 'SLEEVE';
  const share = allocated ? row.total / allocated : 0;
  const used = row.availableCapital ? row.total / row.availableCapital : 0;
  const issuerLimit = (row.issuerLimit || 0) * row.nav;
  const sponsorLimit = (row.sponsorLimit || 0) * row.nav;
  const unfundedLimit = (row.unfundedLimit || 0) * row.nav;
  const unfunded = tranches.filter((tranche) => tranche.unfunded).reduce((total, tranche) => total + (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0), 0);
  const issuer = limitStatus(row.total, issuerLimit);
  const liquidity = limitStatus(row.total, row.availableCapital);
  const sponsor = limitStatus(row.total, sponsorLimit);
  const unfundedRule = limitStatus(unfunded, unfundedLimit);

  return (
    <>
      <div className="da-ph">
        <div className="da-phrow">
          <div>
            <small>{sleeve ? `Sub-portfolio of ${parentName || 'portfolio'}` : 'Portfolio'}</small>
            <h3><Link href={`${domainHref('FUND')}/${row.fundId}`}>{row.fundName}</Link></h3>
          </div>
          {edit?.trancheId === '*' ? null : (
            <button type="button" className="btn" onClick={() => onEdit('*', undefined)}>Exclude entirely</button>
          )}
        </div>
        {edit?.trancheId === '*' && (
          <div className="da-editor">
            <h4>Exclude {row.fundName} entirely</h4>
            <p className="da-note">Every tranche amount moves to the {sleeve ? 'other sub-portfolios' : 'other eligible portfolios'} in proportion to available capital.</p>
            <label>Reason code ({sleeve ? 'optional, manager discretion' : 'required'})
              <select value={edit.reason} onChange={(event) => onChange({ ...edit, reason: event.target.value })}>
                <option value="">{sleeve ? 'No reason code (discretionary)' : 'Select a reason code'}</option>
                {REASONS.map(([code, label]) => <option key={code} value={code}>{code}: {label}</option>)}
              </select>
            </label>
            <label>Note ({edit.reason === 'OTH' ? 'required' : 'optional'})<textarea value={edit.note} onChange={(event) => onChange({ ...edit, note: event.target.value })} /></label>
            <div className="page-actions">
              <button type="button" className="btn btn-primary" onClick={onApply}>Apply adjustment</button>
              <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            </div>
          </div>
        )}
        <div className="da-big">{millions(row.total)}</div>
        <p className="da-note">{(share * 100).toFixed(1)}% of the allocated hold, {facility ? `${(row.total / facility * 100).toFixed(1)}% of the facility` : ''}</p>
      </div>
      <section>
        <h4>Tranche allocations</h4>
        <table className="da-mini">
          <thead><tr><th>Tranche</th><th className="num">Amount</th><th className="num">vs pro-rata</th></tr></thead>
          <tbody>
            {tranches.map((tranche) => {
              const cell = row.cells.find((item) => item.trancheId === tranche.id);
              const base = proRata(row, tranche.id, rows, tranches);
              const delta = cell?.eligible ? (cell.amount - base) : 0;
              const open = edit?.fundId === row.fundId && edit.trancheId === tranche.id;
              return (
                <Fragment key={tranche.id}>
                  <tr className={cell?.eligible ? 'link' : ''} onClick={() => cell?.eligible && onEdit(tranche.id, cell)}>
                    <td>
                      <div className="da-tranchename">
                        {cell?.eligible ? <span className="da-twist" aria-hidden="true">{open ? '▾' : '▸'}</span> : <span className="da-twist" />}
                        <span>
                          <b>{tranche.label || tranche.name}</b>
                          <small>{cell ? splitNote(cell, delta, sleeve) : ''}</small>
                        </span>
                      </div>
                    </td>
                    <td className="num">{plain(cell?.amount || 0)}</td>
                    <td className={`num ${delta > 50_000 ? 'up' : delta < -50_000 ? 'dn' : ''}`}>{cell?.eligible ? (Math.abs(delta) < 50_000 ? '0.00' : `${delta > 0 ? '+' : ''}${plain(delta)}`) : 'n/a'}</td>
                  </tr>
                  {open && edit && (
                    <tr key={`${tranche.id}-edit`}><td colSpan={3}>
                      <div className="da-editor">
                        <h4>{edit.type === 'exclude' ? `Exclude from ${tranche.name}` : `Override ${tranche.name}`}</h4>
                        <div className="da-seg2">
                          <button type="button" aria-pressed={edit.type === 'override'} onClick={() => onChange({ ...edit, type: 'override' })}>Override amount</button>
                          <button type="button" aria-pressed={edit.type === 'exclude'} onClick={() => onChange({ ...edit, type: 'exclude' })}>Exclude from tranche</button>
                        </div>
                        {edit.type === 'override' ? (
                          <>
                            <label>Amount ($M)<input value={edit.amount} onChange={(event) => onChange({ ...edit, amount: event.target.value })} /></label>
                            <p className="da-note">{sleeve
                              ? `System split ${plain(cell?.systemAmount || 0)}. The rest of the portfolio’s amount in this tranche is re-spread across its other sub-portfolios. The portfolio total does not change.`
                              : `System allocation ${plain(cell?.systemAmount || 0)}. The difference is re-spread across the other eligible portfolios.`}</p>
                          </>
                        ) : (
                          <p className="da-note">Its {plain(cell?.amount || 0)} in this tranche moves to the {sleeve ? 'other sub-portfolios' : 'other eligible portfolios'} in proportion to available capital.</p>
                        )}
                        <label>Reason code ({sleeve ? 'optional, manager discretion' : 'required'})
                          <select value={edit.reason} onChange={(event) => onChange({ ...edit, reason: event.target.value })}>
                            <option value="">{sleeve ? 'No reason code (discretionary)' : 'Select a reason code'}</option>
                            {REASONS.map(([code, label]) => <option key={code} value={code}>{code}: {label}</option>)}
                          </select>
                        </label>
                        <label>Note ({edit.reason === 'OTH' ? 'required' : 'optional'})<textarea value={edit.note} onChange={(event) => onChange({ ...edit, note: event.target.value })} placeholder="Context for the audit trail" /></label>
                        <div className="page-actions">
                          <button type="button" className="btn btn-primary" onClick={onApply}>Apply adjustment</button>
                          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                        </div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h4>Liquidity</h4>
        <table>
          <tbody>
            <tr><td>Cash on hand</td><td>{plain(row.cash || 0)}</td></tr>
            <tr><td>Undrawn commitments</td><td>{plain(row.undrawn || 0)}</td></tr>
            <tr><td>Credit line headroom</td><td>{plain(row.line || 0)}</td></tr>
            <tr><td>Reserved for pipeline</td><td>{plain(row.reserve || 0)}</td></tr>
            <tr><td><b>Available capital</b></td><td><b>{plain(row.availableCapital)}</b></td></tr>
            <tr><td>Used by this deal</td><td>{plain(row.total)} ({Math.round(used * 100)}%)</td></tr>
            <tr><td>Remaining after deal</td><td>{plain(Math.max(0, row.availableCapital - row.total))}</td></tr>
          </tbody>
        </table>
        <div className={`da-gauge ${liquidity.kind}`}><i style={{ width: `${Math.min(100, liquidity.ratio * 100)}%` }} /></div>
      </section>
      <section>
        <h4>Compliance rules</h4>
        <Rule name="Single-issuer concentration" status={issuer} detail={`${plain(row.total)} of ${plain(issuerLimit)} allowed (${((row.issuerLimit || 0) * 100).toFixed(1)}% of NAV ${millions(row.nav)}). Pro-forma ${row.nav ? ((row.total / row.nav) * 100).toFixed(2) : '0.00'}%.`} />
        {!sleeve && row.sponsorLimit != null && <Rule name="Sponsor concentration" status={sponsor} detail={`${plain(row.total)} against ${plain(sponsorLimit)} (${((row.sponsorLimit || 0) * 100).toFixed(0)}% of NAV).`} />}
        {!sleeve && tranches.some((tranche) => tranche.unfunded) && <Rule name="Unfunded commitments" status={unfundedRule} detail={`${plain(unfunded)} of unfunded tranches against ${plain(unfundedLimit)} (${((row.unfundedLimit || 0) * 100).toFixed(0)}% of NAV).`} />}
        <Rule name="Liquidity coverage" status={liquidity} detail={`${plain(row.total)} against ${plain(row.availableCapital)} of available capital.`} />
      </section>
    </>
  );
}

function Rule({ name, status, detail }: { name: string; status: { kind: string; label: string; ratio: number }; detail: string }) {
  return (
    <div className="da-rule">
      <div><b>{name}</b><span className={`da-st ${status.kind}`}>{status.label}</span></div>
      <p>{detail}</p>
      <div className={`da-gauge ${status.kind}`}><i style={{ width: `${Math.min(100, status.ratio * 100)}%` }} /></div>
    </div>
  );
}
