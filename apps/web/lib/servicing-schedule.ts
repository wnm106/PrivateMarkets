/** Project a facility's servicing schedule from stored terms. Amounts are dollars. */

export interface ScheduleDraw {
  date: string;
  amount: number;
  trancheId: string;
}

export interface ScheduleInput {
  closeDate: string;
  asOfDate: string;
  /** Closed deals have actuals through the month before the as-of date. */
  funded: boolean;
  indexRate: number;
  spread: number;
  undrawnFeeRate: number;
  pikRate: number;
  /** Quarterly principal, as a fraction of the original funded amount. */
  amortizationRate: number;
  /** Term-loan (or other funded) principal at close. */
  initialFunded: number;
  /** Delayed-draw commitment at close. */
  initialUnfunded: number;
  /** When the view is only the delayed draw, amortization follows the draws. */
  amortizeDraws: boolean;
  draws: ScheduleDraw[];
  months?: number;
}

export interface ScheduleMonth {
  key: string;
  label: string;
  date: string;
  actual: boolean;
  forecastStart: boolean;
  payment: boolean;
  commitment: number;
  opening: number | null;
  undrawn: number;
  drawdown: number;
  repayment: number;
  indexRate: number;
  spread: number;
  coupon: number;
  cashInterest: number;
  undrawnFee: number;
  accruedCash: number | null;
  paidCash: number;
  pikRate: number;
  pikInterest: number;
  accruedPik: number | null;
  capitalisedPik: number;
  pikPayment: number;
  closing: number;
  cashFlow: number;
  cumulative: number;
}

export interface SchedulePayment {
  date: string;
  interest: number;
  fees: number;
  amortization: number;
  total: number;
  pik: number;
  projected: boolean;
}

export interface Schedule {
  months: ScheduleMonth[];
  payments: SchedulePayment[];
}

function parts(iso: string): [number, number, number] {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return [year || 1970, month || 1, day || 1];
}

export function addMonths(iso: string, count: number): string {
  const [year, month, day] = parts(iso);
  const cursor = new Date(Date.UTC(year, month - 1 + count, 1));
  const dim = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, dim);
  const y = cursor.getUTCFullYear();
  const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nextDay).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function monthLabel(iso: string): string {
  const [year, month] = parts(iso);
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${name} ${String(year).slice(2)}`;
}

/** Our dollars of a facility principal amount. Hold percent wins. Otherwise use the funded amount over the tranche size. */
export function heldShare(facility: number, holdPct: number, size: number, heldAmount: number): number {
  if (holdPct > 0) return facility * holdPct / 100;
  if (size > 0 && heldAmount > 0) return facility * (heldAmount / size);
  return facility;
}

export function spreadFromPricing(pricing?: string | null): number {
  const sofr = pricing?.match(/SOFR\s*\+\s*(\d+(?:\.\d+)?)/i);
  if (sofr) return Number(sofr[1]) / 10000;
  const percent = pricing?.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return Number(percent[1]) / 100;
  return 0;
}

export function projectSchedule(input: ScheduleInput): Schedule {
  const count = input.months ?? 25;
  const commitment = input.initialFunded + input.initialUnfunded;
  const coupon = input.indexRate + input.spread;
  let balance = 0;
  let drawn = 0;
  let amortBase = input.initialFunded;
  let accruedCash = 0;
  let accruedPik = 0;
  let quarterInterest = 0;
  let quarterFees = 0;
  let cumulative = 0;
  let seenActual = false;
  let seenForecast = false;
  const months: ScheduleMonth[] = [];
  const payments: SchedulePayment[] = [];
  const asOfKey = monthKey(input.asOfDate);

  for (let index = 0; index < count; index += 1) {
    const date = addMonths(input.closeDate, index);
    const key = monthKey(date);
    const opening = index === 0 ? null : balance;
    const drawdown = (index === 0 ? input.initialFunded : 0)
      + input.draws.filter((draw) => monthKey(draw.date) === key).reduce((sum, draw) => sum + draw.amount, 0);
    drawn += drawdown - (index === 0 ? input.initialFunded : 0);
    if (input.amortizeDraws) amortBase = input.initialFunded + drawn;
    const payment = index > 0 && index % 3 === 0;
    const repayment = payment ? Math.min((opening ?? 0) + drawdown, amortBase * input.amortizationRate) : 0;
    const undrawn = Math.max(0, input.initialUnfunded - drawn);
    const cashInterest = index === 0 ? 0 : (opening ?? 0) * coupon / 12;
    const undrawnFee = index === 0 ? 0 : undrawn * input.undrawnFeeRate / 12;
    const pikInterest = index === 0 ? 0 : (opening ?? 0) * input.pikRate / 12;
    accruedCash += cashInterest + undrawnFee;
    accruedPik += pikInterest;
    quarterInterest += cashInterest;
    quarterFees += undrawnFee;
    const paidCash = payment ? accruedCash : 0;
    const capitalisedPik = payment ? accruedPik : 0;
    const pikPayment = 0;
    if (payment) {
      payments.push({
        date,
        interest: quarterInterest,
        fees: quarterFees,
        amortization: repayment,
        total: quarterInterest + quarterFees + repayment,
        pik: capitalisedPik,
        projected: !(input.funded && key < asOfKey),
      });
      accruedCash = 0;
      accruedPik = 0;
      quarterInterest = 0;
      quarterFees = 0;
    }
    balance = (opening ?? 0) + drawdown - repayment + capitalisedPik;
    const cashFlow = -drawdown + paidCash + repayment + pikPayment;
    cumulative += cashFlow;
    const actual = input.funded && key < asOfKey;
    const forecastStart = !actual && seenActual && !seenForecast;
    if (actual) seenActual = true;
    if (!actual) seenForecast = true;
    months.push({
      key,
      label: monthLabel(date),
      date,
      actual,
      forecastStart,
      payment,
      commitment,
      opening,
      undrawn,
      drawdown,
      repayment,
      indexRate: input.indexRate,
      spread: input.spread,
      coupon,
      cashInterest,
      undrawnFee,
      accruedCash: payment || accruedCash === 0 ? null : accruedCash,
      paidCash,
      pikRate: input.pikRate,
      pikInterest,
      accruedPik: payment || accruedPik === 0 ? null : accruedPik,
      capitalisedPik,
      pikPayment,
      closing: balance,
      cashFlow,
      cumulative,
    });
  }

  return { months, payments };
}
