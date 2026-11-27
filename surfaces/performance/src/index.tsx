'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineSurface } from '@tapestrai/surface-sdk';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import { manifest } from './manifest';
import { PERF_CSS } from './styles';
import { loadBook, loadFundIds, type Book } from './lib/data';
import { contextFor, dealRows, familyRows, investorRows, positionRows } from './lib/view';
import { buildTabs, TAB_INFO, TABS, type TabKey } from './lib/publish';
import { fmtDay } from './lib/format';
import { DerivationLayer, ErrorPanel, Loading } from './components/common';
import { Ribbon } from './components/Ribbon';
import { FundsTab } from './components/FundsTab';
import { PositionsTab } from './components/PositionsTab';
import { DealsTab } from './components/DealsTab';
import { InvestorsTab } from './components/InvestorsTab';
import { AdhocTab, DEFAULT_SPEC, isDefaultSpec, specRequest, STANDARD_PERIODS, type AdhocSpec } from './components/AdhocTab';

/** URL state: read once from the query string, then kept locally and mirrored to the URL. */
function useUrlState(name: string): [string | null, (value: string | null) => void] {
  const host = useSurfaceHost();
  const [param, setParam] = host.useQueryParam(name);
  const [value, setValue] = useState<string | null>(param);
  const set = useCallback((next: string | null) => { setValue(next); setParam(next); }, [setParam]);
  return [value, set];
}

function Performance() {
  const host = useSurfaceHost();
  const [tabParam, setTabParam] = useUrlState('tab');
  const [periodParam, setPeriodParam] = useUrlState('period');
  const tab: TabKey = (TABS as string[]).includes(tabParam || '') ? (tabParam as TabKey) : 'funds';

  const [fundIds, setFundIds] = useState<string[] | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [spec, setSpec] = useState<AdhocSpec>(DEFAULT_SPEC);
  const [applied, setApplied] = useState<AdhocSpec>(DEFAULT_SPEC);
  const [adhocBook, setAdhocBook] = useState<Book | null>(null);
  const [adhocLoading, setAdhocLoading] = useState(false);
  const [adhocError, setAdhocError] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    const funds = await loadFundIds(host);
    if (funds.error) { setError(funds.error); setLoading(false); return; }
    setFundIds(funds.ids);
    const r = await loadBook(host, funds.ids);
    setLoading(false);
    if (r.error || !r.book) { setError(r.error || 'Nothing came back.'); return; }
    setBook(r.book);
  }, [host]);

  useEffect(() => { void load(); }, [host.asOfDate, host.knowledgeDate]);

  /** The ad hoc selection. With nothing chosen it is the firm-wide book already loaded. */
  const measure = useCallback(async (next: AdhocSpec) => {
    const ticket = ++run.current;
    setApplied(next);
    setAdhocError(null);
    if (isDefaultSpec(next) || !fundIds || !book) { setAdhocBook(null); return; }
    setAdhocLoading(true);
    const { filter, windows } = specRequest(next, book.asOfDate);
    const r = await loadBook(host, fundIds, windows, filter);
    if (ticket !== run.current) return;
    setAdhocLoading(false);
    if (r.error || !r.book) { setAdhocError(`Could not measure the selection: ${r.error || 'nothing came back'}.`); return; }
    setAdhocBook(r.book);
  }, [host, fundIds, book]);

  // A new As Of or Knowledge date measures the applied selection again.
  useEffect(() => { if (book && !isDefaultSpec(applied)) void measure(applied); }, [book]);

  const adhocResult = isDefaultSpec(applied) ? book : adhocBook;
  const window = book?.windows.find((w) => w.key === periodParam) ?? book?.windows[0] ?? null;
  const ctx = useMemo(() => (book && window ? contextFor(book, window) : null), [book, window]);

  host.useCrumbs([{ label: 'Performance', href: host.basePath }, ...(tab !== 'funds' ? [{ label: TAB_INFO[tab].label }] : [])]);
  host.usePublishFocus(null);
  const tabs = useMemo(() => buildTabs({ book, windowKey: window?.key ?? 'ITD', adhoc: { book: adhocResult, spec: applied, stale: JSON.stringify(spec) !== JSON.stringify(applied) } }), [book, window, adhocResult, applied, spec]);
  host.usePublishTabs(tabs);

  const counts: Partial<Record<TabKey, number>> = ctx ? {
    funds: familyRows(ctx).length,
    positions: positionRows(ctx).length,
    deals: dealRows(ctx).length,
    investors: investorRows(ctx).length,
  } : {};

  let body;
  if (loading && !book) body = <Loading text="Measuring every fund, position, deal and investor…" />;
  else if (error && !book) body = <ErrorPanel message={`Could not load performance: ${error}`} onRetry={() => void load()} />;
  else if (!book || !ctx) body = <ErrorPanel message="Nothing came back." onRetry={() => void load()} />;
  else {
    body = (
      <>
        <Ribbon ctx={ctx} />
        <div className="da-tabs x-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} role="tab" aria-selected={tab === t} title={TAB_INFO[t].purpose} onClick={() => setTabParam(t === 'funds' ? null : t)}>
              {TAB_INFO[t].label}
              {counts[t] != null && <span className="x-count">{counts[t]}</span>}
            </button>
          ))}
        </div>
        {error && <ErrorPanel message={`Could not refresh: ${error}`} onRetry={() => void load()} />}
        {tab === 'funds' && <FundsTab ctx={ctx} />}
        {tab === 'positions' && <PositionsTab ctx={ctx} />}
        {tab === 'deals' && <DealsTab ctx={ctx} />}
        {tab === 'investors' && <InvestorsTab ctx={ctx} />}
        {tab === 'adhoc' && (
          <AdhocTab base={book} result={adhocResult} loading={adhocLoading} error={adhocError} spec={spec} applied={applied}
            onChange={setSpec} onRun={() => void measure(spec)} onReset={() => { setSpec(DEFAULT_SPEC); void measure(DEFAULT_SPEC); }} />
        )}
      </>
    );
  }

  return (
    <div className="view-fade da performance">
      <style>{PERF_CSS}</style>
      <DerivationLayer>
        <header className="page-header x-head">
          <div className="page-title-block">
            <span className="page-title">Performance</span>{' '}
            <span className="page-meta">· Firm-wide{book ? ` · as of ${fmtDay(book.asOfDate)}` : ''}</span>
          </div>
          {tab !== 'adhoc' && (
            <div className="x-period-seg" role="group" aria-label="Period">
              {STANDARD_PERIODS.map((p) => (
                <button key={p.key} aria-pressed={(window?.key ?? 'ITD') === p.key} title={p.label} onClick={() => setPeriodParam(p.key === 'ITD' ? null : p.key)}>{p.label}</button>
              ))}
            </div>
          )}
          {loading && book && <span className="x-note" role="status">Refreshing…</span>}
        </header>
        {body}
      </DerivationLayer>
    </div>
  );
}

export default defineSurface({ manifest, Component: Performance });
