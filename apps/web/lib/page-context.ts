import { knownDomainCode } from './domain-routes';

export interface RouteChatContext {
  page: string;
  domainCode?: string;
  entityId?: string;
  attributeCode?: string;
}

const PAGES: Record<string, string> = {
  '/': 'Master data overview',
  '/quality': 'Data quality',
  '/reconcile': 'Reconciliation',
  '/imports': 'Load data',
  '/lists': 'Value lists',
  '/intersections': 'Composite entities',
  '/resolve': 'Resolve',
  '/profile': 'Profile',
  '/admin': 'Admin',
  '/admin/entities': 'Entity management',
  '/admin/sources': 'Data sources',
  '/admin/attributes': 'Attributes',
  '/admin/expression-functions': 'Expression functions',
  '/admin/templates': 'Templates',
  '/admin/templates/studio': 'Template studio',
  '/admin/layouts': 'Display layouts',
  '/admin/dq-rules': 'Data quality rules',
  '/admin/compliance': 'Compliance rules',
  '/admin/compliance/funds': 'Fund thresholds',
  '/admin/dashboards': 'Dashboards',
  '/admin/narratives': 'Narratives',
  '/admin/skills': 'Skills',
  '/admin/tenancy': 'Clients, users, and roles',
};

const DOMAIN_LABELS: Record<string, string> = {
  FUND: 'Funds',
  ISSUER: 'Issuers',
  SECURITY: 'Securities',
  DEAL: 'Deals',
  INVESTOR: 'Investors',
  PRICE: 'Prices',
  POSITION: 'Positions',
  CASH_FLOW: 'Cash flows',
};

function domainLabel(domainCode: string) {
  return DOMAIN_LABELS[domainCode] || domainCode.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pretty(segment: string) {
  return segment
    .split('-')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/** Where the user has navigated, derived from the URL alone. */
export function routeChatContext(pathname: string): RouteChatContext {
  const path = (pathname.split('?')[0] || '/').replace(/\/$/, '') || '/';
  const named = PAGES[path];
  if (named) return { page: named };

  const parts = path.split('/').filter(Boolean);
  const domainCode = parts[0] ? knownDomainCode(parts[0]) : null;
  if (domainCode) {
    const label = domainLabel(domainCode);
    if (parts.length === 1) return { page: label, domainCode };
    if (parts[1] === 'new') return { page: `New ${label.replace(/s$/, '')}`, domainCode };
    const entityId = parts[1];
    if (parts[2] === 'edit') return { page: `Editing a ${label.replace(/s$/, '').toLowerCase()}`, domainCode, entityId };
    if (parts[2] === 'lineage' && parts[3]) {
      return { page: `${parts[3]} lineage`, domainCode, entityId, attributeCode: decodeURIComponent(parts[3]) };
    }
    return { page: label, domainCode, entityId };
  }

  if (parts[0] === 'admin' && parts[1] === 'entities' && parts[2]) {
    const code = decodeURIComponent(parts[2]).toUpperCase();
    return { page: `${domainLabel(code)} entity type`, domainCode: code };
  }
  if (parts[0] === 'admin' && parts[1] === 'compliance' && parts[2] === 'funds') {
    return { page: 'Fund thresholds' };
  }
  if (parts[0] === 'admin' && parts[1] === 'compliance' && parts[2]) {
    return { page: `Compliance rule ${decodeURIComponent(parts[2])}` };
  }
  if (parts[0] === 'admin' && parts[1] === 'dashboards' && parts[2]) {
    return { page: `Dashboard ${decodeURIComponent(parts[2])}` };
  }
  if (parts[0] === 'admin' && parts[1] === 'narratives' && parts[2]) {
    return { page: `Narrative ${decodeURIComponent(parts[2])}` };
  }
  if (parts[0] === 'admin' && parts[1] === 'skills' && parts[2]) {
    return { page: `Skill ${decodeURIComponent(parts[2])}` };
  }
  if (parts[0] === 'admin' && parts[1] === 'templates' && parts[2] === 'studio') {
    return { page: 'Template studio' };
  }
  if (parts[0] === 'admin' && parts[1] === 'templates' && parts[3] === 'precedence') {
    return { page: 'Template precedence' };
  }
  if (parts[0] === 'lists' && parts[1]) {
    return { page: `Value list ${decodeURIComponent(parts[1])}` };
  }
  if (parts[0] === 'reconcile' && parts[1]) {
    return { page: 'Reconciliation run' };
  }

  return { page: parts.map((segment) => pretty(decodeURIComponent(segment))).join(' / ') || 'Master data' };
}
