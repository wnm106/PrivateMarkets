// ============== SOURCES ==============
export const sources = {
  bloomberg: { name: 'Bloomberg', color: '#c2410c', hex: '#c2410c' },
  wso: { name: 'WSO', color: '#6d28d9', hex: '#6d28d9' },
  dealcloud: { name: 'DealCloud', color: '#0369a1', hex: '#0369a1' },
  allvue: { name: 'Allvue', color: '#047857', hex: '#047857' },
  spciq: { name: 'S&P Capital IQ', color: '#be185d', hex: '#be185d' },
  manual: { name: 'Manual Override', color: '#b45309', hex: '#b45309' },
  derived: { name: 'Derived', color: '#475569', hex: '#475569' },
} as const;

export type SourceKey = keyof typeof sources;

// ============== ENTITIES ==============
export const entities = [
  { key: 'funds', name: 'Funds', icon: 'F', count: 47, color: '#1b3a4b', desc: 'Investment vehicles, AUM, fee structures, lifecycle states', sources: ['Allvue', 'DealCloud', 'Manual'], quality: 96, trend: 1.2, stewards: 3 },
  { key: 'issuers', name: 'Issuers', icon: 'I', count: 1842, color: '#6d28d9', desc: 'Borrower entities, parent / subsidiary hierarchies, KYC', sources: ['Bloomberg', 'S&P Capital IQ', 'WSO', 'Manual'], quality: 89, trend: 2.4, stewards: 5 },
  { key: 'securities', name: 'Securities', icon: 'S', count: 3104, color: '#c2410c', desc: 'Bonds, loans, equity — the multi-source instrument master', sources: ['Bloomberg', 'WSO', 'S&P', 'Manual'], quality: 92, trend: 0.8, stewards: 4 },
  { key: 'deals', name: 'Deals', icon: 'D', count: 612, color: '#047857', desc: 'Pipeline, closed transactions, IC memos, allocation', sources: ['DealCloud', 'WSO', 'Manual'], quality: 94, trend: 3.1, stewards: 6 },
  { key: 'investors', name: 'Investors', icon: 'V', count: 218, color: '#be185d', desc: 'LPs, commitments, KYC documentation, capital activity', sources: ['DealCloud', 'Allvue', 'Manual'], quality: 91, trend: -0.3, stewards: 2 },
];

// ============== SECURITIES RECORDS ==============
export const securitiesRecords = [
  { id: 'SEC-00412', name: 'Acme Industrial Corp 7.25% Sr. Sec. Notes 2029', type: 'Bond', typeClass: 'bond', issuer: 'Acme Industrial Corp', ccy: 'USD', notional: 285000000, primary: 'bloomberg' as SourceKey, conflicts: 2, quality: 98, trajectory: 'up' as const },
  { id: 'SEC-00413', name: 'Northstar Health Term Loan B 2028', type: 'Term Loan B', typeClass: 'loan', issuer: 'Northstar Health Holdings', ccy: 'USD', notional: 425000000, primary: 'wso' as SourceKey, conflicts: 0, quality: 95, trajectory: 'flat' as const },
  { id: 'SEC-00414', name: 'BlueRiver Energy Unitranche 2030', type: 'Unitranche', typeClass: 'loan', issuer: 'BlueRiver Energy LLC', ccy: 'USD', notional: 180000000, primary: 'wso' as SourceKey, conflicts: 3, quality: 78, trajectory: 'down' as const },
  { id: 'SEC-00415', name: 'Meridian Tech 5.875% Conv. 2027', type: 'Convertible', typeClass: 'bond', issuer: 'Meridian Tech Inc.', ccy: 'USD', notional: 150000000, primary: 'bloomberg' as SourceKey, conflicts: 1, quality: 91, trajectory: 'up' as const },
  { id: 'SEC-00416', name: 'Harborline Logistics 2nd Lien 2031', type: 'Second Lien', typeClass: 'loan', issuer: 'Harborline Logistics Corp', ccy: 'USD', notional: 95000000, primary: 'wso' as SourceKey, conflicts: 0, quality: 88, trajectory: 'up' as const },
  { id: 'SEC-00417', name: 'Vector Pharma 6.50% Sr. Unsec. Notes 2030', type: 'Bond', typeClass: 'bond', issuer: 'Vector Pharma Group', ccy: 'EUR', notional: 320000000, primary: 'bloomberg' as SourceKey, conflicts: 0, quality: 99, trajectory: 'flat' as const },
  { id: 'SEC-00418', name: 'Cardinal Foods Delayed Draw TL', type: 'DDTL', typeClass: 'loan', issuer: 'Cardinal Foods Holdings', ccy: 'USD', notional: 60000000, primary: 'wso' as SourceKey, conflicts: 2, quality: 82, trajectory: 'up' as const },
  { id: 'SEC-00419', name: 'Summit Manufacturing Revolver 2029', type: 'Revolver', typeClass: 'loan', issuer: 'Summit Manufacturing LP', ccy: 'USD', notional: 75000000, primary: 'wso' as SourceKey, conflicts: 1, quality: 90, trajectory: 'flat' as const },
];

