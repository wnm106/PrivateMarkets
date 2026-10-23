export interface AttributeDisplay {
  dataType?: string | null;
  displayFormat?: string | null;
  numericPrecision?: number | null;
  unitOfMeasure?: string | null;
}

export type DisplayKind = 'date' | 'currency' | 'percentage' | 'number' | 'integer' | 'boolean' | 'text';

const DATE_TYPES = new Set(['DATE', 'TIMESTAMP', 'DATETIME']);
const INTEGER_TYPES = new Set(['INTEGER']);
const NUMBER_TYPES = new Set(['NUMBER', 'DECIMAL', 'FLOAT', 'NUMERIC', 'INTEGER', 'CURRENCY', 'PERCENTAGE', 'PERCENT']);

/** Mask follows the attribute data type. A numeric display format only refines a numeric type. */
export function attributeDisplayKind(meta?: AttributeDisplay | null): DisplayKind {
  const type = (meta?.dataType || '').trim().toUpperCase();
  const format = (meta?.displayFormat || '').trim().toLowerCase();

  if (DATE_TYPES.has(type)) return 'date';
  if (type === 'BOOLEAN') return 'boolean';
  if (!NUMBER_TYPES.has(type)) return 'text';
  if (type === 'PERCENTAGE' || type === 'PERCENT' || format === 'percentage' || format === 'percent') return 'percentage';
  if (type === 'CURRENCY' || format === 'currency') return 'currency';
  if (INTEGER_TYPES.has(type)) return 'integer';
  return 'number';
}

export function formatAttributeDisplay(value: string | null | undefined, meta?: AttributeDisplay | null): string {
  if (value == null) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  const kind = attributeDisplayKind(meta);
  if (kind === 'date') return formatDateValue(raw);
  if (kind === 'boolean') return formatBooleanValue(raw);
  if (kind === 'currency' || kind === 'percentage' || kind === 'number' || kind === 'integer') {
    return formatNumericValue(raw, kind, meta);
  }
  return raw;
}

export type TableCellAlign = 'left' | 'right' | 'center';

/** Text stays left. Numbers and dates line up on the right. Yes/no values sit in the center. */
export function tableCellAlign(dataType?: string | null): TableCellAlign {
  const kind = attributeDisplayKind({ dataType });
  if (kind === 'boolean') return 'center';
  if (kind === 'date' || kind === 'currency' || kind === 'percentage' || kind === 'number' || kind === 'integer') return 'right';
  return 'left';
}

export function inputTypeFor(kind: DisplayKind): 'date' | 'number' | 'text' {
  if (kind === 'date') return 'date';
  if (kind === 'currency' || kind === 'percentage' || kind === 'number' || kind === 'integer') return 'number';
  return 'text';
}

export function inputStepFor(kind: DisplayKind): string | undefined {
  if (kind === 'integer') return '1';
  if (kind === 'currency' || kind === 'percentage' || kind === 'number') return 'any';
  return undefined;
}

/** Date controls require yyyy-mm-dd. Other controls keep the stored text. */
export function inputValueFor(kind: DisplayKind, value: string): string {
  if (kind !== 'date') return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : value;
}

function formatDateValue(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return value;
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = value.slice(10).match(/[T ](\d{2}:\d{2})/);
  return time && time[1] !== '00:00' ? `${label} ${time[1]}` : label;
}

function formatBooleanValue(value: string): string {
  const token = value.toLowerCase();
  if (token === 'true' || token === 'yes' || token === 'y' || token === '1') return 'Yes';
  if (token === 'false' || token === 'no' || token === 'n' || token === '0') return 'No';
  return value;
}

function formatNumericValue(value: string, kind: DisplayKind, meta?: AttributeDisplay | null): string {
  const parsed = Number(value.replace(/,/g, '').replace(/%$/, ''));
  if (!Number.isFinite(parsed)) return value;
  const precision = meta?.numericPrecision;
  const digits = precision == null || Number.isNaN(precision) ? null : Math.max(0, precision);

  if (kind === 'currency') {
    const code = (meta?.unitOfMeasure || '').trim().toUpperCase();
    const currency = /^[A-Z]{3}$/.test(code) ? code : 'USD';
    const places = digits ?? 2;
    return parsed.toLocaleString(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
  }

  if (kind === 'percentage') {
    const places = digits ?? 2;
    return `${parsed.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: places })}%`;
  }

  if (kind === 'integer') {
    return parsed.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  return parsed.toLocaleString(undefined, {
    minimumFractionDigits: digits ?? 0,
    maximumFractionDigits: digits ?? 6,
  });
}
