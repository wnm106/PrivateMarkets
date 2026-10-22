'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';

interface DomainTypeRecord {
  id: string;
  domainCode: string;
  domainName: string;
  description?: string;
  isActive: boolean;
}

interface EntityDomainCard {
  key: string;
  domainCode: string;
  name: string;
  icon: string;
  count: number;
  color: string;
  desc: string;
}

interface DashboardStats {
  totalRecords: number;
  avgQuality: number;
  openExceptions: number;
  highPriorityExceptions: number;
  sourcesConnected: number;
  totalSources: number;
  entities: EntityDomainCard[];
}

// Presentation (route slug / icon glyph / accent color) for domain codes we
// know about. This is purely cosmetic — the list of cards itself always
// comes from the live `domainTypes` query, not from this map. Any domain
// type not listed here still renders, with a sensible generated fallback,
// so newly-created domain types show up immediately without a code change.
const DOMAIN_PRESENTATION: Record<string, { route: string; icon: string; color: string }> = {
  FUND: { route: 'funds', icon: 'F', color: '#1b3a4b' },
  ISSUER: { route: 'issuers', icon: 'I', color: '#6d28d9' },
  SECURITY: { route: 'securities', icon: 'S', color: '#c2410c' },
  DEAL: { route: 'deals', icon: 'D', color: '#047857' },
  INVESTOR: { route: 'investors', icon: 'V', color: '#be185d' },
  PRICE: { route: 'prices', icon: 'P', color: '#9a9a93' },
  POSITION: { route: 'positions', icon: 'P', color: '#0369a1' },
};

function presentationFor(domainCode: string) {
  return (
    DOMAIN_PRESENTATION[domainCode] || {
      route: `${domainCode.toLowerCase()}s`,
      icon: domainCode.charAt(0).toUpperCase(),
      color: '#5a5a55',
    }
  );
}

