/**
 * Reads the performance book through the public GraphQL schema, with the user's As Of and
 * Knowledge dates. Every figure is worked out by the platform (`performanceBook`,
 * packages/graphql/src/lib/performance.ts); the surface only arranges what comes back.
 */
import type { SurfaceHost } from '@tapestrai/surface-sdk';

export interface Metrics {
  irr: number | null;
  moic: number | null;
  dpi: number | null;
  rvpi: number | null;
  paidIn: number;
  distributed: number;
  opening: number;
  closing: number;
  gain: number;
  legs: number;
  /** Positions or accounts left out: a value but nothing put in during the window. */
  excluded: number;
}

export type Dimension = 'TOTAL' | 'FAMILY' | 'FUND' | 'DEAL' | 'DEAL_FUND' | 'SECTOR' | 'POSITION' | 'INVESTOR' | 'INVESTOR_FUND';

export interface Group {
  dimension: Dimension;
  key: string;
  label: string;
  entityId: string | null;
  parentKey: string | null;
  gross: Metrics | null;
  net: Metrics | null;
  positionIds: string[];
  accountIds: string[];
}

export interface WindowResult {
  key: string;
  label: string;
  startDate: string | null;
  endDate: string;
  netExcluded: boolean;
  total: Group;
  groups: Group[];
}

export interface Fund {
  id: string;
  code: string;
  name: string;
  familyId: string;
  isFamily: boolean;
  vintage: string | null;
  strategy: string | null;
  reportedNetIrr: number | null;
  reportedGrossIrr: number | null;
  nav: number | null;
}

export interface CashFlow { id: string; date: string; amount: number; type: string | null }

export interface Position {
  id: string;
  name: string;
  fundId: string;
  dealId: string | null;
  trancheId: string | null;
  securityId: string | null;
  issuerId: string | null;
  issuerName: string | null;
  sector: string | null;
  sectorFrom: 'ISSUER' | 'DEAL' | null;
  flows: CashFlow[];
  marks: Array<{ date: string; value: number | null }>;
}

export interface Statement {
  recordId: string | null;
  recordName: string;
  periodEnd: string;
  contributions: number;
  distributions: number;
  closing: number;
  commitment: number | null;
  contributedItd: number | null;
  distributedItd: number | null;
  unfunded: number | null;
}

export interface Account { id: string; investorId: string; fundId: string; statements: Statement[] }

export interface Book {
  asOfDate: string;
  knowledgeDate: string;
  windows: WindowResult[];
  funds: Fund[];
  positions: Position[];
  deals: Array<{ id: string; name: string; sector: string | null }>;
  investors: Array<{ id: string; name: string; type: string | null }>;
  accounts: Account[];
  sectors: string[];
  unmeasuredPositions: number;
}

export interface WindowInput { key: string; label?: string; startDate?: string | null; endDate?: string | null }

export interface Filter {
  includeFundIds?: string[];
  excludeFundIds?: string[];
  includeDealIds?: string[];
  excludeDealIds?: string[];
  includeSectors?: string[];
  excludeSectors?: string[];
}

/** The attributes the surface shows directly. Right-click on each opens its sources. */
export const ATTR = {
  marketValue: 'MARKET_VALUE',
  flowAmount: 'CASHFLOW_INVESTOR_AMOUNT',
  flowDate: 'CASHFLOW_DATE',
  issuerSector: 'SECTOR',
  dealSector: 'DEAL_SECTOR',
  vintage: 'FUND_VINTAGE',
  strategy: 'FUND_STRATEGY',
  netIrr: 'FUND_NET_IRR',
  grossIrr: 'FUND_GROSS_IRR',
  nav: 'NAV',
  investorType: 'INVESTOR_TYPE',
  periodEnd: 'CAPACCT_PERIOD_END',
  contributions: 'CAPACCT_CONTRIBUTIONS',
  distributions: 'CAPACCT_DISTRIBUTIONS',
  closing: 'CAPACCT_CLOSING',
  commitment: 'CAPACCT_COMMITMENT',
  contributedItd: 'CAPACCT_CONTRIBUTED_ITD',
  distributedItd: 'CAPACCT_DISTRIBUTED_ITD',
  unfunded: 'CAPACCT_UNFUNDED',
} as const;

const METRICS = 'irr moic dpi rvpi paidIn distributed opening closing gain legs excluded';
const GROUP = `dimension key label entityId parentKey positionIds accountIds gross { ${METRICS} } net { ${METRICS} }`;
const BOOK = `
  asOfDate knowledgeDate sectors unmeasuredPositions
  windows { key label startDate endDate netExcluded total { ${GROUP} } groups { ${GROUP} } }
  funds { id code name familyId isFamily vintage strategy reportedNetIrr reportedGrossIrr nav }
  positions { id name fundId dealId trancheId securityId issuerId issuerName sector sectorFrom flows { id date amount type } marks { date value } }
  deals { id name sector }
  investors { id name type }
  accounts { id investorId fundId statements { recordId recordName periodEnd contributions distributions closing commitment contributedItd distributedItd unfunded } }`;

const FUNDS = `query PerformanceFunds($asOfDate: Date, $knowledgeDate: DateTime) {
  funds: entities(filter: { domainCode: "FUND", isActive: true }, pagination: { first: 2000 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { edges { node { id } } }
}`;

const PERFORMANCE = `query PerformanceBook($fundIds: [ID!]!, $windows: [PerformanceWindowInput!], $filter: PerformanceFilterInput, $asOfDate: Date, $knowledgeDate: DateTime) {
  performanceBook(fundIds: $fundIds, windows: $windows, filter: $filter, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { ${BOOK} }
}`;

/**
 * The Knowledge date as the API reads it. A bare day means what was known by the end of
 * that day; today (or later) means now. A datetime passes through.
 */
export function knowledgeArg(knowledgeDate: string | null | undefined): string | null {
  const text = (knowledgeDate || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const today = new Date().toISOString().slice(0, 10);
    return text >= today ? null : `${text}T23:59:59.999Z`;
  }
  return text;
}

const dates = (host: SurfaceHost) => ({ asOfDate: host.asOfDate || null, knowledgeDate: knowledgeArg(host.knowledgeDate) });

/** Every active fund the user may see: the book is measured across all of them. */
export async function loadFundIds(host: SurfaceHost): Promise<{ ids: string[]; error: string | null }> {
  const r = await host.query<{ funds: { edges: Array<{ node: { id: string } }> } }>(FUNDS, dates(host), 'network-only');
  if (r.error) return { ids: [], error: r.error.message };
  return { ids: (r.data?.funds.edges || []).map((edge) => edge.node.id), error: null };
}

export async function loadBook(host: SurfaceHost, fundIds: string[], windows?: WindowInput[] | null, filter?: Filter | null): Promise<{ book: Book | null; error: string | null }> {
  const r = await host.query<{ performanceBook: Book }>(PERFORMANCE, { fundIds, windows: windows ?? null, filter: filter ?? null, ...dates(host) }, 'network-only');
  if (r.error) return { book: null, error: r.error.message };
  return { book: r.data?.performanceBook ?? null, error: r.data?.performanceBook ? null : 'Nothing came back.' };
}
