/** The OCIO surface's view of its records, read through the public GraphQL schema. */

export type Lens = 'strategy' | 'region' | 'structure';
export const LENSES: Lens[] = ['strategy', 'region', 'structure'];

/** Min, target and max for each measure. Dollars are dollars; percent is percent points. */
export interface Band {
  usd?: number | null;
  usdMin?: number | null;
  usdMax?: number | null;
  n?: number | null;
  nMin?: number | null;
  nMax?: number | null;
  pct?: number | null;
  pctMin?: number | null;
  pctMax?: number | null;
}

/**
 * A fund's targets as the screens read them: the program band and each hierarchy's targets,
 * keyed by level (the codes from the top of the hierarchy down, joined by a slash). This is
 * only how the surface holds them in memory. Each level is stored as its own allocation
 * target record, and each minimum, target and maximum as its own attribute on that record.
 */
export interface TargetMatrix {
  program: Band;
  strategy: Record<string, Band>;
  region: Record<string, Band>;
  structure: Record<string, Band>;
}

export type PercentBasis = 'PROGRAM' | 'PARENT_LEVEL';

/** Where a target is set: a hierarchy, the total program, or one deployment year. */
export type TargetScope = Lens | 'program' | 'year';
export const targetKey = (scope: TargetScope, level: string) => `${scope}|${level}`;

/** One allocation target record: a fund's target at one level of one hierarchy. */
export interface TargetRecord {
  id: string;
  name: string;
}

/** A client program or a mandate sleeve. Both are FUND records; a sleeve has a FUND_PARENT. */
export interface Fund {
  id: string;
  code: string;
  name: string;
  /** The record's template, so a new sleeve can be created like its client. */
  templateCode?: string | null;
  kind: 'client' | 'sleeve';
  parentId: string | null;
  /** FUND_TOTAL_COMMITMENTS */
  programUsd: number | null;
  /** OCIO_TARGET_INVESTMENT_COUNT */
  programN: number | null;
  basis: PercentBasis;
  /** OCIO_ANNUAL_DEPLOYMENT_TARGET */
  annual: number | null;
  /** INCEPTION_DATE */
  start: string | null;
  /** FUND_INVESTMENT_PERIOD_END */
  end: string | null;
  /** A year's own deployment target where it differs from the annual target: year to dollars. */
  overrides: Record<string, number>;
  matrix: TargetMatrix;
  /** The allocation target record behind each level, by targetKey. A level with none has no record yet. */
  targets: Record<string, TargetRecord>;
  currency: string | null;
  eligible: boolean;
}

/** Classification codes on the underlying investment, from the Harbor Lite tree lists. */
export interface Tags {
  cat: string | null;
  ac: string | null;
  st: string | null;
  sub: string | null;
  rg: string | null;
  ty: string | null;
  det: string | null;
}

/** Security-master fields of an underlying investment (a SECURITY). */
export interface SecurityFacts {
  securityId: string;
  asset: string;
  manager: string;
  tags: Tags;
  investmentType: string | null;
  market: string | null;
  country: string | null;
  geo: string | null;
  sector: string | null;
  fundSize: number | null;
  firstTime: boolean | null;
  relationship: string | null;
  listed: boolean | null;
  fof: boolean | null;
  vintage: string | null;
}

/** One original commitment: a POSITION of a sleeve in a SECURITY. */
export interface Commitment extends SecurityFacts {
  id: string;
  code: string;
  name: string;
  sleeveId: string;
  amount: number;
  date: string;
  currency: string | null;
  allocationYear: string | null;
  followOn: boolean | null;
  contractual: string | null;
  esg: string | null;
  strategyReview: string | null;
}

export interface DealTranche {
  id: string;
  name: string;
  /** TRANCHE_HOLD_AMOUNT: the amount offered to our sleeves. */
  hold: number;
  /** TRANCHE_SIZE */
  size: number | null;
  rank: number;
}

export interface FundingPlan {
  id: string;
  name: string;
  fundId: string;
  amount: number | null;
  ratio: number | null;
  status: string | null;
}

export interface Deal extends SecurityFacts {
  id: string;
  code: string;
  name: string;
  stage: string | null;
  close: string | null;
  description: string | null;
  size: number | null;
  tranches: DealTranche[];
  plans: FundingPlan[];
}

export interface TaxValue {
  code: string;
  label: string;
  parent: string | null;
  level: number;
}

export interface Taxonomy {
  strategy: TaxValue[];
  structure: TaxValue[];
  region: TaxValue[];
  labels: Record<string, string>;
}

export interface StageDef {
  code: string;
  label: string;
}

export interface OcioData {
  funds: Fund[];
  commitments: Commitment[];
  deals: Deal[];
  taxonomy: Taxonomy;
  stages: StageDef[];
}

export const emptyMatrix = (): TargetMatrix => ({ program: {}, strategy: {}, region: {}, structure: {} });
