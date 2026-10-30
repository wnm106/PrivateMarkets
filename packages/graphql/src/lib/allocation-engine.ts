/**
 * Progressive-fill allocation.
 *
 * Each tranche hold is shared across eligible portfolios in proportion to
 * available capital. A portfolio that would exceed a cap is scaled back and
 * the remainder is shared again. Sleeve amounts are filled inside the
 * portfolio total. Manual overrides lock a cell. Exclusions remove a fund
 * and the amount moves to whoever is still eligible.
 *
 * Money is in one unit throughout. Two-decimal rounding uses largest
 * remainder so sleeve amounts add up to the portfolio amount.
 */

export interface AllocationTranche {
  id: string;
  name: string;
  size: number;
  /** 0 to 100. */
  holdPct: number;
  unfunded: boolean;
  instrumentType: string;
}

export interface AllocationSleeve {
  id: string;
  name: string;
  nav: number;
  cash: number;
  undrawn: number;
  line: number;
  reserve: number;
  allowed: string[];
  denyNote: string;
}

export interface AllocationPortfolio {
  id: string;
  name: string;
  nav: number;
  /** Fractions of NAV. 0.05 is a five percent limit. */
  issuerLimit: number;
  sponsorLimit: number;
  unfundedLimit: number;
  sponsorExposure: number;
  unfundedExposure: number;
  allowed: string[];
  denyNote: string;
  sleeves: AllocationSleeve[];
}

export type AdjustmentType = 'override' | 'exclude';

export interface AllocationAdjustment {
  fundId: string;
  /** Tranche id, or '*' for every tranche of the fund. */
  trancheId: string;
  type: AdjustmentType;
  amount?: number;
  reason?: string;
  note?: string;
}

export interface AllocationRequest {
  tranches: AllocationTranche[];
  portfolios: AllocationPortfolio[];
  adjustments?: AllocationAdjustment[];
}

export interface AllocationCellResult {
  trancheId: string;
  eligible: boolean;
  amount: number;
  systemAmount: number;
  capReason: string | null;
  exclusionKind: string | null;
  exclusionCode: string | null;
  exclusionText: string | null;
  overridden: boolean;
  reasonCode: string | null;
}

export interface AllocationRowResult {
  fundId: string;
  fundName: string;
  parentFundId: string | null;
  level: 'PORTFOLIO' | 'SLEEVE';
  availableCapital: number;
  nav: number;
  total: number;
  cells: AllocationCellResult[];
}

export interface AllocationTrancheResult {
  id: string;
  name: string;
  size: number;
  holdPct: number;
  unfunded: boolean;
  instrumentType: string;
  targetAmount: number;
  allocated: number;
}

export interface AllocationResult {
  facilitySize: number;
  targetHold: number;
  allocated: number;
  unallocated: number;
  tranches: AllocationTrancheResult[];
  rows: AllocationRowResult[];
}

const REASON_LABELS: Record<string, string> = {
  LIQ: 'Liquidity or reserve constraint',
  CONC: 'Concentration or exposure limit',
  MAND: 'Mandate or guideline restriction',
  TAX: 'Tax or regulatory',
  CONF: 'Conflict of interest or affiliate',
  PORT: 'Portfolio construction or diversification',
  IC: 'Investment committee directive',
  CLNT: 'Client instruction',
  OTH: 'Other (note required)',
};

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function reasonLabel(code: string | undefined): string {
  if (!code) return '';
  return REASON_LABELS[code] || code;
}

function sleeveAvailable(sleeve: AllocationSleeve): number {
  return sleeve.cash + sleeve.undrawn + sleeve.line - sleeve.reserve;
}

function portfolioAvailable(portfolio: AllocationPortfolio): number {
  return sum(portfolio.sleeves.map(sleeveAvailable));
}

interface FillInput {
  targets: number[];
  weight: number[];
  capTotal: number[];
  capPerTranche: number[][];
  eligible: boolean[][];
}

interface FillResult {
  alloc: number[][];
  left: number[];
  flagTotal: boolean[];
  flagPerTranche: boolean[][];
}

