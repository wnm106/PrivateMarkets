export interface ListValueRow {
  list_code: string;
  value_code: string;
  value_label: string;
  synonyms: string[] | null;
}

export interface NormalizedValue {
  canonicalCode: string | null;
  canonicalLabel: string | null;
  matchType: 'exact_code' | 'exact_label' | 'synonym' | 'unmapped';
}

const NUMERIC_TYPES = new Set(['NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE']);

export function indexReferenceLists(rows: ListValueRow[]): Map<string, Map<string, NormalizedValue>> {
  const byList = new Map<string, Map<string, NormalizedValue & { rank: number }>>();
  const rankOf = { synonym: 1, exact_label: 2, exact_code: 3 } as const;

  const put = (listCode: string, key: string, value: NormalizedValue, rank: number) => {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) return;
    let list = byList.get(listCode);
    if (!list) {
      list = new Map();
      byList.set(listCode, list);
    }
    const existing = list.get(normalizedKey);
    if (!existing || rank > existing.rank) {
      list.set(normalizedKey, { ...value, rank });
    }
  };

  for (const row of rows) {
    const canonical = {
      canonicalCode: row.value_code,
      canonicalLabel: row.value_label,
    };
    for (const synonym of row.synonyms || []) {
      put(row.list_code, synonym, { ...canonical, matchType: 'synonym' }, rankOf.synonym);
    }
    put(row.list_code, row.value_label, { ...canonical, matchType: 'exact_label' }, rankOf.exact_label);
    put(row.list_code, row.value_code, { ...canonical, matchType: 'exact_code' }, rankOf.exact_code);
  }

  const result = new Map<string, Map<string, NormalizedValue>>();
  for (const [listCode, entries] of byList) {
    const cleaned = new Map<string, NormalizedValue>();
    for (const [key, value] of entries) {
      cleaned.set(key, {
        canonicalCode: value.canonicalCode,
        canonicalLabel: value.canonicalLabel,
        matchType: value.matchType,
      });
    }
    result.set(listCode, cleaned);
  }
  return result;
}

export function normalizeToList(
  lists: Map<string, Map<string, NormalizedValue>>,
  listCode: string | null | undefined,
  input: string
): NormalizedValue | null {
  if (!listCode) return null;
  const list = lists.get(listCode);
  if (!list) {
    return { canonicalCode: null, canonicalLabel: null, matchType: 'unmapped' };
  }
  return (
    list.get(input.trim().toLowerCase()) || {
      canonicalCode: null,
      canonicalLabel: null,
      matchType: 'unmapped',
    }
  );
}

export function applyTransform(raw: string, transform?: { kind: string; find?: string; replaceWith?: string; values?: { from: string; to: string }[] } | null): string {
  let text = raw ?? '';
  const replacement = transform?.values?.find((entry) => entry.from.trim().toLowerCase() === text.trim().toLowerCase());
  if (replacement?.to) text = replacement.to;
  switch (transform?.kind) {
    case 'none':
      return text;
    case 'uppercase':
      return text.trim().toUpperCase();
    case 'lowercase':
      return text.trim().toLowerCase();
    case 'number': {
      return numberText(text) ?? text.trim();
    }
    case 'percent': {
      const trimmed = text.trim();
      if (!trimmed.endsWith('%')) return trimmed;
      const parsed = Number(trimmed.slice(0, -1).replace(/,/g, '').trim());
      return Number.isFinite(parsed) ? String(parsed / 100) : trimmed;
    }
    case 'date':
      return parseUsDate(text) || text.trim();
    case 'replace': {
      const find = transform.find ?? '';
      if (!find) return text;
      return text.split(find).join(transform.replaceWith ?? '');
    }
    case 'list':
    case 'trim':
    default:
      return text.trim();
  }
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fullYear(text: string): number {
  const year = Number(text);
  return text.length === 2 ? (year >= 70 ? 1900 + year : 2000 + year) : year;
}

/**
 * Read a date as an ISO day. Only real calendar days are accepted.
 * Slash dates are month first. When the first part cannot be a month
 * (13/01/2025) the day-first reading is used, since it is the only valid one.
 */
export function parseUsDate(input: string): string | null {
  const text = input.trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const year = fullYear(slash[3]);
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    return isoDate(year, first, second) || (first > 12 ? isoDate(year, second, first) : null);
  }
  const months: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  };
  const named = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/);
  if (named && months[named[2].toLowerCase()]) {
    return isoDate(fullYear(named[3]), months[named[2].toLowerCase()], Number(named[1]));
  }
  const monthFirst = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthFirst && months[monthFirst[1].toLowerCase()]) {
    return isoDate(Number(monthFirst[3]), months[monthFirst[1].toLowerCase()], Number(monthFirst[2]));
  }
  return null;
}

