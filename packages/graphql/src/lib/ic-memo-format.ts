/** Pure wording for the investment-committee memo. Amounts are dollars. */

export interface MemoTrancheFace {
  instrumentType: string;
  equityLinked?: boolean | null;
  unfunded?: boolean | null;
  label?: string | null;
}

const FULL_NAME: Record<string, string> = {
  LOAN: 'Term Loan',
  DELAYED_DRAW_TERM_LOAN: 'Delayed Draw Term Loan',
  REVOLVING_CREDIT: 'Revolving Credit Facility',
  SECOND_LIEN_LOAN: 'Second Lien Term Loan',
  MEZZANINE: 'Mezzanine Notes',
  WARRANT: 'Warrant',
  PREFERRED_EQUITY: 'Preferred Equity',
};

const SHORT_NAME: Record<string, string> = {
  LOAN: 'Term Loan',
  DELAYED_DRAW_TERM_LOAN: 'DDTL',
  REVOLVING_CREDIT: 'Revolver',
  SECOND_LIEN_LOAN: '2L Term Loan',
  MEZZANINE: 'Mezz Notes',
  WARRANT: 'Warrant',
  PREFERRED_EQUITY: 'Preferred',
};

export function trancheFullName(instrumentType: string, fallback?: string | null): string {
  return FULL_NAME[instrumentType] || fallback || 'Tranche';
}

export function trancheShortName(instrumentType: string, fallback?: string | null): string {
  return SHORT_NAME[instrumentType] || fallback || 'Tranche';
}

export function seniorityLabel(tranche: MemoTrancheFace, explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (tranche.equityLinked) return 'Equity-linked';
  if (tranche.instrumentType === 'SECOND_LIEN_LOAN') return '2nd lien';
  if (tranche.instrumentType === 'MEZZANINE') return 'Subordinated';
  if (tranche.instrumentType === 'PREFERRED_EQUITY' || tranche.instrumentType === 'WARRANT') return 'Equity-linked';
  return '1st lien senior secured';
}

/** A financing made of first-lien term debt plus a delayed draw is a unitranche with delayed draw. */
export function structurePhrase(tranches: MemoTrancheFace[]): string {
  const types = new Set(tranches.map((tranche) => tranche.instrumentType));
  const senior = [...types].every((type) => type === 'LOAN' || type === 'DELAYED_DRAW_TERM_LOAN' || type === 'REVOLVING_CREDIT');
  if (senior && types.has('LOAN') && types.has('DELAYED_DRAW_TERM_LOAN')) return 'unitranche with delayed draw';
  if (senior && types.has('LOAN') && types.has('REVOLVING_CREDIT')) return 'unitranche with revolver';
  if (senior && types.has('LOAN')) return 'senior term loan';
  if (types.size === 1) return trancheFullName([...types][0]).toLowerCase();
  return 'financing';
}

export function moneyMillions(amount: number, digits = 1): string {
  const millions = amount / 1_000_000;
  return `$${millions.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}M`;
}

/**
 * Gross yield from a pricing line and a base-rate assumption, in percent.
 * "SOFR + 500" with a 4.30% base is 9.30. A cash coupon such as "11.0%" is used as written.
 */
export function couponYield(pricing: string | null | undefined, baseRate: number | null | undefined): number | null {
  if (!pricing) return null;
  const sofr = pricing.match(/SOFR\s*\+\s*(\d+(?:\.\d+)?)/i);
  if (sofr && baseRate != null && Number.isFinite(baseRate)) {
    const spread = Number(sofr[1]);
    const points = spread >= 20 ? spread / 100 : spread;
    return Math.round((baseRate + points) * 10) / 10;
  }
  const cash = pricing.match(/(\d+(?:\.\d+)?)\s*%/);
  if (cash) return Number(cash[1]);
  return null;
}

export function recommendationText(input: {
  dealName: string;
  facilitySize: number;
  targetHold: number;
  unallocated: number;
  fundCount: number;
  tranches: MemoTrancheFace[];
}): string {
  const name = input.dealName || 'this deal';
  const structure = structurePhrase(input.tranches);
  const funds = input.fundCount === 1 ? '1 fund' : `${input.fundCount} funds`;
  const placed = input.unallocated <= Math.max(1_000, input.targetHold * 0.005);
  const closing = placed
    ? "The full hold is placed within each fund's mandate and limits."
    : `${moneyMillions(input.unallocated)} of the hold is still unplaced after mandate, concentration, and liquidity limits.`;
  const across = input.fundCount > 0 ? `, allocated across ${funds}` : '';
  return `The deal team recommends that the committee approve a commitment of ${moneyMillions(input.targetHold)} to ${name}, a ${moneyMillions(input.facilitySize)} ${structure}${across}. ${closing}`;
}

export function unfundedFootnote(tranches: MemoTrancheFace[]): string {
  const names = tranches.filter((tranche) => tranche.unfunded).map((tranche) => trancheShortName(tranche.instrumentType, tranche.label));
  if (!names.length) return '';
  const label = [...new Set(names)].join(', ');
  return `Unfunded tranches (${label}) are excluded from sources and are available for acquisitions and working capital.`;
}
