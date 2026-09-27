import { format, parseISO, isValid } from 'date-fns';

export function formatDate(date: string | Date, formatStr: string = 'yyyy-MM-dd'): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  if (!isValid(d)) return '';
  return format(d, formatStr);
}

export function formatDateTime(date: string | Date, formatStr: string = 'yyyy-MM-dd HH:mm:ss'): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  if (!isValid(d)) return '';
  return format(d, formatStr);
}

export function formatCurrency(value: number | null | undefined, currency: string = 'USD'): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined) return '';
  return `${(value * 100).toFixed(decimals)}%`;
}

export function getToday(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function isDateInRange(date: string, startDate: string, endDate: string): boolean {
  const d = parseISO(date);
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  return d >= start && d <= end;
}

export function addDays(date: string | Date, days: number): Date {
  const d = typeof date === 'string' ? parseISO(date) : date;
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

export function subtractDays(date: string | Date, days: number): Date {
  return addDays(date, -days);
}
