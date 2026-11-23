'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { fetchRecInsights, type RecInsight } from '@/lib/fund-rec-insights';
import { markdownToHtml } from '@/lib/markdown';
import { useTemporalStore } from '@/lib/store';
import { useSurfaceNav } from '@/lib/surface-nav';
import { usePublishTabs, withoutSources, type TabPayload } from '@/lib/view-context';
import {
  CLOSE_PROCESS, FUND_REC_QUERY, HEALTH_LABEL, certify, healthTone, longDate, millions, percent, recFigures, recordDecision, reopen,
  setSignoff, shortDate, signedMillions, stepTone,
  type FundRec, type RecBind,
} from '@/lib/fund-rec';
import { certifyBlockedBy, replacedDependencies, type Certification, type CertificationView } from '@/lib/certification';
import { CertifiedBanner, ReopenButton, useCertification } from '@/components/certification/CertificationScope';
import {
  saveCashAdjustment, saveCashMatch, saveCashRules, unmatchCash,
  type CashRec, type CashRule,
} from '@/lib/cash-rec';
import { summarizeBreaks, type BreakEntry, type BreakSummary } from '@tapestrai/graphql/src/lib/nav-breaks';
import { CashRecTab } from './CashRecTab';
import { NavPackTab } from './NavPackTab';
import { RecBit, RecCell, RecFact, RecInspectProvider, RecLabel, RecPress, joinSources } from './RecInspect';

type TabKey = 'close' | 'breaks' | 'pack' | 'stmt' | 'roll' | 'cash' | 'integrity' | 'fees' | 'val' | 'drift' | 'inputs';