// ============== GOLDEN RECORD ==============
export const goldenRecord = {
  header: {
    id: 'SEC-00414',
    name: 'BlueRiver Energy Unitranche 2030',
    type: 'Unitranche Term Loan',
    status: 'Active',
    lastReviewed: '2 days ago',
    quality: 78,
  },
  sections: [
    {
      name: 'Instrument Identifiers',
      fields: [
        { label: 'Security ID', value: 'SEC-00414', source: 'derived' as SourceKey },
        { label: 'CUSIP / Loan-X', value: 'LX1284AB7', source: 'wso' as SourceKey, alt: 1 },
        { label: 'ISIN', value: 'US12849ABCD7', source: 'bloomberg' as SourceKey },
        { label: 'Ticker / Facility', value: 'BLURIV-UT-2030', source: 'wso' as SourceKey },
      ],
    },
    {
      name: 'Instrument Terms',
      fields: [
        { label: 'Instrument Type', value: 'Unitranche', source: 'wso' as SourceKey, standardized: true },
        { label: 'Seniority', value: 'Senior Secured', source: 'wso' as SourceKey, standardized: true },
        { label: 'Notional (Original)', value: '$180,000,000', source: 'wso' as SourceKey },
        { label: 'Maturity Date', value: '2030-09-15', source: 'wso' as SourceKey, alt: 1 },
        { label: 'Reference Rate', value: 'Term SOFR', source: 'wso' as SourceKey, standardized: true },
        { label: 'Spread (bps)', value: '575', source: 'wso' as SourceKey, conflict: true, alt: 1 },
      ],
    },
    {
      name: 'Issuer & Hierarchy',
      fields: [
        { label: 'Issuer Name', value: 'BlueRiver Energy LLC', source: 'manual' as SourceKey, conflict: true, alt: 2 },
        { label: 'Parent Entity', value: 'BlueRiver Holdings Inc.', source: 'spciq' as SourceKey },
        { label: 'Industry (GICS)', value: 'Energy Equipment & Services', source: 'spciq' as SourceKey, standardized: true },
        { label: 'Country of Risk', value: 'United States', source: 'bloomberg' as SourceKey, standardized: true },
      ],
    },
    {
      name: 'Ratings & Risk',
      fields: [
        { label: 'S&P Rating', value: 'B+', source: 'spciq' as SourceKey, standardized: true },
        { label: "Moody's Rating", value: 'B2', source: 'bloomberg' as SourceKey, standardized: true },
        { label: 'Internal Rating', value: '4 (Watch)', source: 'manual' as SourceKey, standardized: true },
        { label: 'PD (1Y)', value: '4.8%', source: 'derived' as SourceKey },
      ],
    },
    {
      name: 'Holdings & Allocation',
      fields: [
        { label: 'Held by Funds', value: 'Alpha Direct Lending III, Alpha Opp. Credit II', source: 'allvue' as SourceKey },
        { label: 'Position (Par)', value: '$45,000,000', source: 'allvue' as SourceKey },
        { label: 'Originating Deal', value: 'DEAL-2024-0182', source: 'dealcloud' as SourceKey },
      ],
    },
  ],
};

