'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineSurface } from '@tapestrai/surface-sdk';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import { manifest } from './manifest';
import { OCIO_CSS } from './styles';
import type { Fund, Lens, OcioData, TargetMatrix, TargetScope } from './lib/types';
import { LENSES } from './lib/types';
import { ATTR, createSleeve, loadOcio, saveTargets, targetChanges, writeAttribute, type NewSleeve } from './lib/data';
import { buildTrees, LENS_INFO, nodeLabel, walk, hasTarget } from './lib/tree';
import { loadRuleMeta, loadSnapshots, rulesFromSnapshot, type RuleResult } from './lib/compliance';
import { summarize, type FundSummary } from './lib/summary';
import { buildTabs, TAB_INFO, type TabKey } from './lib/publish';
import { parseDay, fmtUsd, fmtX, parseMeasure, MEASURES } from './lib/format';
import { Rail, Ribbon } from './components/Shell';
import { AssignedTargets, TargetGrid, type TargetEdit } from './components/TargetGrid';
import { PacingTab } from './components/PacingTab';
import { CommitmentsTab } from './components/CommitmentsTab';
import { ComplianceTab } from './components/ComplianceTab';
import { OverviewView } from './components/OverviewView';
import { PipelineView } from './components/PipelineView';
import { DerivationLayer, ErrorPanel, Loading } from './components/common';

type View = 'targets' | 'overview' | 'pipeline';
type Tab = Lens | 'pacing' | 'commitments' | 'compliance';
const TABS: Tab[] = ['strategy', 'region', 'structure', 'pacing', 'commitments', 'compliance'];

/** URL state: read once from the query string, then kept locally and mirrored to the URL. */
function useUrlState(name: string): [string | null, (value: string | null) => void] {
  const host = useSurfaceHost();
  const [param, setParam] = host.useQueryParam(name);
  const [value, setValue] = useState<string | null>(param);
  const set = useCallback((next: string | null) => { setValue(next); setParam(next); }, [setParam]);
  return [value, set];
}

interface Write { attr: string; value: string }
interface UndoEntry { fundId: string; prev: Partial<Fund>; writes: Write[]; reason: string }

/** The fund's own attributes a change writes. Its targets are saved value by value (saveTargets). */
function writesFor(next: Partial<Fund>): Write[] {
  const out: Write[] = [];
  if (next.programUsd != null) out.push({ attr: ATTR.programUsd, value: String(next.programUsd) });
  if (next.programN != null) out.push({ attr: ATTR.programN, value: String(next.programN) });
  if (next.basis) out.push({ attr: ATTR.basis, value: next.basis });
  if (next.annual != null) out.push({ attr: ATTR.annual, value: String(next.annual) });
  return out;
}

function targetsCsv(data: OcioData, trees: ReturnType<typeof buildTrees>): string {
  const head = ['Client or sleeve', 'Hierarchy', 'Level', ...MEASURES.flatMap((m) => [`${m.sym} min`, `${m.sym} target`, `${m.sym} max`])];
  const lines = [head];
  for (const f of data.funds) {
    lines.push([f.name, 'Program', 'Total program', '', String(f.programUsd ?? ''), '', '', String(f.programN ?? ''), '', '', '100', '']);
    for (const lens of LENSES) {
      walk(trees.roots[lens], (n) => {
        const t = f.matrix[lens][n.key];
        if (!n.depth || !hasTarget(t)) return;
        lines.push([f.name, LENS_INFO[lens].label, nodeLabel(n), ...MEASURES.flatMap((m) => ['Min', '', 'Max'].map((s) => String((t as Record<string, number | undefined>)[`${m.k}${s}`] ?? '')))]);
      });
    }
  }
  return lines.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}