function fill(input: FillInput): FillResult {
  const count = input.weight.length;
  const trancheCount = input.targets.length;
  const alloc = input.weight.map(() => Array(trancheCount).fill(0));
  const remainingTarget = input.targets.slice();
  const remainingCap = input.capTotal.slice();
  const remainingPerTranche = input.capPerTranche.map((row) => row.slice());
  const flagTotal = Array(count).fill(false);
  const flagPerTranche = input.weight.map(() => Array(trancheCount).fill(false));

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const tentative = input.weight.map(() => Array(trancheCount).fill(0));
    for (let tranche = 0; tranche < trancheCount; tranche += 1) {
      if (remainingTarget[tranche] < 1e-7) continue;
      const participants: number[] = [];
      let weight = 0;
      for (let index = 0; index < count; index += 1) {
        if (
          input.eligible[index][tranche]
          && remainingCap[index] > 1e-7
          && remainingPerTranche[index][tranche] > 1e-7
          && input.weight[index] > 0
        ) {
          participants.push(index);
          weight += input.weight[index];
        }
      }
      if (!participants.length) continue;
      for (const index of participants) {
        let amount = remainingTarget[tranche] * input.weight[index] / weight;
        if (amount > remainingPerTranche[index][tranche]) {
          amount = remainingPerTranche[index][tranche];
          flagPerTranche[index][tranche] = true;
        }
        tentative[index][tranche] = amount;
      }
    }
    for (let index = 0; index < count; index += 1) {
      const taken = sum(tentative[index]);
      if (taken > remainingCap[index] + 1e-9) {
        const scale = remainingCap[index] / taken;
        for (let tranche = 0; tranche < trancheCount; tranche += 1) tentative[index][tranche] *= scale;
        flagTotal[index] = true;
      }
    }
    let moved = false;
    for (let index = 0; index < count; index += 1) {
      for (let tranche = 0; tranche < trancheCount; tranche += 1) {
        const amount = tentative[index][tranche];
        if (amount > 1e-9) {
          alloc[index][tranche] += amount;
          remainingTarget[tranche] -= amount;
          remainingCap[index] -= amount;
          remainingPerTranche[index][tranche] -= amount;
          moved = true;
        }
      }
    }
    if (!moved || remainingTarget.every((value) => value < 1e-7)) break;
  }

  return { alloc, left: remainingTarget, flagTotal, flagPerTranche };
}

function adjustmentKey(fundId: string, trancheId: string): string {
  return `${fundId}|${trancheId}`;
}

function indexAdjustments(adjustments: AllocationAdjustment[]): Map<string, AllocationAdjustment> {
  const map = new Map<string, AllocationAdjustment>();
  for (const adjustment of adjustments) map.set(adjustmentKey(adjustment.fundId, adjustment.trancheId), adjustment);
  return map;
}

interface RawRow {
  fundId: string;
  amounts: number[];
  eligible: boolean[];
  available: number;
  excludedEntirely: AllocationAdjustment | null;
  override: Array<AllocationAdjustment | null>;
  why: Array<{ kind: string; code?: string; text: string } | null>;
  cap: Array<string | null>;
}

interface RawResult {
  targets: number[];
  rows: Map<string, RawRow>;
  totals: number[];
}

