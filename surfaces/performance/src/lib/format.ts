/** Number and date formatting. Amounts are dollars; rates and multiples arrive as decimals. */

const trim = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  if (v < 0) return `-${fmtUsd(-v)}`;
  if (v >= 1e9) return `$${trim((v / 1e9).toFixed(2))}B`;
  if (v >= 1e6) return `$${trim((v / 1e6).toFixed(1))}M`;
  if (v >= 1e3) return `$${trim((v / 1e3).toFixed(0))}K`;
  return `$${Math.round(v)}`;
}

/** A decimal rate as a percent: 0.1234 is 12.3%. */
export const fmtRate = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);
/** A stored percent attribute (12.5 means 12.5%). */
export const fmtPctValue = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${trim(v.toFixed(1))}%`);
export const fmtX = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}x`);
/** A difference of two rates, in basis points. */
export const fmtBps = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 10000)}bps`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(text: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
}

/** Tone for a return: up when positive, down when negative. */
export const tone = (v: number | null | undefined) => (v == null ? '' : v < 0 ? 'x-dn' : 'x-up');

/** A stored code such as DIRECT_LENDING as words ("Direct lending"). Anything else is shown as stored. */
export function words(value: string | null | undefined): string {
  const text = (value || '').trim();
  if (!/^[A-Z0-9]+(_[A-Z0-9]+)*$/.test(text) || /^\d+$/.test(text)) return text;
  const lower = text.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