function CopyDialog({ target, funds, onClose, onApply }: { target: Fund; funds: Fund[]; onClose: () => void; onApply: (matrix: TargetMatrix, reason: string) => void }) {
  const others = funds.filter((f) => f.id !== target.id);
  const [from, setFrom] = useState(others.find((f) => f.id === target.parentId)?.id || others[0]?.id || '');
  const [lenses, setLenses] = useState<Set<Lens>>(new Set(LENSES));
  const [mode, setMode] = useState<'keep' | 'replace' | 'clear'>('keep');
  const src = funds.find((f) => f.id === from);
  const apply = () => {
    if (!src) return;
    const next = structuredClone(target.matrix);
    for (const lens of lenses) {
      if (mode === 'clear') next[lens] = structuredClone(src.matrix[lens]);
      else for (const [k, band] of Object.entries(src.matrix[lens])) if (mode === 'replace' || !next[lens][k]) next[lens][k] = structuredClone(band);
    }
    onApply(next, `OCIO targets copied from ${src.name} (${[...lenses].join(', ')}, ${mode})`);
  };
  return (
    <div className="da-panel" role="dialog" aria-label="Copy targets" style={{ margin: '12px 0' }}>
      <div className="da-ph"><h2>Copy targets into {target.name}</h2></div>
      <div className="da-toolbar">
        <label>From <select value={from} onChange={(e) => setFrom(e.target.value)}>{others.map((f) => <option key={f.id} value={f.id}>{f.kind === 'sleeve' ? '  ' : ''}{f.name}</option>)}</select></label>
        {LENSES.map((l) => (
          <label key={l}><input type="checkbox" checked={lenses.has(l)} onChange={(e) => setLenses((s) => { const n = new Set(s); if (e.target.checked) n.add(l); else n.delete(l); return n; })} /> {LENS_INFO[l].label}</label>
        ))}
        <label>Existing targets <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="keep">Keep them, add the rest</option>
          <option value="replace">Replace where both have one</option>
          <option value="clear">Clear them first</option>
        </select></label>
        <button className="btn btn-sm btn-primary" disabled={!src || !lenses.size} onClick={apply}>Copy</button>
        <button className="btn btn-sm" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function AddSleeveDialog({ clients, initial, asOf, onClose, onCreate }: { clients: Fund[]; initial: string; asOf: string; onClose: () => void; onCreate: (client: Fund, sleeve: NewSleeve) => Promise<string | null> }) {
  const [clientId, setClientId] = useState(clients.some((c) => c.id === initial) ? initial : clients[0]?.id || '');
  const [name, setName] = useState('');
  const [program, setProgram] = useState('');
  const [count, setCount] = useState('');
  const [start, setStart] = useState(asOf);
  const [annual, setAnnual] = useState('');
  const [basis, setBasis] = useState<Fund['basis']>('PROGRAM');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const client = clients.find((c) => c.id === clientId);
  const usd = parseMeasure('usd', program);
  const n = parseMeasure('n', count);
  const yearly = parseMeasure('usd', annual);
  const ready = !!client && name.trim().length > 1 && usd.ok && usd.v != null && usd.v > 0 && n.ok && yearly.ok && /^\d{4}-\d{2}-\d{2}$/.test(start);
  const submit = async () => {
    if (!ready || !client || !usd.ok || !n.ok || !yearly.ok || usd.v == null) return;
    setBusy(true);
    setProblem(null);
    const failed = await onCreate(client, { name: name.trim(), programUsd: usd.v, programN: n.v, start, annual: yearly.v, basis });
    setBusy(false);
    if (failed) setProblem(failed);
  };
  return (
    <div className="x-dialog" role="dialog" aria-label="Add mandate sleeve">
      <h2>Add a mandate sleeve</h2>
      <p className="da-note">A sleeve is a fund record under a client, with its own program, pacing and targets. It starts with no targets; copy them from the client afterwards if you want a starting point.</p>
      <div className="x-form">
        <label>Client<select value={clientId} onChange={(e) => setClientId(e.target.value)}>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Name<input value={name} placeholder="e.g. Secondaries Sleeve" onChange={(e) => setName(e.target.value)} /></label>
        <label>Program $<input value={program} placeholder="e.g. 400M" aria-invalid={(program !== '' && !usd.ok) || undefined} onChange={(e) => setProgram(e.target.value)} /></label>
        <label>Investments<input value={count} placeholder="e.g. 24" aria-invalid={!n.ok || undefined} onChange={(e) => setCount(e.target.value)} /></label>
        <label>Start date<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Annual deployment target<input value={annual} placeholder="e.g. 70M" aria-invalid={!yearly.ok || undefined} onChange={(e) => setAnnual(e.target.value)} /></label>
        <label>% basis<select value={basis} onChange={(e) => setBasis(e.target.value as Fund['basis'])}><option value="PROGRAM">Program</option><option value="PARENT_LEVEL">Parent level</option></select></label>
      </div>
      {problem && <ErrorPanel message={problem} />}
      <div className="x-formacts">
        <span className="da-note">Dollars are millions unless you type K or B.</span>
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Adding…' : 'Add sleeve'}</button>
      </div>
    </div>
  );
}

function Ocio() {
  const host = useSurfaceHost();
  const [viewParam, setViewParam] = useUrlState('view');
  const [fundParam, setFundParam] = useUrlState('fund');
  const [tabParam, setTabParam] = useUrlState('tab');
  const [dealParam, setDealParam] = useUrlState('deal');
  const view: View = viewParam === 'overview' || viewParam === 'pipeline' ? viewParam : 'targets';
  const tab: Tab = (TABS as string[]).includes(tabParam || '') ? (tabParam as Tab) : 'strategy';

  const [data, setData] = useState<OcioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<Record<string, RuleResult[]> | null>(null);
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const [copying, setCopying] = useState(false);
  const [adding, setAdding] = useState(false);
  // The side list is a second view of the same targets: shown when there is room for it beside the grid.
  const [sideOpen, setSideOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1700);
  const [copied, setCopied] = useState<string | null>(null);
  const undo = useRef<UndoEntry[]>([]);
  /** Saves run in order; and the target records they made, by fund, until the next load brings them back. */
  const saves = useRef<Promise<void>>(Promise.resolve());
  const madeTargets = useRef<Record<string, Fund['targets']>>({});
  const latest = useRef<OcioData | null>(null);
  latest.current = data;
  const [undoCount, setUndoCount] = useState(0);
  const asOf = useMemo(() => parseDay(host.asOfDate) ?? new Date(), [host.asOfDate]);
  const editable = host.permissions.includes('entity.write');

  const loadCompliance = useCallback(async (d: OcioData) => {
    setRules(null);
    const sleeves = d.funds.filter((f) => f.kind === 'sleeve').map((f) => f.id);
    const [meta, snaps] = await Promise.all([loadRuleMeta(host), loadSnapshots(host, sleeves)]);
    // Only sleeves that were scored get a result; the rest are shown as not scored.
    setRules(Object.fromEntries(sleeves.filter((id) => !snaps.errors[id]).map((id) => [id, rulesFromSnapshot(snaps.lines[id] || [], meta)])));
    setRuleErrors(snaps.errors);
  }, [host]);

  const load = useCallback(async () => {
    setError(null);
    const r = await loadOcio(host);
    setLoading(false);
    if (r.error || !r.data) { setError(r.error || 'Nothing came back.'); return; }
    madeTargets.current = {};
    setData(r.data);
    void loadCompliance(r.data);
  }, [host, loadCompliance]);

  useEffect(() => { setLoading(true); void load(); }, [host.asOfDate, host.knowledgeDate]);

  const trees = useMemo(() => (data ? buildTrees(data.taxonomy) : null), [data]);
  const summaries: FundSummary[] = useMemo(() => (data && trees ? data.funds.map((f) => summarize(f, data, trees, asOf, rules)) : []), [data, trees, asOf, rules]);
  const selectedId = data?.funds.some((f) => f.id === fundParam) ? fundParam : data?.funds.find((f) => f.kind === 'sleeve')?.id ?? data?.funds[0]?.id ?? null;
  const open = summaries.find((s) => s.fund.id === selectedId) || null;
  const client = open?.fund.kind === 'sleeve' ? data?.funds.find((f) => f.id === open.fund.parentId) : null;

  host.useCrumbs([
    { label: 'Mandate Target Manager', href: host.basePath },
    ...(client ? [{ label: client.name, href: `${host.basePath}?fund=${client.id}` }] : []),
    ...(open && view === 'targets' ? [{ label: open.fund.name }] : []),
  ]);

  host.usePublishFocus(open && view === 'targets' ? {
    entityId: open.fund.id,
    entityName: open.fund.name,
    entityCode: open.fund.code,
    domainCode: 'FUND',
    summary: open.fund.kind === 'client' ? 'Client program' : `Mandate sleeve${client ? ` of ${client.name}` : ''}`,
    snapshot: {
      program: fmtUsd(open.fund.programUsd) || null,
      committed: fmtUsd(open.committed) || '$0',
      investmentsMade: open.pacing.count,
      targetInvestments: open.fund.programN,
      annualDeploymentTarget: fmtUsd(open.fund.annual) || null,
      pacingVelocity: fmtX(open.pacing.ytdVelocity),
      targetsAssigned: open.targetCount,
      openTab: TAB_INFO[tab as TabKey].label,
    },
  } : null);

  const tabs = useMemo(() => buildTabs({ open, summaries, data, trees, asOf, complianceLoaded: rules != null }), [open, summaries, data, trees, asOf, rules]);
  host.usePublishTabs(tabs);

  const patchFund = (id: string, next: Partial<Fund>) => setData((d) => (d ? { ...d, funds: d.funds.map((f) => (f.id === id ? { ...f, ...next } : f)) } : d));

  /** What a new target record is called: the hierarchy and the level's names from the top down. */
  const nameOf = useCallback((scope: TargetScope, level: string): string => {
    if (scope === 'program') return 'Total program';
    if (scope === 'year') return `Deployment year · ${level}`;
    const node = trees?.nodes[scope][level];
    return `${LENS_INFO[scope].label} · ${node ? nodeLabel(node) : level}`;
  }, [trees]);

  /**
   * Show the change at once, then store it. A target change is stored value by value: only
   * the minimums, targets and maximums that differ are written, each to its own attribute on
   * that level's target record. Saves run one after another, so two quick edits to a level
   * that has no record yet make one record, not two. If the store refuses a value, the
   * screen reloads to show what is actually stored.
   *
   * An edit saves as the person leaves the cell, with undo; it is not staged for a commit.
   * The brief left this open (surfaces/ocio/build.md, "Open questions") and it was decided
   * on 2026-11-23: keep saving on blur.
   */
  const change = useCallback((fund: Fund, next: Partial<Fund>, reason: string, record = true): Promise<void> => {
    const writes = writesFor(next);
    const changes = next.matrix || next.overrides
      ? targetChanges(fund, { matrix: next.matrix ?? fund.matrix, overrides: next.overrides ?? fund.overrides })
      : [];
    if (!writes.length && !changes.length) return Promise.resolve();
    const prev = Object.fromEntries(Object.keys(next).map((k) => [k, fund[k as keyof Fund]])) as Partial<Fund>;
    patchFund(fund.id, next);
    setSaveError(null);
    setSaving((n) => n + 1);
    const run = async () => {
      let failed: string | null = null;
      for (const w of writes) {
        failed = await writeAttribute(host, fund.id, w.attr, w.value, reason.slice(0, 900));
        if (failed) break;
      }
      if (!failed && changes.length) {
        // Records made by an earlier save in this queue may not have reached the screen's copy yet.
        const known = { ...(latest.current?.funds.find((f) => f.id === fund.id)?.targets || fund.targets), ...(madeTargets.current[fund.id] || {}) };
        const saved = await saveTargets(host, { ...fund, targets: known }, changes, reason, nameOf);
        if (Object.keys(saved.created).length) {
          madeTargets.current[fund.id] = { ...(madeTargets.current[fund.id] || {}), ...saved.created };
          setData((d) => (d ? { ...d, funds: d.funds.map((f) => (f.id === fund.id ? { ...f, targets: { ...f.targets, ...saved.created } } : f)) } : d));
        }
        failed = saved.error;
      }
      setSaving((n) => n - 1);
      if (failed) {
        setSaveError(`Not saved: ${failed}`);
        void load();
        return;
      }
      if (record) {
        undo.current.push({ fundId: fund.id, prev, writes, reason });
        if (undo.current.length > 60) undo.current.shift();
        setUndoCount(undo.current.length);
      }
      // Program size and the annual target are rule denominators: score again.
      if ((next.programUsd != null || next.annual != null) && latest.current) void loadCompliance(latest.current);
    };
    saves.current = saves.current.then(run, run);
    return saves.current;
  }, [host, load, loadCompliance, nameOf]);

  const undoLast = useCallback(() => {
    const e = undo.current.pop();
    setUndoCount(undo.current.length);
    const f = e && data?.funds.find((x) => x.id === e.fundId);
    if (!e || !f) return;
    void change(f, e.prev, `Undo: ${e.reason}`, false);
  }, [data, change]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !(ev.target instanceof HTMLInputElement)) { ev.preventDefault(); undoLast(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoLast]);

  const onTargetEdit = (edit: TargetEdit) => {
    if (!open) return;
    if (edit.program) void change(open.fund, edit.program.k === 'usd' ? { programUsd: edit.program.v } : { programN: edit.program.v }, edit.reason);
    else if (edit.matrix) void change(open.fund, { matrix: edit.matrix }, edit.reason);
  };

  const copyCsv = async () => {
    if (!data || !trees) return;
    try { await navigator.clipboard.writeText(targetsCsv(data, trees)); setCopied('Targets copied as CSV.'); } catch { setCopied('The browser did not allow copying.'); }
    setTimeout(() => setCopied(null), 3000);
  };

  const addSleeve = async (to: Fund, sleeve: NewSleeve): Promise<string | null> => {
    const made = await createSleeve(host, to, sleeve);
    if (!made.id) return made.error;
    setAdding(false);
    if (made.error) setSaveError(made.error);
    await load();
    setFundParam(made.id);
    return null;
  };

  const go = (v: View) => setViewParam(v === 'targets' ? null : v);
  const openFund = (id: string, lens?: Lens) => { setFundParam(id); setViewParam(null); if (lens) setTabParam(lens); };

  const header = (
    <header className="page-header">
      <div className="page-title-block">
        <div><span className="page-title">Mandate Target Manager</span> <span className="page-meta">· Fund-of-Funds &amp; Directs</span></div>
        <div className="cr-seg" role="group" aria-label="View">
          {(['targets', 'overview', 'pipeline'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => go(v)}>{v === 'targets' ? 'Assign targets' : v === 'overview' ? 'Overview' : 'Pipeline'}</button>
          ))}
        </div>
      </div>
      <div className="page-actions">
        {saving > 0 && <span className="da-note">Saving…</span>}
        {copied && <span className="da-note" role="status">{copied}</span>}
        <button className="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled={!undoCount || !editable} onClick={undoLast}>Undo</button>
        <button className="btn btn-sm" title="Copy all targets as CSV" disabled={!data} onClick={copyCsv}>Copy CSV</button>
        {open && <a className="btn btn-sm" href={host.href(`/funds/${open.fund.id}/overview`)}>Open the record</a>}
      </div>
    </header>
  );

  let body;
  if (loading && !data) body = <Loading text="Loading client programs, sleeves and commitments…" />;
  else if (error && !data) body = <ErrorPanel message={error} onRetry={() => { setLoading(true); void load(); }} />;
  else if (!data || !trees || !data.funds.length) {
    // The records are there for the client the screen is set up for, but a tenant admin can
    // open it while working in another client (a support session that has run out, say).
    // Say that, instead of implying no targets have ever been entered.
    const elsewhere = !!manifest.clients?.length && !manifest.clients.includes(host.clientCode || '');
    body = elsewhere ? (
      <div className="xp-empty" role="status">
        <b>You are not working in the client this screen belongs to.</b> It is set up for {manifest.clients!.join(', ')}
        {host.clientCode ? <>, and you are working in {host.clientCode}</> : <>, and no client is selected</>}. In the bar at the top of the page, choose that client and select <b>Simulate client</b>.
        A support session ends on its own after eight hours, which returns you here. The targets themselves are untouched.
      </div>
    ) : <div className="xp-empty">No client programs yet. A fund appears here once it has a target percent basis.</div>;
  }
  else if (view === 'overview') body = <OverviewView summaries={summaries} data={data} trees={trees} asOf={asOf} onOpen={openFund} />;
  else if (view === 'pipeline') body = <PipelineView data={data} trees={trees} asOf={asOf} editable={editable} selected={dealParam} onSelect={setDealParam} onReload={() => void load()} />;
  else if (open) {
    const f = open.fund;
    const counts = open.counts;
    const breaches = counts ? counts.breach + counts.soft : null;
    // Scoring finished, but this fund (or one of its sleeves) could not be scored.
    const scoreErrors = rules ? Object.entries(ruleErrors).filter(([id]) => id === f.id || data.funds.find((s) => s.id === id)?.parentId === f.id).map(([, m]) => m) : [];
    body = (
      <div className={`x-shell${sideOpen ? '' : ' x-noside'}`}>
        <Rail summaries={summaries} selected={f.id} asOf={asOf} editable={editable} onSelect={(id) => setFundParam(id)} onAdd={() => setAdding(true)} />
        <main className="x-mainc">
          <div className="crumbs">
            {client ? <><a className="crumb-link" href={`${host.basePath}?fund=${client.id}`} onClick={(e) => { e.preventDefault(); setFundParam(client.id); }}>{client.name}</a><span className="sep">›</span><span className="crumb-current">Mandate sleeve</span></> : <span className="crumb-current">Client program</span>}
          </div>
          <Ribbon s={open} asOf={asOf} editable={editable} onCompliance={() => setTabParam('compliance')} onBasis={(basis) => { if (basis !== f.basis) void change(f, { basis }, `OCIO: percent basis set to ${basis === 'PROGRAM' ? 'program' : 'parent level'}`); }} onCopy={() => setCopying(true)} scoreError={scoreErrors[0] || null} onEdit={(next, reason) => void change(f, next, reason)} />
          {adding && <AddSleeveDialog clients={data.funds.filter((x) => x.kind === 'client')} initial={client?.id || f.id} asOf={host.asOfDate} onClose={() => setAdding(false)} onCreate={addSleeve} />}
          {copying && <CopyDialog target={f} funds={data.funds} onClose={() => setCopying(false)} onApply={(matrix, reason) => { setCopying(false); void change(f, { matrix }, reason); }} />}
          {saveError && <ErrorPanel message={saveError} />}
          <div className="x-tabrow">
            <div className="da-tabs x-tabs" role="tablist">
              {TABS.map((t, i) => {
                const about = t === 'pacing' ? 'Annual deployment by year' : t === 'commitments' ? 'Original commitments and attributes' : t === 'compliance' ? 'Rules, limits and results' : LENS_INFO[t].path;
                return (
                  <span key={t} style={{ display: 'contents' }}>
                    {i === 3 && <span className="x-tabsep" aria-hidden="true" />}
                    <button className={tab === t ? 'on' : ''} role="tab" aria-selected={tab === t} title={about} onClick={() => setTabParam(t === 'strategy' ? null : t)}>
                      {TAB_INFO[t as TabKey].label}
                      {(t === 'strategy' || t === 'region' || t === 'structure') && <span className="cr-n">{open.targets[t]}</span>}
                      {t === 'commitments' && <span className="cr-n">{open.list.length}</span>}
                      {t === 'compliance' && (scoreErrors.length ? <span className="da-st na" title={scoreErrors[0]}>Not scored</span> : breaches == null ? <span className="cr-n">…</span> : breaches ? <span className="da-st breach">{breaches} breach{breaches === 1 ? '' : 'es'}</span> : <span className="da-st ok">Pass</span>)}
                    </button>
                  </span>
                );
              })}
            </div>
            {!sideOpen && <button className="btn btn-sm" onClick={() => setSideOpen(true)}>Assigned targets ({open.targetCount})</button>}
          </div>
          {(tab === 'strategy' || tab === 'region' || tab === 'structure') && (
            <TargetGrid key={`${f.id}-${tab}`} fund={f} lens={tab} data={data} trees={trees} list={open.list} editable={editable} onEdit={onTargetEdit} />
          )}
          {tab === 'pacing' && (
            <PacingTab fund={f} summary={open} pacing={open.pacing} data={data} asOf={asOf} editable={editable}
              onAnnual={(v) => void change(f, { annual: v }, `OCIO: annual deployment target set to ${fmtUsd(v)}`)}
              onOverride={(year, v) => { const overrides = { ...f.overrides }; if (v == null) delete overrides[String(year)]; else overrides[String(year)] = v; void change(f, { overrides }, `OCIO: ${year} deployment target ${v == null ? 'reset to the annual target' : `set to ${fmtUsd(v)}`}`); }} />
          )}
          {tab === 'commitments' && <CommitmentsTab fund={f} list={open.list} data={data} rules={open.rules} onJump={(lens) => setTabParam(lens === 'strategy' ? null : lens)} />}
          {tab === 'compliance' && <ComplianceTab fund={f} rules={open.rules} counts={open.counts} errors={scoreErrors} bandIssues={open.bandIssues} onRetry={() => void loadCompliance(data)} />}
        </main>
        {sideOpen && <AssignedTargets fund={f} trees={trees} list={open.list} onOpen={(lens) => setTabParam(lens === 'strategy' ? null : lens)} onHide={() => setSideOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="view-fade da ocio">
      <style>{OCIO_CSS}</style>
      <DerivationLayer>
        {header}
        {!editable && data && <p className="da-note">You can view these targets. Changing them needs permission to edit records.</p>}
        {body}
      </DerivationLayer>
    </div>
  );
}

export default defineSurface({ manifest, Component: Ocio });
