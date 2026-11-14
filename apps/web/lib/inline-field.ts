/** The value an inline editor should start from. Dates from the register arrive as Date objects. */
export function cellEditSeed(value: unknown): string {
  if (value == null || value === '' || value === '—') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value);
}

/** A blank golden value is stored as an em dash on the row. The editor starts empty. */
export function inlineDraft(value: string): string {
  if (!value || value === '—') return '';
  return value;
}

/** The text to write, or null when the edit is blank or unchanged. */
export function inlineCommitValue(draft: string, current: string, numeric: boolean): string | null {
  const normalize = (raw: string) => (numeric ? raw.replace(/,/g, '') : raw).trim();
  const next = normalize(draft);
  const previous = normalize(inlineDraft(current));
  if (!next || next === previous) return null;
  return next;
}
