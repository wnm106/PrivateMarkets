const DOMAIN_ROUTES: Record<string, string> = {
  FUND: 'funds',
  ISSUER: 'issuers',
  SECURITY: 'securities',
  DEAL: 'deals',
  INVESTOR: 'investors',
  PRICE: 'prices',
  POSITION: 'positions',
};

/** List-page path for a domain code. Unknown codes keep the historical fallback. */
export function domainHref(domainCode: string) {
  const route = DOMAIN_ROUTES[domainCode] || `${domainCode.toLowerCase()}s`;
  return `/${route}`;
}