const TABS: Array<[TabKey, string]> = [
  ['close', 'Close status'],
  ['breaks', 'Breaks'],
  ['pack', 'NAV pack'],
  ['stmt', 'NAV statement'],
  ['roll', 'Position roll-forward'],
  ['cash', 'Cash reconciliation'],
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

const head = <T,>(rows: T[], limit: number) => rows.slice(0, limit);

/** The name, purpose and reading notes of each tab, published whether or not the close has loaded. */
const REC_TAB_INFO = {
  close: {
    label: 'Close status',
    purpose: 'Where this period\'s NAV close stands: the steps to certify, who owns them, what blocks certification and which review items are still undecided.',
    howToRead: 'health and certifyBlock say whether the NAV can be certified now. steps are the close steps in order. items are the review items from the fees, marks and drift tabs; decision is null while undecided.',
  },
  pack: {
    label: 'NAV pack',
    purpose: 'The administrator\'s NAV pack, part by part: the NAV bridge, trial balance, financial statements, investors\' capital accounts, management fee, carry and waterfall, valuation support, calls and distributions, commitments, and FX. What is on file for the period, what each part is checked against, and where it stands.',
    howToRead: 'components lists the ten parts. status is Ties (on file and every check agrees), Breaks (a check disagrees), Open (a review item on it is undecided), Partial (on file but a figure or the notes are missing), Not on file (the fund\'s pack should hold it and it does not) or Not expected (the fund\'s terms do not call for it). required parts block certification when missing or breaking. Amounts are whole dollars. In the bridge, distributions and expenses are negative. In capital accounts, distributions are positive amounts taken off, and carry is negative for a limited partner and positive for the GP. FX rates are units of the base currency for one unit of the currency.',
  },
  breaks: {
    label: 'Breaks',
    purpose: 'Everything that stands between this period\'s NAV and sign-off, in one list: checks that break, checks with a figure missing, review items still open, and inputs not on file.',
    howToRead: 'Each entry has the two figures it compares (reported and expected), the difference, the cause, what settles it and who does that. kind is break, missing, item or gap; blocking entries stand in the way of certification. Amounts are dollars, or points for a mark. comparedWith is the date the period is compared with: the statement\'s comparative date when it has one, such as the last fiscal year end for a 10-Q.',
  },
  stmt: {
    label: 'NAV statement',
    purpose: 'The administrator\'s NAV statements compared line by line with our own figures for the period.',
    howToRead: 'current is the fund administrator\'s figure, internal is ours, and variance is administrator minus internal where both are on file. Amounts are dollars, except lines whose unit is SHARES (a share count) or PER_SHARE (dollars a share). prior is the figure at the date the period is compared with.',
  },
  roll: {
    label: 'Position roll-forward',
    purpose: 'Whether the position roll-forward from the prior period ties to the NAV statement.',
    howToRead: 'rows are positions and columns are the movements. ties compares each rolled-forward line with the statement: Ties, Break or Missing.',
  },
  cash: {
    label: 'Cash reconciliation',
    purpose: 'Whether the fund\'s cash flows agree with the bank: matched, proposed and open items and what is left unexplained.',
    howToRead: 'positionTotal is cash per our records and bankTotal is per the bank. residual is the unexplained difference. flows and transactions that are open have no match yet.',
  },
  integrity: {
    label: 'Statement integrity',
    purpose: 'Whether the statements tie to one another: each check compares two figures that must agree.',
    howToRead: 'result is Ties, Break or Missing. difference is a minus b. breaks counts the checks that do not tie.',
  },
  fees: {
    label: 'Fees',
    purpose: 'Whether the management and performance fees the administrator charged agree with our recalculation.',
    howToRead: 'admin is the administrator\'s fee and recalculated is ours. difference is the gap. mgmtFee.basis says what the rate is charged on: commitments, or average net or total assets over the months the statement covers (share). perfFee.basis WATERFALL follows the liquidation waterfall: profit over the hurdle, then catch-up and carry. INCOME is an incentive fee: profit is pre-incentive net investment income, the hurdle is the preferred return on opening net assets (nav), and carry is the recalculated fee.',
  },
  val: {
    label: 'Marks and accruals',
    purpose: 'Whether the administrator\'s valuation marks and accruals agree with our own, and the effect of each difference on NAV.',
    howToRead: 'admin is the administrator\'s mark and agent is the agent\'s. effect is the NAV impact of the difference. flagged marks are outside tolerance.',
  },
  drift: {
    label: 'Period drift',
    purpose: 'How each statement line moved since the prior period, and which large moves are explained.',
    howToRead: 'change is current minus prior. flagged lines moved more than the threshold; explained says why, when known.',
  },
  inputs: {
    label: 'Rec inputs',
    purpose: 'Whether everything the reconciliation needs is on file for the period.',
    howToRead: 'A required input with ok false blocks the reconciliation. readyForRec is true when none do.',
  },
} satisfies Record<string, Omit<TabPayload, 'data'>>;

/** Every tab with data: null, for while the close is still loading. */
function pendingRecTabs(): Record<string, TabPayload> {
  return Object.fromEntries(Object.entries(REC_TAB_INFO).map(([key, tab]) => [key, { ...tab, data: null }]));
}

/**
 * What each tab tells the assistant, built from the one load that feeds every tab,
 * so it sees all of them at once. Amounts are in dollars.
 */
function recTabs(
  rec: FundRec,
  cash: CashRec | null,
  insights: RecInsight[] | null,
  breaks: BreakSummary,
  certification: Certification | null,
  view: CertificationView,
  reopened: Certification | null,
): Record<string, TabPayload> {
  const undecided = rec.items.filter((item) => item.decision == null);
  const item = (row: FundRec['items'][number]) => ({ title: row.title, tab: row.tab, administrator: row.admin, ours: row.ours, effect: row.effect, unit: row.unit, why: row.why, decision: row.decision, note: row.note });
  return withoutSources({
    close: {
      ...REC_TAB_INFO.close,
      data: {
        fund: rec.fundName, period: rec.periodLabel, periodEnd: rec.periodEnd, health: rec.health, healthNote: rec.healthNote,
        certified: rec.certified, canCertify: rec.canCertify, certifyBlock: rec.certifyBlock, targetDate: rec.targetDate, daysToTarget: rec.daysToTarget,
        navReported: rec.navReported, navProposed: rec.navProposed, navPrior: rec.navPrior, navChangePct: rec.navChangePct, netIrr: rec.netIrr,
        adjustments: rec.adjustments, stepsDone: rec.stepsDone, steps: rec.steps.map((step) => ({ name: step.name, owner: step.owner, due: step.due, state: step.state, detail: step.detail, overdue: step.overdue })),
        itemsDecided: rec.itemsDecided, itemsOpen: undecided.length, openItems: head(undecided, 40).map(item),
        insights: insights?.map((point) => point) ?? null,
        certification: certification
          ? {
            certifiedBy: certification.certifiedBy, certifiedAt: certification.certifiedAt,
            asOfDate: certification.asOfDate, knowledgeAt: certification.knowledgeAt, version: certification.version,
            showing: view === 'certified' ? 'what was certified, as known at knowledgeAt' : 'current data, not what was certified',
            priorPeriodReopenedSince: replacedDependencies(certification).map((item) => ({ periodEnd: item.periodEnd, version: item.version, reason: item.revokeReason })),
          }
          : null,
        reopened: reopened
          ? { version: reopened.version, asOfDate: reopened.asOfDate, reason: reopened.revokeReason, note: 'Reads the reopened version\'s As Of date as known now. A re-certification keeps that As Of date.' }
          : null,
        comparedWithPrior: rec.priorCertification
          ? { periodEnd: rec.priorCertification.periodEnd, version: rec.priorCertification.version, knowledgeAt: rec.priorCertification.knowledgeAt }
          : null,
      },
    },
    breaks: {
      ...REC_TAB_INFO.breaks,
      data: {
        headline: breaks.headline, period: breaks.periodLabel, periodEnd: breaks.periodEnd, comparedWith: breaks.comparedWith, spanMonths: breaks.spanMonths,
        nav: breaks.nav, counts: breaks.counts,
        entries: head(breaks.entries, 60).map(({ id: _id, ...entry }) => entry),
        tied: head(breaks.tied, 40),
        pack: breaks.pack,
      },
    },
    pack: {
      ...REC_TAB_INFO.pack,
      data: {
        period: rec.periodLabel,
        components: rec.pack.components.map(({ checks: _checks, items: _items, ...part }) => part),
        bridge: { opening: rec.pack.bridge.opening, steps: rec.pack.bridge.steps.map(({ sources: _sources, ...step }) => step), closing: rec.pack.bridge.closing, reported: rec.pack.bridge.reported, difference: rec.pack.bridge.difference },
        checks: rec.pack.checks.map((check) => ({ label: check.label, part: check.component, compared: check.compared, a: check.a, b: check.b, difference: check.difference, result: check.result })),
        trialBalance: rec.pack.trialBalance,
        capitalAccounts: rec.pack.capitalAccounts
          ? { investors: rec.pack.capitalAccounts.investors, totals: rec.pack.capitalAccounts.totals, accounts: head(rec.pack.capitalAccounts.rows, 50).map(({ id: _id, ...row }) => row) }
          : null,
        fees: rec.pack.fees,
        waterfall: rec.pack.waterfall,
        valuation: rec.pack.valuation
          ? { ...rec.pack.valuation, unsupported: head(rec.pack.valuation.unsupported, 25).map(({ id: _id, ...row }) => row), outside: head(rec.pack.valuation.outside, 25).map(({ id: _id, ...row }) => row) }
          : null,
        capitalActivity: rec.pack.capitalActivity
          ? { ...rec.pack.capitalActivity, pending: head(rec.pack.capitalActivity.pending, 20).map(({ id: _id, ...row }) => row) }
          : null,
        commitments: rec.pack.commitments,
        fx: rec.pack.fx,
      },
    },
    stmt: {
      ...REC_TAB_INFO.stmt,
      data: { period: rec.periodLabel, statements: rec.statements.map((statement) => ({ kind: statement.kind, title: statement.title, lines: head(statement.lines, 100) })) },
    },
    roll: {
      ...REC_TAB_INFO.roll,
      data: { present: rec.roll.present, tied: rec.roll.tied, columns: rec.roll.columns, rows: head(rec.roll.rows, 120), total: rec.roll.total, statement: rec.roll.statement, ties: rec.roll.ties },
    },
    cash: {
      ...REC_TAB_INFO.cash,
      data: cash ? {
        summary: cash.summary,
        matches: head(cash.matches, 60),
        openFlows: head(cash.flows.filter((flow) => flow.status === 'OPEN'), 60),
        openTransactions: head(cash.transactions.filter((txn) => txn.status === 'OPEN'), 60),
        adjustments: cash.adjustments,
      } : null,
    },
    integrity: {
      ...REC_TAB_INFO.integrity,
      data: { breaks: rec.breaks, missing: rec.missing, checks: rec.checks },
    },
    fees: {
      ...REC_TAB_INFO.fees,
      data: { mgmtFee: rec.mgmtFee, perfFee: rec.perfFee, items: rec.items.filter((row) => row.tab === 'fees').map(item) },
    },
    val: {
      ...REC_TAB_INFO.val,
      data: { marks: head(rec.marks, 100), accruals: head(rec.accruals, 100), items: rec.items.filter((row) => row.tab === 'val').map(item) },
    },
    drift: {
      ...REC_TAB_INFO.drift,
      data: { drift: head(rec.drift, 120), items: rec.items.filter((row) => row.tab === 'drift').map(item) },
    },
    inputs: {
      ...REC_TAB_INFO.inputs,
      data: { readyForRec: rec.readyForRec, readiness: rec.readiness },
    },
  });
}

export function FundRecWorkspace({ fundId, initialTab }: { fundId: string; initialTab?: string | null }) {
  const userAsOf = useTemporalStore((state) => state.asOfDate);
  const userKnowledge = useTemporalStore((state) => state.knowledgeDate);
  const [rec, setRec] = useState<FundRec | null>(null);
  const [cash, setCash] = useState<CashRec | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(10);
  const [tab, setTab] = useState<TabKey>(TABS.some(([key]) => key === initialTab) ? (initialTab as TabKey) : 'close');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [insights, setInsights] = useState<RecInsight[] | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [insightTry, setInsightTry] = useState(0);

  // A certified close reads at its certification: the As Of date and the
  // knowledge instant it was certified at. docs/CERTIFICATION.md.
  const scope = useCertification({ processCode: CLOSE_PROCESS, subjectEntityId: rec?.closeEntityId, periodEnd: rec?.periodEnd });
  // Choosing another period reads it at the user's dates until its own certification is read.
  const standing = scope.certification ?? scope.reopened;
  const certFits = !period || standing?.periodEnd === period;
  const dates = certFits ? scope.dates : { asOfDate: userAsOf, knowledgeDate: userKnowledge, pinnedBy: null, asOfKeptBy: null };
  const asOfDate = dates.asOfDate;
  // Pinned or being re-certified, the period is the certification's.
  const pinnedPeriod = certFits && (scope.pinned || dates.asOfKeptBy) ? standing?.periodEnd ?? null : null;

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ fundRec: FundRec; cashRec: CashRec }, Record<string, unknown>>(
      FUND_REC_QUERY,
      { fundId, periodEnd: period ?? pinnedPeriod, asOfDate, knowledgeDate: dates.knowledgeDate, driftThresholdPct: threshold },
      'network-only',
    );
    if (result.error) { setError(result.error.message || 'Could not load the close'); return; }
    setRec(result.data?.fundRec ?? null);
    setCash(result.data?.cashRec ?? null);
    setError(null);
  }, [fundId, period, pinnedPeriod, asOfDate, dates.knowledgeDate, threshold]);

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

  const breaks = useMemo(() => (rec ? summarizeBreaks(rec) : null), [rec]);
  const certification = certFits ? scope.certification ?? null : null;
  const reopened = certFits ? scope.reopened : null;
  usePublishTabs(rec && breaks && scope.ready ? recTabs(rec, cash, insights, breaks, certification, scope.view, reopened) : pendingRecTabs());

  if (!rec) return error ? <div className="xp-error">{error}</div> : <div className="xp-empty">Loading close…</div>;

  const ctx = { rec, asOfDate };
  const figures = recFigures(rec, cash);
  // Closes certified before certifications were recorded, or whose record failed, are not pinned.
  const unpinned = rec.certified && scope.ready && !scope.error && !certification && !reopened;
  // The prior period's certification this close compared against, so a later re-certification of it shows here.
  const dependsOn = rec.priorCertification ? [rec.priorCertification.id] : [];
  const onCertify = () => run(async () => {
    const blocked = certifyBlockedBy(userKnowledge);
    if (blocked) throw new Error(blocked);
    // What the person saw is what is certified. The records are marked first,
    // so the instant the certification stamps already knows the close is certified.
    const seen = recFigures(rec, cash);
    const closeId = await certify(ctx);
    await scope.certify(seen, { subjectEntityId: closeId, dependsOn });
  });
  const onPin = () => run(async () => {
    const blocked = certifyBlockedBy(userKnowledge);
    if (blocked) throw new Error(blocked);
    if (!rec.closeEntityId) throw new Error('This close has no close record to certify on.');
    await scope.certify(figures, { note: 'Recorded after certification, as known when recorded.', subjectEntityId: rec.closeEntityId, dependsOn });
  });
  const onReopen = (reason: string) => run(async () => {
    await scope.reopen(reason);
    await reopen(ctx);
  });
  const open = rec.items.filter((item) => item.decision == null);
  const decided = rec.items.length - open.length;
  const tabCount = (key: TabKey) => (key === 'val' || key === 'fees' || key === 'drift'
    ? rec.items.filter((item) => item.tab === key && item.decision == null).length
    : key === 'breaks' ? (breaks ? breaks.counts.breaks + breaks.counts.items : 0)
    : key === 'pack' ? rec.pack.components.filter((part) => part.status === 'Breaks' || part.status === 'Not on file').length
    : key === 'integrity' ? rec.breaks : key === 'roll' && rec.roll.present && !rec.roll.tied ? 1 : key === 'inputs' ? rec.readiness.filter((item) => item.required && !item.ok).length : key === 'cash' && cash ? cash.summary.openFlowCount + cash.summary.openTxnCount : 0);

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
            ? <ReopenButton disabled={busy || !scope.ready} onReopen={onReopen} />
            : <button type="button" className="btn btn-primary" disabled={busy || !rec.canCertify || !scope.ready} onClick={onCertify}>
              {reopened
                ? `Re-certify as of ${longDate(reopened.asOfDate)}`
                : rec.adjustments ? 'Certify with proposed adjustments' : 'Certify NAV'}
            </button>}
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
      {certFits && scope.ready && <CertifiedBanner scope={scope} figures={figures} />}
      {unpinned && (
        <div className="cert-banner cert-warn cert-banner-head">
          <span><strong>Certified, but not pinned.</strong> This close was certified before certifications were recorded, so it shows current data and can still change. Recording it now pins it to what is known now.</span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onPin}>Record certification</button>
        </div>
      )}

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

      <div className={tab === 'cash' ? 'da-main solo' : 'da-main'}>
        <div>
          {tab === 'close' && <CloseTab rec={rec} onOpen={setTab} onSignoff={(label) => run(() => setSignoff(ctx, SIGNOFF_BY_LABEL[label]))} />}
          {tab === 'breaks' && breaks && <BreaksTab summary={breaks} onOpen={setTab} />}
          {tab === 'pack' && <NavPackTab pack={rec.pack} checks={rec.checks} />}
          {tab === 'stmt' && <StatementTab rec={rec} />}
          {tab === 'roll' && <RollTab rec={rec} />}
          {tab === 'cash' && (cash
            ? <CashRecTab
                cash={cash}
                busy={busy}
                onApprove={(bankTxnId) => run(async () => {
                  const txn = cash.transactions.find((row) => row.id === bankTxnId);
                  if (!txn) return;
                  await saveCashMatch(cash, bankTxnId, txn.flowIds, txn.ruleKind || 'MANUAL', 100, txn.variance ?? 0, asOfDate);
                })}
                onPair={(bankTxnId, flowIds) => run(async () => {
                  const flows = cash.flows.filter((row) => flowIds.includes(row.id));
                  const txn = cash.transactions.find((row) => row.id === bankTxnId);
                  const variance = (txn?.amount ?? 0) - flows.reduce((total, row) => total + row.amount, 0);
                  await saveCashMatch(cash, bankTxnId, flowIds, 'MANUAL', 100, variance, asOfDate);
                })}
                onUnmatch={(matchId) => run(() => unmatchCash(matchId, asOfDate))}
                onAdjust={(amount, side, reason) => run(() => saveCashAdjustment(cash, amount, side, reason, asOfDate))}
                onRules={(rules: CashRule[]) => run(() => saveCashRules(cash, rules, asOfDate))}
              />
            : <div className="xp-empty">Cash reconciliation is not available for this close.</div>)}
          {tab === 'integrity' && <IntegrityTab rec={rec} />}
          {tab === 'fees' && <FeesTab rec={rec} />}
          {tab === 'val' && <MarksTab rec={rec} />}
          {tab === 'drift' && <DriftTab rec={rec} threshold={threshold} onThreshold={setThreshold} />}
          {tab === 'inputs' && <InputsTab rec={rec} />}
        </div>

        {tab !== 'cash' && <aside className="da-panel" aria-label="Review queue">
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
        </aside>}
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

