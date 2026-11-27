/**
 * How each figure with no attribute of its own is worked out, in words, with the records behind
 * it. Shown when a person right-clicks it. Every number here came back from the platform: tests
 * from the compliance engine, the rest from cloBook. Nothing is recomputed.
 */
import type { Derivation } from '../components/common';
import type { Holding, Kpi, Note, Test, Vehicle, WaterfallStep } from './data';
import { ATTR } from './data';
import { limitBind, onNote, onPosition, onSecurity, onTxn } from './binds';
import { fmtBps, fmtDay, fmtDollars, fmtMeasure, fmtNum, fmtPct, fmtTest, fmtUsd, fmtYears } from './format';

const LISTED = 12;

/** The holdings a test reads, with the value it reads off each, largest first. Listed only; the engine applies the test's own filters. */
function holdingsFor(v: Vehicle, t: Pick<Test, 'metric' | 'group' | 'category' | 'ruleName'>): Pick<Derivation, 'rows' | 'more'> {
  let list: Holding[] = v.holdings.filter((h) => !h.defaulted);
  let rows: NonNullable<Derivation['rows']>;
  if (t.group) {
    list = list.filter((h) => h.industry === t.group || h.obligorGroup === t.group);
  }
  switch (t.metric) {
    case 'WARF':
      list = [...list].sort((a, b) => b.par * (b.factor ?? 0) - a.par * (a.factor ?? 0));
      rows = list.slice(0, LISTED).map((h) => ({ label: h.name, sub: `${fmtUsd(h.par)} par · ${h.ratingMoodys || 'unrated'}`, value: fmtNum(h.factor), bind: onSecurity(h, ATTR.factor, 'Moody’s rating factor') ?? undefined }));
      break;
    case 'WAS':
      list = list.filter((h) => !h.fixedRate).sort((a, b) => (a.spreadBps ?? 0) - (b.spreadBps ?? 0));
      rows = list.slice(0, LISTED).map((h) => ({ label: h.name, sub: `${fmtUsd(h.par)} par`, value: fmtBps(h.spreadBps), bind: onSecurity(h, ATTR.spread, 'Spread') ?? undefined }));
      break;
    case 'WAL':
      list = [...list].sort((a, b) => (b.lifeYears ?? 0) * b.par - (a.lifeYears ?? 0) * a.par);
      rows = list.slice(0, LISTED).map((h) => ({ label: h.name, sub: `${fmtUsd(h.par)} par · ${fmtYears(h.lifeYears)}`, value: fmtDay(h.maturity), bind: onSecurity(h, ATTR.maturity, 'Maturity date') ?? undefined }));
      break;
    case 'WARR':
      list = [...list].sort((a, b) => (a.recovery ?? 0) - (b.recovery ?? 0));
      rows = list.slice(0, LISTED).map((h) => ({ label: h.name, sub: `${fmtUsd(h.par)} par`, value: fmtPct(h.recovery, 1), bind: onSecurity(h, ATTR.recovery, 'Moody’s recovery rate') ?? undefined }));
      break;
    case 'CCC':
      list = list.filter((h) => h.ccc);
      rows = list.slice(0, LISTED).map((h) => ({ label: h.name, sub: `${h.ratingMoodys || ''} · price ${fmtNum(h.price, 2)}`, value: fmtUsd(h.par), bind: onPosition(h, ATTR.par, 'Funded par') }));
      break;
    case 'OC':
    case 'IC':
      return {};
    default:
      rows = list.slice(0, LISTED).map((h) => ({ label: h.name, sub: [h.industry, h.obligorGroup].filter(Boolean).join(' · '), value: fmtUsd(h.par), bind: onPosition(h, ATTR.par, 'Funded par') }));
  }
  return { rows, more: list.length > LISTED ? list.length - LISTED : undefined };
}

