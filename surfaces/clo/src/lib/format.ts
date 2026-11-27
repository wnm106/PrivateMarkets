/** Number and date formats used across the CLO surface. */
const nf = (digits: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const dash = '—';

/** Dollars in millions with one decimal, or whole dollars under $1M. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return dash;
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${nf(2).format(a / 1e9)}bn`;
  if (a >= 1e6) return `${sign}$${nf(1).format(a / 1e6)}m`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

/** Whole dollars, for waterfall amounts. */
export function fmtDollars(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return dash;
  return `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? dash : `${nf(digits).format(n)}%`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? dash : nf(digits).format(n);
}

export function fmtBps(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? dash : `${Math.round(n)} bps`;
}

export function fmtSigned(n: number | null | undefined, digits = 2, unit = ''): string {
  if (n == null || !Number.isFinite(n)) return dash;
  const shown = nf(digits).format(Math.abs(n));
  // A change that rounds to nothing carries no sign.
  const zero = Number(shown.replace(/,/g, '')) === 0;
  return `${zero ? '' : n > 0 ? '+' : '-'}${shown}${unit}`;
}

export function fmtDay(d: string | null | undefined): string {
  if (!d) return dash;
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Q3 2026" for a quarter end, the date otherwise. */
export function fmtQuarter(d: string): string {
  const [y, m] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m % 3 === 0 && Number(d.slice(8, 10)) === last) return `Q${m / 3} ${y}`;
  return fmtDay(d);
}

export function fmtYears(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? dash : `${nf(2).format(n)} yrs`;
}

/** Words for an UPPER_SNAKE code. */
export function words(code: string | null | undefined): string {
  if (!code) return dash;
  return code.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** How a figure of one measure is shown. */
export function fmtMeasure(metric: string, n: number | null | undefined): string {
  switch (metric) {
    case 'WARF': return fmtNum(n, 0);
    case 'WAS': return fmtBps(n);
    case 'WAL': return fmtYears(n);
    case 'DIVERSITY': return fmtNum(n, 1);
    default: return fmtPct(n);
  }
}

/** A change in one measure, in its own unit. */
export function fmtMeasureChange(metric: string, n: number | null | undefined): string {
  switch (metric) {
    case 'WARF': return fmtSigned(n, 0);
    case 'WAS': return fmtSigned(n, 0, ' bps');
    case 'WAL': return fmtSigned(n, 2, ' yrs');
    case 'DIVERSITY': return fmtSigned(n, 1);
    default: return fmtSigned(n, 2, ' pts');
  }
}

export const STATUS_WORD: Record<string, string> = {
  PASS: 'Pass', HARD_BREACH: 'Breach', SOFT_BREACH: 'Warning', NO_DATA: 'No data', ERROR: 'Error', NO_LIMIT: 'No limit',
};

export function statusClass(status: string | null | undefined): string {
  switch (status) {
    case 'PASS': return 'ok';
    case 'HARD_BREACH': return 'breach';
    case 'SOFT_BREACH': return 'near';
    default: return 'na';
  }
}

/** A test's value or limit in the test's own unit: a count of holdings, a percent, or the measure's ratio unit. */
export function fmtTest(t: { metric: string | null; unit: string | null }, n: number | null | undefined): string {
  if (t.unit === 'COUNT') return fmtNum(n, 0);
  if (t.metric && t.metric !== 'CCC' && t.metric !== 'OC' && t.metric !== 'IC') return fmtMeasure(t.metric, n);
  if (t.unit === 'PERCENTAGE') return fmtPct(n);
  return fmtNum(n, 2);
}
