/** Projected gross and net returns on our allocated debt position. Amounts are dollars. Rates are decimals. */

import { projectSchedule, type ScheduleDraw } from '@/lib/servicing-schedule';

export interface PerformanceTranche {
  id: string;
  name: string;
  unfunded: boolean;
  /** Our par commitment. */
  hold: number;
  spread: number;
  draws: ScheduleDraw[];
}

export interface PerformanceFees {
  management: number;
  expenses: number;
  carry: number;
  hurdle: number;
}

export interface PerformanceInput {
  closeDate: string;
  asOfDate: string;
  /** Closed deals have actual months before the as-of date. */
  closed: boolean;
  /** Hold used as the projected life, in years. */
  holdYears: number;
  /** Purchase price as a fraction of par, such as 0.98. */
  oid: number;
  /** Exit mark as a fraction of par, such as 0.998. */
  mark: number;
  indexRate: number;
  undrawnFeeRate: number;
  pikRate: number;
  /** Quarterly principal, as a fraction of original funded par. */
  amortizationRate: number;
  seniorLeverage: number | null;
  totalLeverage: number | null;
  fees: PerformanceFees;
  tranches: PerformanceTranche[];
}

export interface TranchePerformance {
  id: string;
  name: string;
  position: number;
  coupon: number;
  leverageFrom: number | null;
  leverageTo: number | null;
  income: number;
  mark: number;
  profit: number;
  irr: number | null;
  moic: number | null;
  share: number;
  contribution: number | null;
}

export interface ProfitPoint {
  date: string;
  gross: number;
  net: number;
}

export interface SourceLine {
  label: string;
  amount: number;
  shareOfProfit: number | null;
  onInvested: number | null;
}

export interface BridgeLine {
  label: string;
  amount: number;
  shareOfGross: number | null;
  irr: number | null;
  moic: number | null;
  net?: boolean;
}

export interface PerformanceCase {
  endDate: string;
  invested: number;
  grossProfit: number;
  netProfit: number;
  grossIrr: number | null;
  netIrr: number | null;
  grossMoic: number | null;
  netMoic: number | null;
  dpi: number | null;
  rvpi: number | null;
  cashYield: number | null;
  allInYield: number | null;
  weightedCoupon: number | null;
  weightedSpread: number | null;
  pikShare: number | null;
  walYears: number | null;
  coverage: number | null;
  points: ProfitPoint[];
  tranches: TranchePerformance[];
  bridge: BridgeLine[];
  sources: SourceLine[];
}

interface TrancheRun {
  tranche: PerformanceTranche;
  coupon: number;
  cash: number[];
  dates: string[];
  incomeMonth: number[];
  fundingCost: number[];
  repayment: number[];
  interest: number;
  undrawn: number;
  pik: number;
  cashIncomeMonth: number[];
  fundedPar: number;
  endPar: number;
  principalTimes: Array<{ amount: number; years: number }>;
}

function annualIrr(cash: number[]): number | null {
  if (cash.length < 2 || !cash.some((value) => value > 0) || !cash.some((value) => value < 0)) return null;
  let rate = 0.008;
  for (let pass = 0; pass < 60; pass += 1) {
    let npv = 0;
    let slope = 0;
    for (let t = 0; t < cash.length; t += 1) {
      const den = (1 + rate) ** t;
      npv += cash[t] / den;
      if (t > 0) slope -= (t * cash[t]) / (1 + rate) ** (t + 1);
    }
    if (!Number.isFinite(npv) || Math.abs(slope) < 1e-12) break;
    const next = rate - npv / slope;
    if (!Number.isFinite(next) || next <= -0.95) return null;
    if (Math.abs(next - rate) < 1e-9) return (1 + next) ** 12 - 1;
    rate = next;
  }
  return (1 + rate) ** 12 - 1;
}

function add(left: number[], right: number[]): number[] {
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, index) => (left[index] || 0) + (right[index] || 0));
}

function runTranche(input: PerformanceInput, tranche: PerformanceTranche, months: number): TrancheRun {
  const schedule = projectSchedule({
    closeDate: input.closeDate,
    asOfDate: input.asOfDate,
    funded: input.closed,
    indexRate: input.indexRate,
    spread: tranche.spread,
    undrawnFeeRate: tranche.unfunded ? input.undrawnFeeRate : 0,
    pikRate: input.pikRate,
    amortizationRate: input.amortizationRate,
    initialFunded: tranche.unfunded ? 0 : tranche.hold,
    initialUnfunded: tranche.unfunded ? tranche.hold : 0,
    amortizeDraws: tranche.unfunded,
    draws: tranche.draws,
    months,
  });
  const cash: number[] = [];
  const dates: string[] = [];
  const incomeMonth: number[] = [];
  const cashIncomeMonth: number[] = [];
  const fundingCost: number[] = [];
  const repayment: number[] = [];
  const principalTimes: Array<{ amount: number; years: number }> = [];
  let interest = 0;
  let undrawn = 0;
  let pik = 0;
  let fundedPar = 0;
  schedule.months.forEach((month, index) => {
    const cost = index === 0 ? month.drawdown * input.oid : month.drawdown;
    cash.push(-cost + month.paidCash + month.repayment);
    dates.push(month.date);
    incomeMonth.push(month.cashInterest + month.undrawnFee + month.pikInterest);
    cashIncomeMonth.push(month.cashInterest + month.undrawnFee);
    fundingCost.push(cost);
    repayment.push(month.repayment);
    interest += month.cashInterest;
    undrawn += month.undrawnFee;
    pik += month.pikInterest;
    if (index === 0) fundedPar += month.drawdown;
    if (month.repayment > 0) principalTimes.push({ amount: month.repayment, years: index / 12 });
  });
  const end = schedule.months[schedule.months.length - 1];
  const endPar = end?.closing || 0;
  if (end && endPar > 0) {
    cash[cash.length - 1] += endPar * input.mark;
    principalTimes.push({ amount: endPar, years: (schedule.months.length - 1) / 12 });
  }
  return {
    tranche,
    coupon: input.indexRate + tranche.spread,
    cash,
    dates,
    incomeMonth,
    fundingCost,
    repayment,
    interest,
    undrawn,
    pik,
    cashIncomeMonth,
    fundedPar,
    endPar,
    principalTimes,
  };
}