export function testHow(v: Vehicle, asOf: string, t: Test): Derivation {
  const limitAttr = t.limitAttribute ? ` The limit is ${t.limitHolder === 'NOTE' ? 'the covered class’s trigger' : 'the indenture term'} ${t.limitAttribute}.` : ' The limit is the rule’s own number.';
  const ratio = t.denominator != null && t.denominator !== 0;
  const rows: NonNullable<Derivation['rows']> = [];
  if (t.numerator != null) rows.push({ label: 'Numerator', value: t.unit === 'PERCENTAGE' && ratio ? fmtDollars(t.numerator) : fmtNum(t.numerator, 2) });
  if (ratio) rows.push({ label: 'Denominator', value: fmtDollars(t.denominator) });
  const lb = limitBind(v, t);
  rows.push({ label: `Limit (${t.direction === 'MIN' ? 'minimum' : 'maximum'})`, value: fmtTest(t, t.limit), bind: lb ?? undefined });
  rows.push({ label: 'Cushion', value: t.cushion == null ? '—' : `${fmtTest(t, t.cushion)} (${fmtPct(t.cushionPct, 1)} of the limit)` });
  if (t.metric === 'OC' || t.metric === 'IC') {
    for (const n of v.notes.filter((x) => !x.residual && t.rank != null && x.rank <= t.rank)) {
      rows.push(t.metric === 'OC'
        ? { label: `${n.name}`, sub: 'Par outstanding, in the denominator', value: fmtUsd(n.par), bind: onNote(n, ATTR.notePar, 'Par outstanding') }
        : { label: `${n.name}`, sub: 'Interest due, in the denominator', value: fmtDollars(n.interestDue), bind: onNote(n, ATTR.noteDue, 'Interest due') });
    }
  }
  const listed = holdingsFor(v, t);
  return {
    title: `${v.name} · ${t.ruleName}${t.group ? ` · ${t.group}` : ''}`,
    value: fmtTest(t, t.value),
    formula: `Scored by the compliance engine as of ${fmtDay(asOf)}, on the CLO’s booked holdings.${ratio ? ' The value is the numerator over the denominator' + (t.unit === 'PERCENTAGE' ? ', as a percent.' : '.') : ''}${limitAttr} ${t.status === 'HARD_BREACH' ? 'It is past its limit.' : t.status === 'PASS' ? 'It is inside its limit.' : 'The engine could not score it: a value it needs is missing.'}${listed.rows?.length ? ' Listed below: the holdings it reads, with the value it reads off each.' : ''}`,
    rows: [...rows, ...(listed.rows || [])],
    more: listed.more,
  };
}

export function diversityHow(v: Vehicle): Derivation {
  const d = v.diversity;
  return {
    title: `${v.name} · Diversity score`,
    value: fmtNum(d.score, 1),
    formula: `Moody’s diversity score, worked out by the platform from performing holdings. Par is summed by obligor group (${d.obligors} obligors, average ${fmtUsd(d.averagePar)}); each obligor counts its par over the average, up to one unit; each industry’s units go through the Moody’s diversity table (the MOODYS_DIVERSITY_TABLE list), and the industry scores add up. The minimum is the indenture term ${ATTR.minDiversity}.${d.unclassifiedPar ? ` ${fmtUsd(d.unclassifiedPar)} of par has no Moody’s industry and is left out.` : ''}`,
    rows: [
      { label: 'Minimum', value: fmtNum(d.limit, 1), bind: onTxn(v, ATTR.minDiversity, 'Minimum diversity score') ?? undefined },
      ...d.industries.slice(0, LISTED).map((i) => ({ label: i.industry, sub: `${i.obligors} obligors · ${fmtUsd(i.par)} · ${fmtNum(i.units, 2)} units`, value: fmtNum(i.score, 2) })),
    ],
    more: d.industries.length > LISTED ? d.industries.length - LISTED : undefined,
  };
}

export function kpiHow(v: Vehicle, asOf: string, k: Kpi): Derivation {
  if (k.metric === 'DIVERSITY') return diversityHow(v);
  const t = v.tests.find((x) => x.ruleCode === k.ruleCode && !x.group);
  if (t) return testHow(v, asOf, t);
  return { title: `${v.name} · ${k.label}`, value: fmtMeasure(k.metric, k.value), formula: 'The compliance engine did not score this measure for this CLO.' };
}

type CollateralKey = 'par' | 'performingPar' | 'defaultedPar' | 'marketValue' | 'weightedPrice' | 'count' | 'obligors' | 'cccPct' | 'interestProceeds' | 'notesPar' | 'largestObligorPct';