// ============== FIELD CANDIDATES (for drill-down) ==============
export interface Candidate {
  src: SourceKey;
  value: string;
  updated: string;
  synced: string;
  reliability: number | null;
  status: 'winner' | 'applied' | 'eligible' | 'skipped' | 'no-data';
  stale?: boolean;
  divergent?: boolean;
  muted?: boolean;
  confirms?: boolean;
  listMapped?: string;
  note?: string;
}

export interface FieldDrilldown {
  rule: string;
  candidates: Candidate[];
}

export const fieldCandidates: Record<string, FieldDrilldown> = {
  'CUSIP / Loan-X': {
    rule: 'RULE-SEC-003 · WSO authoritative for loan identifiers',
    candidates: [
      { src: 'wso', value: 'LX1284AB7', updated: '2026-05-15', synced: '2026-05-20 22:00', reliability: 94, status: 'winner' },
      { src: 'bloomberg', value: '— Not covered', muted: true, updated: '—', synced: '2026-05-20 06:14', reliability: 97, status: 'no-data' },
      { src: 'spciq', value: 'LX1284AB7', updated: '2026-04-30', synced: '2026-05-20 06:14', reliability: 93, status: 'eligible' },
    ],
  },
  'Maturity Date': {
    rule: 'RULE-SEC-021 · WSO → Bloomberg → Manual',
    candidates: [
      { src: 'wso', value: '2030-09-15', updated: '2026-04-02', synced: '2026-05-20 22:00', reliability: 94, status: 'winner' },
      { src: 'bloomberg', value: '2030-09-30', updated: '2026-03-15', synced: '2026-05-20 06:14', reliability: 97, status: 'eligible', stale: true, divergent: true },
      { src: 'manual', value: '—', muted: true, updated: '—', synced: '—', reliability: null, status: 'no-data' },
    ],
  },
  'Spread (bps)': {
    rule: 'RULE-SEC-018 · WSO (loans) → Manual → Bloomberg',
    candidates: [
      { src: 'wso', value: '575', updated: '2026-05-15', synced: '2026-05-20 22:00', reliability: 94, status: 'winner' },
      { src: 'manual', value: '600', updated: '2026-05-17', synced: '2026-05-17 09:08', reliability: 100, status: 'eligible', divergent: true, note: 'Pending review' },
      { src: 'bloomberg', value: '— Not covered', muted: true, updated: '—', synced: '2026-05-20 06:14', reliability: 97, status: 'no-data' },
    ],
  },
  'Issuer Name': {
    rule: 'RULE-ISS-042 · Manual override when set, else SPCIQ → Bloomberg → WSO',
    candidates: [
      { src: 'manual', value: 'BlueRiver Energy LLC', updated: '2026-05-19', synced: '2026-05-19 14:22', reliability: 100, status: 'winner', note: 'Override by B. Reagan' },
      { src: 'spciq', value: 'BlueRiver Energy, LLC', updated: '2026-05-10', synced: '2026-05-20 06:14', reliability: 93, status: 'eligible', divergent: true },
      { src: 'bloomberg', value: 'Blue River Energy LLC', updated: '2026-04-22', synced: '2026-05-20 06:14', reliability: 97, status: 'eligible', divergent: true },
      { src: 'wso', value: 'BlueRiver Energy, LLC.', updated: '2026-05-15', synced: '2026-05-20 22:00', reliability: 94, status: 'eligible', divergent: true },
    ],
  },
  'Instrument Type': {
    rule: 'RULE-SEC-001 · WSO primary for loans, normalized via list STD_INST',
    candidates: [
      { src: 'wso', value: 'Unitranche', updated: '2026-05-15', synced: '2026-05-20 22:00', reliability: 94, status: 'winner', listMapped: 'STD_INST.UNITR' },
      { src: 'bloomberg', value: 'Term Loan', updated: '2026-04-22', synced: '2026-05-20 06:14', reliability: 97, status: 'skipped', listMapped: 'STD_INST.TL (mismatch)' },
      { src: 'spciq', value: 'Senior Secured Loan', updated: '2026-05-01', synced: '2026-05-20 06:14', reliability: 93, status: 'skipped', listMapped: 'STD_INST.SSL (alt)' },
    ],
  },
  'Notional (Original)': {
    rule: 'RULE-SEC-009 · WSO authoritative for loan notional',
    candidates: [
      { src: 'wso', value: '$180,000,000', updated: '2026-05-15', synced: '2026-05-20 22:00', reliability: 94, status: 'winner' },
      { src: 'allvue', value: '$180,000,000', updated: '2026-05-18', synced: '2026-05-20 22:00', reliability: 99, status: 'eligible', confirms: true },
      { src: 'dealcloud', value: '$180,000,000', updated: '2024-12-10', synced: '2026-05-20 22:00', reliability: 91, status: 'eligible', confirms: true },
    ],
  },
};

