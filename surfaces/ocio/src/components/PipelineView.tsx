'use client';

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import type { Commitment, Deal, OcioData } from '../lib/types';
import { fmtDate, fmtPct, fmtUsd, parseDay } from '../lib/format';
import { commitmentsOf, type Trees } from '../lib/tree';
import { profileFor, runAllocation, targetHeadroom, type Allocation, type AllocInput } from '../lib/sharing';
import { capacityFor, proformaFor, type CapacityQuote, type ProformaLine } from '../lib/compliance';
import { dealBind, fundBind, planBind, shownTargetBind, trancheBind } from '../lib/binds';
import { Bound, Derived, Empty, ErrorPanel, type Derivation } from './common';
import { dealViews } from '../lib/pipeline';

const LIVE = new Set(['ALLOCATION', 'CLOSING']);
const M = 1e6;

const CREATE = `mutation OcioStagePlan($input: CreateEntityInput!) { createEntity(input: $input) { entity { id } errors { message } } }`;

function AllocationGrid({ deal, data, trees, asOf, editable, onStaged }: { deal: Deal; data: OcioData; trees: Trees; asOf: Date; editable: boolean; onStaged: () => void }) {
  const host = useSurfaceHost();
  const sleeves = data.funds.filter((f) => f.kind === 'sleeve' && f.eligible);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, Record<number, number>>>({});
  const [caps, setCaps] = useState<Record<string, CapacityQuote> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [checks, setChecks] = useState<Record<string, { approved: boolean; lines: ProformaLine[]; error: string | null }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const profiles = useMemo(() => new Map(sleeves.map((s) => [s.id, profileFor(s, deal, data.funds, data.commitments, trees, asOf, excluded.has(s.id))])), [sleeves, deal, data, trees, asOf, excluded]);
  const securityId = deal.securityId;

  useEffect(() => {
    let cancelled = false;
    setCaps(null);
    setChecks(null);
    setOverrides({});
    setExcluded(new Set());
    const targeted = sleeves.filter((s) => profileFor(s, deal, data.funds, data.commitments, trees, asOf, false).targeted);
    Promise.all(targeted.map(async (s) => [s.id, await capacityFor(host, s.id, securityId, deal.close)] as const)).then((rows) => {
      if (!cancelled) setCaps(Object.fromEntries(rows));
    });
    return () => { cancelled = true; };
    // A new deal or new dates reload capacity; the host is stable.
  }, [deal.id, host.asOfDate, host.knowledgeDate]);

  const allocation: Allocation = useMemo(() => {
    const inputs: AllocInput[] = sleeves.map((s) => {
      const mine: Commitment[] = commitmentsOf(s, data.funds, data.commitments);
      const q = caps?.[s.id];
      return { fund: s, profile: profiles.get(s.id)!, engineCap: q?.capacity ?? null, bindingRule: q?.bindingRule ?? null, headroom: targetHeadroom(s, deal, mine, trees) };
    });
    return runAllocation(deal, inputs, overrides);
  }, [sleeves, profiles, caps, deal, overrides, data, trees]);

  const rows = allocation.rows.filter((r) => showAll || r.profile.targeted);
  const hidden = allocation.rows.length - rows.length;
  const byClient = data.funds.filter((f) => f.kind === 'client').map((c) => ({ client: c, rows: rows.filter((r) => r.fund.parentId === c.id) })).filter((g) => g.rows.length);
  const unallocated = allocation.unallocated.reduce((s, v) => s + v, 0);
  const staged = deal.plans.length > 0;

  const check = async () => {
    setBusy('Checking each sleeve against its rules…');
    const out: Record<string, { approved: boolean; lines: ProformaLine[]; error: string | null }> = {};
    await Promise.all(allocation.rows.filter((r) => r.total > 0.5).map(async (r) => { out[r.fund.id] = await proformaFor(host, r.fund.id, securityId, Math.round(r.total), deal.close); }));
    setChecks(out);
    setBusy(null);
  };

  const stage = async () => {
    const list = allocation.rows.filter((r) => r.total > 0.5);
    if (!list.length) return;
    setBusy('Staging the funding plan…');
    const problems: string[] = [];
    for (const r of list) {
      const res = await host.mutate<{ createEntity: { entity: { id: string } | null; errors: Array<{ message: string }> } }>(CREATE, {
        input: {
          entityCode: `OCIO-PLAN-${deal.code}-${r.fund.code}-${Date.now().toString(36)}`,
          entityName: `${deal.name} · ${r.fund.name}`,
          domainCode: 'DEAL_FUNDING_PLAN',
          templateCode: 'DEAL_FUNDING_PLAN_STANDARD',
          description: 'Proposed OCIO allocation, staged for review.',
          attributes: { OCIO_ALLOCATION_AMOUNT: String(Math.round(r.total)), OCIO_SHARING_RATIO: String(Math.round(r.ratio * 10000) / 100), FUNDING_STATUS: 'DRAFT' },
          childRelationships: [
            { parentEntityId: deal.id, childEntityId: deal.id, relationshipType: 'Funding plan for deal', relationshipCode: 'FUNDING_DEAL', isPrimary: true, validFrom: host.asOfDate },
            { parentEntityId: r.fund.id, childEntityId: r.fund.id, relationshipType: 'Funding plan for fund', relationshipCode: 'FUNDING_FUND', isPrimary: true, validFrom: host.asOfDate },
          ],
        },
      });
      const err = res.error?.message || res.data?.createEntity.errors?.[0]?.message;
      if (err) problems.push(`${r.fund.name}: ${err}`);
    }
    setBusy(null);
    setMessage(problems.length ? `Some plans were not staged. ${problems.join('; ')}` : `Staged ${list.length} draft funding plan${list.length === 1 ? '' : 's'} for review. Nothing is booked until they are approved.`);
    onStaged();
  };

  /** A figure added up across the sleeves shown: right-click lists what it adds. */
  const added = (name: string, shown: string, formula: string, parts: Array<{ label: string; value: string }>, node?: ReactNode) => (
    <Derived name={name} how={() => ({ title: name, value: shown, formula, rows: parts.slice(0, 12), more: parts.length > 12 ? parts.length - 12 : undefined })}>{node ?? shown}</Derived>
  );
  const m2 = (v: number) => (v / M).toFixed(2);

  const setOverride = (fundId: string, ti: number, raw: string) => {
    const v = Number(raw.replace(/[$,\s]/g, ''));
    setOverrides((o) => {
      const next = { ...o, [fundId]: { ...(o[fundId] || {}) } };
      if (raw.trim() === '' || !Number.isFinite(v)) delete next[fundId][ti];
      else next[fundId][ti] = v * M;
      return next;
    });
  };

  return (
    <section className="da-sec">
      <div className="da-sechead">
        <div>
          <h2>Allocation grid · {deal.name}</h2>
          <p className="da-note">Each sleeve&apos;s sharing ratio is its remaining profile allocation spread over the years left in its investment period, as a share of all eligible sleeves. Capacity is the most the compliance engine lets the sleeve commit before a hard limit, or the headroom under a typed target maximum, whichever is lower. Amounts in $M.</p>
          <div className="x-chips">
            {[deal.tags.cat, deal.tags.ac, deal.tags.st, deal.tags.sub, deal.tags.rg, deal.tags.ty].filter(Boolean).map((c) => <span key={c!} className="da-chip">{data.taxonomy.labels[c!] || c}</span>)}
            {deal.sector && <span className="da-chip" title="Sector">{deal.sector}</span>}
            {deal.market && <span className="da-chip" title="Market">{deal.market}</span>}
            {deal.manager && <span className="da-chip" title="Manager">{deal.manager}</span>}
            <span>Close {deal.close ? fmtDate(parseDay(deal.close)!) : '—'}</span>
          </div>
        </div>
      </div>
      {message && <div className="xp-empty" role="status">{message}</div>}
      {caps && Object.values(caps).some((q) => q.error) && (
        <ErrorPanel message={`The compliance engine could not size every sleeve, so those caps use target maximums only. Check compliance before staging. ${[...new Set(Object.values(caps).map((q) => q.error).filter(Boolean))].join('; ')}`} />
      )}
      <div className="da-toolbar">
        <label><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show sleeves without a target ({hidden || allocation.rows.filter((r) => !r.profile.targeted).length})</label>
        <span style={{ marginLeft: 'auto' }}>
          {!caps && <span className="da-note">Asking the compliance engine for each sleeve&apos;s capacity… </span>}
          {busy && <span className="da-note">{busy} </span>}
          <button className="btn btn-sm" onClick={() => { setOverrides({}); setExcluded(new Set()); }}>Reset allocation</button>{' '}
          <button className="btn btn-sm" disabled={!caps || !!busy} onClick={check}>Check compliance</button>{' '}
          <button className="btn btn-sm btn-primary" disabled={!editable || !caps || !!busy || staged || allocation.allocated < 0.5} title={staged ? 'A funding plan is already staged for this deal' : 'Write draft funding plans for review. Nothing is booked.'} onClick={stage}>Stage funding plan</button>
        </span>
      </div>
      <div className="da-gridwrap x-gridwrap">
        <table className="da-grid">
          <thead>
            <tr>
              <th>Portfolio</th>
              <th className="num" title="Program × strategy % × region %, and what is already deployed in that profile">Profile allocation</th>
              <th className="num" title="Remaining profile allocation ÷ years left in the investment period">Annual pace</th>
              <th className="num" title="Annual pace ÷ the sum of all eligible sleeves">Sharing ratio</th>
              <th>Capacity</th>
              {deal.tranches.map((t) => <th key={t.id} className="num da-tcol">{t.name}<small> {(t.hold / M).toFixed(2)} of {t.size != null ? (t.size / M).toFixed(0) : '—'}</small></th>)}
              <th className="num">Total allocation</th>
              {checks && <th>Pre-trade check</th>}
            </tr>
          </thead>
          <tbody>
            {byClient.map(({ client, rows: rs }) => {
              const total = rs.reduce((s, r) => s + r.total, 0);
              return (
                <Fragment key={client.id}>
                  <tr className="par">
                    <td><b>{client.name}</b><small> {rs.length} sleeve{rs.length === 1 ? '' : 's'}</small></td>
                    <td className="num">{added(`${client.name} profile allocation`, m2(rs.reduce((s, r) => s + r.profile.allocUsd, 0)), 'Its sleeves’ profile allocations added up, in $M.', rs.map((r) => ({ label: r.fund.name, value: m2(r.profile.allocUsd) })))}</td>
                    <td className="num">{added(`${client.name} annual pace`, m2(rs.reduce((s, r) => s + r.profile.annual, 0)), 'Its sleeves’ annual pace added up, in $M.', rs.map((r) => ({ label: r.fund.name, value: m2(r.profile.annual) })))}</td>
                    <td className="num"><b>{added(`${client.name} sharing ratio`, fmtPct(rs.reduce((s, r) => s + r.ratio, 0) * 100), 'Its sleeves’ sharing ratios added up.', rs.map((r) => ({ label: r.fund.name, value: fmtPct(r.ratio * 100) || '0%' })))}</b></td>
                    <td />
                    {deal.tranches.map((t, ti) => <td key={t.id} className="num"><b>{added(`${client.name} ${t.name} allocation`, m2(rs.reduce((s, r) => s + (r.alloc[ti] || 0), 0)), 'What its sleeves take of this tranche, added up, in $M.', rs.map((r) => ({ label: r.fund.name, value: m2(r.alloc[ti] || 0) })))}</b></td>)}
                    <td className="num"><b>{added(`${client.name} total allocation`, m2(total), 'What its sleeves take across every tranche, added up, in $M.', rs.map((r) => ({ label: r.fund.name, value: m2(r.total) })))}</b><small> {allocation.hold ? fmtPct((total / allocation.hold) * 100) : ''} of hold</small></td>
                    {checks && <td />}
                  </tr>
                  {rs.map((r) => {
                    const p = r.profile;
                    const q = caps?.[r.fund.id];
                    const chk = checks?.[r.fund.id];
                    const newBreaches = chk?.lines.filter((l) => !l.approved) || [];
                    return (
                      <tr key={r.fund.id} className="sub">
                        <td>
                          <b>{r.fund.name}</b>
                          <small> {p.reason || (p.strategyKey ? p.strategyKey.split('/').map((c) => data.taxonomy.labels[c] || c).join(' › ') : '')}</small>{' '}
                          <button className="btn btn-sm" disabled={!editable} title="Leave this sleeve out of this deal" onClick={() => setExcluded((s) => { const n = new Set(s); if (n.has(r.fund.id)) n.delete(r.fund.id); else n.add(r.fund.id); return n; })}>{excluded.has(r.fund.id) ? 'Include' : 'Exclude'}</button>
                        </td>
                        <td className="num"><Derived name={`${r.fund.name} profile allocation`} how={() => ({ title: `${r.fund.name}: profile allocation`, value: fmtUsd(p.allocUsd) || '$0', formula: 'The sleeve’s program size, times its strategy target share for this deal’s profile, times its region share when one is set. What is already deployed in that profile comes off it to give what is left.', rows: [{ label: 'Program size', value: fmtUsd(p.programUsd) || '—', bind: fundBind.program(r.fund) }, { label: 'Strategy target share', value: fmtPct(p.strategyPct * 100) || '0%', bind: (p.strategyKey ? shownTargetBind(r.fund, 'strategy', p.strategyKey, 'pct') : null) ?? undefined }, ...(p.regionPct != null ? [{ label: `Region share (${p.regionSource === 'client' ? 'from the client' : 'sleeve'})`, value: fmtPct(p.regionPct * 100) }] : []), { label: 'Already deployed in this profile', value: fmtUsd(p.deployed) || '$0' }, { label: 'Left to deploy', value: fmtUsd(Math.max(0, p.remaining)) || '$0' }] })}>{(p.allocUsd / M).toFixed(2)}<small> {fmtPct(p.strategyPct * 100)}{p.regionPct != null ? ` × ${fmtPct(p.regionPct * 100)}` : ''} · {(p.deployed / M).toFixed(2)} deployed</small></Derived></td>
                        <td className="num"><Derived name={`${r.fund.name} annual pace`} how={() => ({ title: `${r.fund.name}: annual pace`, value: fmtUsd(p.annual) || '$0', formula: 'What is left of the profile allocation, divided by the years left in the sleeve’s investment period at your As Of date.', rows: [{ label: 'Left to deploy', value: fmtUsd(Math.max(0, p.remaining)) || '$0' }, { label: 'Years left', value: p.years.toFixed(2) }, { label: 'Investment period end', value: fmtDate(p.end), bind: fundBind.end(r.fund) }] })}>{(p.annual / M).toFixed(2)}<small> {(Math.max(0, p.remaining) / M).toFixed(2)} over {p.years.toFixed(2)} yrs</small></Derived></td>
                        <td className="num"><Derived name={`${r.fund.name} sharing ratio`} how={() => ({ title: `${r.fund.name}: sharing ratio`, value: fmtPct(r.ratio * 100) || '0%', formula: 'This sleeve’s annual pace as a share of the annual pace of every eligible sleeve with a target for this deal’s profile.', rows: allocation.rows.filter((x) => x.profile.annual > 0).map((x) => ({ label: x.fund.name, value: `${fmtUsd(x.profile.annual) || '$0'} · ${fmtPct(x.ratio * 100) || '0%'}` })) })}><span className="da-share"><i style={{ width: `${(r.ratio * 100).toFixed(1)}%` }} /></span><b>{fmtPct(r.ratio * 100)}</b></Derived></td>
                        <td>
                          {!p.targeted ? <span className="x-nil">·</span>
                            : !caps ? <span className="da-note">…</span>
                              : q?.error && r.capacity === Infinity ? <span className="da-st na" title={q.error}>Engine capacity unavailable</span>
                              : r.capacity === Infinity ? <span className="da-note">No rule caps it</span>
                                : <><Derived name={`${r.fund.name} capacity`} how={() => ({ title: `${r.fund.name}: capacity for this deal`, value: fmtUsd(r.capacity), formula: 'The lower of two figures: the most the compliance engine lets the sleeve commit before a hard limit, and the headroom under a typed target maximum. The engine sizes the first; the surface does not evaluate rules.', rows: [{ label: 'Compliance engine capacity', sub: q?.bindingRule || undefined, value: q?.capacity != null ? fmtUsd(q.capacity) : 'No rule caps it' }, { label: 'Headroom under a target maximum', sub: r.headroom?.basis, value: r.headroom ? fmtUsd(r.headroom.cap) || '$0' : 'No maximum typed' }] })}><b>{(r.capacity / M).toFixed(2)}</b></Derived><small> {r.binding || ''} <span className="cr-rule">{r.binding === r.headroom?.basis ? 'Target' : 'Limit'}</span></small>{q?.error && <small className="fs-warn" title={q.error}> Engine capacity unavailable</small>}</>}
                        </td>
                        {deal.tranches.map((t, ti) => (
                          <td key={t.id} className="num act">
                            <Derived name={`${r.fund.name} ${t.name} allocation`} how={() => ({ title: `${r.fund.name}: ${t.name}`, value: fmtUsd(r.alloc[ti] || 0) || '$0', formula: 'The tranche’s hold times this sleeve’s sharing ratio, capped at its capacity. A figure you type takes its place and is marked Adjusted. Nothing is saved until the funding plan is staged.', rows: [{ label: 'Tranche hold', value: fmtUsd(t.hold) || '$0', bind: trancheBind(t) }, { label: 'Sharing ratio', value: fmtPct(r.ratio * 100) || '0%' }, { label: 'By ratio', value: fmtUsd(r.proRata[ti] || 0) || '$0' }, { label: 'Allocated', value: fmtUsd(r.alloc[ti] || 0) || '$0' }] })}>
                            <input
                              defaultValue={r.alloc[ti] != null ? ((r.alloc[ti] || 0) / M).toFixed(2) : ''}
                              key={`${r.fund.id}-${ti}-${Math.round(r.alloc[ti] || 0)}`}
                              aria-label={`${r.fund.name} ${t.name} allocation in $M`}
                              disabled={!editable || !p.targeted}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                if (raw === '') setOverride(r.fund.id, ti, '');
                                else if (raw !== ((r.alloc[ti] || 0) / M).toFixed(2)) setOverride(r.fund.id, ti, raw);
                              }}
                            />
                            </Derived>
                            <small className={r.overridden[ti] ? 'fs-warn' : undefined}>{r.overridden[ti] ? 'Adjusted' : r.capped && (r.alloc[ti] || 0) < r.proRata[ti] - 1 ? 'Capped' : t.hold ? `${fmtPct(((r.alloc[ti] || 0) / t.hold) * 100)} of tranche` : ''}</small>
                          </td>
                        ))}
                        <td className="num"><Derived name={`${r.fund.name} total allocation`} how={() => ({ title: `${r.fund.name}: total allocation`, value: fmtUsd(r.total) || '$0', formula: 'Each tranche’s hold split by sharing ratio, capped at the sleeve’s capacity, with any amount you typed taking its place.', rows: deal.tranches.map((t, ti) => ({ label: t.name, sub: r.overridden[ti] ? 'Adjusted by hand' : undefined, value: fmtUsd(r.alloc[ti] || 0) || '$0' })) })}><b>{(r.total / M).toFixed(2)}</b></Derived>{r.overCap && <small className="fs-warn"> Over capacity</small>}</td>
                        {checks && (
                          <td>
                            {!chk ? <span className="x-nil">·</span>
                              : chk.error ? <span className="da-st na" title={chk.error}>Not scored</span>
                                : chk.approved ? <span className="da-st ok">Passes</span>
                                  : <span className="da-st breach" title={newBreaches.map((l) => `${l.ruleName}${l.groupByValue ? ` (${l.groupByValue})` : ''}: ${l.verdict}`).join('\n')}>{newBreaches.length} rule{newBreaches.length === 1 ? '' : 's'} worse</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td colSpan={5}>Allocated</td>{deal.tranches.map((t, ti) => <td key={t.id} className="num">{added(`${t.name} allocated`, m2(t.hold - allocation.unallocated[ti]), 'What every sleeve takes of this tranche, added up, in $M.', allocation.rows.filter((r) => (r.alloc[ti] || 0) > 0).map((r) => ({ label: r.fund.name, value: m2(r.alloc[ti] || 0) })))}</td>)}<td className="num">{added('Total allocated', m2(allocation.allocated), 'Every sleeve’s allocation across every tranche, added up, in $M.', allocation.rows.filter((r) => r.total > 0).map((r) => ({ label: r.fund.name, value: m2(r.total) })))}</td>{checks && <td />}</tr>
            <tr><td colSpan={5}>Target hold</td>{deal.tranches.map((t) => <td key={t.id} className="num"><Bound {...trancheBind(t)} value={fmtUsd(t.hold)}>{(t.hold / M).toFixed(2)}</Bound></td>)}<td className="num">{added('Total target hold', m2(allocation.hold), 'The hold on each tranche, added up, in $M.', deal.tranches.map((t) => ({ label: t.name, value: m2(t.hold) })))}</td>{checks && <td />}</tr>
            <tr><td colSpan={5}>Unallocated</td>{allocation.unallocated.map((u, ti) => <td key={ti} className="num">{added(`${deal.tranches[ti]?.name || 'Tranche'} unallocated`, m2(u), 'The tranche’s hold less what the sleeves take of it, in $M.', [{ label: 'Hold', value: m2(deal.tranches[ti]?.hold || 0) }, { label: 'Allocated', value: m2((deal.tranches[ti]?.hold || 0) - u) }])}</td>)}<td className="num">{added('Total unallocated', m2(unallocated), 'Target hold less everything allocated, in $M.', [{ label: 'Target hold', value: m2(allocation.hold) }, { label: 'Allocated', value: m2(allocation.allocated) }])}</td>{checks && <td />}</tr>
          </tfoot>
        </table>
      </div>
      {staged && (
        <>
          <div className="da-sechead"><h2>Staged funding plans</h2></div>
          <table className="da-grid fit">
            <thead><tr><th>Sleeve</th><th className="num">Allocation</th><th className="num">Sharing ratio</th><th>Status</th></tr></thead>
            <tbody>
              {deal.plans.map((p) => (
                <tr key={p.id}>
                  <td><a href={host.href(`/deals/${deal.id}`)}>{data.funds.find((f) => f.id === p.fundId)?.name || p.name}</a></td>
                  <td className="num"><Bound {...planBind.amount(p)} value={fmtUsd(p.amount)}>{fmtUsd(p.amount)}</Bound></td>
                  <td className="num"><Bound {...planBind.ratio(p)} value={fmtPct(p.ratio)}>{fmtPct(p.ratio)}</Bound></td>
                  <td><Bound {...planBind.status(p)} value={p.status || 'DRAFT'}><span className={`da-st ${p.status === 'APPROVED' ? 'ok' : 'near'}`}>{p.status || 'DRAFT'}</span></Bound></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export function PipelineView({ data, trees, asOf, editable, selected, onSelect, onReload }: {
  data: OcioData;
  trees: Trees;
  asOf: Date;
  editable: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onReload: () => void;
}) {
  const host = useSurfaceHost();
  const [cell, setCell] = useState<{ cat: string | null; stage: string | null }>({ cat: null, stage: null });
  const [query, setQuery] = useState('');
  const views = dealViews(data, asOf);
  if (!views.length) return <Empty>No pipeline deals are classified for OCIO yet.</Empty>;
  const cats = trees.roots.strategy.children;
  const stages = data.stages.length ? data.stages : [...new Set(views.map((v) => v.deal.stage || ''))].map((c) => ({ code: c, label: c }));
  const q = query.trim().toLowerCase();
  const shown = views.filter((v) => (!cell.cat || v.deal.tags.cat === cell.cat) && (!cell.stage || v.deal.stage === cell.stage)
    && (!q || [v.deal.name, v.deal.manager, v.deal.sector].some((s) => (s || '').toLowerCase().includes(q))));
  const totalHold = views.reduce((s, v) => s + v.hold, 0);
  const closedStage = 'CLOSED';
  const deal = data.deals.find((d) => d.id === selected) || null;
  /** The deals behind a cell of the matrix, and the hold they add up to. */
  const holdHow = (title: string, list: typeof views): Derivation => ({
    title,
    value: `${list.length} deal${list.length === 1 ? '' : 's'} · ${fmtUsd(list.reduce((a, v) => a + v.hold, 0)) || '$0'}`,
    formula: 'The pipeline deals in this category and stage, and the hold on their tranches added up.',
    rows: list.slice(0, 12).map((v) => ({ label: v.deal.name, sub: v.stageLabel, value: fmtUsd(v.hold) || '$0' })),
    more: list.length > 12 ? list.length - 12 : undefined,
  });
  return (
    <main>
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Pipeline</span>
          <h1>Deal pipeline</h1>
          <p>Where every deal sits in its life cycle, across categories. Pick a cell to filter the list, then open a deal to allocate it across mandate sleeves.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Open deals</span><strong><Derived name="Open deals" how={() => ({ title: 'Open deals', value: String(views.filter((v) => v.deal.stage !== closedStage).length), formula: 'Pipeline deals classified for these programs that have not reached the last stage, at your As Of date.', rows: views.filter((v) => v.deal.stage !== closedStage).slice(0, 12).map((v) => ({ label: v.deal.name, value: v.stageLabel, bind: dealBind.stage(v.deal) })) })}>{views.filter((v) => v.deal.stage !== closedStage).length}</Derived></strong></div>
          <div className="da-fact"><span>Deal size</span><strong><Derived name="Pipeline deal size" how={() => ({ title: 'Deal size', value: fmtUsd(views.reduce((s, v) => s + (v.deal.size || 0), 0)), formula: 'The deal value of every pipeline deal, added up.', rows: views.slice(0, 12).map((v) => ({ label: v.deal.name, value: fmtUsd(v.deal.size) || '—', bind: dealBind.size(v.deal) })), more: views.length > 12 ? views.length - 12 : undefined })}>{fmtUsd(views.reduce((s, v) => s + (v.deal.size || 0), 0))}</Derived></strong></div>
          <div className="da-fact"><span>Our target hold</span><strong><Derived name="Our target hold" how={() => ({ title: 'Our target hold', value: fmtUsd(totalHold), formula: 'The hold amount on every tranche of every pipeline deal, added up.', rows: views.slice(0, 12).map((v) => ({ label: v.deal.name, value: fmtUsd(v.hold) || '$0' })), more: views.length > 12 ? views.length - 12 : undefined })}>{fmtUsd(totalHold)}</Derived></strong></div>
          <div className="da-fact"><span>Staged for review</span><strong><Derived name="Staged for review" how={() => ({ title: 'Staged for review', value: fmtUsd(views.reduce((s, v) => s + v.staged, 0)) || '$0', formula: 'Draft funding plans across the pipeline, added up. Nothing is booked until a person approves them.', rows: views.filter((v) => v.staged).slice(0, 12).map((v) => ({ label: v.deal.name, value: fmtUsd(v.staged) })) })}>{fmtUsd(views.reduce((s, v) => s + v.staged, 0)) || '$0'}</Derived></strong></div>
        </div>
      </header>
      <section className="da-sec">
        <div className="pipe-board" style={{ marginTop: 12 }}>
          <table className="pipe-mx">
            <thead>
              <tr>
                <th>Category<span className="sx">Our hold by stage</span></th>
                {stages.map((s) => {
                  const vs = views.filter((v) => v.deal.stage === s.code);
                  return <th key={s.code}>{s.label}<span className="sx">{vs.length} deal{vs.length === 1 ? '' : 's'}, {fmtUsd(vs.reduce((a, v) => a + v.hold, 0)) || '$0'}</span></th>;
                })}
                <th>All stages</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => {
                const inCat = views.filter((v) => v.deal.tags.cat === c.code);
                if (!inCat.length) return null;
                return (
                  <tr key={c.code}>
                    <th>{c.name}<span className="sx">{inCat.length} deals, {fmtUsd(inCat.reduce((a, v) => a + (v.deal.size || 0), 0))} deal size</span></th>
                    {stages.map((s) => {
                      const vs = inCat.filter((v) => v.deal.stage === s.code);
                      const attn = vs.filter((v) => LIVE.has(v.deal.stage || '')).length;
                      return (
                        <td key={s.code}>
                          <button className={`cb${vs.length ? '' : ' zero'}`} aria-pressed={cell.cat === c.code && cell.stage === s.code} title={`Filter the list to ${c.name} · ${s.label}`} onClick={() => setCell(cell.cat === c.code && cell.stage === s.code ? { cat: null, stage: null } : { cat: c.code, stage: s.code })}>
                            {attn > 0 && <Derived name={`${c.name} ${s.label} deals to allocate`} how={() => holdHow(`${c.name} · ${s.label}: deals in a live stage`, vs.filter((v) => LIVE.has(v.deal.stage || '')))}><span className="at">{attn}</span></Derived>}
                            <Derived name={`${c.name} ${s.label} deals`} how={() => holdHow(`${c.name} · ${s.label}`, vs)}><span className="n">{vs.length}</span></Derived>
                            {vs.length ? <Derived name={`${c.name} ${s.label} hold`} how={() => holdHow(`${c.name} · ${s.label}`, vs)}><span className="d">{fmtUsd(vs.reduce((a, v) => a + v.hold, 0))}</span></Derived> : <span className="d">none</span>}
                          </button>
                        </td>
                      );
                    })}
                    <td className="tc">
                      <button className="cb" onClick={() => setCell({ cat: c.code, stage: null })}>
                        <Derived name={`${c.name} deals`} how={() => holdHow(`${c.name} · all stages`, inCat)}><span className="n">{inCat.length}</span></Derived>
                        <Derived name={`${c.name} hold`} how={() => holdHow(`${c.name} · all stages`, inCat)}><span className="d">{fmtUsd(inCat.reduce((a, v) => a + v.hold, 0))}</span></Derived>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pipe-tools">
          <div className="l"><input className="pipe-search" type="search" placeholder="Search deal, manager or sector" aria-label="Search deals" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        </div>
        <p className="pipe-count">Showing {shown.length} of {views.length} deals</p>
        <div className="da-gridwrap x-gridwrap">
          <table className="da-grid">
            <thead><tr><th>Deal</th><th>Stage</th><th className="num">Deal size</th><th className="num">Our hold</th><th>Staged</th><th>Flags</th><th className="num">Close</th></tr></thead>
            <tbody>
              {shown.map((v) => {
                const idx = stages.findIndex((s) => s.code === v.deal.stage);
                return (
                  <tr key={v.deal.id} className={`x-rowlink${selected === v.deal.id ? ' sel' : ''}`} onClick={() => onSelect(selected === v.deal.id ? null : v.deal.id)}>
                    <td>
                      <div className="da-name">
                        <span>
                          <b><a href={host.href(`/deals/${v.deal.id}`)} title="Open the record" onClick={(e) => e.stopPropagation()}>{v.deal.name}</a></b> <span className="x-mut">{v.deal.description}</span>
                          <small>{[v.deal.tags.cat, v.deal.tags.st, v.deal.tags.rg].filter(Boolean).map((c) => data.taxonomy.labels[c!] || c).join(' · ')}</small>
                        </span>
                      </div>
                    </td>
                    <td><Bound {...dealBind.stage(v.deal)} value={v.stageLabel}><span className="pipe-stg"><span className="pipe-trk" aria-hidden="true">{stages.map((s, j) => <i key={s.code} className={j <= idx ? 'on' : ''} />)}</span>{v.stageLabel}</span></Bound></td>
                    <td className="num"><Bound {...dealBind.size(v.deal)} value={fmtUsd(v.deal.size)}>{fmtUsd(v.deal.size)}</Bound></td>
                    <td className="num"><Derived name={`${v.deal.name} our hold`} how={() => ({ title: `${v.deal.name}: our hold`, value: fmtUsd(v.hold), formula: 'The hold amount on each of the deal’s tranches, added up: the part of the deal offered to our sleeves.', rows: v.deal.tranches.map((t) => ({ label: t.name, value: fmtUsd(t.hold) || '$0', bind: trancheBind(t) })) })}>{fmtUsd(v.hold)}</Derived></td>
                    <td className="x-nw">{v.staged ? <Derived name={`${v.deal.name} staged`} how={() => ({ title: `${v.deal.name}: staged for review`, value: fmtUsd(v.staged), formula: 'Draft funding plans written for this deal, added up, as a share of our hold. Nothing is booked until a person approves them.', rows: v.deal.plans.map((p) => ({ label: data.funds.find((f) => f.id === p.fundId)?.name || p.name, sub: p.status || 'DRAFT', value: fmtUsd(p.amount) || '$0', bind: planBind.amount(p) })) })}><span className="pipe-prog"><i style={{ width: `${Math.min(100, (v.staged / (v.hold || 1)) * 100)}%` }} />{fmtPct((v.staged / (v.hold || 1)) * 100)}</span></Derived> : <span className="x-nil">·</span>}</td>
                    <td>{LIVE.has(v.deal.stage || '') && v.closeDays != null && v.closeDays <= 21 && v.closeDays >= 0 ? <span className="da-st x-st-info">Closes in {v.closeDays} days</span> : null}{LIVE.has(v.deal.stage || '') && !v.staged ? <span className="da-st near">Not allocated</span> : null}</td>
                    <td className="num">{v.deal.close ? <Bound {...dealBind.close(v.deal)} value={v.deal.close}>{fmtDate(parseDay(v.deal.close)!)}</Bound> : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {deal ? <AllocationGrid key={deal.id} deal={deal} data={data} trees={trees} asOf={asOf} editable={editable} onStaged={onReload} /> : <p className="da-note">Select a deal to allocate it across mandate sleeves.</p>}
      {deal && deal.tranches.length === 0 && <ErrorPanel message="This deal has no tranche to allocate." />}
    </main>
  );
}