export function collateralHow(v: Vehicle, key: CollateralKey): Derivation {
  const c = v.collateral;
  const top = (by: (h: Holding) => number, value: (h: Holding) => string, code: string, label: string, filter: (h: Holding) => boolean = () => true) => {
    const list = v.holdings.filter(filter).sort((a, b) => by(b) - by(a));
    return { rows: list.slice(0, LISTED).map((h) => ({ label: h.name, sub: h.industry || undefined, value: value(h), bind: onPosition(h, code, label) })), more: list.length > LISTED ? list.length - LISTED : undefined };
  };
  switch (key) {
    case 'par': return { title: `${v.name} · Collateral par`, value: fmtUsd(c.par), formula: `Funded par of every booked holding, added up (${c.count} holdings). Pre-trade scenario positions are left out${v.hypotheticalPositions ? ` (${v.hypotheticalPositions} here)` : ''}.`, ...top((h) => h.par, (h) => fmtUsd(h.par), ATTR.par, 'Funded par') };
    case 'performingPar': return { title: `${v.name} · Performing par`, value: fmtUsd(c.performingPar), formula: 'Funded par of holdings whose security is not a defaulted obligation.', ...top((h) => h.par, (h) => fmtUsd(h.par), ATTR.par, 'Funded par', (h) => !h.defaulted) };
    case 'defaultedPar': return { title: `${v.name} · Defaulted par`, value: fmtUsd(c.defaultedPar), formula: 'Funded par of holdings whose security is flagged a defaulted obligation. The OC tests carry them at their defaulted carry value instead.', ...top((h) => h.par, (h) => fmtUsd(h.par), ATTR.par, 'Funded par', (h) => h.defaulted) };
    case 'marketValue': return { title: `${v.name} · Market value`, value: fmtUsd(c.marketValue), formula: 'Market value of each holding, added up.', ...top((h) => h.marketValue ?? 0, (h) => fmtUsd(h.marketValue), ATTR.marketValue, 'Market value') };
    case 'weightedPrice': return { title: `${v.name} · Weighted price`, value: fmtNum(c.weightedPrice, 2), formula: 'Each holding’s price weighted by its funded par.', ...top((h) => h.par, (h) => fmtNum(h.price, 2), ATTR.price, 'Price') };
    case 'count': return { title: `${v.name} · Holdings`, value: String(c.count), formula: 'Booked holdings with funded par, as of the As Of date.' };
    case 'obligors': return { title: `${v.name} · Obligors`, value: String(c.obligors), formula: 'Distinct obligor groups among performing holdings (OBLIGOR_GROUP_ID on each issuer; an issuer with none is its own group).' };
    case 'cccPct': return { title: `${v.name} · CCC share`, value: fmtPct(c.cccPct), formula: 'Performing par rated CCC+/Caa1 or below (CLO_IS_CCC on the security) over performing par. The engine’s CCC test is the figure to report; this is the same split shown on the holdings.', ...top((h) => h.par, (h) => fmtUsd(h.par), ATTR.par, 'Funded par', (h) => h.ccc && !h.defaulted) };
    case 'interestProceeds': return { title: `${v.name} · Interest collections`, value: fmtDollars(c.interestProceeds), formula: 'Expected interest for the period on each performing holding, added up. It is the interest the IC tests and the waterfall start from.', ...top((h) => h.expectedInterest ?? 0, (h) => fmtDollars(h.expectedInterest), ATTR.expectedInterest, 'Expected interest', (h) => !h.defaulted) };
    case 'notesPar': return { title: `${v.name} · Notes outstanding`, value: fmtUsd(c.notesPar), formula: 'Par outstanding of every note class, the subordinated notes included.', rows: v.notes.map((n) => ({ label: n.name, value: fmtUsd(n.par), bind: onNote(n, ATTR.notePar, 'Par outstanding') })) };
    case 'largestObligorPct': {
      const groups = new Map<string, number>();
      for (const h of v.holdings.filter((x) => !x.defaulted)) groups.set(h.obligorGroup || h.issuer, (groups.get(h.obligorGroup || h.issuer) || 0) + h.par);
      const rows = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, LISTED).map(([g, par]) => ({ label: g, value: `${fmtUsd(par)} · ${fmtPct(c.performingPar ? (par / c.performingPar) * 100 : null)}` }));
      return { title: `${v.name} · Largest obligor`, value: fmtPct(c.largestObligorPct), formula: 'Performing par of the largest obligor group over performing par.', rows };
    }
    default: return { title: v.name, formula: '' };
  }
}