export function getFieldDrilldown(fieldLabel: string, winningSource: SourceKey, winningValue: string): FieldDrilldown {
  if (fieldCandidates[fieldLabel]) return fieldCandidates[fieldLabel];
  return {
    rule: 'Domain default precedence rule applies',
    candidates: [
      { src: winningSource, value: winningValue, updated: '2026-05-15', synced: '2026-05-20 22:00', reliability: 95, status: 'winner' },
      { src: 'manual', value: '—', muted: true, updated: '—', synced: '—', reliability: null, status: 'no-data' },
    ],
  };
}

// ============== PRECEDENCE RULES ==============
export const precedenceRules = [
  { field: 'Spread (bps)', cond: 'WHEN Instrument Type IN (Term Loan B, Unitranche, Revolver, DDTL, Second Lien)', chain: ['wso', 'manual', 'bloomberg'] as SourceKey[], note: 'Loan products primary from WSO; Bloomberg coverage limited' },
  { field: 'Spread (bps)', cond: 'WHEN Instrument Type IN (Bond, Convertible, Note)', chain: ['bloomberg', 'spciq', 'manual'] as SourceKey[], note: 'Public bond instruments primary from Bloomberg' },
  { field: 'Maturity Date', cond: 'ALWAYS (no conditions)', chain: ['wso', 'bloomberg', 'manual'] as SourceKey[], note: 'WSO authoritative for loan paper; falls back to Bloomberg' },
  { field: 'Issuer Name', cond: 'WHEN Manual Override IS NOT NULL', chain: ['manual', 'spciq', 'bloomberg', 'wso'] as SourceKey[], note: 'Manual overrides win for legal name normalization' },
  { field: 'GICS Industry', cond: 'ALWAYS', chain: ['spciq', 'bloomberg'] as SourceKey[], note: 'S&P Capital IQ is GICS publisher of record', standardized: true },
  { field: 'S&P Rating', cond: 'ALWAYS', chain: ['spciq', 'bloomberg'] as SourceKey[], note: 'S&P primary for own ratings', standardized: true },
  { field: 'Position (Par)', cond: 'ALWAYS', chain: ['allvue'] as SourceKey[], note: 'Allvue is sole authority for fund holdings' },
];

// ============== QUALITY MATRIX ==============
export const qualityMatrix = [
  { ent: 'Funds', avail: 99, qual: 96, traj: 1.2, exc: 3, spark: [88, 90, 92, 93, 95, 95, 96] },
  { ent: 'Issuers', avail: 91, qual: 89, traj: 2.4, exc: 62, spark: [82, 84, 85, 86, 87, 88, 89] },
  { ent: 'Securities', avail: 95, qual: 92, traj: 0.8, exc: 41, spark: [89, 90, 90, 91, 91, 92, 92] },
  { ent: 'Deals', avail: 97, qual: 94, traj: 3.1, exc: 28, spark: [85, 87, 89, 91, 92, 93, 94] },
  { ent: 'Investors', avail: 93, qual: 91, traj: -0.3, exc: 13, spark: [92, 92, 92, 92, 91, 91, 91] },
];

