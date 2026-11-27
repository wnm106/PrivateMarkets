'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineSurface } from '@tapestrai/surface-sdk';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import { manifest } from './manifest';
import { CLO_CSS } from './styles';
import { loadBook, loadDrift, loadOpportunities, type Book, type Drift, type Opportunities } from './lib/data';
import { buildTabs, TAB_INFO, TABS, type TabKey } from './lib/publish';
import { recordPath } from './lib/binds';
import { fmtDay } from './lib/format';
import { headline } from './lib/view';
import { DerivationLayer, ErrorPanel, Loading, RecordLink } from './components/common';
import { Ribbon } from './components/Ribbon';
import { VehiclesTab } from './components/VehiclesTab';
import { IndentureTab } from './components/IndentureTab';
import { CollateralTab } from './components/CollateralTab';
import { KpiTab } from './components/KpiTab';
import { DriftTab } from './components/DriftTab';
import { LiabilitiesTab } from './components/LiabilitiesTab';
import { OpportunitiesTab } from './components/OpportunitiesTab';

/** URL state: read once from the query string, then kept locally and mirrored to the URL. */
function useUrlState(name: string): [string | null, (value: string | null) => void] {
  const host = useSurfaceHost();
  const [param, setParam] = host.useQueryParam(name);
  const [value, setValue] = useState<string | null>(param);
  const set = useCallback((next: string | null) => { setValue(next); setParam(next); }, [setParam]);
  return [value, set];
}

interface Slot<T> { key: string | null; data: T | null; loading: boolean; error: string | null }
const empty = <T,>(): Slot<T> => ({ key: null, data: null, loading: false, error: null });