export default function LandingPage() {
  const [stats, setStats] = useState<DashboardStats>({
    totalRecords: 0,
    avgQuality: 0,
    openExceptions: 0,
    highPriorityExceptions: 0,
    sourcesConnected: 0,
    totalSources: 0,
    entities: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDashboardData() {
      try {
        // Entity domain cards are driven entirely by what's configured in
        // Admin > Entity Type Management (metadata_register.domain_types),
        // not by a hardcoded list.
        const domainTypesResult = await graphqlQuery<
          { domainTypes: DomainTypeRecord[] },
          Record<string, never>
        >(`query { domainTypes { id domainCode domainName description isActive } }`);

        const activeDomains = (domainTypesResult.data?.domainTypes || []).filter(
          (d) => d.isActive
        );

        // Fetch a record count per domain via the generic `entities` query,
        // aliased so every domain's count comes back in a single request.
        const counts: Record<string, number> = {};
        if (activeDomains.length > 0) {
          if (activeDomains.length > 0) {
            const countsQuery = `
              query {
                ${activeDomains
                  .map(
                    (d, i) =>
                      `d${i}: entities(filter: { domainCode: "${d.domainCode}" }, pagination: { first: 1 }) { totalCount }`
                  )
                  .join('\n')}
              }
            `;
            const countsResult = await graphqlQuery<
              Record<string, { totalCount: number } | undefined>,
              Record<string, never>
            >(countsQuery);

            activeDomains.forEach((d, i) => {
              counts[d.domainCode] = countsResult.data?.[`d${i}`]?.totalCount || 0;
            });
          }
        }

        // Fetch DQ exceptions
        const exceptionsQuery = `
          query {
            dqExceptions(filter: { status: { equals: OPEN } }) {
              totalCount
            }
          }
        `;

        const exceptionsResult = await graphqlQuery<any, Record<string, never>>(exceptionsQuery);

        const entities: EntityDomainCard[] = activeDomains.map((d) => {
          const presentation = presentationFor(d.domainCode);
          return {
            key: presentation.route,
            domainCode: d.domainCode,
            name: d.domainName,
            icon: presentation.icon,
            color: presentation.color,
            desc: d.description || '',
            count: counts[d.domainCode] || 0,
          };
        });

        const totalRecords = entities.reduce((sum, e) => sum + e.count, 0);
        const openExceptions = exceptionsResult.data?.dqExceptions?.totalCount || 0;

        setStats({
          totalRecords,
          avgQuality: 0, // Not configured yet
          openExceptions,
          highPriorityExceptions: 0,
          sourcesConnected: 0, // Not configured yet
          totalSources: 0,
          entities,
        });
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboardData();
  }, []);
  return (
    <div className="view-fade">
      {/* Hero Section */}
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Master Data Management</div>
          <h1 className="hero-title">
            One <em>source of truth</em>,
            <br />
            across every system.
          </h1>
          <p className="hero-sub">
            Select an entity domain to manage golden records, configure source precedence, and monitor data quality. All domains share the same lineage, normalization, and exception framework.
          </p>
        </div>
        <div className="search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5a5a55" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input placeholder="Search by CUSIP, fund, issuer, deal…" />
          <span className="kbd">⌘K</span>
        </div>
      </div>

      {/* Stat Strip */}
      <div className="stat-strip">
        <div className="stat">
          <div className="stat-label">Total Records</div>
          <div className="stat-val">{loading ? '—' : stats.totalRecords.toLocaleString()}</div>
          <div className="stat-sub">
            across {stats.entities.length} entity domain{stats.entities.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg Data Quality</div>
          <div className="stat-val">
            {loading ? '—' : stats.avgQuality > 0 ? `${stats.avgQuality.toFixed(1)}%` : 'Not configured'}
          </div>
          <div className="stat-sub">
            {stats.avgQuality > 0 ? <span className="up">▲ 1.8</span> : 'Set up DQ rules to track'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Open Exceptions</div>
          <div className="stat-val">{loading ? '—' : stats.openExceptions}</div>
          <div className="stat-sub">
            {stats.highPriorityExceptions > 0 ? (
              <span className="warn">{stats.highPriorityExceptions} high priority</span>
            ) : (
              'No active exceptions'
            )}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Sources Connected</div>
          <div className="stat-val">
            {loading ? '—' : stats.sourcesConnected > 0 ? `${stats.sourcesConnected} / ${stats.totalSources}` : 'Not configured'}
          </div>
          <div className="stat-sub">
            {stats.sourcesConnected > 0 ? 'last sync 06:14 EST' : 'Configure source registry'}
          </div>
        </div>
      </div>

      {/* Entity Domains Section */}
      <div className="section-title">
        <h2>Entity Domains</h2>
        <span className="hint">Click any domain to manage its records</span>
      </div>

      <div className="entity-grid">
        {!loading && stats.entities.length === 0 && (
          <div style={{ color: 'var(--ink-3)', fontSize: '13px', padding: '8px 0' }}>
            No entity domains defined yet.{' '}
            <Link href="/admin/entities" style={{ color: 'var(--accent)' }}>
              Create one in Entity Type Management
            </Link>
            .
          </div>
        )}
        {stats.entities.map((entity) => {
          return (
            <Link key={entity.key} href={`/${entity.key}`}>
              <div className="entity-card" style={{ '--card-accent': entity.color } as React.CSSProperties}>
                <div className="entity-head-block">
                  <div className="entity-name-header">{entity.name}</div>
                  <div className="entity-count-inline">
                    <strong>{loading ? '—' : entity.count.toLocaleString()}</strong> records
                  </div>
                </div>
                <div className="entity-desc">{entity.desc}</div>
                <div className="entity-footer">
                  <div className="entity-quality">
                    <div className="lbl">Status</div>
                    <div className="val" style={{ color: entity.count > 0 ? 'var(--green)' : 'var(--ink-3)' }}>
                      {entity.count > 0 ? 'Active' : 'Empty'}
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Cross-Cutting Tools */}
      <div className="section-title">
        <h2>Cross-Cutting Tools</h2>
      </div>

      <div className="nav-row">
        <Link href="/merge">
          <div className="nav-card">
            <div className="nav-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="8" r="3" />
                <circle cx="17" cy="8" r="3" />
                <path d="M10 8h4" />
                <path d="M12 11v3" />
                <path d="M8 20c.6-2 2.2-3 4-3s3.4 1 4 3" />
              </svg>
            </div>
            <div>
              <div className="nav-title">Entity Resolution</div>
              <div className="nav-desc">Match exact keys and fuzzy names across entity types, then merge without flattening the relationship graph.</div>
            </div>
          </div>
        </Link>
        <Link href="/precedence">
          <div className="nav-card">
            <div className="nav-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 6h18M3 12h18M3 18h12" />
                <circle cx="5" cy="6" r="1.5" fill="currentColor" />
                <circle cx="5" cy="12" r="1.5" fill="currentColor" />
                <circle cx="5" cy="18" r="1.5" fill="currentColor" />
              </svg>
            </div>
            <div>
              <div className="nav-title">Precedence Rules</div>
              <div className="nav-desc">Field-level source priority with conditional logic.</div>
            </div>
          </div>
        </Link>
        <Link href="/quality">
          <div className="nav-card">
            <div className="nav-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3v18h18" />
                <path d="m7 14 4-4 4 4 5-5" />
              </svg>
            </div>
            <div>
              <div className="nav-title">Data Quality Framework</div>
              <div className="nav-desc">Availability, quality, and trajectory across all domains.</div>
            </div>
          </div>
        </Link>
        <Link href="/lists">
          <div className="nav-card">
            <div className="nav-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2 2 7l10 5 10-5-10-5Z" />
                <path d="m2 17 10 5 10-5" />
                <path d="m2 12 10 5 10-5" />
              </svg>
            </div>
            <div>
              <div className="nav-title">Standardized Value Lists</div>
              <div className="nav-desc">Controlled vocabularies for types, seniority, ratings, and more.</div>
            </div>
          </div>
        </Link>
        <Link href="/intersections">
          <div className="nav-card">
            <div className="nav-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="18" r="3" />
                <path d="M8.5 7.5 15.5 16.5" />
                <path d="M15.5 7.5 8.5 16.5" />
              </svg>
            </div>
            <div>
              <div className="nav-title">Composite Entities</div>
              <div className="nav-desc">Intersection framework for N-ary entity combinations with bi-temporal tracking.</div>
            </div>
          </div>
        </Link>
        <Link href="/imports">
          <div className="nav-card">
            <div className="nav-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M4 21h16" />
              </svg>
            </div>
            <div>
              <div className="nav-title">Position File Load</div>
              <div className="nav-desc">Map a flat file onto Issuer, Fund, Security, and Position, then load parents first.</div>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