export function projectPerformance(input: PerformanceInput): PerformanceCase | null {
  const live = input.tranches.filter((tranche) => tranche.hold > 1);
  if (!input.closeDate || live.length === 0) return null;
  const months = Math.max(1, Math.round((input.holdYears > 0 ? input.holdYears : 3) * 12)) + 1;
  const runs = live.map((tranche) => runTranche(input, tranche, months));
  const dates = runs[0]?.dates || [];
  const cash = runs.reduce((sum, run) => add(sum, run.cash), [] as number[]);
  const incomeMonth = runs.reduce((sum, run) => add(sum, run.incomeMonth), [] as number[]);
  const fundingCost = runs.reduce((sum, run) => add(sum, run.fundingCost), [] as number[]);
  const repayment = runs.reduce((sum, run) => add(sum, run.repayment), [] as number[]);
  const interest = runs.reduce((sum, run) => sum + run.interest, 0);
  const undrawn = runs.reduce((sum, run) => sum + run.undrawn, 0);
  const pik = runs.reduce((sum, run) => sum + run.pik, 0);
  const fundedPar = runs.reduce((sum, run) => sum + run.fundedPar, 0);
  const oidIncome = fundedPar * (1 - input.oid);
  const grossProfit = cash.reduce((sum, value) => sum + value, 0);
  const markIncome = grossProfit - (interest + undrawn + pik) - oidIncome;
  const invested = fundingCost.reduce((sum, value) => sum + value, 0);
  const exit = runs.reduce((sum, run) => sum + run.endPar * input.mark, 0);
  const distributed = cash.reduce((sum, value) => sum + Math.max(value, 0), 0) - exit;

  let cost = 0;
  let hurdleAccrued = 0;
  let feeTotal = 0;
  let expenseTotal = 0;
  const feeRate = input.fees.management + input.fees.expenses;
  const points: ProfitPoint[] = [];
  let grossRunning = 0;
  let feesRunning = 0;
  let carryRunning = 0;
  const oidStep = dates.length > 1 ? oidIncome / (dates.length - 1) : oidIncome;
  dates.forEach((date, index) => {
    cost += fundingCost[index] || 0;
    const fee = index === 0 ? 0 : cost * feeRate / 12;
    const expense = feeRate > 0 ? fee * (input.fees.expenses / feeRate) : 0;
    feeTotal += fee - expense;
    expenseTotal += expense;
    feesRunning += fee;
    hurdleAccrued += index === 0 ? 0 : cost * input.fees.hurdle / 12;
    grossRunning += (incomeMonth[index] || 0) + (index === 0 ? 0 : oidStep) + (index === dates.length - 1 ? markIncome : 0);
    const carryNow = input.fees.carry * Math.max(0, grossRunning - hurdleAccrued);
    carryRunning = carryNow;
    cost = Math.max(0, cost - (repayment[index] || 0));
    points.push({ date, gross: grossRunning, net: grossRunning - feesRunning - carryRunning });
  });
  if (points.length > 0) points[points.length - 1].gross = grossProfit;

  const carry = input.fees.carry * Math.max(0, grossProfit - hurdleAccrued);
  let openCost = 0;
  const netFlows = cash.map((value, index) => {
    openCost += fundingCost[index] || 0;
    const fee = index === 0 ? 0 : openCost * feeRate / 12;
    openCost = Math.max(0, openCost - (repayment[index] || 0));
    return value - fee - (index === cash.length - 1 ? carry : 0);
  });
  const netProfit = grossProfit - feeTotal - expenseTotal - carry;
  if (points.length > 0) points[points.length - 1].net = netProfit;

  const position = live.reduce((sum, tranche) => sum + tranche.hold, 0);
  const weightedCoupon = position ? live.reduce((sum, tranche, index) => sum + tranche.hold * runs[index].coupon, 0) / position : null;
  const weightedSpread = position ? live.reduce((sum, tranche) => sum + tranche.hold * tranche.spread, 0) / position : null;
  const income = interest + undrawn + pik;
  const senior = input.seniorLeverage;
  const total = input.totalLeverage;
  const trancheRows: TranchePerformance[] = runs.map((run) => {
    const profit = run.cash.reduce((sum, value) => sum + value, 0);
    const rowIncome = run.interest + run.undrawn + run.pik + run.fundedPar * (1 - input.oid);
    const rowMark = profit - rowIncome;
    const rowInvested = run.fundingCost.reduce((sum, value) => sum + value, 0);
    const from = run.tranche.unfunded ? senior : 0;
    const to = run.tranche.unfunded ? total : (senior ?? total);
    return {
      id: run.tranche.id,
      name: run.tranche.name,
      position: run.tranche.hold,
      coupon: run.coupon,
      leverageFrom: from,
      leverageTo: to,
      income: rowIncome,
      mark: rowMark,
      profit,
      irr: annualIrr(run.cash),
      moic: rowInvested > 0 ? (rowInvested + profit) / rowInvested : null,
      share: grossProfit ? profit / grossProfit : 0,
      contribution: null,
    };
  });
  const grossIrr = annualIrr(cash);
  const netIrr = annualIrr(netFlows);
  trancheRows.forEach((row) => {
    row.contribution = grossIrr == null ? null : row.share * grossIrr;
  });

  const principal = runs.flatMap((run) => run.principalTimes);
  const principalTotal = principal.reduce((sum, item) => sum + item.amount, 0);
  const walYears = principalTotal ? principal.reduce((sum, item) => sum + item.amount * item.years, 0) / principalTotal : null;

  const quarter = [1, 2, 3].filter((index) => index < dates.length);
  let quarterIncome = 0;
  let quarterPar = 0;
  quarter.forEach((index) => {
    runs.forEach((run) => { quarterIncome += run.cashIncomeMonth[index] || 0; });
  });
  let par = 0;
  const parAt: number[] = [];
  dates.forEach((_, index) => {
    const drawn = runs.reduce((sum, run) => sum + (index === 0 ? run.fundedPar : (run.fundingCost[index] || 0)), 0);
    par += index === 0 ? fundedPar : drawn;
    par -= repayment[index] || 0;
    parAt.push(par);
  });
  quarter.forEach((index) => { quarterPar += parAt[index - 1] || parAt[index] || 0; });
  const cashYield = quarter.length && quarterPar ? (quarterIncome * 12) / quarterPar : null;
  const years = Math.max((months - 1) / 12, 1 / 12);
  const allInYield = weightedCoupon == null ? null : weightedCoupon + (position ? oidIncome / position / years : 0);

  const coverage = senior && weightedCoupon ? 1 / (senior * weightedCoupon) : (total && weightedCoupon ? 1 / (total * weightedCoupon) : null);
  const grossMoic = invested > 0 ? (invested + grossProfit) / invested : null;
  const netMoic = invested > 0 ? (invested + netProfit) / invested : null;
  const dpi = invested > 0 ? distributed / invested : null;
  const rvpi = invested > 0 ? exit / invested : null;
  const share = (amount: number) => (grossProfit ? amount / grossProfit : null);
  const onInvested = (amount: number) => (invested ? amount / invested : null);

  return {
    endDate: dates[dates.length - 1] || input.closeDate,
    invested,
    grossProfit,
    netProfit,
    grossIrr,
    netIrr,
    grossMoic,
    netMoic,
    dpi,
    rvpi,
    cashYield,
    allInYield,
    weightedCoupon,
    weightedSpread,
    pikShare: income + oidIncome > 0 ? pik / (income + oidIncome) : null,
    walYears,
    coverage,
    points,
    tranches: trancheRows,
    bridge: [
      { label: 'Gross profit', amount: grossProfit, shareOfGross: 1, irr: grossIrr, moic: grossMoic },
      { label: 'Management fee', amount: -feeTotal, shareOfGross: share(-feeTotal), irr: null, moic: null },
      { label: 'Fund expenses', amount: -expenseTotal, shareOfGross: share(-expenseTotal), irr: null, moic: null },
      { label: 'Incentive fee', amount: -carry, shareOfGross: share(-carry), irr: null, moic: null },
      { label: 'Net profit to investors', amount: netProfit, shareOfGross: share(netProfit), irr: netIrr, moic: netMoic, net: true },
    ],
    sources: [
      { label: 'Cash interest and undrawn fees', amount: interest + undrawn, shareOfProfit: share(interest + undrawn), onInvested: onInvested(interest + undrawn) },
      { label: 'PIK interest', amount: pik, shareOfProfit: share(pik), onInvested: onInvested(pik) },
      { label: 'OID and upfront fees', amount: oidIncome, shareOfProfit: share(oidIncome), onInvested: onInvested(oidIncome) },
      { label: 'Mark-to-market and equity kicker', amount: markIncome, shareOfProfit: share(markIncome), onInvested: onInvested(markIncome) },
      { label: 'Total gross profit', amount: grossProfit, shareOfProfit: 1, onInvested: onInvested(grossProfit) },
    ],
  };
}
