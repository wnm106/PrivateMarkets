'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { SKILL_NAV } from '@/lib/skill-catalog';
import { BrandLogo } from './BrandLogo';
import { UserMenu } from './UserMenu';

interface DomainLink {
  code: string;
  name: string;
  href: string;
  count: number;
}

const TOOLS = [
  { href: '/pipeline', label: 'Deal Pipeline', icon: 'layers' },
  { href: '/quality', label: 'Data Quality', icon: 'chart' },
  { href: '/merge', label: 'Entity Resolution', icon: 'nodes' },
  { href: '/reconcile', label: 'Reconcile', icon: 'chart' },
  { href: '/lists', label: 'Value Lists', icon: 'layers' },
  { href: '/intersections', label: 'Composite Entities', icon: 'nodes' },
  { href: '/imports', label: 'Load data', icon: 'download' },
] as const;

const ADMIN = [
  { href: '/admin/entities', label: 'Entity Management', icon: 'domains' },
  { href: '/admin/sources', label: 'Data Sources', icon: 'sources' },
  { href: '/admin/attributes', label: 'Attributes', icon: 'list' },
  { href: '/admin/templates/studio', label: 'Statement Studio', icon: 'chart' },
  { href: '/admin/expression-functions', label: 'Expression Functions', icon: 'list' },
  { href: '/admin/templates', label: 'Templates', icon: 'layers' },
  { href: '/admin/layouts', label: 'Display Layouts', icon: 'domains' },
  { href: '/admin/dq-rules', label: 'DQ Rules', icon: 'alert' },
  { href: '/admin/compliance', label: 'Compliance Rules', icon: 'list' },
  { href: '/admin/dashboards', label: 'Dashboards', icon: 'chart' },
  { href: '/admin/experiences', label: 'Record Experiences', icon: 'domains' },
  { href: '/admin/narratives', label: 'Narratives', icon: 'list' },
  { href: '/admin/skills', label: 'Skills', icon: 'list' },
  { href: '/admin/tenancy', label: 'Clients, Users & Roles', icon: 'users' },
] as const;

const COLLAPSED_KEY = 'tapestr-nav-collapsed';
const TOOLS_KEY = 'tapestr-nav-tools';
const DOMAINS_KEY = 'tapestr-nav-domains';
const ADMIN_KEY = 'tapestr-nav-admin';

type NavSection = 'domains' | 'tools' | 'admin';

function writeOpenSection(section: NavSection | null) {
  try {
    localStorage.setItem(DOMAINS_KEY, section === 'domains' ? '1' : '0');
    localStorage.setItem(TOOLS_KEY, section === 'tools' ? '1' : '0');
    localStorage.setItem(ADMIN_KEY, section === 'admin' ? '1' : '0');
  } catch {
    /* Storage can be unavailable in private modes. */
  }
}

function readOpenSection(): NavSection | null {
  const domains = localStorage.getItem(DOMAINS_KEY) !== '0';
  const tools = localStorage.getItem(TOOLS_KEY) !== '0';
  const admin = localStorage.getItem(ADMIN_KEY) === '1';
  const open: NavSection[] = [];
  if (domains) open.push('domains');
  if (tools) open.push('tools');
  if (admin) open.push('admin');
  const chosen = open[0] ?? null;
  if (open.length > 1) writeOpenSection(chosen);
  return chosen;
}

function navActive(pathname: string, href: string, exact = false) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function adminLinkActive(pathname: string, href: string) {
  if (href === '/admin/templates' && (pathname === '/admin/templates/studio' || pathname.startsWith('/admin/templates/studio/'))) {
    return false;
  }
  if (href === '/admin/skills') return pathname === '/admin/skills';
  return navActive(pathname, href);
}

function NavIcon({ name }: { name: string }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...props}>
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
        </svg>
      );
    case 'domains':
      return (
        <svg {...props}>
          <path d="M4 7h7v6H4zM13 7h7v4h-7zM13 13h7v4h-7zM4 15h7v4H4z" />
        </svg>
      );
    case 'sources':
      return (
        <svg {...props}>
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
          <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
        </svg>
      );
    case 'alert':
      return (
        <svg {...props}>
          <path d="M12 4 3.5 19h17L12 4z" />
          <path d="M12 10v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    case 'list':
      return (
        <svg {...props}>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="M4 6h.01M4 12h.01M4 18h.01" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...props}>
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <path d="m7 14 4-4 3 3 5-6" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...props}>
          <path d="m12 3 9 5-9 5-9-5 9-5z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 17 9 5 9-5" />
        </svg>
      );
    case 'nodes':
      return (
        <svg {...props}>
          <circle cx="6" cy="7" r="2.2" />
          <circle cx="18" cy="7" r="2.2" />
          <circle cx="12" cy="17" r="2.2" />
          <path d="M8 8.2 10.6 15M16 8.2 13.4 15" />
        </svg>
      );
    case 'download':
      return (
        <svg {...props}>
          <path d="M12 4v11" />
          <path d="m7 11 5 5 5-5" />
          <path d="M5 20h14" />
        </svg>
      );
    case 'gear':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6" />
        </svg>
      );
    case 'users':
      return (
        <svg {...props}>
          <circle cx="9" cy="8" r="2.4" />
          <path d="M4.5 18.5c.6-2.4 2.4-3.7 4.5-3.7s3.9 1.3 4.5 3.7" />
          <circle cx="16.2" cy="9" r="1.8" />
          <path d="M15.2 14.8c1.6.3 2.8 1.3 3.4 3.2" />
        </svg>
      );
    default:
      return null;
  }
}

