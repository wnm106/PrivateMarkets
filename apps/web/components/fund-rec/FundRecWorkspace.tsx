'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { fetchRecInsights, type RecInsight } from '@/lib/fund-rec-insights';
import { useTemporalStore } from '@/lib/store';
import { useSurfaceNav } from '@/lib/surface-nav';
import {
  FUND_REC_QUERY, HEALTH_LABEL, certify, healthTone, longDate, millions, percent, recordDecision, reopen,
  setSignoff, shortDate, signedMillions, stepTone,
  type FundRec, type RecBind,
} from '@/lib/fund-rec';
import { RecBit, RecCell, RecFact, RecInspectProvider, RecLabel, RecPress, joinSources } from './RecInspect';

type TabKey = 'close' | 'stmt' | 'roll' | 'integrity' | 'fees' | 'val' | 'drift' | 'inputs';

const TABS: Array<[TabKey, string]> = [
  ['close', 'Close status'],
  ['stmt', 'NAV statement'],
  ['roll', 'Position roll-forward'],
  ['integrity', 'Statement integrity'],
  ['fees', 'Fees'],
  ['val', 'Marks and accruals'],
  ['drift', 'Period drift'],
  ['inputs', 'Rec inputs'],
];

const SIGNOFF = [['NOT_STARTED', 'Not started'], ['IN_PROGRESS', 'In progress'], ['BLOCKED', 'Blocked'], ['DONE', 'Done']] as const;

/** Green when the movement is up, red when it is down. Blank when the cell prints as a dash. */
function moveTone(value: number | null | undefined, money = true): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '';
  if (money && Math.abs(value) / 1e6 < 0.005) return '';
  return value > 0 ? 'up' : 'dn';
}
const SIGNOFF_BY_LABEL: Record<string, string> = { 'Not started': 'NOT_STARTED', 'In progress': 'IN_PROGRESS', Blocked: 'BLOCKED', Done: 'DONE' };

