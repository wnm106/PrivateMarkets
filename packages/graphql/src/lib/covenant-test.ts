/**
 * Covenant tests as the app shows them.
 *
 * The calculation itself is Postgres (golden_master.covenant_evaluate), so the
 * stored golden value and what the page shows come from one place. This file
 * turns that function's JSON into typed rows and decides the status, the
 * cushion, and whether the stored value has fallen behind the definition.
 */

export type CovenantStatus = 'PASS' | 'WATCH' | 'BREACH' | 'NO_DATA';

/** Inside this cushion a passing covenant is on watch. Matches the Servicing tab. */
export const WATCH_CUSHION = 0.1;

export interface CovenantComponentResult {
  id: string;
  name: string;
  side: 'NUMERATOR' | 'DENOMINATOR';
  line: string | null;
  lineName: string | null;
  sign: 'ADD' | 'SUBTRACT';
  measure: string;
  capType: string;
  capValue: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  clause: string | null;
  active: boolean;
  raw: number | null;
  capLimit: number | null;
  allowed: number | null;
  applied: number | null;
  capped: boolean;
}

export interface CovenantReading {
  sourceCode: string;
  sourceName: string;
  value: number | null;
  validFrom: string | null;
}

export interface CovenantHistoryPoint {
  testDate: string;
  value: number | null;
  house: number | null;
  level: number | null;
  tested: boolean;
}

export interface CovenantTest {
  covenantId: string;
  code: string;
  name: string;
  dealId: string | null;
  dealName: string | null;
  metric: string | null;
  direction: string | null;
  unit: string | null;
  level: number | null;
  firstTest: string | null;
  beforeFirstTest: boolean;
  asOf: string;
  testDate: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  stored: number | null;
  manualOverride: boolean;
  stale: boolean;
  status: CovenantStatus;
  cushion: number | null;
  house: number | null;
  houseId: string | null;
  houseName: string | null;
  reported: CovenantReading[];
  reportedDifference: number | null;
  isLibrary: boolean;
  isHouse: boolean;
  components: CovenantComponentResult[];
  missing: string[];
  history: CovenantHistoryPoint[];
}

export interface CovenantDefinitionChoice {
  id: string;
  name: string;
  description: string | null;
  metric: string | null;
  isHouse: boolean;
  componentCount: number;
}

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function day(value: unknown): string | null {
  const text = str(value);
  return text ? text.slice(0, 10) : null;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === 'object') : [];
}

/** How far the value sits inside the level, as a share of the level (MAX) or of the value (MIN). */
export function covenantCushion(direction: string | null, level: number | null, value: number | null): number | null {
  if (level == null || value == null) return null;
  if (direction === 'MIN') return value === 0 ? null : (value - level) / value;
  return level === 0 ? null : (level - value) / level;
}

export function covenantStatus(direction: string | null, level: number | null, value: number | null): CovenantStatus {
  if (value == null || level == null) return 'NO_DATA';
  const breached = direction === 'MIN' ? value < level : value > level;
  if (breached) return 'BREACH';
  const cushion = covenantCushion(direction, level, value);
  return cushion != null && cushion < WATCH_CUSHION ? 'WATCH' : 'PASS';
}

/** The stored golden value is behind when it differs from what the definition gives now. A manual override is never behind. */
export function isStale(stored: number | null, value: number | null, manualOverride: boolean): boolean {
  if (manualOverride) return false;
  if (stored == null || value == null) return stored !== value;
  const scale = Math.max(1, Math.abs(value));
  return Math.abs(stored - value) > scale * 1e-9;
}

export function mapCovenantComponent(row: Row): CovenantComponentResult {
  return {
    id: String(row.id ?? ''),
    name: str(row.name) ?? '',
    side: row.side === 'DENOMINATOR' ? 'DENOMINATOR' : 'NUMERATOR',
    line: str(row.line),
    lineName: str(row.lineName),
    sign: row.sign === 'SUBTRACT' ? 'SUBTRACT' : 'ADD',
    measure: str(row.measure) ?? 'POINT',
    capType: str(row.capType) ?? 'NONE',
    capValue: num(row.capValue),
    effectiveFrom: day(row.effectiveFrom),
    effectiveTo: day(row.effectiveTo),
    clause: str(row.clause),
    active: row.active === true,
    raw: num(row.raw),
    capLimit: num(row.capLimit),
    allowed: num(row.allowed),
    applied: num(row.applied),
    capped: row.capped === true,
  };
}

export function mapCovenantTest(row: Row): CovenantTest {
  const direction = str(row.direction);
  const level = num(row.level);
  const value = num(row.value);
  const stored = num(row.stored);
  const testDate = day(row.testDate);
  const firstTest = day(row.firstTest);
  const reported = rows(row.reported).map((item) => ({
    sourceCode: str(item.sourceCode) ?? '',
    sourceName: str(item.sourceName) ?? '',
    value: num(item.value),
    validFrom: day(item.validFrom),
  }));
  const manualOverride = reported.some((item) => item.sourceCode === 'MANUAL' && item.value != null);
  const certificate = reported.find((item) => item.sourceCode !== 'MANUAL' && item.value != null);
  const components = rows(row.components).map(mapCovenantComponent).sort((a, b) => {
    if (a.side !== b.side) return a.side === 'NUMERATOR' ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return 0;
  });
  return {
    covenantId: String(row.covenantId ?? ''),
    code: str(row.code) ?? '',
    name: str(row.name) ?? '',
    dealId: str(row.dealId),
    dealName: str(row.dealName),
    metric: str(row.metric),
    direction,
    unit: str(row.unit),
    level,
    firstTest,
    beforeFirstTest: Boolean(firstTest && testDate && testDate < firstTest),
    asOf: day(row.asOf) ?? '',
    testDate,
    value,
    numerator: num(row.numerator),
    denominator: num(row.denominator),
    stored,
    manualOverride,
    stale: isStale(stored, value, manualOverride),
    status: covenantStatus(direction, level, value),
    cushion: covenantCushion(direction, level, value),
    house: num(row.house),
    houseId: str(row.houseId),
    houseName: str(row.houseName),
    reported,
    reportedDifference: certificate?.value != null && value != null ? certificate.value - value : null,
    isLibrary: row.isLibrary === true,
    isHouse: row.isHouse === true,
    components,
    missing: Array.isArray(row.missing) ? row.missing.map((item) => String(item)) : [],
    history: rows(row.history)
      .map((item) => ({
        testDate: day(item.testDate) ?? '',
        value: num(item.value),
        house: num(item.house),
        level: num(item.level),
        tested: item.tested !== false,
      }))
      .filter((item) => item.testDate),
  };
}

export function mapCovenantChoice(row: Row): CovenantDefinitionChoice {
  return {
    id: String(row.id ?? ''),
    name: str(row.name) ?? '',
    description: str(row.description),
    metric: str(row.metric),
    isHouse: row.isHouse === true,
    componentCount: num(row.componentCount) ?? 0,
  };
}