function compute(request: AllocationRequest, adjustments: AllocationAdjustment[]): RawResult {
  const tranches = request.tranches;
  const portfolios = request.portfolios.filter((portfolio) => portfolio.sleeves.length > 0);
  const targets = tranches.map((tranche) => tranche.size * tranche.holdPct / 100);
  const adj = indexAdjustments(adjustments);

  const exclusion = (fundId: string, trancheId: string): AllocationAdjustment | null => {
    const entire = adj.get(adjustmentKey(fundId, '*'));
    if (entire && entire.type === 'exclude') return entire;
    const cell = adj.get(adjustmentKey(fundId, trancheId));
    return cell && cell.type === 'exclude' ? cell : null;
  };
  const override = (fundId: string, trancheId: string): AllocationAdjustment | null => {
    const cell = adj.get(adjustmentKey(fundId, trancheId));
    return cell && cell.type === 'override' ? cell : null;
  };
  const allowed = (list: string[], instrument: string) => list.includes(instrument);

  const sleeveCap = (portfolio: AllocationPortfolio, sleeve: AllocationSleeve) => {
    const available = sleeveAvailable(sleeve);
    const issuer = portfolio.issuerLimit * sleeve.nav;
    return available <= issuer
      ? { value: available, why: 'available capital' }
      : { value: issuer, why: 'single-issuer concentration limit' };
  };
  const sleeveEligible = (portfolio: AllocationPortfolio, sleeve: AllocationSleeve, trancheIndex: number) => {
    const tranche = tranches[trancheIndex];
    return allowed(portfolio.allowed, tranche.instrumentType)
      && allowed(sleeve.allowed, tranche.instrumentType)
      && !exclusion(portfolio.id, tranche.id)
      && !exclusion(sleeve.id, tranche.id);
  };
  const portfolioEligible = (portfolio: AllocationPortfolio, trancheIndex: number) => (
    portfolio.sleeves.some((sleeve) => sleeveEligible(portfolio, sleeve, trancheIndex))
  );
  const portfolioCap = (portfolio: AllocationPortfolio) => {
    const parts = [
      { value: sum(portfolio.sleeves.map((sleeve) => sleeveCap(portfolio, sleeve).value)), why: 'sub-portfolio capacity' },
      { value: portfolio.issuerLimit * portfolio.nav, why: 'single-issuer concentration limit' },
      { value: portfolio.sponsorLimit * portfolio.nav - portfolio.sponsorExposure, why: 'sponsor concentration limit' },
    ];
    const tightest = parts.reduce((best, part) => (part.value < best.value ? part : best));
    return { value: Math.max(0, tightest.value), why: tightest.why };
  };

  const totalAvailable = sum(portfolios.map(portfolioAvailable));
  const locks = portfolios.map(() => tranches.map(() => null as number | null));
  portfolios.forEach((portfolio, portfolioIndex) => {
    tranches.forEach((tranche, trancheIndex) => {
      const cell = override(portfolio.id, tranche.id);
      if (cell && portfolioEligible(portfolio, trancheIndex) && cell.amount != null) locks[portfolioIndex][trancheIndex] = cell.amount;
    });
  });

  const unfundedSize = sum(tranches.filter((tranche) => tranche.unfunded).map((tranche) => tranche.size)) || 1;
  const capPerTranche = portfolios.map((portfolio) => tranches.map((tranche) => (
    tranche.unfunded
      ? Math.max(0, portfolio.unfundedLimit * portfolio.nav - portfolio.unfundedExposure) * tranche.size / unfundedSize
      : Number.POSITIVE_INFINITY
  )));
  const capWhy: string[][] = portfolios.map(() => tranches.map((tranche) => (tranche.unfunded ? 'unfunded commitment limit' : '')));

  let portfolioFill: FillResult | null = null;
  let sleeveFills: Array<FillResult & { locks: Array<Array<number | null>> }> = [];
  let portfolioAmounts: number[][] = [];

  for (let pass = 0; pass < 12; pass += 1) {
    const lockedByTranche = tranches.map((_, trancheIndex) => sum(portfolios.map((_, portfolioIndex) => locks[portfolioIndex][trancheIndex] || 0)));
    const lockedByPortfolio = portfolios.map((_, portfolioIndex) => sum(tranches.map((_, trancheIndex) => locks[portfolioIndex][trancheIndex] || 0)));
    portfolioFill = fill({
      targets: targets.map((target, trancheIndex) => Math.max(0, target - lockedByTranche[trancheIndex])),
      weight: portfolios.map(portfolioAvailable),
      capTotal: portfolios.map((portfolio, portfolioIndex) => Math.max(0, portfolioCap(portfolio).value - lockedByPortfolio[portfolioIndex])),
      capPerTranche,
      eligible: portfolios.map((portfolio, portfolioIndex) => tranches.map((_, trancheIndex) => (
        portfolioEligible(portfolio, trancheIndex) && locks[portfolioIndex][trancheIndex] === null
      ))),
    });
    portfolioAmounts = portfolios.map((portfolio, portfolioIndex) => tranches.map((_, trancheIndex) => (
      locks[portfolioIndex][trancheIndex] !== null ? locks[portfolioIndex][trancheIndex] as number : portfolioFill!.alloc[portfolioIndex][trancheIndex]
    )));

    sleeveFills = portfolios.map((portfolio, portfolioIndex) => {
      const sleeveLocks = portfolio.sleeves.map((sleeve) => tranches.map((tranche, trancheIndex) => {
        const cell = override(sleeve.id, tranche.id);
        return cell && sleeveEligible(portfolio, sleeve, trancheIndex) && cell.amount != null ? cell.amount : null;
      }));
      tranches.forEach((_, trancheIndex) => {
        const locked = sum(sleeveLocks.map((row) => row[trancheIndex] || 0));
        if (locked > portfolioAmounts[portfolioIndex][trancheIndex] + 1e-9 && locked > 0) {
          const scale = portfolioAmounts[portfolioIndex][trancheIndex] / locked;
          sleeveLocks.forEach((row) => {
            if (row[trancheIndex] !== null) row[trancheIndex] = (row[trancheIndex] as number) * scale;
          });
        }
      });
      tranches.forEach((tranche, trancheIndex) => {
        if (locks[portfolioIndex][trancheIndex] === null) return;
        const locked = sum(sleeveLocks.map((row) => row[trancheIndex] || 0));
        const remainder = Math.max(0, portfolioAmounts[portfolioIndex][trancheIndex] - locked);
        const open = portfolio.sleeves
          .map((sleeve, sleeveIndex) => sleeveIndex)
          .filter((sleeveIndex) => sleeveEligible(portfolio, portfolio.sleeves[sleeveIndex], trancheIndex) && sleeveLocks[sleeveIndex][trancheIndex] === null);
        const weight = sum(open.map((sleeveIndex) => sleeveAvailable(portfolio.sleeves[sleeveIndex])));
        if (weight > 0) {
          open.forEach((sleeveIndex) => {
            sleeveLocks[sleeveIndex][trancheIndex] = remainder * sleeveAvailable(portfolio.sleeves[sleeveIndex]) / weight;
          });
        }
      });
      const lockedByTranche = tranches.map((_, trancheIndex) => sum(sleeveLocks.map((row) => row[trancheIndex] || 0)));
      const lockedBySleeve = sleeveLocks.map((row) => sum(row.map((value) => value || 0)));
      const result = fill({
        targets: tranches.map((_, trancheIndex) => Math.max(0, portfolioAmounts[portfolioIndex][trancheIndex] - lockedByTranche[trancheIndex])),
        weight: portfolio.sleeves.map(sleeveAvailable),
        capTotal: portfolio.sleeves.map((sleeve, sleeveIndex) => Math.max(0, sleeveCap(portfolio, sleeve).value - lockedBySleeve[sleeveIndex])),
        capPerTranche: portfolio.sleeves.map(() => tranches.map(() => Number.POSITIVE_INFINITY)),
        eligible: portfolio.sleeves.map((sleeve, sleeveIndex) => tranches.map((_, trancheIndex) => (
          sleeveEligible(portfolio, sleeve, trancheIndex) && sleeveLocks[sleeveIndex][trancheIndex] === null
        ))),
      });
      return { ...result, locks: sleeveLocks };
    });

    let changed = false;
    portfolios.forEach((portfolio, portfolioIndex) => {
      tranches.forEach((_, trancheIndex) => {
        if (locks[portfolioIndex][trancheIndex] !== null) return;
        const leftover = sleeveFills[portfolioIndex].left[trancheIndex];
        if (leftover > 1e-6) {
          capPerTranche[portfolioIndex][trancheIndex] = Math.max(
            0,
            Math.min(capPerTranche[portfolioIndex][trancheIndex], portfolioFill!.alloc[portfolioIndex][trancheIndex] - leftover),
          );
          capWhy[portfolioIndex][trancheIndex] = 'sub-portfolio capacity';
          changed = true;
        }
      });
    });
    if (!changed) break;
  }

  const parentReason = (portfolio: AllocationPortfolio, trancheIndex: number) => {
    const tranche = tranches[trancheIndex];
    const excluded = exclusion(portfolio.id, tranche.id);
    if (excluded) return { kind: 'manual', code: excluded.reason, text: `Excluded: ${reasonLabel(excluded.reason) || 'manual exclusion'}` };
    if (!allowed(portfolio.allowed, tranche.instrumentType)) {
      return { kind: 'mandate', text: portfolio.denyNote || 'Not permitted by mandate' };
    }
    return { kind: 'sub', text: 'No sub-portfolio is eligible' };
  };
  const sleeveReason = (portfolio: AllocationPortfolio, sleeve: AllocationSleeve, trancheIndex: number) => {
    const tranche = tranches[trancheIndex];
    const parentExcluded = exclusion(portfolio.id, tranche.id);
    if (parentExcluded) return { kind: 'manual', code: parentExcluded.reason, text: `Fund excluded: ${reasonLabel(parentExcluded.reason) || 'manual exclusion'}` };
    if (!allowed(portfolio.allowed, tranche.instrumentType)) {
      return { kind: 'mandate', text: portfolio.denyNote || 'Fund mandate does not permit this security' };
    }
    if (!allowed(sleeve.allowed, tranche.instrumentType)) {
      return { kind: 'guideline', text: sleeve.denyNote || 'Guidelines do not permit this security' };
    }
    const sleeveExcluded = exclusion(sleeve.id, tranche.id);
    if (sleeveExcluded) {
      return { kind: 'manual', code: sleeveExcluded.reason, text: `Excluded: ${reasonLabel(sleeveExcluded.reason) || 'manager discretion'}` };
    }
    return { kind: 'guideline', text: 'Not eligible' };
  };

  const rows = new Map<string, RawRow>();
  const totals = tranches.map(() => 0);

  portfolios.forEach((portfolio, portfolioIndex) => {
    const raw = portfolio.sleeves.map((sleeve, sleeveIndex) => tranches.map((_, trancheIndex) => (
      sleeveFills[portfolioIndex].locks[sleeveIndex][trancheIndex] !== null
        ? sleeveFills[portfolioIndex].locks[sleeveIndex][trancheIndex] as number
        : sleeveFills[portfolioIndex].alloc[sleeveIndex][trancheIndex]
    )));
    const sleeveAmounts = portfolio.sleeves.map(() => tranches.map(() => 0));
    tranches.forEach((_, trancheIndex) => {
      let remainder = Math.round(sum(raw.map((row) => row[trancheIndex])) * 100);
      const fractions: Array<[number, number]> = [];
      raw.forEach((row, sleeveIndex) => {
        if (sleeveFills[portfolioIndex].locks[sleeveIndex][trancheIndex] !== null) {
          const cents = Math.round(row[trancheIndex] * 100);
          sleeveAmounts[sleeveIndex][trancheIndex] = cents;
          remainder -= cents;
        } else {
          const cents = Math.floor(row[trancheIndex] * 100 + 1e-9);
          sleeveAmounts[sleeveIndex][trancheIndex] = cents;
          remainder -= cents;
          fractions.push([sleeveIndex, row[trancheIndex] * 100 - cents]);
        }
      });
      fractions.sort((left, right) => right[1] - left[1]);
      for (let index = 0; index < fractions.length && remainder > 0; index += 1) {
        sleeveAmounts[fractions[index][0]][trancheIndex] += 1;
        remainder -= 1;
      }
      sleeveAmounts.forEach((row) => {
        row[trancheIndex] = row[trancheIndex] / 100;
      });
    });
    const amounts = tranches.map((_, trancheIndex) => sum(sleeveAmounts.map((row) => row[trancheIndex])));
    const eligible = tranches.map((_, trancheIndex) => portfolioEligible(portfolio, trancheIndex));
    const cap = portfolioCap(portfolio);
    rows.set(portfolio.id, {
      fundId: portfolio.id,
      amounts,
      eligible,
      available: portfolioAvailable(portfolio),
      excludedEntirely: exclusion(portfolio.id, '*'),
      override: tranches.map((tranche, trancheIndex) => (eligible[trancheIndex] ? override(portfolio.id, tranche.id) : null)),
      why: tranches.map((_, trancheIndex) => (eligible[trancheIndex] ? null : parentReason(portfolio, trancheIndex))),
      cap: tranches.map((_, trancheIndex) => {
        if (!eligible[trancheIndex] || locks[portfolioIndex][trancheIndex] !== null) return null;
        if (portfolioFill!.flagPerTranche[portfolioIndex][trancheIndex]) return capWhy[portfolioIndex][trancheIndex] || null;
        if (portfolioFill!.flagTotal[portfolioIndex] && amounts[trancheIndex] > 0) return cap.why;
        return null;
      }),
    });
    portfolio.sleeves.forEach((sleeve, sleeveIndex) => {
      const sleeveEligibleFlags = tranches.map((_, trancheIndex) => sleeveEligible(portfolio, sleeve, trancheIndex));
      const sleeveCapResult = sleeveCap(portfolio, sleeve);
      rows.set(sleeve.id, {
        fundId: sleeve.id,
        amounts: sleeveAmounts[sleeveIndex],
        eligible: sleeveEligibleFlags,
        available: sleeveAvailable(sleeve),
        excludedEntirely: exclusion(sleeve.id, '*'),
        override: tranches.map((tranche, trancheIndex) => (sleeveEligibleFlags[trancheIndex] ? override(sleeve.id, tranche.id) : null)),
        why: tranches.map((_, trancheIndex) => (sleeveEligibleFlags[trancheIndex] ? null : sleeveReason(portfolio, sleeve, trancheIndex))),
        cap: tranches.map((_, trancheIndex) => (
          sleeveEligibleFlags[trancheIndex]
          && sleeveFills[portfolioIndex].locks[sleeveIndex][trancheIndex] === null
          && sleeveFills[portfolioIndex].flagTotal[sleeveIndex]
          && sleeveAmounts[sleeveIndex][trancheIndex] > 0
            ? sleeveCapResult.why
            : null
        )),
      });
    });
    tranches.forEach((_, trancheIndex) => {
      totals[trancheIndex] += amounts[trancheIndex];
    });
  });

  return { targets, rows, totals };
}

