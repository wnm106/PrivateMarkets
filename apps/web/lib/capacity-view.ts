/**
 * Where a fund stands on a compliance rule, read from the capacity the
 * allocation preview already loads: the current figure, the room left for
 * this deal, and the figure once this allocation is in. No positions are
 * written and no rule is run.
 */

export interface CapacityReading {
  fundId: string;
  ruleCode: string;
  ruleName: string;
  groupValue?: string | null;
  /** What a group of the rule is called (Issuer, Sector), from the rule itself. */
  groupLabel?: string | null;
  /** MAX: stay at or below the limit. MIN: stay at or above it. Missing is MAX. */
  limitDirection?: string | null;
  trancheIds: string[];
  room: number;
  numerator?: number | null;
  denominator?: number | null;
  hardLimit?: number | null;
  softLimit?: number | null;
  resultUnit?: string | null;
  denominatorGrows: boolean;
}

export type CapacityTone = 'ok' | 'near' | 'breach' | 'na' | 'blocked';

export interface CapacityStanding {
  reading: CapacityReading;
  /** The fund that holds the reading, when it is not the fund asked about (a sleeve of a portfolio). */
  ownerId: string | null;
  /** The figure on the booked book, in the rule's unit. Null when the rule reports only room. */
  current: number | null;
  /** The figure with this allocation in. */
  proForma: number | null;
  /** What this allocation places in the tranches the rule counts. */
  used: number;
  /** used over room. Above 1 when the allocation takes more than the room. */
  roomUsed: number | null;
  /** proForma over the hard limit, the gauge's fill. */
  utilisation: number | null;
  tone: CapacityTone;
  label: string;
  currentTone: CapacityTone;
  currentLabel: string;
}

function scale(unit?: string | null): number {
  return unit === 'PERCENTAGE' ? 100 : 1;
}

function isShare(unit?: string | null): boolean {
  return unit === 'PERCENTAGE' || unit === 'RATIO';
}

/** The figure the rule reports for a numerator and denominator. */
export function figure(reading: CapacityReading, added: number): number | null {
  if (reading.numerator == null) return null;
  const numerator = reading.numerator + added;
  if (!isShare(reading.resultUnit)) return numerator;
  if (reading.denominator == null) return null;
  const denominator = reading.denominator + (reading.denominatorGrows ? added : 0);
  if (denominator <= 0) return null;
  return (numerator / denominator) * scale(reading.resultUnit);
}

/** A limit of 0: the fund may not hold this at all. */
export function isProhibition(reading: CapacityReading): boolean {
  return reading.hardLimit === 0;
}

export function standingTone(value: number | null, reading: CapacityReading): { tone: CapacityTone; label: string } {
  if (isProhibition(reading)) {
    return value != null && value > 1e-6 ? { tone: 'breach', label: 'Not permitted, held' } : { tone: 'blocked', label: 'Not permitted' };
  }
  if (value == null || reading.hardLimit == null) return { tone: 'na', label: 'Not measured' };
  if (reading.limitDirection === 'MIN') {
    // A floor: the figure must stay at or above the limit.
    if (value < reading.hardLimit * 0.9995) return { tone: 'breach', label: 'Below limit' };
    if (value <= reading.hardLimit * 1.005) return { tone: 'breach', label: 'At limit' };
    if (reading.softLimit != null && reading.softLimit > reading.hardLimit && value < reading.softLimit) {
      return { tone: 'near', label: 'Below soft limit' };
    }
    if (value <= reading.hardLimit / 0.85) return { tone: 'near', label: 'Near limit' };
    return { tone: 'ok', label: 'Within limit' };
  }
  const ratio = value / reading.hardLimit;
  if (ratio > 1.0005) return { tone: 'breach', label: 'Over limit' };
  if (ratio >= 0.995) return { tone: 'breach', label: 'At limit' };
  if (reading.softLimit != null && reading.softLimit < reading.hardLimit && value > reading.softLimit) {
    return { tone: 'near', label: 'Over soft limit' };
  }
  if (ratio >= 0.85) return { tone: 'near', label: 'Near limit' };
  return { tone: 'ok', label: 'Within limit' };
}

export function standing(reading: CapacityReading, used: number, ownerId: string | null = null): CapacityStanding {
  const current = figure(reading, 0);
  const proForma = figure(reading, used);
  const roomUsed = reading.room > 0 ? used / reading.room : used > 0 ? Number.POSITIVE_INFINITY : 0;
  const now = standingTone(current, reading);
  let after = standingTone(proForma, reading);
  // A rule that reports only room (a composite ratio) is read from the room.
  if (proForma == null && !isProhibition(reading)) {
    if (reading.room <= 0) after = { tone: 'breach', label: 'No room' };
    else if (roomUsed > 1.0005) after = { tone: 'breach', label: 'Over limit' };
    else if (roomUsed >= 0.995) after = { tone: 'breach', label: 'At limit' };
    else if (roomUsed >= 0.85) after = { tone: 'near', label: 'Near limit' };
    else after = { tone: 'ok', label: 'Within limit' };
  }
  const utilisation = isProhibition(reading)
    ? 1
    : proForma != null && reading.hardLimit
      ? (reading.limitDirection === 'MIN' ? (proForma > 0 ? reading.hardLimit / proForma : 1) : proForma / reading.hardLimit)
      : Number.isFinite(roomUsed) ? roomUsed : 1;
  return {
    reading,
    ownerId,
    current,
    proForma,
    used,
    roomUsed: Number.isFinite(roomUsed) ? roomUsed : null,
    utilisation,
    tone: after.tone,
    label: after.label,
    currentTone: now.tone,
    currentLabel: now.label,
  };
}

interface FundAmounts {
  fundId: string;
  parentFundId?: string | null;
  cells: Array<{ trancheId: string; amount: number }>;
}

function usedBy(fund: FundAmounts | undefined, trancheIds: string[]): number {
  if (!fund) return 0;
  return fund.cells.filter((cell) => trancheIds.includes(cell.trancheId)).reduce((total, cell) => total + (cell.amount || 0), 0);
}

const TONE_RANK: Record<CapacityTone, number> = { breach: 0, blocked: 1, near: 2, ok: 3, na: 4 };

/**
 * The fund's own readings, then its sleeves' readings for rules the fund has
 * none of, as the deal surface shows a limit set only on a sleeve. The
 * tightest come first.
 */
export function standingsForFund(
  fundId: string,
  readings: CapacityReading[],
  funds: FundAmounts[],
): CapacityStanding[] {
  const byId = new Map(funds.map((fund) => [fund.fundId, fund]));
  const own = readings.filter((reading) => reading.fundId === fundId);
  const covered = new Set(own.map((reading) => reading.ruleCode));
  const sleeves = new Set(funds.filter((fund) => fund.parentFundId === fundId && fund.fundId !== fundId).map((fund) => fund.fundId));
  const extra = readings.filter((reading) => sleeves.has(reading.fundId) && !covered.has(reading.ruleCode));
  return [
    ...own.map((reading) => standing(reading, usedBy(byId.get(fundId), reading.trancheIds))),
    ...extra.map((reading) => standing(reading, usedBy(byId.get(reading.fundId), reading.trancheIds), reading.fundId)),
  ].sort((left, right) => (
    TONE_RANK[left.tone] - TONE_RANK[right.tone]
    || (right.utilisation ?? 0) - (left.utilisation ?? 0)
  ));
}
