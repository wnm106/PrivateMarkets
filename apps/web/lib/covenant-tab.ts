import { covenantStatus, type CovenantComponentResult, type CovenantTest } from '@tapestrai/graphql/src/lib/covenant-test';
import type { TabPayload } from './view-context';

/**
 * What the covenant Test tab publishes to the assistant: the test as the tab
 * shows it, built from the same result the tab draws.
 */

export const COVENANT_MEASURE_LABELS: Record<string, string> = {
  LTM: 'Last four quarters',
  QUARTER: 'Test quarter',
  ANNUALIZED: 'Test quarter × 4',
  POINT: 'At test date',
};

export const COVENANT_METRIC_LABELS: Record<string, string> = {
  NET_LEVERAGE: 'Net leverage',
  TOTAL_LEVERAGE: 'Total leverage',
  INTEREST_COVERAGE: 'Interest coverage',
  FIXED_CHARGE_COVERAGE: 'Fixed charge coverage',
  LIQUIDITY: 'Liquidity',
};

const MAX_LINES = 40;

function round(value: number | null, digits: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Ratios to two places; currency amounts to whole dollars. */
function figure(test: CovenantTest, value: number | null): number | null {
  return round(value, test.unit === 'CURRENCY' ? 0 : 2);
}

export function covenantCapText(row: CovenantComponentResult): string | null {
  if (row.capType === 'AMOUNT') return row.capValue != null ? `Up to ${Math.round(row.capValue).toLocaleString('en-US')}` : 'Capped at an amount';
  if (row.capType === 'PCT_OF_BASE') return `Up to ${row.capValue ?? 0}% of the side's uncapped lines`;
  return null;
}

export function covenantTabPayload(label: string, test: CovenantTest | null): TabPayload {
  const base = {
    label,
    purpose: 'Whether this covenant passes on its latest test date under the deal\'s own definition, how each line of the definition contributes, and how it compares with the borrower\'s certificate and the house standard.',
    howToRead: 'value is this deal\'s definition on testDate, the latest borrower quarter on or before the As Of date. Leverage is a multiple (MAX: lower is better); coverage is a multiple (MIN: higher is better); liquidity is in dollars (MIN). status is PASS, WATCH (inside a 10% cushion), BREACH, or NO_DATA. cushion is a share of the level for MAX and of the value for MIN. certificate.difference is the borrower\'s figure less ours. house is the same borrower under the house standard. lines: applied is what a line added to its side after its cap and sign; lines not in force on the test date have inForce false. history is oldest first; tested is false before the first test, when a quarter is monitored but not scored.',
  };
  if (!test) return { ...base, data: null };

  const certificate = test.reported.find((row) => row.sourceCode !== 'MANUAL' && row.value != null);
  const manual = test.reported.find((row) => row.sourceCode === 'MANUAL' && row.value != null);
  const active = test.components.filter((row) => row.active);
  const lines = [...active, ...test.components.filter((row) => !row.active)].slice(0, MAX_LINES);

  return {
    ...base,
    data: {
      covenant: test.name,
      deal: test.dealName,
      metric: COVENANT_METRIC_LABELS[test.metric || ''] || test.metric,
      direction: test.direction,
      unit: test.unit,
      testDate: test.testDate,
      value: figure(test, test.value),
      level: figure(test, test.level),
      status: test.status,
      cushion: round(test.cushion, 3),
      firstTest: test.firstTest,
      beforeFirstTest: test.beforeFirstTest,
      numerator: round(test.numerator, 0),
      denominator: round(test.denominator, 0),
      certificate: certificate
        ? { source: certificate.sourceName, value: figure(test, certificate.value), difference: figure(test, test.reportedDifference), received: certificate.validFrom }
        : null,
      house: test.houseId && !test.isHouse ? { definition: test.houseName, value: figure(test, test.house) } : null,
      manualOverride: manual ? figure(test, manual.value) : null,
      storedValueBehind: test.stale,
      cannotCalculate: test.missing,
      isLibraryDefinition: test.isLibrary,
      isHouseStandard: test.isHouse,
      lineCount: test.components.length,
      lines: lines.map((row) => ({
        line: row.name,
        side: row.side,
        sign: row.sign,
        statementLine: row.lineName || row.line,
        period: COVENANT_MEASURE_LABELS[row.measure] || row.measure,
        cap: covenantCapText(row),
        capped: row.capped,
        inForce: row.active,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        clause: row.clause,
        statementValue: row.active ? round(row.raw, 0) : null,
        applied: row.active ? round(row.applied, 0) : null,
      })),
      history: test.history.map((point) => ({
        quarterEnd: point.testDate,
        value: figure(test, point.value),
        house: test.isHouse ? null : figure(test, point.house),
        level: figure(test, point.level),
        tested: point.tested,
        status: point.value == null ? 'NO_DATA' : point.tested ? covenantStatus(test.direction, point.level, point.value) : 'BEFORE_FIRST_TEST',
      })),
    },
  };
}