function cellFrom(
  trancheId: string,
  raw: RawRow,
  system: RawRow | undefined,
  trancheIndex: number,
): AllocationCellResult {
  const systemAmount = system && system.eligible[trancheIndex] ? system.amounts[trancheIndex] : 0;
  const why = raw.why[trancheIndex];
  const cellOverride = raw.override[trancheIndex];
  return {
    trancheId,
    eligible: raw.eligible[trancheIndex],
    amount: raw.amounts[trancheIndex],
    systemAmount,
    capReason: raw.cap[trancheIndex],
    exclusionKind: why ? why.kind : null,
    exclusionCode: why?.code || null,
    exclusionText: why ? why.text : null,
    overridden: Boolean(cellOverride),
    reasonCode: cellOverride?.reason || why?.code || null,
  };
}

export function allocate(request: AllocationRequest): AllocationResult {
  const adjustments = request.adjustments || [];
  const final = compute(request, adjustments);
  const system = adjustments.length ? compute(request, []) : final;
  const rows: AllocationRowResult[] = [];

  for (const portfolio of request.portfolios) {
    const portfolioRow = final.rows.get(portfolio.id);
    if (!portfolioRow) continue;
    const systemRow = system.rows.get(portfolio.id);
    rows.push({
      fundId: portfolio.id,
      fundName: portfolio.name,
      parentFundId: null,
      level: 'PORTFOLIO',
      availableCapital: portfolioRow.available,
      nav: portfolio.nav,
      total: sum(portfolioRow.amounts),
      cells: request.tranches.map((tranche, index) => cellFrom(tranche.id, portfolioRow, systemRow, index)),
    });
    for (const sleeve of portfolio.sleeves) {
      const sleeveRow = final.rows.get(sleeve.id);
      if (!sleeveRow) continue;
      rows.push({
        fundId: sleeve.id,
        fundName: sleeve.name,
        parentFundId: portfolio.id,
        level: 'SLEEVE',
        availableCapital: sleeveRow.available,
        nav: sleeve.nav,
        total: sum(sleeveRow.amounts),
        cells: request.tranches.map((tranche, index) => cellFrom(tranche.id, sleeveRow, system.rows.get(sleeve.id), index)),
      });
    }
  }

  const facilitySize = sum(request.tranches.map((tranche) => tranche.size));
  const targetHold = sum(final.targets);
  const allocated = sum(final.totals);
  return {
    facilitySize,
    targetHold,
    allocated,
    unallocated: targetHold - allocated,
    tranches: request.tranches.map((tranche, index) => ({
      id: tranche.id,
      name: tranche.name,
      size: tranche.size,
      holdPct: tranche.holdPct,
      unfunded: tranche.unfunded,
      instrumentType: tranche.instrumentType,
      targetAmount: final.targets[index],
      allocated: final.totals[index] || 0,
    })),
    rows,
  };
}
