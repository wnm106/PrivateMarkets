export const STALE_AFTER_DAYS = 30;

export function receiptAgeDays(receivedAt: string | null | undefined, now = Date.now()): number | null {
  if (!receivedAt) return null;
  const time = new Date(receivedAt).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / 86400000));
}

export function isStaleReceipt(receivedAt: string | null | undefined, sourceCode?: string | null): boolean {
  const code = (sourceCode || '').toUpperCase();
  if (code === 'DERIVED' || code === 'CALCULATED') return false;
  const age = receiptAgeDays(receivedAt);
  return age != null && age > STALE_AFTER_DAYS;
}

export function formatReceipt(receivedAt: string): string {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return receivedAt;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