/** The notes a reconciliation workflow kept on this close. Read-only here: a new run replaces them. */
function RecNotes({ notes, outcome }: { notes: string; outcome: string }) {
  const html = useMemo(() => markdownToHtml(notes.replace(/^#{4,}\s/gm, '### ')), [notes]);
  return (
    <section className="da-sec">
      <div className="da-sechead">
        <h2>Reconciliation notes</h2>
        {outcome ? <p>When these were saved: {outcome}</p> : null}
      </div>
      <div className="markdown-content" style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, maxWidth: 900, padding: '4px 16px 16px' }} dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

function CloseTab({ rec, onOpen, onSignoff }: { rec: FundRec; onOpen: (tab: TabKey) => void; onSignoff: (label: string) => void }) {
  const next = rec.steps.find((step) => step.state !== 'Done');
  const tabOf: Record<string, TabKey> = { integrity: 'integrity', roll: 'roll', val: 'val', fees: 'fees', drift: 'drift' };
  return (
    <>
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
    {rec.closeNotes?.notes ? <RecNotes notes={rec.closeNotes.notes} outcome={rec.closeNotes.outcome} /> : null}
    </>
  );
}

/** A statement figure: $ millions, or a share count, or dollars a share. */
function lineAmount(value: number | null, unit?: string): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (unit === 'SHARES') return Math.round(value).toLocaleString('en-US');
  if (unit === 'PER_SHARE') return `$${value.toFixed(2)}`;
  return millions(value);
}

const BREAK_GROUPS: Array<[BreakEntry['kind'], string, string]> = [
  ['break', 'Breaks', 'Two figures that must agree do not.'],
  ['item', 'Open review items', 'Figures that need a decision: accept, adjust, or query the administrator.'],
  ['missing', 'Checks with a figure missing', 'A check that cannot be made until the figure is on file. A gap, not a break.'],
  ['gap', 'Not on file', 'Inputs the reconciliation needs for this period.'],
];

const BREAK_TAB: Partial<Record<BreakEntry['kind'], TabKey>> = { break: 'integrity', missing: 'integrity', gap: 'inputs', item: 'close' };

function breakFigure(value: number | null, unit: BreakEntry['unit']): string {
  if (value == null) return '—';
  if (unit === 'POINTS') return value.toFixed(2);
  if (unit === 'COUNT') return String(value);
  if (unit === 'PCT') return `${value.toFixed(2)}%`;
  return millions(value);
}

/** Everything between this period and sign-off: the same summary the NAV reconciliation workflow writes. */
function BreaksTab({ summary, onOpen }: { summary: BreakSummary; onOpen: (tab: TabKey) => void }) {
  const [showTied, setShowTied] = useState(false);
  return (
    <>
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Breaks</h2>
          <p>{summary.headline} Compared with {longDate(summary.comparedWith)} ({summary.spanMonths} month{summary.spanMonths === 1 ? '' : 's'}). {summary.counts.ties} of {summary.counts.checks} checks tie.</p>
        </div>
        {summary.entries.length === 0 && <div className="xp-empty">Nothing breaks, nothing is missing and every review item is decided.</div>}
      </section>
      {BREAK_GROUPS.map(([kind, title, note]) => {
        const entries = summary.entries.filter((entry) => entry.kind === kind);
        if (!entries.length) return null;
        const tab = BREAK_TAB[kind];
        return (
          <section className="da-sec" key={kind}>
            <div className="da-sechead"><h2>{title}</h2><p>{note}</p></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>What</th>{kind !== 'gap' && <><th className="num">Reported</th><th className="num">Expected</th><th className="num">Difference</th></>}<th>Cause and next step</th><th>Owner</th></tr></thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className={entry.kind === 'break' ? 'flag' : ''}>
                      <td>
                        {tab ? <button type="button" className="cr-link" onClick={() => onOpen(entry.component ? 'pack' : tab)}>{entry.title}</button> : entry.title}
                        {entry.blocking && <span className="da-st breach da-gap">Blocks certification</span>}
                      </td>
                      {kind !== 'gap' && <>
                        <td className="num">{breakFigure(entry.reported, entry.unit)}</td>
                        <td className="num">{breakFigure(entry.expected, entry.unit)}</td>
                        <td className={`num ${moveTone(entry.difference, entry.unit === 'USD')}`}>{breakFigure(entry.difference, entry.unit)}</td>
                      </>}
                      <td>{entry.cause} <b>Next:</b> {entry.action}</td>
                      <td>{entry.owner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {summary.tied.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead">
            <h2>What ties</h2>
            <p>
              {summary.tied.length} checks agree.{' '}
              <button type="button" className="cr-link" onClick={() => setShowTied((value) => !value)} aria-expanded={showTied}>{showTied ? 'Hide them' : 'Show them'}</button>
            </p>
          </div>
          {showTied && <ul className="da-note">{summary.tied.map((label) => <li key={label}>{label}</li>)}</ul>}
        </section>
      )}
    </>
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
                  const format = (value: number | null) => lineAmount(value, line.unit);
                  const signedFormat = (value: number) => (line.unit && line.unit !== 'AMOUNT' ? `${value < 0 ? '−' : '+'}${lineAmount(Math.abs(value), line.unit)}` : signedMillions(value));
                  const adminText = headerLike ? '' : format(line.current);
                  const internalText = headerLike ? '' : format(line.internal);
                  const varianceText = headerLike || line.variance == null ? '' : signedFormat(line.variance);
                  const priorText = headerLike ? '' : format(line.prior);
                  const changeText = line.change == null ? '' : signedFormat(line.change);
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
        <div className="da-sechead"><h2>Management fee</h2><p>Recomputed from fund terms: {fee.rate == null ? 'no rate on file' : <><RecBit sources={fee.sources.rate} display={`${fee.rate}%`}>{fee.rate}%</RecBit> of <RecBit sources={fee.sources.base} display={millions(fee.base, 0)}>{millions(fee.base, 0)}M</RecBit> {fee.basis === 'NET_ASSETS' ? 'average net assets' : fee.basis === 'TOTAL_ASSETS' ? 'average total assets' : 'commitments'}, {(fee.share * 100).toFixed(1)}% of a year</>}. Edit terms on the <Link href={`/funds/${rec.fundId}/overview`}>fund record</Link>.</p></div>
        <div className="da-gridwrap"><table className="da-grid"><thead><tr><th>Item</th><th className="num">$M</th></tr></thead><tbody>
          {row('Recalculated fee', millions(fee.recalculated, 3), fee.sources.recalculated)}
          {row('Administrator accrual', millions(fee.admin, 3), fee.sources.admin)}
          {row('Difference', fee.difference == null ? '—' : `${signedMillions(fee.difference, 3)} (${percent(fee.differencePct, 1, true)})`, fee.sources.difference, moveTone(fee.difference, false))}
          {row('Fee base implied by admin', fee.impliedBase == null ? '—' : `$${millions(fee.impliedBase, 1)}M`, fee.sources.impliedBase)}
        </tbody></table></div>
      </section>
      <section className="da-sec">
        <div className="da-sechead"><h2>{perf.basis === 'INCOME' ? 'Incentive fee on income' : 'Performance fee'}</h2><p>{!perf.ready ? 'Preferred return and carry are not set on the fund, so no estimate is possible.' : perf.basis === 'INCOME' ? 'Recalculated on pre-incentive net investment income over the hurdle for the months the statement covers. The adviser\'s quarterly calculation governs.' : 'Reasonableness estimate from NAV, distributions and capital calls. The admin waterfall governs.'}</p></div>
        <div className="da-gridwrap"><table className="da-grid"><thead><tr><th>Item</th><th className="num">$M</th></tr></thead><tbody>
          {perf.basis === 'INCOME' ? <>
            {row('Pre-incentive net investment income', millions(perf.profit), perf.sources.profit)}
            {row(`Hurdle (${perf.prefPct}% a year on opening net assets of ${millions(perf.nav, 0)}M)`, millions(perf.hurdle), perf.sources.hurdle)}
            {row('Income above the hurdle', millions(perf.excess), perf.sources.excess)}
            {row(`Recalculated fee (${perf.carryPct}% with ${perf.catchUpPct}% catch-up)`, millions(perf.carry), joinSources(perf.sources.carry, perf.sources.carryRate, perf.sources.catchUp))}
            {row('In the statements', millions(perf.admin), perf.sources.admin, perf.ready && Math.abs(perf.carry - perf.admin) > 50000 ? 'neg' : '')}
          </> : <>
          {row('Net asset value plus distributions to date', millions(perf.nav + perf.distributions), joinSources(perf.sources.nav, perf.sources.distributions))}
          {row('Less contributions', millions(-perf.contributions), perf.sources.contributions)}
          {row('Profit to date', millions(perf.profit), perf.sources.profit)}
          {row(`Preferred return hurdle (${perf.prefPct}% on each call)`, millions(perf.hurdle), perf.sources.hurdle)}
          {row('Profit above hurdle', millions(perf.excess), perf.sources.excess)}
          {row(`Estimated carry accrual (${perf.carryPct}% carry, ${perf.catchUpPct}% catch-up)`, millions(perf.carry), joinSources(perf.sources.carry, perf.sources.carryRate, perf.sources.catchUp))}
          {row('Administrator accrual', millions(perf.admin), perf.sources.admin, perf.ready && Math.abs(perf.carry - perf.admin) > 50000 ? 'neg' : '')}
          </>}
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
