/** Number and date formatting for the OCIO surface. Amounts are dollars. */

const trim = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '';
  if (v < 0) return `-${fmtUsd(-v)}`;
  if (v >= 1e9) return `$${trim((v / 1e9).toFixed(2))}B`;
  if (v >= 1e6) return `$${trim((v / 1e6).toFixed(1))}M`;
  if (v >= 1e3) return `$${trim((v / 1e3).toFixed(0))}K`;
  return `$${Math.round(v)}`;
}

export const fmtPct = (v: number | null | undefined): string => (v == null || Number.isNaN(v) ? '' : `${trim(v.toFixed(1))}%`);
export const fmtN = (v: number | null | undefined): string => (v == null ? '' : String(v));
export const fmtX = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}x`);

export type Measure = 'usd' | 'n' | 'pct';
export const MEASURES: Array<{ k: Measure; sym: string; name: string }> = [
  { k: 'usd', sym: '$', name: 'Dollars' },
  { k: 'n', sym: '#', name: 'Investments' },
  { k: 'pct', sym: '%', name: 'Percent' },
];

export const fmtMeasure = (k: Measure, v: number | null | undefined): string => (k === 'usd' ? fmtUsd(v) : k === 'pct' ? fmtPct(v) : fmtN(v));

/** Parse a typed cell. Bare numbers are millions for dollars; K and B suffixes work. */
export function parseMeasure(k: Measure, raw: string): { ok: true; v: number | null } | { ok: false } {
  const s = String(raw).trim().replace(/[,\s$]/g, '');
  if (s === '' || s === '—') return { ok: true, v: null };
  if (k === 'usd') {
    const m = s.match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return { ok: false };
    const mult = ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[(m[2] || 'm').toLowerCase()];
    return { ok: true, v: Math.round(parseFloat(m[1]) * mult) };
  }
  if (k === 'pct') {
    const body = s.replace(/%$/, '');
    const v = parseFloat(body);
    if (Number.isNaN(v) || v < 0 || v > 1000 || !/^\d*\.?\d+$/.test(body)) return { ok: false };
    return { ok: true, v: Math.round(v * 100) / 100 };
  }
  if (!/^\d+$/.test(s)) return { ok: false };
  return { ok: true, v: parseInt(s, 10) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthYear = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const fmtDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** A YYYY-MM-DD string as a local date. */
export function parseDay(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
