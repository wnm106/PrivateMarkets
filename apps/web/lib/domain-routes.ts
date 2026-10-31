const DOMAIN_ROUTES: Record<string, string> = {
  FUND: 'funds',
  ISSUER: 'issuers',
  SECURITY: 'securities',
  DEAL: 'deals',
  SPONSOR: 'sponsors',
  DEAL_TRANCHE: 'tranches',
  DEAL_MEMO_POINT: 'memo-points',
  DEAL_CAPITAL_ITEM: 'capital-items',
  FINANCIAL_PERIOD: 'financial-periods',
  IC_APPROVAL: 'approvals',
  DEAL_OPEN_ITEM: 'open-items',
  INVESTOR: 'investors',
  INVESTOR_COMMITMENT: 'investor-commitments',
  CAPITAL_ACTIVITY: 'capital-activity',
  CAPITAL_PLAN: 'capital-plans',
  NAV_STATEMENT: 'nav-statements',
  NAV_LINE: 'nav-lines',
  CREDIT_FACILITY: 'credit-facilities',
  CASH_FORECAST: 'cash-forecasts',
  EXPOSURE_LIMIT: 'exposure-limits',
  PRICE: 'prices',
  POSITION: 'positions',
  CASH_FLOW: 'cash_flows',
};

/** Same palette as Entity Type cards. Unknown domains use the neutral mark. */
const DOMAIN_COLORS: Record<string, string> = {
  FUND: '#1b3a4b',
  ISSUER: '#6d28d9',
  SECURITY: '#c2410c',
  DEAL: '#047857',
  INVESTOR: '#be185d',
  POSITION: '#0369a1',
};

export function domainColor(domainCode: string) {
  return DOMAIN_COLORS[domainCode] || '#6b7280';
}

/** List-page path for a domain code. Unknown codes keep the historical fallback. */
export function domainHref(domainCode: string) {
  const route = DOMAIN_ROUTES[domainCode] || `${domainCode.toLowerCase()}s`;
  return `/${route}`;
}

/** Domain code when `route` is a known list segment. Unknown paths return null. */
export function knownDomainCode(route: string): string | null {
  const normalized = route.replace(/-/g, '_');
  const known = Object.entries(DOMAIN_ROUTES).find(([, path]) => path === route || path === normalized);
  return known ? known[0] : null;
}

/** Domain code for a list-page segment such as "prices" or "cash_flows". */
export function domainCodeFromRoute(route: string) {
  const normalized = route.replace(/-/g, '_');
  const known = Object.entries(DOMAIN_ROUTES).find(([, path]) => path === route || path === normalized);
  if (known) return known[0];
  const stem = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
  return stem.toUpperCase();
}