export function noteHow(v: Vehicle, n: Note, key: 'share' | 'attachment' | 'coupon' | 'detachment'): Derivation {
  switch (key) {
    case 'share': return { title: `${n.name} · Share of the capital structure`, value: fmtPct(n.sharePct, 1), formula: 'The class’s par outstanding over the par outstanding of every class.', rows: [{ label: n.name, value: fmtUsd(n.par), bind: onNote(n, ATTR.notePar, 'Par outstanding') }, { label: 'All classes', value: fmtUsd(v.collateral.notesPar) }] };
    case 'attachment':
    case 'detachment': return { title: `${n.name} · ${key === 'attachment' ? 'Attachment' : 'Detachment'}`, value: fmtPct(key === 'attachment' ? n.attachmentPct : n.detachmentPct, 1), formula: 'Measured from the bottom of the capital structure: the share of note par that ranks below the class (attachment), and that plus the class itself (detachment). Losses reach the class once they pass its attachment.', rows: v.notes.slice().reverse().map((x) => ({ label: x.name, value: fmtPct(x.sharePct, 1) })) };
    case 'coupon': return { title: `${n.name} · Coupon`, value: fmtPct(n.couponPct), formula: 'The benchmark rate set for the period plus the class spread.', rows: [
      { label: 'Benchmark rate', value: fmtPct(v.benchmarkPct), bind: onTxn(v, ATTR.benchmark, 'Benchmark rate') ?? undefined },
      { label: 'Spread', value: fmtBps(n.spreadBps), bind: onNote(n, ATTR.noteSpread, 'Coupon spread') },
    ] };
  }
}

export function stepHow(v: Vehicle, s: WaterfallStep, field: 'due' | 'paid' | 'short'): Derivation {
  const note = s.noteId ? v.notes.find((n) => n.id === s.noteId) : undefined;
  const rows: NonNullable<Derivation['rows']> = [
    { label: 'Available before this step', value: fmtDollars(s.availableBefore) },
    { label: 'Due', value: fmtDollars(s.due) },
    { label: 'Paid', value: fmtDollars(s.paid) },
  ];
  if (s.deferred) rows.push({ label: 'Deferred (added to the class)', value: fmtDollars(s.deferred) });
  if (s.shortfall) rows.push({ label: 'Not paid', value: fmtDollars(s.shortfall) });
  if (note && s.kind === 'INTEREST') rows.push({ label: `${note.name} interest due`, value: fmtDollars(note.interestDue), bind: onNote(note, ATTR.noteDue, 'Interest due') });
  if (s.kind === 'EXPENSE') rows.push({ label: 'Senior expenses', value: fmtDollars(s.due), bind: onTxn(v, ATTR.seniorExpenses, 'Senior expenses') ?? undefined });
  if (s.kind === 'FEE') {
    const senior = /senior/i.test(s.label);
    rows.push({ label: senior ? 'Senior fee (bps a year)' : 'Subordinated fee (bps a year)', value: fmtNum(v.terms.find((t) => t.code === (senior ? ATTR.seniorFee : ATTR.subFee))?.numeric, 0), bind: onTxn(v, senior ? ATTR.seniorFee : ATTR.subFee, senior ? 'Senior management fee' : 'Subordinated management fee') ?? undefined });
  }
  if (s.waterfall === 'PRINCIPAL') {
    const p = v.accounts.find((a) => a.type === 'PRINCIPAL');
    if (p) rows.push({ label: p.name, value: fmtDollars(p.balance), bind: { entityId: p.id, entityName: p.name, domainCode: 'CLO_ACCOUNT', code: ATTR.acctBalance, name: 'Balance' } });
  }
  const label = field === 'due' ? 'due' : field === 'paid' ? 'paid' : 'not paid';
  return { title: `${v.name} · ${s.label} · ${label}`, value: fmtDollars(field === 'due' ? s.due : field === 'paid' ? s.paid : s.deferred + s.shortfall), formula: `Worked out by the platform’s waterfall for the next payment date. ${s.basis}`, rows };
}

export function countHow(title: string, value: string, formula: string, rows?: Derivation['rows']): Derivation {
  return { title, value, formula, rows };
}