export function FundRecWorkspace({ fundId, initialTab }: { fundId: string; initialTab?: string | null }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const [rec, setRec] = useState<FundRec | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(10);
  const [tab, setTab] = useState<TabKey>(TABS.some(([key]) => key === initialTab) ? (initialTab as TabKey) : 'close');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [insights, setInsights] = useState<RecInsight[] | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [insightTry, setInsightTry] = useState(0);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ fundRec: FundRec }, Record<string, unknown>>(
      FUND_REC_QUERY,
      { fundId, periodEnd: period, asOfDate, driftThresholdPct: threshold },
      'network-only',
    );
    if (result.error) { setError(result.error.message || 'Could not load the close'); return; }
    setRec(result.data?.fundRec ?? null);
    setError(null);
  }, [fundId, period, asOfDate, threshold]);

  useEffect(() => { void load(); }, [load]);

  const insightStamp = rec ? `${rec.fundId}|${rec.periodEnd}|${rec.drift.map((row) => `${row.id}:${row.flagged}`).join(',')}|${insightTry}` : '';
  useEffect(() => {
    if (!rec) return;
    const controller = new AbortController();
    setInsights(null);
    setInsightError(null);
    fetchRecInsights(rec, controller.signal)
      .then((points) => { if (!controller.signal.aborted) setInsights(points); })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setInsightError(caught instanceof Error ? caught.message : 'Could not read this period');
        setInsights([]);
      });
    return () => controller.abort();
    // The stamp already names the period and the drift the model should see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insightStamp]);

  useSurfaceNav(rec
    ? [{ label: 'Fund reconciliation', href: '/fund-rec' }, { label: rec.fundName }, { label: `${rec.periodLabel} close` }]
    : [{ label: 'Fund reconciliation', href: '/fund-rec' }]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save'); } finally { setBusy(false); }
  };

  if (!rec) return error ? <div className="xp-error">{error}</div> : <div className="xp-empty">Loading close…</div>;

  const ctx = { rec, asOfDate };
  const open = rec.items.filter((item) => item.decision == null);
  const decided = rec.items.length - open.length;
  const tabCount = (key: TabKey) => (key === 'val' || key === 'fees' || key === 'drift'
    ? rec.items.filter((item) => item.tab === key && item.decision == null).length
    : key === 'integrity' ? rec.breaks : key === 'roll' && rec.roll.present && !rec.roll.tied ? 1 : key === 'inputs' ? rec.readiness.filter((item) => item.required && !item.ok).length : 0);

  const proposed = millions(rec.navProposed);
  const reported = millions(rec.navReported);
  return (
    <RecInspectProvider onChanged={() => { void load(); }}>
    <div className="view-fade da fund-rec">
      <header className="da-ribbon">
        <div className="da-title">
          <RecBit className={`da-st ${healthTone(rec.health, rec.atRisk)}`} sources={rec.sources.health} display={HEALTH_LABEL[rec.health]}>{HEALTH_LABEL[rec.health]}</RecBit>
          <h1>{rec.fundName}</h1>
          <p>NAV review for <RecBit sources={rec.sources.period} display={longDate(rec.periodEnd)}>{longDate(rec.periodEnd)}</RecBit>. {rec.healthNote}.</p>
        </div>
        <div className="da-facts five">
          <RecFact className="da-fact big" sources={rec.sources.navReported} display={reported}><span>NAV as reported</span><strong>{reported}M</strong></RecFact>
          <RecFact className="da-fact" sources={rec.sources.navProposed} display={proposed}><span>Proposed NAV</span><strong>{proposed}M</strong><small>{rec.adjustments ? `${rec.adjustments} adjustment${rec.adjustments === 1 ? '' : 's'}` : 'No adjustments'}</small></RecFact>
          <RecFact className="da-fact" sources={rec.sources.navChange} display={percent(rec.navChangePct, 1, true)}><span>Change on prior</span><strong>{percent(rec.navChangePct, 1, true)}</strong><small>Prior {millions(rec.navPrior)}M</small></RecFact>
          <RecFact className="da-fact" sources={rec.sources.netIrr} display={rec.netIrr == null ? '—' : percent(rec.netIrr)}><span>Net IRR</span><strong>{rec.netIrr == null ? '—' : percent(rec.netIrr)}</strong></RecFact>
          <RecFact className="da-fact" sources={rec.sources.target} display={shortDate(rec.targetDate)}><span>Certify by</span><strong>{shortDate(rec.targetDate)}</strong><small>{rec.certified ? 'Certified' : rec.daysToTarget >= 0 ? `${rec.daysToTarget} days left` : `${-rec.daysToTarget} days late`}</small></RecFact>
        </div>
        <RecFact className="da-holdbox" sources={rec.sources.progress} display={`${rec.stepsDone} of ${rec.steps.length}`}>
          <div className="da-holdtop"><span>Close progress</span><b>{rec.stepsDone} of {rec.steps.length}</b></div>
          <div className="da-bar"><i style={{ width: `${(rec.stepsDone / rec.steps.length) * 100}%` }} /></div>
          <p>{rec.certified ? `NAV certified ${rec.certifiedAt ? longDate(rec.certifiedAt) : ''}.` : rec.certifyBlock || 'Every check ties and every item is decided.'}</p>
          {rec.certified
            ? <button type="button" className="btn" disabled={busy} onClick={() => run(() => reopen(ctx))}>Reopen</button>
            : <button type="button" className="btn btn-primary" disabled={busy || !rec.canCertify} onClick={() => run(() => certify(ctx))}>{rec.adjustments ? 'Certify with proposed adjustments' : 'Certify NAV'}</button>}
        </RecFact>
      </header>

      <div className="da-toolbar">
        <RecLabel sources={rec.sources.period} display={longDate(rec.periodEnd)}>Period
          <select value={period ?? rec.periods[0]} onChange={(event) => setPeriod(event.target.value === rec.periods[0] ? null : event.target.value)}>
            {rec.periods.map((end) => <option key={end} value={end}>{longDate(end)}</option>)}
          </select>
        </RecLabel>
        <Link href="/fund-rec" className="btn">All funds</Link>
        <Link href={`/funds/${rec.fundId}/overview`} className="btn">Fund record</Link>
      </div>
      {error && <div className="xp-error">{error}</div>}

      <div className="da-tabs" role="tablist">
        {TABS.map(([key, label]) => {
          const count = tabCount(key);
          return (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
              {label}{count ? <i className="da-count">{count}</i> : null}
            </button>
          );
        })}
      </div>

      <div className="da-main">
        <div>
          {tab === 'close' && <CloseTab rec={rec} onOpen={setTab} onSignoff={(label) => run(() => setSignoff(ctx, SIGNOFF_BY_LABEL[label]))} />}
          {tab === 'stmt' && <StatementTab rec={rec} />}
          {tab === 'roll' && <RollTab rec={rec} />}
          {tab === 'integrity' && <IntegrityTab rec={rec} />}
          {tab === 'fees' && <FeesTab rec={rec} />}
          {tab === 'val' && <MarksTab rec={rec} />}
          {tab === 'drift' && <DriftTab rec={rec} threshold={threshold} onThreshold={setThreshold} />}
          {tab === 'inputs' && <InputsTab rec={rec} />}
        </div>

        <aside className="da-panel" aria-label="Review queue">
          <section>
            <h2 className="da-qtitle">Review queue</h2>
            <p className="da-note">{decided} of {rec.items.length} items decided. Accept, propose an adjustment, or query the admin.</p>
            <div className="da-bar"><i style={{ width: `${rec.items.length ? (decided / rec.items.length) * 100 : 100}%` }} /></div>
            {rec.items.map((item) => {
              const note = notes[item.id] ?? item.note;
              const adminText = item.unit === 'POINTS' ? item.admin.toFixed(1) : millions(item.admin);
              const oursText = item.unit === 'POINTS' ? item.ours.toFixed(1) : millions(item.ours);
              const effectText = item.effect ? signedMillions(item.effect) : '—';
              const decisionSources = item.decisionSources.length ? item.decisionSources : item.adminSources;
              const noteSources = item.noteSources.length ? item.noteSources : item.adminSources;
              return (
                <div key={item.id} className="da-q">
                  <div className="da-qhead">
                    <RecBit sources={item.adminSources} display={item.title}><b>{item.title}</b></RecBit>
                    <span className="da-st na">Rule</span>
                  </div>
                  <div className="da-qg">
                    <span>Admin<RecBit sources={item.adminSources} display={adminText}><b>{adminText}</b></RecBit></span>
                    <span>{item.drift ? 'Prior' : 'Ours'}<RecBit sources={item.oursSources} display={oursText}><b>{oursText}</b></RecBit></span>
                    <span>NAV effect<RecBit sources={item.effectSources} display={effectText}><b>{effectText}</b></RecBit></span>
                  </div>
                  <p>{item.why}</p>
                  <div className="da-decide">
                    {([['ACCEPT', 'Accept'], ['ADJUST', 'Adjust'], ['QUERY', 'Query admin']] as const).map(([value, label]) => (
                      <RecPress
                        key={value}
                        disabled={busy || rec.certified}
                        className={`${item.decision === value ? 'on' : ''} ${value.toLowerCase()}`}
                        sources={decisionSources}
                        display={label}
                        onClick={() => run(() => recordDecision(ctx, item, item.decision === value ? '' : value, note))}
                      >{label}</RecPress>
                    ))}
                  </div>
                  <RecNote
                    sources={noteSources}
                    display={note}
                    value={note}
                    disabled={rec.certified}
                    onChange={(value) => setNotes((current) => ({ ...current, [item.id]: value }))}
                    onBlur={() => {
                      if (item.dispositionId && note !== item.note) void run(() => recordDecision(ctx, item, item.decision ?? '', note));
                    }}
                  />
                </div>
              );
            })}
            {!rec.items.length && <p className="da-note">{rec.steps[0].state === 'Done' ? 'Nothing to review for this period.' : 'The review queue fills when the administrator pack is loaded.'}</p>}
            <div className="da-ai">
              <h3>From the model</h3>
              <p className="da-note">Written from this period&apos;s reconciliation. These points do not decide the close.</p>
              {insights == null && !insightError && <p className="da-note">Reading this period…</p>}
              {insightError && (
                <div className="da-note">
                  <p>{insightError}</p>
                  <button type="button" className="btn btn-sm" onClick={() => setInsightTry((tryCount) => tryCount + 1)}>Try again</button>
                </div>
              )}
              {insights?.map((point) => (
                <div key={point.title} className="da-q">
                  <div className="da-qhead">
                    <b>{point.title}</b>
                    <span className={`da-st ${point.severity === 'break' ? 'breach' : point.severity === 'watch' ? 'near' : 'ok'}`}>
                      {point.severity === 'break' ? 'Break' : point.severity === 'watch' ? 'Watch' : 'Note'}
                    </span>
                  </div>
                  <p>{point.detail}</p>
                </div>
              ))}
              {insights?.length === 0 && !insightError && <p className="da-note">Nothing further beyond the rules.</p>}
            </div>
          </section>
        </aside>
      </div>
    </div>
    </RecInspectProvider>
  );
}