export function AppSidebar() {
  const pathname = usePathname() || '/';
  const [collapsed, setCollapsed] = useState(false);
  const [openSection, setOpenSection] = useState<NavSection | null>('domains');
  const [domains, setDomains] = useState<DomainLink[]>([]);
  const [openExceptions, setOpenExceptions] = useState(0);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1');
      setOpenSection(readOpenSection());
    } catch {
      /* Storage can be unavailable in private modes. */
    }
  }, []);

  const load = useCallback(async () => {
    const [domainsResult, exceptionsResult] = await Promise.all([
      graphqlQuery<
        {
          domainTypes: Array<{ domainCode: string; domainName: string; isActive: boolean }>;
          domainRecordCounts: Array<{ domainCode: string; totalCount: number }>;
        },
        Record<string, never>
      >(
        `query SidebarDomains {
          domainTypes { domainCode domainName isActive }
          domainRecordCounts { domainCode totalCount }
        }`,
        {},
        'network-only'
      ),
      graphqlQuery<{ openExceptions: { totalCount: number } }, Record<string, never>>(
        `query SidebarExceptions {
          openExceptions: dqExceptions(filter: { status: OPEN }, pagination: { first: 1 }) {
            totalCount
          }
        }`,
        {},
        'network-only'
      ),
    ]);
    if (!domainsResult.error && domainsResult.data) {
      const counts: Record<string, number> = {};
      for (const row of domainsResult.data.domainRecordCounts || []) counts[row.domainCode] = row.totalCount || 0;
      setDomains(
        (domainsResult.data.domainTypes || [])
          .filter((domain) => domain.isActive)
          .map((domain) => ({
            code: domain.domainCode,
            name: domain.domainName,
            href: domainHref(domain.domainCode),
            count: counts[domain.domainCode] || 0,
          }))
      );
    }
    if (!exceptionsResult.error && exceptionsResult.data) {
      setOpenExceptions(exceptionsResult.data.openExceptions?.totalCount || 0);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, pathname]);

  useEffect(() => {
    const sources = pathname === '/admin/sources' || pathname.startsWith('/admin/sources/');
    if (pathname.startsWith('/admin') && !sources) {
      setOpenSection('admin');
      writeOpenSection('admin');
    }
  }, [pathname]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const toggleSection = (section: NavSection) => {
    if (collapsed) {
      setCollapsed(false);
      setOpenSection(section);
      try {
        localStorage.setItem(COLLAPSED_KEY, '0');
      } catch {
        /* ignore */
      }
      writeOpenSection(section);
      return;
    }
    setOpenSection((current) => {
      const next = current === section ? null : section;
      writeOpenSection(next);
      return next;
    });
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-brand">
        <Link href="/" className={collapsed ? 'sidebar-logo is-mark' : 'sidebar-logo'} title="Home">
          <BrandLogo size={collapsed ? 28 : 30} />
        </Link>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
            <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
            <path d="M9 4.5v15" />
          </svg>
        </button>
      </div>

      <nav className="sidebar-nav">
        <Link
          href="/"
          className={`sidebar-link ${navActive(pathname, '/', true) ? 'active' : ''}`}
          title="Home"
          aria-current={navActive(pathname, '/', true) ? 'page' : undefined}
        >
          <NavIcon name="home" />
          {!collapsed && <span className="sidebar-label">Home</span>}
        </Link>

        <button
          type="button"
          className={`sidebar-link sidebar-section ${openSection === 'domains' && !collapsed ? 'open' : ''} ${collapsed && domains.some((domain) => navActive(pathname, domain.href)) ? 'active' : ''}`}
          onClick={() => toggleSection('domains')}
          aria-expanded={!collapsed && openSection === 'domains'}
          title="Domains"
        >
          <NavIcon name="domains" />
          {!collapsed && <span className="sidebar-label">Domains</span>}
          {!collapsed && (
            <svg className="sidebar-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </button>
        {!collapsed && openSection === 'domains' && (
          <div className="sidebar-sub">
            {domains.length === 0 && <div className="sidebar-empty">No domains yet</div>}
            {domains.map((domain) => (
              <Link
                key={domain.code}
                href={domain.href}
                className={`sidebar-sublink ${navActive(pathname, domain.href) ? 'active' : ''}`}
                title={domain.name}
                aria-current={navActive(pathname, domain.href) ? 'page' : undefined}
              >
                <span className="sidebar-label">{domain.name}</span>
                <span className="sidebar-count">{domain.count.toLocaleString()}</span>
              </Link>
            ))}
          </div>
        )}

        <Link
          href="/admin/sources"
          className={`sidebar-link ${navActive(pathname, '/admin/sources') ? 'active' : ''}`}
          title="Sources"
          aria-current={navActive(pathname, '/admin/sources') ? 'page' : undefined}
        >
          <NavIcon name="sources" />
          {!collapsed && <span className="sidebar-label">Sources</span>}
        </Link>

        <Link
          href="/quality"
          className={`sidebar-link ${navActive(pathname, '/quality') ? 'active' : ''}`}
          title="Exceptions"
          aria-current={navActive(pathname, '/quality') ? 'page' : undefined}
        >
          <NavIcon name="alert" />
          {!collapsed && <span className="sidebar-label">Exceptions</span>}
          {openExceptions > 0 && (
            <span className={collapsed ? 'sidebar-dot' : 'sidebar-badge'}>{collapsed ? '' : openExceptions.toLocaleString()}</span>
          )}
        </Link>

        <div className="sidebar-tools">
          <button
            type="button"
            className={`sidebar-link sidebar-section ${openSection === 'tools' && !collapsed ? 'open' : ''} ${collapsed && TOOLS.some((tool) => navActive(pathname, tool.href)) ? 'active' : ''}`}
            onClick={() => toggleSection('tools')}
            aria-expanded={!collapsed && openSection === 'tools'}
            title="Tools"
          >
            <NavIcon name="layers" />
            {!collapsed && <span className="sidebar-label">Tools</span>}
            {!collapsed && (
              <svg className="sidebar-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            )}
          </button>
          {!collapsed && openSection === 'tools' && (
            <div className="sidebar-sub">
              {TOOLS.map((tool) => (
                <Link
                  key={tool.href}
                  href={tool.href}
                  className={`sidebar-sublink ${navActive(pathname, tool.href) ? 'active' : ''}`}
                  title={tool.label}
                  aria-current={navActive(pathname, tool.href) ? 'page' : undefined}
                >
                  <NavIcon name={tool.icon} />
                  <span className="sidebar-label">{tool.label}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-tools">
          <button
            type="button"
            className={`sidebar-link sidebar-section ${openSection === 'admin' && !collapsed ? 'open' : ''} ${collapsed && (ADMIN.some((item) => adminLinkActive(pathname, item.href)) || SKILL_NAV.some((skill) => navActive(pathname, skill.href))) ? 'active' : ''}`}
            onClick={() => toggleSection('admin')}
            aria-expanded={!collapsed && openSection === 'admin'}
            title="Admin"
          >
            <NavIcon name="gear" />
            {!collapsed && <span className="sidebar-label">Admin</span>}
            {!collapsed && (
              <svg className="sidebar-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            )}
          </button>
          {!collapsed && openSection === 'admin' && (
            <div className="sidebar-sub">
              {ADMIN.map((item) => (
                item.href === '/admin/skills' ? (
                  <div key={item.href} className="sidebar-skill-group">
                    <Link
                      href={item.href}
                      className={`sidebar-sublink ${adminLinkActive(pathname, item.href) ? 'active' : ''}`}
                      title={item.label}
                      aria-current={pathname === item.href ? 'page' : undefined}
                    >
                      <NavIcon name={item.icon} />
                      <span className="sidebar-label">{item.label}</span>
                    </Link>
                    <div className="sidebar-skill-links">
                      {SKILL_NAV.map((skill) => (
                        <Link
                          key={skill.id}
                          href={skill.href}
                          className={`sidebar-sublink ${navActive(pathname, skill.href) ? 'active' : ''}`}
                          title={skill.name}
                          aria-current={navActive(pathname, skill.href) ? 'page' : undefined}
                        >
                          <span className="sidebar-label">{skill.name}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`sidebar-sublink ${adminLinkActive(pathname, item.href) ? 'active' : ''}`}
                    title={item.label}
                    aria-current={adminLinkActive(pathname, item.href) ? 'page' : undefined}
                  >
                    <NavIcon name={item.icon} />
                    <span className="sidebar-label">{item.label}</span>
                  </Link>
                )
              ))}
            </div>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <UserMenu
          variant="sidebar"
          showLabel={!collapsed}
          anchor={collapsed ? 'side' : 'up-start'}
        />
      </div>
    </aside>
  );
}