function CloManager() {
  const host = useSurfaceHost();
  const [tabParam, setTabParam] = useUrlState('tab');
  const [cloParam, setCloParam] = useUrlState('clo');
  const tab: TabKey = (TABS as readonly string[]).includes(tabParam || '') ? (tabParam as TabKey) : 'vehicles';

  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState<Slot<Drift>>(empty);
  const [opps, setOpps] = useState<Slot<Opportunities>>(empty);
  const [oppsOpened, setOppsOpened] = useState(false);
  const run = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++run.current;
    setError(null);
    setLoading(true);
    const r = await loadBook(host);
    if (ticket !== run.current) return;
    setLoading(false);
    if (r.error || !r.book) { setError(r.error || 'Nothing came back.'); return; }
    setBook(r.book);
    setDrift(empty());
    setOpps(empty());
  }, [host]);

  useEffect(() => { void load(); }, [host.asOfDate, host.knowledgeDate]);

  const vehicle = useMemo(() => {
    if (!book?.vehicles.length) return null;
    return book.vehicles.find((x) => x.id === cloParam) ?? book.vehicles[0];
  }, [book, cloParam]);

  // Drift warms after the book, for the open CLO. Offered loans are scored only once their tab is opened.
  const fetchDrift = useCallback(async (fundId: string) => {
    setDrift({ key: fundId, data: null, loading: true, error: null });
    const r = await loadDrift(host, fundId);
    setDrift((s) => (s.key === fundId ? { key: fundId, data: r.drift, loading: false, error: r.error } : s));
  }, [host]);
  const fetchOpps = useCallback(async (fundId: string) => {
    setOpps({ key: fundId, data: null, loading: true, error: null });
    const r = await loadOpportunities(host, fundId);
    setOpps((s) => (s.key === fundId ? { key: fundId, data: r.opportunities, loading: false, error: r.error } : s));
  }, [host]);
  useEffect(() => { if (vehicle && drift.key !== vehicle.id) void fetchDrift(vehicle.id); }, [vehicle, drift.key, fetchDrift]);
  useEffect(() => { if (tab === 'opportunities') setOppsOpened(true); }, [tab]);
  useEffect(() => { if (vehicle && oppsOpened && opps.key !== vehicle.id) void fetchOpps(vehicle.id); }, [vehicle, oppsOpened, opps.key, fetchOpps]);

  const driftData = vehicle && drift.key === vehicle.id ? drift.data : null;
  const oppsData = vehicle && opps.key === vehicle.id ? opps.data : null;

  host.useCrumbs([{ label: 'CLO Manager', href: host.basePath }, ...(vehicle && tab !== 'vehicles' ? [{ label: vehicle.name }] : []), ...(tab !== 'vehicles' ? [{ label: TAB_INFO[tab].label }] : [])]);
  host.usePublishFocus(vehicle ? {
    entityId: vehicle.id, entityName: vehicle.name, entityCode: vehicle.code, domainCode: 'FUND',
    summary: `CLO${vehicle.manager ? ` managed by ${vehicle.manager}` : ''}${vehicle.phase ? `, in its ${vehicle.phase.toLowerCase()} period` : ''}`,
    snapshot: {
      collateralPar: Math.round(vehicle.collateral.par), notesPar: Math.round(vehicle.collateral.notesPar),
      warf: headline(vehicle, 'WARF')?.value ?? null, was: headline(vehicle, 'WAS')?.value ?? null, wal: headline(vehicle, 'WAL')?.value ?? null,
      diversity: vehicle.diversity.score, breaches: vehicle.summary.breaches,
    },
  } : null);
  const tabs = useMemo(() => buildTabs({ book, vehicle, drift: driftData, opportunities: oppsData, opportunitiesOpened: oppsOpened }), [book, vehicle, driftData, oppsData, oppsOpened]);
  host.usePublishTabs(tabs);

  const counts: Partial<Record<TabKey, string>> = book && vehicle ? {
    vehicles: String(book.vehicles.length),
    indenture: vehicle.summary.breaches ? `${vehicle.summary.breaches} breach${vehicle.summary.breaches === 1 ? '' : 'es'}` : undefined,
    collateral: String(vehicle.collateral.count),
    opportunities: oppsData ? String(oppsData.opportunities.length) : undefined,
  } : {};

  let body;
  if (loading && !book) body = <Loading text="Reading every CLO and scoring its tests…" />;
  else if (error && !book) body = <ErrorPanel message={`Could not load the CLO book: ${error}`} onRetry={() => void load()} />;
  else if (!book) body = <ErrorPanel message="Nothing came back." onRetry={() => void load()} />;
  else if (!vehicle) body = <VehiclesTab book={book} selected={null} onSelect={() => undefined} />;
  else {
    const select = (id: string) => setCloParam(id === book.vehicles[0]?.id ? null : id);
    body = (
      <>
        <Ribbon v={vehicle} asOf={book.asOfDate} />
        <div className="da-tabs x-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} role="tab" aria-selected={tab === t} title={TAB_INFO[t].purpose} onClick={() => setTabParam(t === 'vehicles' ? null : t)}>
              {TAB_INFO[t].label}
              {counts[t] && <span className="x-count">{counts[t]}</span>}
            </button>
          ))}
        </div>
        {error && <ErrorPanel message={`Could not refresh: ${error}`} onRetry={() => void load()} />}
        {book.errors.length > 0 && <p className="x-note">{book.errors.slice(0, 3).join('; ')}</p>}
        {tab === 'vehicles' && <VehiclesTab book={book} selected={vehicle.id} onSelect={select} />}
        {tab === 'indenture' && <IndentureTab key={vehicle.id} v={vehicle} asOf={book.asOfDate} />}
        {tab === 'collateral' && <CollateralTab key={vehicle.id} v={vehicle} />}
        {tab === 'kpis' && <KpiTab book={book} v={vehicle} />}
        {tab === 'drift' && <DriftTab v={vehicle} drift={driftData} loading={drift.loading} error={drift.error} onRetry={() => void fetchDrift(vehicle.id)} />}
        {tab === 'liabilities' && <LiabilitiesTab v={vehicle} asOf={book.asOfDate} />}
        {tab === 'opportunities' && <OpportunitiesTab v={vehicle} asOf={book.asOfDate} data={oppsData} loading={opps.loading} error={opps.error} onRetry={() => void fetchOpps(vehicle.id)} />}
      </>
    );
  }

  return (
    <div className="view-fade da clo">
      <style>{CLO_CSS}</style>
      <DerivationLayer>
        <header className="page-header x-head">
          <div className="page-title-block">
            <span className="page-title">CLO Manager</span>{' '}
            <span className="page-meta">
              {vehicle ? <>· <RecordLink path={recordPath.fund(vehicle.id)}>{vehicle.name}</RecordLink></> : null}
              {book ? ` · as of ${fmtDay(book.asOfDate)}` : ''}
            </span>
          </div>
          {book && book.vehicles.length > 0 && (
            <label className="x-pick">
              CLO
              <select value={vehicle?.id ?? ''} onChange={(e) => setCloParam(e.target.value === book.vehicles[0]?.id ? null : e.target.value)}>
                {book.vehicles.map((x) => <option key={x.id} value={x.id}>{x.name}{x.summary.breaches ? ` (${x.summary.breaches} in breach)` : ''}</option>)}
              </select>
            </label>
          )}
          {loading && book && <span className="x-note" role="status">Refreshing…</span>}
        </header>
        {body}
      </DerivationLayer>
    </div>
  );
}

export default defineSurface({ manifest, Component: CloManager });
