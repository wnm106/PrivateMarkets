/** A session limit as typed in the sign-in rules form: blank means no limit, anything else not a number is NaN. */
export function limitMinutes(text: string, unitMinutes: number): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * unitMinutes) : Number.NaN;
}
