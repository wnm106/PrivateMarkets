// Extended mock data for CRUD and administrative screens
import { SourceKey } from './data';

// ============== TYPES ==============
export type DomainKey = 'funds' | 'issuers' | 'securities' | 'deals' | 'investors' | 'positions';
export type DataType = 'STRING' | 'FLOAT' | 'INTEGER' | 'DATE' | 'TIMESTAMP' | 'REFERENCE_LIST';

export interface Attribute {
  id: string;
  code: string;
  name: string;
  description: string;
  domain: DomainKey;
  dataType: DataType;
  validationRules: {
    regex?: string;
    min?: number;
    max?: number;
    required: boolean;
  };
  unitOfMeasure?: string;
  isUDF: boolean;
  listValues?: string[];
  isMultiValued?: boolean;
  isDerived?: boolean;
  derivationType?: 'SIMPLE' | 'AGGREGATE' | 'LOOKUP' | 'CUSTOM';
  derivationFormula?: string;
  derivationDependencies?: string[];
  formulaLanguage?: 'SQL' | 'JS' | 'DSL';
  usageCount: number;
  templateCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id: string;
  code: string;
  name: string;
  domain: DomainKey;
  description: string;
  attributes: TemplateAttribute[];
  entityCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateAttribute {
  attributeId: string;
  attributeCode: string;
  attributeName: string;
  required: boolean;
  displaySection: string;
  sortOrder: number;
}

export interface SourceConfig {
  id: string;
  code: string;
  name: string;
  type: 'vendor' | 'manual' | 'derived';
  reliabilityScore: number;
  syncSchedule: string;
  enabled: boolean;
  connectionConfig: string;
  lastSync: string;
  nextSync: string;
  stats: {
    totalRecords: number;
    recordsToday: number;
    errorRate: number;
    avgLatency: number;
  };
  qualityMetrics: {
    completeness: number;
    accuracy: number;
    timeliness: number;
  };
}

export interface DQRule {
  id: string;
  name: string;
  description: string;
  type: 'Availability' | 'Tolerance' | 'Trajectory';
  scope: 'domain' | 'template' | 'attribute';
  scopeRef: string;
  scopeLabel: string;
  threshold: number;
  severity: 'high' | 'medium' | 'low';
  enabled: boolean;
  exceptionCount: number;
  lastEvaluated: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  who: string;
  whoInitials: string;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  timestamp: string;
  source: string;
}

export interface LineageEntry {
  id: string;
  source: SourceKey;
  sourceName: string;
  value: string;
  validFrom: string;
  validTo: string | null;
  systemTime: string;
  ruleApplied: string;
  isGolden: boolean;
  superseded: boolean;
}

// ============== DOMAIN CONFIG ==============
export interface DomainConfig {
  key: DomainKey;
  name: string;
  color: string;
  count: number;
  templates: string[];
}

export const domainConfigs: DomainConfig[] = [
  { key: 'funds', name: 'Funds', color: '#1b3a4b', count: 47, templates: ['OPEN_END', 'CLOSED_END', 'EVERGREEN'] },
  { key: 'issuers', name: 'Issuers', color: '#6d28d9', count: 1842, templates: ['CORPORATE', 'SOVEREIGN', 'SPV'] },
  { key: 'securities', name: 'Securities', color: '#c2410c', count: 3104, templates: ['BOND', 'LOAN', 'EQUITY', 'DERIVATIVE'] },
  { key: 'deals', name: 'Deals', color: '#047857', count: 612, templates: ['DIRECT_LENDING', 'UNITRANCHE', 'SECOND_LIEN', 'EQUITY'] },
  { key: 'investors', name: 'Investors', color: '#be185d', count: 218, templates: ['PENSION', 'ENDOWMENT', 'FAMILY_OFFICE', 'FUND_OF_FUNDS', 'INSURANCE'] },
  { key: 'positions', name: 'Positions', color: '#475569', count: 892, templates: ['DIRECT', 'FUND_LP', 'CO_INVEST'] },
];

export function getDomainConfig(key: string): DomainConfig {
  return domainConfigs.find(d => d.key === key) || domainConfigs[2];
}

// ============== ATTRIBUTES ==============
export const attributes: Attribute[] = [
  {
    id: 'ATTR-001', code: 'CUSIP', name: 'CUSIP / Loan-X', description: 'Committee on Uniform Securities Identification Procedures number or Loan-X identifier',
    domain: 'securities', dataType: 'STRING', validationRules: { regex: '^[A-Z0-9]{9,12}$', required: true },
    isUDF: false, usageCount: 3104, templateCount: 4, createdAt: '2024-01-15', updatedAt: '2026-03-10',
  },
  {
    id: 'ATTR-002', code: 'ISIN', name: 'ISIN', description: 'International Securities Identification Number',
    domain: 'securities', dataType: 'STRING', validationRules: { regex: '^[A-Z]{2}[A-Z0-9]{9}[0-9]$', required: true },
    isUDF: false, usageCount: 2987, templateCount: 4, createdAt: '2024-01-15', updatedAt: '2026-02-22',
  },
  {
    id: 'ATTR-003', code: 'INSTRUMENT_TYPE', name: 'Instrument Type', description: 'Classification of the financial instrument',
    domain: 'securities', dataType: 'REFERENCE_LIST', validationRules: { required: true },
    listValues: ['Bond', 'Loan', 'Equity', 'Derivative', 'Unitranche', 'Term Loan', 'Revolving Credit'],
    isMultiValued: false,
    isUDF: false, usageCount: 3104, templateCount: 4, createdAt: '2024-01-15', updatedAt: '2026-04-01',
  },
  {
    id: 'ATTR-004', code: 'SENIORITY', name: 'Seniority', description: 'Capital structure seniority ranking',
    domain: 'securities', dataType: 'REFERENCE_LIST', validationRules: { required: true },
    listValues: ['Senior Secured', 'Senior Unsecured', 'Mezzanine', 'Subordinated', 'Junior'],
    isMultiValued: false,
    isUDF: false, usageCount: 2856, templateCount: 3, createdAt: '2024-01-15', updatedAt: '2026-03-15',
  },
  {
    id: 'ATTR-005', code: 'NOTIONAL', name: 'Notional (Original)', description: 'Original notional amount in base currency',
    domain: 'securities', dataType: 'FLOAT', validationRules: { min: 0, required: true },
    unitOfMeasure: 'USD', isUDF: false, usageCount: 3098, templateCount: 4, createdAt: '2024-01-15', updatedAt: '2026-05-01',
  },
  {
    id: 'ATTR-006', code: 'MATURITY_DATE', name: 'Maturity Date', description: 'Final payment date of the instrument',
    domain: 'securities', dataType: 'DATE', validationRules: { required: true },
    isUDF: false, usageCount: 3089, templateCount: 4, createdAt: '2024-01-15', updatedAt: '2026-04-18',
  },
  {
    id: 'ATTR-007', code: 'SPREAD_BPS', name: 'Spread (bps)', description: 'Credit spread over reference rate in basis points',
    domain: 'securities', dataType: 'INTEGER', validationRules: { min: 0, max: 5000, required: false },
    unitOfMeasure: 'bps', isUDF: false, usageCount: 2654, templateCount: 2, createdAt: '2024-02-01', updatedAt: '2026-05-10',
  },
  {
    id: 'ATTR-008', code: 'COUPON_RATE', name: 'Coupon Rate', description: 'Annual interest rate paid on the bond',
    domain: 'securities', dataType: 'FLOAT', validationRules: { min: 0, max: 30, required: false },
    unitOfMeasure: '%', isUDF: false, usageCount: 1842, templateCount: 1, createdAt: '2024-02-01', updatedAt: '2026-03-22',
  },
  {
    id: 'ATTR-009', code: 'ISSUER_NAME', name: 'Issuer Name', description: 'Legal name of the issuing entity',
    domain: 'issuers', dataType: 'STRING', validationRules: { required: true },
    isUDF: false, usageCount: 1842, templateCount: 3, createdAt: '2024-01-15', updatedAt: '2026-05-19',
  },
  {
    id: 'ATTR-010', code: 'GICS_INDUSTRY', name: 'GICS Industry', description: 'Global Industry Classification Standard sector',
    domain: 'issuers', dataType: 'REFERENCE_LIST', validationRules: { required: true },
    listValues: ['Energy', 'Materials', 'Industrials', 'Consumer Discretionary', 'Consumer Staples', 'Health Care', 'Financials', 'Information Technology', 'Communication Services', 'Utilities', 'Real Estate'],
    isMultiValued: false,
    isUDF: false, usageCount: 1756, templateCount: 3, createdAt: '2024-01-15', updatedAt: '2026-04-05',
  },
  {
    id: 'ATTR-011', code: 'COUNTRY_OF_RISK', name: 'Country of Risk', description: 'Primary country of risk exposure',
    domain: 'issuers', dataType: 'REFERENCE_LIST', validationRules: { required: true },
    listValues: ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Japan', 'Australia', 'Brazil', 'India', 'China'],
    isMultiValued: true,
    isUDF: false, usageCount: 1842, templateCount: 3, createdAt: '2024-01-15', updatedAt: '2026-03-01',
  },
  {
    id: 'ATTR-012', code: 'FUND_AUM', name: 'AUM', description: 'Assets under management in millions',
    domain: 'funds', dataType: 'FLOAT', validationRules: { min: 0, required: true },
    unitOfMeasure: 'USD M', isUDF: false, usageCount: 47, templateCount: 3, createdAt: '2024-01-15', updatedAt: '2026-05-15',
  },
  {
    id: 'ATTR-013', code: 'FUND_NAV', name: 'NAV per Unit', description: 'Net asset value per fund unit',
    domain: 'funds', dataType: 'FLOAT', validationRules: { min: 0, required: true },
    unitOfMeasure: 'USD', isUDF: false, usageCount: 47, templateCount: 3, createdAt: '2024-01-15', updatedAt: '2026-05-20',
  },
  {
    id: 'ATTR-014', code: 'DEAL_SIZE', name: 'Deal Size', description: 'Total transaction value',
    domain: 'deals', dataType: 'FLOAT', validationRules: { min: 0, required: true },
    unitOfMeasure: 'USD M', isUDF: false, usageCount: 612, templateCount: 4, createdAt: '2024-01-15', updatedAt: '2026-05-18',
  },
  {
    id: 'ATTR-015', code: 'COMMITMENT', name: 'Commitment', description: 'Total capital commitment from investor',
    domain: 'investors', dataType: 'FLOAT', validationRules: { min: 0, required: true },
    unitOfMeasure: 'USD M', isUDF: false, usageCount: 218, templateCount: 5, createdAt: '2024-01-15', updatedAt: '2026-05-12',
  },
  {
    id: 'ATTR-016', code: 'REFERENCE_RATE', name: 'Reference Rate', description: 'Benchmark reference rate for floating instruments',
    domain: 'securities', dataType: 'REFERENCE_LIST', validationRules: { required: false },
    listValues: ['Term SOFR', 'Daily SOFR', 'LIBOR', 'EURIBOR', 'SONIA', 'TONAR'],
    isMultiValued: false,
    isUDF: false, usageCount: 2201, templateCount: 2, createdAt: '2024-02-10', updatedAt: '2026-04-20',
  },
  {
    id: 'ATTR-017', code: 'INTERNAL_NOTES', name: 'Internal Notes', description: 'Steward notes and observations',
    domain: 'securities', dataType: 'STRING', validationRules: { required: false },
    isUDF: true, usageCount: 342, templateCount: 4, createdAt: '2024-06-01', updatedAt: '2026-05-15',
  },
  {
    id: 'ATTR-018', code: 'CUSTOM_FIELD_1', name: 'ESG Score', description: 'Environmental, Social, Governance composite score',
    domain: 'issuers', dataType: 'FLOAT', validationRules: { min: 0, max: 100, required: false },
    isUDF: true, usageCount: 421, templateCount: 1, createdAt: '2025-03-15', updatedAt: '2026-04-10',
  },
];

// ============== TEMPLATES ==============
export const templates: Template[] = [
  {
    id: 'TPL-001', code: 'BOND', name: 'Bond', domain: 'securities',
    description: 'Fixed-income securities including corporate bonds, notes, and convertibles',
    entityCount: 1247,
    attributes: [
      { attributeId: 'ATTR-001', attributeCode: 'CUSIP', attributeName: 'CUSIP / Loan-X', required: true, displaySection: 'Identifiers', sortOrder: 1 },
      { attributeId: 'ATTR-002', attributeCode: 'ISIN', attributeName: 'ISIN', required: true, displaySection: 'Identifiers', sortOrder: 2 },
      { attributeId: 'ATTR-003', attributeCode: 'INSTRUMENT_TYPE', attributeName: 'Instrument Type', required: true, displaySection: 'Classification', sortOrder: 3 },
      { attributeId: 'ATTR-005', attributeCode: 'NOTIONAL', attributeName: 'Notional (Original)', required: true, displaySection: 'Terms', sortOrder: 4 },
      { attributeId: 'ATTR-006', attributeCode: 'MATURITY_DATE', attributeName: 'Maturity Date', required: true, displaySection: 'Terms', sortOrder: 5 },
      { attributeId: 'ATTR-008', attributeCode: 'COUPON_RATE', attributeName: 'Coupon Rate', required: true, displaySection: 'Terms', sortOrder: 6 },
      { attributeId: 'ATTR-016', attributeCode: 'REFERENCE_RATE', attributeName: 'Reference Rate', required: false, displaySection: 'Terms', sortOrder: 7 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-04-15',
  },
  {
    id: 'TPL-002', code: 'LOAN', name: 'Loan', domain: 'securities',
    description: 'Private credit instruments including term loans, revolvers, and unitranches',
    entityCount: 1423,
    attributes: [
      { attributeId: 'ATTR-001', attributeCode: 'CUSIP', attributeName: 'CUSIP / Loan-X', required: true, displaySection: 'Identifiers', sortOrder: 1 },
      { attributeId: 'ATTR-003', attributeCode: 'INSTRUMENT_TYPE', attributeName: 'Instrument Type', required: true, displaySection: 'Classification', sortOrder: 2 },
      { attributeId: 'ATTR-004', attributeCode: 'SENIORITY', attributeName: 'Seniority', required: true, displaySection: 'Classification', sortOrder: 3 },
      { attributeId: 'ATTR-005', attributeCode: 'NOTIONAL', attributeName: 'Notional (Original)', required: true, displaySection: 'Terms', sortOrder: 4 },
      { attributeId: 'ATTR-006', attributeCode: 'MATURITY_DATE', attributeName: 'Maturity Date', required: true, displaySection: 'Terms', sortOrder: 5 },
      { attributeId: 'ATTR-007', attributeCode: 'SPREAD_BPS', attributeName: 'Spread (bps)', required: true, displaySection: 'Terms', sortOrder: 6 },
      { attributeId: 'ATTR-016', attributeCode: 'REFERENCE_RATE', attributeName: 'Reference Rate', required: true, displaySection: 'Terms', sortOrder: 7 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-05-01',
  },
  {
    id: 'TPL-003', code: 'EQUITY', name: 'Equity', domain: 'securities',
    description: 'Equity securities including common stock, preferred, and warrants',
    entityCount: 312,
    attributes: [
      { attributeId: 'ATTR-001', attributeCode: 'CUSIP', attributeName: 'CUSIP / Loan-X', required: true, displaySection: 'Identifiers', sortOrder: 1 },
      { attributeId: 'ATTR-002', attributeCode: 'ISIN', attributeName: 'ISIN', required: true, displaySection: 'Identifiers', sortOrder: 2 },
      { attributeId: 'ATTR-003', attributeCode: 'INSTRUMENT_TYPE', attributeName: 'Instrument Type', required: true, displaySection: 'Classification', sortOrder: 3 },
      { attributeId: 'ATTR-005', attributeCode: 'NOTIONAL', attributeName: 'Notional (Original)', required: true, displaySection: 'Terms', sortOrder: 4 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-03-20',
  },
  {
    id: 'TPL-004', code: 'DERIVATIVE', name: 'Derivative', domain: 'securities',
    description: 'Derivative instruments including options, swaps, and structured products',
    entityCount: 122,
    attributes: [
      { attributeId: 'ATTR-001', attributeCode: 'CUSIP', attributeName: 'CUSIP / Loan-X', required: true, displaySection: 'Identifiers', sortOrder: 1 },
      { attributeId: 'ATTR-003', attributeCode: 'INSTRUMENT_TYPE', attributeName: 'Instrument Type', required: true, displaySection: 'Classification', sortOrder: 2 },
      { attributeId: 'ATTR-005', attributeCode: 'NOTIONAL', attributeName: 'Notional (Original)', required: true, displaySection: 'Terms', sortOrder: 3 },
      { attributeId: 'ATTR-006', attributeCode: 'MATURITY_DATE', attributeName: 'Maturity Date', required: true, displaySection: 'Terms', sortOrder: 4 },
    ],
    createdAt: '2024-02-15', updatedAt: '2026-04-01',
  },
  {
    id: 'TPL-005', code: 'CORPORATE', name: 'Corporate Issuer', domain: 'issuers',
    description: 'Corporate borrowing entities including operating companies and holding companies',
    entityCount: 1456,
    attributes: [
      { attributeId: 'ATTR-009', attributeCode: 'ISSUER_NAME', attributeName: 'Issuer Name', required: true, displaySection: 'Identity', sortOrder: 1 },
      { attributeId: 'ATTR-010', attributeCode: 'GICS_INDUSTRY', attributeName: 'GICS Industry', required: true, displaySection: 'Classification', sortOrder: 2 },
      { attributeId: 'ATTR-011', attributeCode: 'COUNTRY_OF_RISK', attributeName: 'Country of Risk', required: true, displaySection: 'Classification', sortOrder: 3 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-03-15',
  },
  {
    id: 'TPL-006', code: 'OPEN_END', name: 'Open-End Fund', domain: 'funds',
    description: 'Open-ended investment funds with daily NAV calculation',
    entityCount: 22,
    attributes: [
      { attributeId: 'ATTR-012', attributeCode: 'FUND_AUM', attributeName: 'AUM', required: true, displaySection: 'Performance', sortOrder: 1 },
      { attributeId: 'ATTR-013', attributeCode: 'FUND_NAV', attributeName: 'NAV per Unit', required: true, displaySection: 'Performance', sortOrder: 2 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-05-10',
  },
  {
    id: 'TPL-007', code: 'DIRECT_LENDING', name: 'Direct Lending', domain: 'deals',
    description: 'Direct lending transactions to middle-market companies',
    entityCount: 234,
    attributes: [
      { attributeId: 'ATTR-014', attributeCode: 'DEAL_SIZE', attributeName: 'Deal Size', required: true, displaySection: 'Terms', sortOrder: 1 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-04-25',
  },
  {
    id: 'TPL-008', code: 'PENSION', name: 'Pension Fund', domain: 'investors',
    description: 'Public and corporate pension fund investors',
    entityCount: 68,
    attributes: [
      { attributeId: 'ATTR-015', attributeCode: 'COMMITMENT', attributeName: 'Commitment', required: true, displaySection: 'Capital', sortOrder: 1 },
    ],
    createdAt: '2024-01-10', updatedAt: '2026-03-01',
  },
];

// ============== SOURCE CONFIGS ==============
export const sourceConfigs: SourceConfig[] = [
  {
    id: 'SRC-001', code: 'BLOOMBERG', name: 'Bloomberg', type: 'vendor',
    reliabilityScore: 97, syncSchedule: 'Daily 06:00 EST', enabled: true,
    connectionConfig: 'API Key: ****8f2a · Endpoint: blp-serial-v3',
    lastSync: '2026-05-21 06:14', nextSync: '2026-05-22 06:00',
    stats: { totalRecords: 4821, recordsToday: 142, errorRate: 0.3, avgLatency: 234 },
    qualityMetrics: { completeness: 98, accuracy: 97, timeliness: 96 },
  },
  {
    id: 'SRC-002', code: 'WSO', name: 'WSO', type: 'vendor',
    reliabilityScore: 94, syncSchedule: 'Daily 22:00 EST', enabled: true,
    connectionConfig: 'SFTP: wso-feed.private · Auth: SSH key',
    lastSync: '2026-05-20 22:00', nextSync: '2026-05-21 22:00',
    stats: { totalRecords: 3892, recordsToday: 98, errorRate: 0.8, avgLatency: 412 },
    qualityMetrics: { completeness: 95, accuracy: 94, timeliness: 93 },
  },
  {
    id: 'SRC-003', code: 'DEALCLOUD', name: 'DealCloud', type: 'vendor',
    reliabilityScore: 91, syncSchedule: 'Every 4 hours', enabled: true,
    connectionConfig: 'REST API: api.dealcloud.com/v2 · OAuth2',
    lastSync: '2026-05-21 08:00', nextSync: '2026-05-21 12:00',
    stats: { totalRecords: 2148, recordsToday: 34, errorRate: 1.2, avgLatency: 567 },
    qualityMetrics: { completeness: 92, accuracy: 91, timeliness: 89 },
  },
  {
    id: 'SRC-004', code: 'ALLVUE', name: 'Allvue', type: 'vendor',
    reliabilityScore: 99, syncSchedule: 'Daily 22:00 EST', enabled: true,
    connectionConfig: 'API Key: ****3c91 · Endpoint: api.allvue.com/v1',
    lastSync: '2026-05-20 22:00', nextSync: '2026-05-21 22:00',
    stats: { totalRecords: 1847, recordsToday: 67, errorRate: 0.1, avgLatency: 189 },
    qualityMetrics: { completeness: 99, accuracy: 99, timeliness: 98 },
  },
  {
    id: 'SRC-005', code: 'SPCIQ', name: 'S&P Capital IQ', type: 'vendor',
    reliabilityScore: 93, syncSchedule: 'Daily 06:30 EST', enabled: true,
    connectionConfig: 'API Key: ****7b4e · Endpoint: spcapitaliq.com/api',
    lastSync: '2026-05-21 06:30', nextSync: '2026-05-22 06:30',
    stats: { totalRecords: 3241, recordsToday: 88, errorRate: 0.6, avgLatency: 345 },
    qualityMetrics: { completeness: 94, accuracy: 93, timeliness: 92 },
  },
  {
    id: 'SRC-006', code: 'MANUAL', name: 'Manual Override', type: 'manual',
    reliabilityScore: 88, syncSchedule: 'On demand', enabled: true,
    connectionConfig: 'Internal UI · Steward entry',
    lastSync: '2026-05-19 14:22', nextSync: '—',
    stats: { totalRecords: 412, recordsToday: 3, errorRate: 2.1, avgLatency: 0 },
    qualityMetrics: { completeness: 85, accuracy: 92, timeliness: 78 },
  },
  {
    id: 'SRC-007', code: 'DERIVED', name: 'Derived', type: 'derived',
    reliabilityScore: 95, syncSchedule: 'Real-time', enabled: true,
    connectionConfig: 'Internal computation engine',
    lastSync: '2026-05-21 10:45', nextSync: 'Continuous',
    stats: { totalRecords: 1204, recordsToday: 214, errorRate: 0.2, avgLatency: 45 },
    qualityMetrics: { completeness: 96, accuracy: 95, timeliness: 99 },
  },
];

// ============== DQ RULES ==============
export const dqRules: DQRule[] = [
  {
    id: 'DQR-001', name: 'CUSIP Required for Securities', description: 'All active security records must have a valid CUSIP or Loan-X identifier',
    type: 'Availability', scope: 'attribute', scopeRef: 'ATTR-001', scopeLabel: 'CUSIP / Loan-X',
    threshold: 100, severity: 'high', enabled: true, exceptionCount: 12, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-03-01',
  },
  {
    id: 'DQR-002', name: 'Maturity Date Staleness', description: 'Maturity dates not updated in 30+ days should be flagged for review',
    type: 'Trajectory', scope: 'attribute', scopeRef: 'ATTR-006', scopeLabel: 'Maturity Date',
    threshold: 30, severity: 'high', enabled: true, exceptionCount: 24, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-03-15',
  },
  {
    id: 'DQR-003', name: 'Notional Tolerance Check', description: 'Notional values from different sources must be within 1% tolerance',
    type: 'Tolerance', scope: 'attribute', scopeRef: 'ATTR-005', scopeLabel: 'Notional (Original)',
    threshold: 1, severity: 'medium', enabled: true, exceptionCount: 8, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-04-01',
  },
  {
    id: 'DQR-004', name: 'Issuer Name Completeness', description: 'All issuer records must have a normalized legal name',
    type: 'Availability', scope: 'attribute', scopeRef: 'ATTR-009', scopeLabel: 'Issuer Name',
    threshold: 100, severity: 'high', enabled: true, exceptionCount: 38, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-03-01',
  },
  {
    id: 'DQR-005', name: 'Securities Domain Completeness', description: 'All securities records must have 90%+ of required fields populated',
    type: 'Availability', scope: 'domain', scopeRef: 'securities', scopeLabel: 'Securities',
    threshold: 90, severity: 'medium', enabled: true, exceptionCount: 41, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-02-15',
  },
  {
    id: 'DQR-006', name: 'Loan Template Quality', description: 'Loan template records must pass all validation rules at 95%+ rate',
    type: 'Tolerance', scope: 'template', scopeRef: 'LOAN', scopeLabel: 'Loan Template',
    threshold: 95, severity: 'medium', enabled: true, exceptionCount: 19, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-05-01',
  },
  {
    id: 'DQR-007', name: 'Spread Trajectory Monitor', description: 'Alert when spread values change by more than 50bps in a single sync',
    type: 'Trajectory', scope: 'attribute', scopeRef: 'ATTR-007', scopeLabel: 'Spread (bps)',
    threshold: 50, severity: 'low', enabled: false, exceptionCount: 0, lastEvaluated: '2026-05-20 06:00', createdAt: '2025-01-15',
  },
  {
    id: 'DQR-008', name: 'Fund NAV Completeness', description: 'All active funds must have current NAV within 2 business days',
    type: 'Availability', scope: 'template', scopeRef: 'OPEN_END', scopeLabel: 'Open-End Fund',
    threshold: 100, severity: 'high', enabled: true, exceptionCount: 3, lastEvaluated: '2026-05-21 06:00', createdAt: '2024-06-01',
  },
];

// ============== AUDIT LOG ==============
export const auditLog: AuditEntry[] = [
  { id: 'AUD-001', who: 'Bill Reagan', whoInitials: 'BR', action: 'Updated', field: 'Spread (bps)', oldValue: '575', newValue: '600', timestamp: '2026-05-17 09:08', source: 'Manual Override' },
  { id: 'AUD-002', who: 'System', whoInitials: 'SY', action: 'Sync completed', timestamp: '2026-05-20 22:00', source: 'WSO' },
  { id: 'AUD-003', who: 'Bill Reagan', whoInitials: 'BR', action: 'Reviewed', timestamp: '2026-05-19 14:22', source: 'Manual' },
  { id: 'AUD-004', who: 'Alice Jin', whoInitials: 'AJ', action: 'Conflict detected', field: 'Issuer Name', timestamp: '2026-05-16 11:30', source: 'System' },
  { id: 'AUD-005', who: 'System', whoInitials: 'SY', action: 'Precedence rule applied', field: 'Instrument Type', oldValue: 'Term Loan', newValue: 'Unitranche', timestamp: '2026-05-15 22:05', source: 'RULE-SEC-001' },
  { id: 'AUD-006', who: 'Bill Reagan', whoInitials: 'BR', action: 'Created entity', timestamp: '2026-05-10 09:15', source: 'Manual' },
  { id: 'AUD-007', who: 'System', whoInitials: 'SY', action: 'Sync completed', timestamp: '2026-05-20 06:14', source: 'Bloomberg' },
  { id: 'AUD-008', who: 'Carlos Mendez', whoInitials: 'CM', action: 'Updated', field: 'AUM', oldValue: '$2.1B', newValue: '$2.4B', timestamp: '2026-05-18 16:45', source: 'Allvue' },
];

// ============== LINEAGE DATA ==============
export const attributeLineage: LineageEntry[] = [
  {
    id: 'LIN-001', source: 'wso', sourceName: 'WSO', value: '575',
    validFrom: '2026-04-02', validTo: null, systemTime: '2026-05-15 22:00',
    ruleApplied: 'RULE-SEC-018', isGolden: true, superseded: false,
  },
  {
    id: 'LIN-002', source: 'manual', sourceName: 'Manual Override', value: '600',
    validFrom: '2026-05-17', validTo: null, systemTime: '2026-05-17 09:08',
    ruleApplied: 'Manual override (pending review)', isGolden: false, superseded: false,
  },
  {
    id: 'LIN-003', source: 'wso', sourceName: 'WSO', value: '550',
    validFrom: '2026-01-15', validTo: '2026-04-02', systemTime: '2026-01-15 22:00',
    ruleApplied: 'RULE-SEC-018', isGolden: false, superseded: true,
  },
  {
    id: 'LIN-004', source: 'bloomberg', sourceName: 'Bloomberg', value: '—',
    validFrom: '2026-01-01', validTo: null, systemTime: '2026-05-20 06:14',
    ruleApplied: 'Not covered for loan instruments', isGolden: false, superseded: false,
  },
  {
    id: 'LIN-005', source: 'wso', sourceName: 'WSO', value: '525',
    validFrom: '2025-09-01', validTo: '2026-01-15', systemTime: '2025-09-01 22:00',
    ruleApplied: 'RULE-SEC-018', isGolden: false, superseded: true,
  },
  {
    id: 'LIN-006', source: 'dealcloud', sourceName: 'DealCloud', value: '575',
    validFrom: '2024-12-10', validTo: null, systemTime: '2026-05-20 22:00',
    ruleApplied: 'Confirms WSO value', isGolden: false, superseded: false,
  },
];

// ============== HELPER FUNCTIONS ==============
export function getAttributesForDomain(domain: DomainKey): Attribute[] {
  return attributes.filter(a => a.domain === domain);
}

export function getTemplatesForDomain(domain: DomainKey): Template[] {
  return templates.filter(t => t.domain === domain);
}

export function getTemplateByCode(code: string): Template | undefined {
  return templates.find(t => t.code === code);
}

export function getAttributeById(id: string): Attribute | undefined {
  return attributes.find(a => a.id === id);
}

export function formatAttrValue(attr: Attribute, value: string): string {
  if (!value) return '—';
  switch (attr.dataType) {
    case 'FLOAT': return attr.unitOfMeasure === 'USD' ? `$${Number(value).toLocaleString()}` : `${value}${attr.unitOfMeasure ? ' ' + attr.unitOfMeasure : ''}`;
    case 'INTEGER': return attr.unitOfMeasure === 'bps' ? `${value} bps` : value;
    case 'DATE': return value;
    default: return value;
  }
}