const BLANK_TOKENS = new Set(['-', '--', '—', '–', 'n/a', 'na', 'n.a.', 'nan', 'null', 'none', 'nil', '#n/a']);

/** A placeholder for "no value". Treated as blank so it never overwrites a stored value. */
export function isBlankToken(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === '' || BLANK_TOKENS.has(trimmed);
}

/**
 * Read a number from text. Handles currency symbols, accounting parentheses,
 * a trailing minus, and both 1,234.56 and 1.234,56. A lone comma followed by
 * exactly three digits is a thousands separator; any other lone comma is a decimal.
 * Returns the plain digits with a leading minus if negative, or null when
 * the text is not a number. The digits keep their original precision.
 */
export function numberText(input: string): string | null {
  let text = input.trim().replace(/[$€£¥\s]/g, '');
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (!/^[\d.,]*(?:[eE][+-]?\d+)?$/.test(text) || !/\d/.test(text)) return null;
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    if (text.split(decimal).length > 2) return null;
    text = text.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    const parts = text.split(',');
    const grouped = parts.length > 1 && parts.slice(1).every((part) => /^\d{3}$/.test(part)) && /^\d{1,3}$/.test(parts[0]);
    if (grouped) text = parts.join('');
    else if (parts.length === 2) text = `${parts[0]}.${parts[1]}`;
    else return null;
  } else if (lastDot >= 0 && text.split('.').length > 2) {
    const parts = text.split('.');
    if (!parts.slice(1).every((part) => /^\d{3}$/.test(part))) return null;
    text = parts.join('');
  }
  if (!Number.isFinite(Number(text))) return null;
  return negative ? `-${text}` : text;
}

export function parseNumber(input: string): number | null {
  const text = numberText(input);
  return text === null ? null : Number(text);
}

export function dayBefore(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export interface Period {
  id: string;
  validFrom: string;
  validTo: string;
}

/**
 * Where a value that starts on `validFrom` fits among a source's existing periods.
 * It ends where the period it falls inside ended, or the day before the next later
 * period starts, or stays open. The period it falls inside is cut off the day
 * before it starts, so no two periods overlap.
 */
export function planPeriod(periods: Period[], validFrom: string): { validTo: string; closeId: string | null; closeTo: string | null } {
  const covering = periods.find((period) => period.validFrom < validFrom && period.validTo >= validFrom);
  const nextLater = periods
    .filter((period) => period.validFrom > validFrom)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
  let validTo = covering ? covering.validTo : nextLater ? dayBefore(nextLater.validFrom) : '9999-12-31';
  if (nextLater && validTo > dayBefore(nextLater.validFrom)) validTo = dayBefore(nextLater.validFrom);
  return { validTo, closeId: covering ? covering.id : null, closeTo: covering ? dayBefore(validFrom) : null };
}

export interface CoercedValue {
  golden_value: string;
  golden_value_numeric: number | null;
  golden_value_date: string | null;
  raw_value: string;
}

export function coerceAttributeValue(raw: string, dataType: string): CoercedValue | { error: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (NUMERIC_TYPES.has(dataType)) {
    if (isBlankToken(text)) return null;
    const percent = text.endsWith('%');
    const parsed = parseNumber(percent ? text.slice(0, -1) : text);
    if (parsed === null) return { error: `"${text}" is not a number` };
    const value = percent ? parsed / 100 : parsed;
    return {
      golden_value: String(value),
      golden_value_numeric: value,
      golden_value_date: null,
      raw_value: text,
    };
  }
  if (dataType === 'DATE') {
    if (isBlankToken(text)) return null;
    const iso = parseUsDate(text);
    if (!iso) return { error: `"${text}" is not a date` };
    return {
      golden_value: iso,
      golden_value_numeric: null,
      golden_value_date: iso,
      raw_value: text,
    };
  }
  return {
    golden_value: text,
    golden_value_numeric: null,
    golden_value_date: null,
    raw_value: text,
  };
}
