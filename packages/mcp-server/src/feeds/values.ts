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
    case 'number':
      return text.replace(/,/g, '').trim();
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

export function parseUsDate(input: string): string | null {
  const text = input.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!us) return null;
  const month = Number(us[1]);
  const day = Number(us[2]);
  const year = Number(us[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function dayBefore(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
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
    const percent = text.endsWith('%');
    const numericText = text.replace(/%$/, '').replace(/,/g, '').trim();
    const parsed = Number(numericText);
    if (!Number.isFinite(parsed)) return { error: `"${text}" is not a number` };
    const value = percent ? parsed / 100 : parsed;
    return {
      golden_value: String(value),
      golden_value_numeric: value,
      golden_value_date: null,
      raw_value: text,
    };
  }
  if (dataType === 'DATE') {
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
