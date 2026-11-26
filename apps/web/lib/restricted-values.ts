/** What a screen shows in place of a value the person is not cleared to see. */
export const RESTRICTED_TEXT = 'Restricted';

/**
 * Whether a column or field code names a hidden attribute. Related columns are
 * written as path.CODE (sec.INDUSTRY); the attribute is the last part.
 */
export function isHiddenAttribute(hidden: ReadonlySet<string>, code: string | null | undefined): boolean {
  if (!code || hidden.size === 0) return false;
  if (hidden.has(code)) return true;
  const last = code.split('.').pop();
  return Boolean(last && hidden.has(last));
}