function RecNote({
  sources, display, value, disabled, onChange, onBlur,
}: {
  sources: RecBind[];
  display: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <RecBit className="da-qnote-wrap" sources={sources} display={display || 'Note for the file'}>
      <input
        className="da-qnote"
        placeholder="Note for the file"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </RecBit>
  );
}

function CloseTab({ rec, onOpen, onSignoff }: { rec: FundRec; onOpen: (tab: TabKey) => void; onSignoff: (label: string) => void }) {
  const next = rec.steps.find((step) => step.state !== 'Done');
  const tabOf: Record<string, TabKey> = { integrity: 'integrity', roll: 'roll', val: 'val', fees: 'fees', drift: 'drift' };
  return (
    <section className="da-sec">
      <div className="da-sechead">
        <h2>Status to close</h2>
        <p>{rec.stepsDone} of {rec.steps.length} steps complete. Certification target {shortDate(rec.targetDate)}. {next ? `Next up: ${next.name.toLowerCase()}.` : 'Ready to certify.'}</p>
      </div>
      <div className="da-gridwrap">
        <table className="da-grid">
          <thead><tr><th>Step</th><th>Owner</th><th>Due</th><th>Status</th><th>Detail</th><th /></tr></thead>
          <tbody>
            {rec.steps.map((step) => (
              <tr key={step.key}>
                <RecCell sources={step.sources} display={step.name}>{step.name}</RecCell>
                <td>{step.owner}</td>
                <RecCell sources={step.dueSources} display={shortDate(step.due)}>{shortDate(step.due)}</RecCell>
                <RecCell sources={step.sources} display={step.state}>
                  <span className={`da-st ${stepTone(step.state)}`}>{step.state}</span>
                  {step.overdue ? <span className="da-st breach da-gap">Overdue</span> : null}
                </RecCell>
                <RecCell sources={step.sources} display={step.detail}>{step.detail}</RecCell>
                <td>
                  {step.manual
                    ? (
                      <RecBit sources={step.sources} display={step.state}>
                        <select value={step.state} disabled={rec.certified} onChange={(event) => onSignoff(event.target.value)}>{SIGNOFF.map(([, label]) => <option key={label}>{label}</option>)}</select>
                      </RecBit>
                    )
                    : step.tab ? <button type="button" className="btn" onClick={() => onOpen(tabOf[step.tab!] ?? 'integrity')}>Open</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatementTab({ rec }: { rec: FundRec }) {
  if (!rec.statements.length) return <div className="xp-empty">No administrator statement for this period yet.</div>;
  return (
    <>
      {rec.statements.map((statement) => (
        <section className="da-sec" key={statement.kind}>
          <div className="da-sechead"><h2>{statement.title}</h2><p>{statement.kind === 'CHANGES' ? 'Fund administrator and internal sources for this period, $M.' : `Fund administrator against internal, and against the fund administrator source as of ${longDate(rec.priorPeriodEnd)}. $M.`}</p></div>
          <div className="da-gridwrap">
            <table className="da-grid da-roll">
              <thead><tr><th>$ millions</th><th className="num">Fund admin</th><th className="num">Internal</th><th className="num">Variance</th><th className="num">Prior</th><th className="num">Change</th><th className="num">%</th></tr></thead>
              <tbody>
                {statement.lines.map((line) => {
                  const cls = line.role === 'HEADER' ? 'band' : line.role === 'SUBTOTAL' ? 'sub' : line.role === 'TOTAL' ? 'total' : line.indent ? 'indent' : '';
                  const headerLike = line.role === 'HEADER' || line.role === 'NOTE';
                  const both = joinSources(line.currentSources, line.internalSources, line.priorSources);
                  const adminText = headerLike ? '' : millions(line.current);
                  const internalText = headerLike ? '' : millions(line.internal);
                  const varianceText = headerLike || line.variance == null ? '' : signedMillions(line.variance);
                  const priorText = headerLike ? '' : millions(line.prior);
                  const changeText = line.change == null ? '' : signedMillions(line.change);
                  const pctText = line.changePct == null ? '' : percent(line.changePct, 1, true);
                  return (
                    <tr key={line.id} className={`${cls} ${line.flagged || line.varianceFlagged ? 'flag' : ''}`}>
                      <RecCell sources={both.length ? both : line.currentSources} display={line.label}>{line.label}{line.flagged ? <span className="da-st near da-gap">Unexplained drift</span> : null}{line.varianceFlagged ? <span className="da-st near da-gap">Source variance</span> : null}</RecCell>
                      <RecCell className="num" sources={line.currentSources} display={adminText}>{adminText}</RecCell>
                      <RecCell className="num" sources={line.internalSources} display={internalText}>{internalText}</RecCell>
                      <RecCell className={`num ${moveTone(line.variance)}`} sources={joinSources(line.currentSources, line.internalSources)} display={varianceText}>{varianceText}</RecCell>
                      <RecCell className="num" sources={line.priorSources} display={priorText}>{priorText}</RecCell>
                      <RecCell className={`num ${moveTone(line.change)}`} sources={joinSources(line.currentSources, line.priorSources)} display={changeText}>{changeText}</RecCell>
                      <RecCell className={`num ${moveTone(line.changePct, false)}`} sources={joinSources(line.currentSources, line.priorSources)} display={pctText}>{pctText}</RecCell>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function RollTab({ rec }: { rec: FundRec }) {
  const { roll } = rec;
  if (!roll.present) return <div className="xp-empty">No position cash flows are loaded for this period. Each purchase, repayment, sale, interest, fee, and PIK flow rolls into its bucket.</div>;
  const groups: Array<{ label: string; span: number }> = [];
  for (const column of roll.columns) {
    const last = groups[groups.length - 1];
    if (last && last.label === column.group) last.span += 1; else groups.push({ label: column.group, span: 1 });
  }
  const bad = roll.statement.some((value, index) => value != null && roll.columns[index].key !== 'diff' && Math.abs(roll.total[index] - value) >= 5000);
  const diffIndex = roll.columns.findIndex((column) => column.key === 'diff');
  return (
    <>
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Position roll-forward</h2>
          <p>Opening value plus cash flows plus every P&amp;L driver equals ending value, $M. Value is fair value plus accrued interest.</p>
        </div>
        <p><RecBit className={`da-st ${bad || !roll.tied ? 'breach' : 'ok'}`} sources={joinSources(roll.totalSources[diffIndex], roll.statementSources[diffIndex])} display={bad || !roll.tied ? 'Does not tie' : 'Ties to statements'}>{bad || !roll.tied ? 'Does not tie' : 'Ties to statements'}</RecBit></p>
        <div className="da-gridwrap">
          <table className="da-grid da-roll">
            <thead>
              <tr><th />{groups.map((group) => <th key={group.label} colSpan={group.span} className="num">{group.label}</th>)}</tr>
              <tr><th>Position</th>{roll.columns.map((column) => <th key={column.key} className="num">{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {roll.rows.map((row) => (
                <tr key={row.id} className={row.header ? 'sub' : 'indent'}>
                  <RecCell sources={row.sources[12] || row.sources[0]} display={row.name}>{row.name}</RecCell>
                  {row.values.map((value, index) => {
                    const text = Math.abs(value) < 5000 ? '—' : millions(value);
                    return <RecCell key={index} className={`num ${value < 0 ? 'neg' : ''}`} sources={row.sources[index]} display={text}>{text}</RecCell>;
                  })}
                </tr>
              ))}
              <tr className="net">
                <td>Total fund</td>
                {roll.total.map((value, index) => {
                  const text = Math.abs(value) < 5000 ? '—' : millions(value);
                  return <RecCell key={index} className="num" sources={roll.totalSources[index]} display={text}>{text}</RecCell>;
                })}
              </tr>
              <tr className="sub">
                <td>Per statements</td>
                {roll.statement.map((value, index) => {
                  const text = value == null ? '' : millions(value);
                  return <RecCell key={index} className="num" sources={roll.statementSources[index]} display={text}>{text}</RecCell>;
                })}
              </tr>
              <tr className="total">
                <td>Difference</td>
                {roll.statement.map((value, index) => {
                  const text = index === diffIndex
                    ? (Math.abs(roll.total[index]) < 5000 ? 'Ties' : millions(roll.total[index]))
                    : value == null ? '' : Math.abs(roll.total[index] - value) < 5000 ? 'Ties' : millions(roll.total[index] - value);
                  const tone = text === 'Ties' ? 'ok' : text ? 'breach' : '';
                  return (
                    <RecCell key={index} className="num" sources={joinSources(roll.totalSources[index], roll.statementSources[index])} display={text}>
                      {text === '' ? '' : <span className={`da-st ${tone}`}>{text}</span>}
                    </RecCell>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="da-sec">
        <div className="da-sechead"><h2>Ties to the statements</h2><p>Roll-forward totals against the reported figures.</p></div>
        <div className="da-gridwrap">
          <table className="da-grid">
            <thead><tr><th>Line</th><th className="num">Roll-forward</th><th className="num">Statement</th><th className="num">Result</th></tr></thead>
            <tbody>
              {roll.ties.map((tie) => {
                const both = joinSources(tie.rollSources, tie.statementSources);
                const result = tie.result === 'Missing' ? 'No statement line' : tie.result;
                return (
                  <tr key={tie.line}>
                    <RecCell sources={both} display={tie.line}>{tie.line}</RecCell>
                    <RecCell className="num" sources={tie.rollSources} display={millions(tie.rollforward)}>{millions(tie.rollforward)}</RecCell>
                    <RecCell className="num" sources={tie.statementSources} display={millions(tie.statement)}>{millions(tie.statement)}</RecCell>
                    <RecCell className="num" sources={both} display={result}><span className={`da-st ${tie.result === 'Ties' ? 'ok' : tie.result === 'Break' ? 'breach' : 'na'}`}>{result}</span></RecCell>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function IntegrityTab({ rec }: { rec: FundRec }) {
  return (
    <section className="da-sec">
      <div className="da-sechead"><h2>Statement integrity</h2><p>Every statement must agree with the others and with outside evidence before any judgement is needed.</p></div>
      <div className="da-gridwrap">
        <table className="da-grid">
          <thead><tr><th>Check</th><th>Compared</th><th className="num">A</th><th className="num">B</th><th className="num">Difference</th><th className="num">Result</th></tr></thead>
          <tbody>
            {rec.checks.map((check) => {
              const both = joinSources(check.aSources, check.bSources);
              const result = check.result === 'Missing' ? 'Evidence missing' : check.result === 'Break' ? 'Break' : 'Ties';
              const diff = check.result === 'Ties' ? '—' : millions(check.difference);
              return (
                <tr key={check.id} className={check.result === 'Break' ? 'flag' : ''}>
                  <RecCell sources={both} display={check.label}>{check.label}</RecCell>
                  <RecCell sources={both} display={check.compared}>{check.compared}</RecCell>
                  <RecCell className="num" sources={check.aSources} display={millions(check.a)}>{millions(check.a)}</RecCell>
                  <RecCell className="num" sources={check.bSources} display={millions(check.b)}>{millions(check.b)}</RecCell>
                  <RecCell className={`num ${check.result === 'Ties' ? '' : moveTone(check.difference)}`} sources={both} display={diff}>{diff}</RecCell>
                  <RecCell className="num" sources={both} display={result}><span className={`da-st ${check.result === 'Ties' ? 'ok' : check.result === 'Break' ? 'breach' : 'na'}`}>{result}</span></RecCell>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FeesTab({ rec }: { rec: FundRec }) {
  const fee = rec.mgmtFee;
  const perf = rec.perfFee;
  const row = (label: string, value: string, sources: RecBind[], tone = '') => (
    <tr key={label}>
      <RecCell sources={sources} display={label}>{label}</RecCell>
      <RecCell className={`num ${tone}`} sources={sources} display={value}>{value}</RecCell>
    </tr>
  );
  return (
    <>
      <section className="da-sec">
        <div className="da-sechead"><h2>Management fee</h2><p>Recomputed from fund terms: {fee.rate == null ? 'no rate on file' : <><RecBit sources={fee.sources.rate} display={`${fee.rate}%`}>{fee.rate}%</RecBit> of <RecBit sources={fee.sources.base} display={millions(fee.base, 0)}>{millions(fee.base, 0)}M</RecBit> commitments, {(fee.share * 100).toFixed(1)}% of a year</>}. Edit terms on the <Link href={`/funds/${rec.fundId}/overview`}>fund record</Link>.</p></div>
        <div className="da-gridwrap"><table className="da-grid"><thead><tr><th>Item</th><th className="num">$M</th></tr></thead><tbody>
          {row('Recalculated fee', millions(fee.recalculated, 3), fee.sources.recalculated)}
          {row('Administrator accrual', millions(fee.admin, 3), fee.sources.admin)}
          {row('Difference', fee.difference == null ? '—' : `${signedMillions(fee.difference, 3)} (${percent(fee.differencePct, 1, true)})`, fee.sources.difference, moveTone(fee.difference, false))}
          {row('Fee base implied by admin', fee.impliedBase == null ? '—' : `$${millions(fee.impliedBase, 1)}M`, fee.sources.impliedBase)}
        </tbody></table></div>
      </section>
      <section className="da-sec">
        <div className="da-sechead"><h2>Performance fee</h2><p>{perf.ready ? 'Reasonableness estimate from NAV, distributions and capital calls. The admin waterfall governs.' : 'Preferred return and carry are not set on the fund, so no estimate is possible.'}</p></div>
        <div className="da-gridwrap"><table className="da-grid"><thead><tr><th>Item</th><th className="num">$M</th></tr></thead><tbody>
          {row('Net asset value plus distributions to date', millions(perf.nav + perf.distributions), joinSources(perf.sources.nav, perf.sources.distributions))}
          {row('Less contributions', millions(-perf.contributions), perf.sources.contributions)}
          {row('Profit to date', millions(perf.profit), perf.sources.profit)}
          {row(`Preferred return hurdle (${perf.prefPct}% on each call)`, millions(perf.hurdle), perf.sources.hurdle)}
          {row('Profit above hurdle', millions(perf.excess), perf.sources.excess)}
          {row(`Estimated carry accrual (${perf.carryPct}% carry, ${perf.catchUpPct}% catch-up)`, millions(perf.carry), joinSources(perf.sources.carry, perf.sources.carryRate, perf.sources.catchUp))}
          {row('Administrator accrual', millions(perf.admin), perf.sources.admin, perf.ready && Math.abs(perf.carry - perf.admin) > 50000 ? 'neg' : '')}
        </tbody></table></div>
      </section>
    </>
  );
}

function MarksTab({ rec }: { rec: FundRec }) {
  return (
    <>
      <section className="da-sec">
        <div className="da-sechead"><h2>Position marks</h2><p>Administrator mark against valuation agent price. Differences over one point need a decision.</p></div>
        <div className="da-gridwrap"><table className="da-grid">
          <thead><tr><th>Position</th><th className="num">Admin</th><th className="num">Agent</th><th className="num">Difference</th><th className="num">NAV effect at agent price</th><th className="num">Result</th></tr></thead>
          <tbody>
            {rec.marks.map((mark) => {
              const both = joinSources(mark.adminSources, mark.agentSources);
              const admin = mark.admin.toFixed(1);
              const agent = mark.agent.toFixed(1);
              const diff = mark.difference ? `${mark.difference < 0 ? '−' : '+'}${Math.abs(mark.difference).toFixed(1)}` : '0.0';
              const effect = mark.effect ? signedMillions(mark.effect) : '0.00';
              const result = mark.flagged ? 'Review' : 'Within';
              return (
                <tr key={mark.id} className={mark.flagged ? 'flag' : ''}>
                  <RecCell sources={both} display={mark.name}>{mark.name}</RecCell>
                  <RecCell className="num" sources={mark.adminSources} display={admin}>{admin}</RecCell>
                  <RecCell className="num" sources={mark.agentSources} display={agent}>{agent}</RecCell>
                  <RecCell className={`num ${moveTone(mark.difference, false)}`} sources={both} display={diff}>{diff}</RecCell>
                  <RecCell className={`num ${moveTone(mark.effect)}`} sources={mark.effectSources} display={effect}>{effect}</RecCell>
                  <RecCell className="num" sources={both} display={result}><span className={`da-st ${mark.flagged ? 'near' : 'ok'}`}>{result}</span></RecCell>
                </tr>
              );
            })}
            {!rec.marks.length && <tr><td colSpan={6}>No positions carry both an administrator mark and an agent price.</td></tr>}
          </tbody>
        </table></div>
      </section>
      <section className="da-sec">
        <div className="da-sechead"><h2>Accrual spot check</h2><p>Administrator interest receivable against our loan-level accrual.</p></div>
        <div className="da-gridwrap"><table className="da-grid">
          <thead><tr><th>Position</th><th className="num">Admin</th><th className="num">Our accrual</th><th className="num">Difference</th><th className="num">Result</th></tr></thead>
          <tbody>
            {rec.accruals.map((accrual) => {
              const off = Math.abs(accrual.difference) >= 5000;
              const both = joinSources(accrual.adminSources, accrual.oursSources);
              const diff = off ? millions(accrual.difference) : '—';
              const result = off ? 'Review' : 'Within';
              return (
                <tr key={accrual.id} className={off ? 'flag' : ''}>
                  <RecCell sources={both} display={accrual.name}>{accrual.name}</RecCell>
                  <RecCell className="num" sources={accrual.adminSources} display={millions(accrual.admin)}>{millions(accrual.admin)}</RecCell>
                  <RecCell className="num" sources={accrual.oursSources} display={millions(accrual.ours)}>{millions(accrual.ours)}</RecCell>
                  <RecCell className={`num ${off ? moveTone(accrual.difference) : ''}`} sources={both} display={diff}>{diff}</RecCell>
                  <RecCell className="num" sources={both} display={result}><span className={`da-st ${off ? 'near' : 'ok'}`}>{result}</span></RecCell>
                </tr>
              );
            })}
            {!rec.accruals.length && <tr><td colSpan={5}>No loan-level accrual is loaded.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}

function DriftTab({ rec, threshold, onThreshold }: { rec: FundRec; threshold: number; onThreshold: (value: number) => void }) {
  return (
    <section className="da-sec">
      <div className="da-sechead">
        <h2>Prior period to current period</h2>
        <p>
          Each movement should be explained by a flow in the pack. Unexplained moves above{' '}
          <select value={threshold} onChange={(event) => onThreshold(Number(event.target.value))}>{[5, 10, 15, 25].map((value) => <option key={value} value={value}>{value}%</option>)}</select>{' '}
          go to the review queue.
        </p>
      </div>
      <div className="da-gridwrap"><table className="da-grid">
        <thead><tr><th>Line</th><th className="num">Prior</th><th className="num">Current</th><th className="num">Change</th><th className="num">%</th><th>Explained by</th></tr></thead>
        <tbody>
          {rec.drift.map((row) => {
            const digits = 2;
            const fmt = (value: number) => (row.ratio ? value.toFixed(digits) : millions(value));
            const both = joinSources(row.currentSources, row.priorSources);
            const change = row.ratio ? `${row.change < 0 ? '−' : '+'}${Math.abs(row.change).toFixed(digits)}` : signedMillions(row.change);
            const pct = row.changePct == null ? '—' : percent(row.changePct, 1, true);
            const explained = row.explained || (row.flagged ? 'Unexplained' : 'Within threshold');
            return (
              <tr key={row.id} className={row.flagged ? 'flag' : ''}>
                <RecCell sources={both} display={row.label}>{row.label}</RecCell>
                <RecCell className="num" sources={row.priorSources} display={fmt(row.prior)}>{fmt(row.prior)}</RecCell>
                <RecCell className="num" sources={row.currentSources} display={fmt(row.current)}>{fmt(row.current)}</RecCell>
                <RecCell className={`num ${moveTone(row.change, !row.ratio)}`} sources={both} display={change}>{change}</RecCell>
                <RecCell className={`num ${moveTone(row.changePct, false)}`} sources={both} display={pct}>{pct}</RecCell>
                <RecCell sources={both} display={explained}>{row.explained || (row.flagged ? <span className="da-st near">Unexplained</span> : 'Within threshold')}</RecCell>
              </tr>
            );
          })}
          {!rec.drift.length && <tr><td colSpan={6}>No prior period amounts to compare against.</td></tr>}
        </tbody>
      </table></div>
    </section>
  );
}

function InputsTab({ rec }: { rec: FundRec }) {
  return (
    <section className="da-sec">
      <div className="da-sechead"><h2>Reconciliation inputs</h2><p>What this close reads for {rec.periodLabel}. Comparisons use the values on file at the prior certification.</p></div>
      <div className="da-gridwrap"><table className="da-grid">
        <thead><tr><th>Input</th><th>On file</th><th className="num">Status</th></tr></thead>
        <tbody>
          {rec.readiness.map((item) => {
            const status = item.ok ? 'On file' : item.required ? 'Missing' : 'Not needed';
            return (
              <tr key={item.key}>
                <RecCell sources={item.sources} display={item.label}>{item.label}</RecCell>
                <RecCell sources={item.sources} display={item.detail}>{item.detail}</RecCell>
                <RecCell className="num" sources={item.sources} display={status}><span className={`da-st ${item.ok ? 'ok' : item.required ? 'near' : 'na'}`}>{status}</span></RecCell>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </section>
  );
}