// ============== STANDARDIZED LISTS ==============
export const standardizedLists = [
  { name: 'Instrument Type', count: 18, mapped: 84, unmapped: 2, sources: ['Bloomberg', 'WSO'] },
  { name: 'Seniority', count: 7, mapped: 23, unmapped: 0, sources: ['WSO', 'Bloomberg'] },
  { name: 'Reference Rate', count: 12, mapped: 41, unmapped: 1, sources: ['WSO', 'Bloomberg'] },
  { name: 'GICS Industry (L2)', count: 69, mapped: 142, unmapped: 8, sources: ['S&P Capital IQ'] },
  { name: 'Country of Risk', count: 195, mapped: 89, unmapped: 0, sources: ['Bloomberg', 'S&P'] },
  { name: 'S&P Rating Scale', count: 22, mapped: 22, unmapped: 0, sources: ['S&P Capital IQ'] },
  { name: 'Internal Rating', count: 8, mapped: 8, unmapped: 0, sources: ['Manual'] },
  { name: 'Deal Status', count: 11, mapped: 28, unmapped: 5, sources: ['DealCloud', 'WSO'] },
  { name: 'Fund Lifecycle Stage', count: 6, mapped: 14, unmapped: 0, sources: ['Allvue', 'DealCloud'] },
];

// ============== TOP EXCEPTION RULES ==============
export const topExceptions = [
  { rule: 'Issuer Name normalization mismatch', count: 38, sev: 'med' as const },
  { rule: 'Maturity Date stale (>30 days)', count: 24, sev: 'high' as const },
  { rule: 'GICS Industry missing or unmapped', count: 19, sev: 'med' as const },
  { rule: 'Internal Rating not set on Active record', count: 14, sev: 'high' as const },
  { rule: 'Position (Par) mismatch vs Allvue', count: 11, sev: 'high' as const },
];

// ============== SOURCE RELIABILITY ==============
export const sourceReliability = [
  { src: 'allvue' as SourceKey, score: 99, delta: 0.1 },
  { src: 'bloomberg' as SourceKey, score: 97, delta: 0.3 },
  { src: 'wso' as SourceKey, score: 94, delta: 1.1 },
  { src: 'spciq' as SourceKey, score: 93, delta: -0.2 },
  { src: 'dealcloud' as SourceKey, score: 91, delta: 0.8 },
  { src: 'manual' as SourceKey, score: 88, delta: -1.4 },
];

// ============== SOURCE CONTRIBUTION (for record detail rail) ==============
export const sourceContribution = [
  { src: 'wso' as SourceKey, pct: 48, count: 11 },
  { src: 'bloomberg' as SourceKey, pct: 17, count: 4 },
  { src: 'spciq' as SourceKey, pct: 13, count: 3 },
  { src: 'manual' as SourceKey, pct: 9, count: 2 },
  { src: 'allvue' as SourceKey, pct: 9, count: 2 },
  { src: 'dealcloud' as SourceKey, pct: 4, count: 1 },
];

// ============== ACTIVITY FEED ==============
export const activityFeed = [
  { who: 'BR', time: '2h ago', txt: 'Manual override on Spread (bps) → 600' },
  { who: 'SY', time: '1d ago', txt: 'WSO sync updated 6 fields' },
  { who: 'BR', time: '2d ago', txt: 'Reviewed record · marked Watch' },
  { who: 'AJ', time: '5d ago', txt: 'New conflict detected on Issuer Name' },
];

// ============== HELPERS ==============
export function qualityColor(q: number): string {
  if (q >= 95) return 'var(--green)';
  if (q >= 85) return 'var(--accent-2)';
  if (q >= 75) return 'var(--amber)';
  return 'var(--red)';
}

export function fmtDollar(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  return '$' + (n / 1e6).toFixed(1) + 'M';
}

export function daysAgo(dateStr: string): string {
  if (!dateStr || dateStr === '—') return '';
  const then = new Date(dateStr);
  const now = new Date('2026-05-21');
  const days = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
