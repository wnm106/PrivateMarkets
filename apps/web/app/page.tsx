'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';

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
  count: number;
  desc: string;
}

interface ExceptionRow {
  id: string;
  entityId: string;
  entityName: string;
  domainCode: string;
  exceptionMessage: string;
  severity: string;
  status: string;
  detectedAt: string;
}

interface SourceRow {
  id: string;
  sourceName: string;
  isActive: boolean;
  updatedAt: string;
  createdAt: string;
}

interface DashboardStats {
  totalRecords: number;
  qualityPercent: number | null;
  openExceptions: number;
  highPriorityExceptions: number;
  sourcesConnected: number;
  totalSources: number;
  entities: EntityDomainCard[];
  exceptions: ExceptionRow[];
  activity: ActivityItem[];
}

interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  at: string;
  href?: string;
  tone: 'ok' | 'warn' | 'info';
}

const EMPTY: DashboardStats = {
  totalRecords: 0,
  qualityPercent: null,
  openExceptions: 0,
  highPriorityExceptions: 0,
  sourcesConnected: 0,
  totalSources: 0,
  entities: [],
  exceptions: [],
  activity: [],
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open',
  IN_REVIEW: 'Review',
  RESOLVED: 'Resolved',
  WAIVED: 'Waived',
  FALSE_POSITIVE: 'False positive',
};

function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function LandingPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [stats, setStats] = useState<DashboardStats>(EMPTY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchDashboardData() {
      try {
        const [domainsResult, opsResult] = await Promise.all([
          graphqlQuery<
            {
              domainTypes: DomainTypeRecord[];
              domainRecordCounts: Array<{ domainCode: string; totalCount: number }>;
              dataSources: SourceRow[];
            },
            Record<string, never>
          >(
            `query {
              domainTypes { id domainCode domainName description isActive }
              domainRecordCounts { domainCode totalCount }
              dataSources { id sourceName isActive updatedAt createdAt }
            }`,
            {},
            'network-only'
          ),
          graphqlQuery<
            {
              openExceptions: { totalCount: number; edges: Array<{ node: ExceptionRow }> };
              highExceptions: { totalCount: number };
              criticalExceptions: { totalCount: number };
            },
            Record<string, never>
          >(
            `query {
              openExceptions: dqExceptions(filter: { status: OPEN }, pagination: { first: 8 }) {
                totalCount
                edges {
                  node {
                    id
                    entityId
                    entityName
                    domainCode
                    exceptionMessage
                    severity
                    status
                    detectedAt
                  }
                }
              }
              highExceptions: dqExceptions(filter: { status: OPEN, severity: HIGH }, pagination: { first: 1 }) {
                totalCount
              }
              criticalExceptions: dqExceptions(filter: { status: OPEN, severity: CRITICAL }, pagination: { first: 1 }) {
                totalCount
              }
            }`,
            {},
            'network-only'
          ),
        ]);

        const activeDomains = (domainsResult.data?.domainTypes || []).filter((domain) => domain.isActive);
        const counts: Record<string, number> = {};
        for (const row of domainsResult.data?.domainRecordCounts || []) {
          counts[row.domainCode] = row.totalCount || 0;
        }
        const names: Record<string, string> = {};
        const entities: EntityDomainCard[] = activeDomains.map((domain) => {
          names[domain.domainCode] = domain.domainName;
          return {
            key: domainHref(domain.domainCode),
            domainCode: domain.domainCode,
            name: domain.domainName,
            desc: domain.description || '',
            count: counts[domain.domainCode] || 0,
          };
        });

        const sources = domainsResult.data?.dataSources || [];
        const exceptions = (opsResult.data?.openExceptions?.edges || []).map((edge) => edge.node);
        const activity: ActivityItem[] = [
          ...exceptions.map((row) => ({
            id: `ex-${row.id}`,
            title: row.exceptionMessage,
            detail: `${row.entityName} · ${names[row.domainCode] || row.domainCode}`,
            at: row.detectedAt,
            href: `${domainHref(row.domainCode)}/${row.entityId}`,
            tone: row.severity === 'HIGH' || row.severity === 'CRITICAL' ? 'warn' as const : 'info' as const,
          })),
          ...sources.map((source) => ({
            id: `src-${source.id}`,
            title: source.isActive ? 'Source connected' : 'Source inactive',
            detail: source.sourceName,
            at: source.updatedAt || source.createdAt,
            href: '/admin/sources',
            tone: source.isActive ? 'ok' as const : 'warn' as const,
          })),
        ]
          .filter((item) => item.at)
          .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
          .slice(0, 6);

        if (cancelled) return;
        setStats({
          totalRecords: entities.reduce((sum, entity) => sum + entity.count, 0),
          qualityPercent: null,
          openExceptions: opsResult.data?.openExceptions?.totalCount || 0,
          highPriorityExceptions:
            (opsResult.data?.highExceptions?.totalCount || 0) +
            (opsResult.data?.criticalExceptions?.totalCount || 0),
          sourcesConnected: sources.filter((source) => source.isActive).length,
          totalSources: sources.length,
          entities,
          exceptions,
          activity,
        });
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDashboardData();

    graphqlQuery<{ dataQualityDashboard: { summary: { qualityPercent: number | null } } }, Record<string, never>>(
      `query { dataQualityDashboard { summary { qualityPercent } } }`,
      {},
      'network-only'
    ).then((result) => {
      const quality = result.data?.dataQualityDashboard?.summary?.qualityPercent;
      if (!cancelled && typeof quality === 'number') {
        setStats((current) => ({ ...current, qualityPercent: quality }));
      }
    }).catch(() => {
      /* Quality is optional on the overview. The rest of the page still renders. */
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const domains = useMemo(() => {
    if (!needle) return stats.entities;
    return stats.entities.filter((entity) =>
      `${entity.name} ${entity.domainCode} ${entity.desc}`.toLowerCase().includes(needle)
    );
  }, [needle, stats.entities]);

  const exceptions = useMemo(() => {
    if (!needle) return stats.exceptions;
    return stats.exceptions.filter((row) =>
      `${row.entityName} ${row.domainCode} ${row.exceptionMessage}`.toLowerCase().includes(needle)
    );
  }, [needle, stats.exceptions]);

  const domainName = (code: string) => stats.entities.find((entity) => entity.domainCode === code)?.name || code;
  const sourcesHealthy = stats.totalSources > 0 && stats.sourcesConnected === stats.totalSources;

  return (
    <div className="view-fade home">
      <header className="home-hero">
        <h1 className="home-title">
          One <em>trusted</em> record. Every system.
        </h1>
        <p className="home-sub">
          Golden records, source precedence, and data quality for private credit and asset management.
        </p>
        <label className="home-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter domains and open exceptions"
            aria-label="Search domains and open exceptions"
          />
          <span className="kbd">⌘K</span>
        </label>
      </header>

      <section className="home-kpis" aria-label="Overview">
        <article className="home-kpi">
          <div className="home-kpi-icon tone-blue" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z" />
            </svg>
          </div>
          <div>
            <div className="home-kpi-label">Golden Records</div>
            <div className="home-kpi-value">{loading ? '—' : stats.totalRecords.toLocaleString()}</div>
            <div className="home-kpi-sub">
              across {stats.entities.length} entity domain{stats.entities.length === 1 ? '' : 's'}
            </div>
          </div>
        </article>
        <article className="home-kpi">
          <div className="home-kpi-icon tone-blue" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </div>
          <div>
            <div className="home-kpi-label">Match Confidence</div>
            <div className="home-kpi-value">
              {loading ? '—' : stats.qualityPercent != null ? `${stats.qualityPercent.toFixed(1)}%` : '—'}
            </div>
            <div className="home-kpi-sub">
              {stats.qualityPercent != null ? 'From active quality rules' : 'Not configured yet'}
            </div>
          </div>
        </article>
        <article className="home-kpi">
          <div className="home-kpi-icon tone-red" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 4 3.5 19h17L12 4z" />
              <path d="M12 10v4M12 17h.01" />
            </svg>
          </div>
          <div>
            <div className="home-kpi-label">Needs Review</div>
            <div className="home-kpi-value">{loading ? '—' : stats.openExceptions.toLocaleString()}</div>
            <div className="home-kpi-sub">
              {stats.highPriorityExceptions > 0 ? (
                <span className="warn">{stats.highPriorityExceptions} high priority</span>
              ) : (
                'No high-severity items'
              )}
            </div>
          </div>
        </article>
        <article className="home-kpi">
          <div className="home-kpi-icon tone-green" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M21 12a9 9 0 1 1-2.6-6.3" />
              <path d="M21 4v5h-5" />
            </svg>
          </div>
          <div>
            <div className="home-kpi-label">Source Health</div>
            <div className="home-kpi-value">
              {loading ? '—' : stats.totalSources > 0 ? `${stats.sourcesConnected}/${stats.totalSources}` : '—'}
            </div>
            <div className="home-kpi-sub">
              {stats.totalSources === 0
                ? 'No sources connected'
                : sourcesHealthy
                  ? <span className="up">All feeds current</span>
                  : `${stats.totalSources - stats.sourcesConnected} inactive`}
            </div>
          </div>
        </article>
      </section>

      <section>
        <div className="home-section-title">
          <h2>Entity Domains</h2>
          <span>
            <Link href="/merge">Resolve entities</Link>
            {' · '}
            <Link href="/admin/entities">Manage domains</Link>
          </span>
        </div>
        <div className="home-domains">
          {!loading && domains.length === 0 && (
            <div className="home-empty">
              {needle ? 'No domains match that search.' : 'No entity domains defined yet.'}{' '}
              {!needle && <Link href="/admin/entities">Create one in Entity Type Management</Link>}
            </div>
          )}
          {domains.map((entity) => (
            <Link key={entity.domainCode} href={entity.key} className="home-domain">
              <div className="home-domain-top">
                <span className="home-domain-mark" aria-hidden>{entity.name.charAt(0)}</span>
                <span className="home-domain-name">{entity.name}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </div>
              <div className="home-domain-count">{loading ? '—' : entity.count.toLocaleString()}</div>
              <div className="home-domain-desc">{entity.desc || 'Entity domain'}</div>
              <span className={`home-pill ${entity.count > 0 ? 'is-active' : ''}`}>
                {entity.count > 0 ? 'Active' : 'Empty'}
              </span>
            </Link>
          ))}
          {!needle && (
            <Link href="/admin/entities" className="home-domain home-domain-add">
              <span className="home-domain-plus" aria-hidden>+</span>
              <span>Add entity domain</span>
              <span className="home-domain-hint">e.g. Covenants, Amortization, Capital Call</span>
            </Link>
          )}
        </div>
      </section>

      <section className="home-lower">
        <div className="home-panel">
          <div className="home-section-title">
            <h2>
              Exception Queue
              {!loading && stats.openExceptions > 0 && <span className="home-count">{stats.openExceptions}</span>}
            </h2>
            <Link href="/quality">View all</Link>
          </div>
          {exceptions.length === 0 ? (
            <div className="home-empty">{loading ? 'Loading exceptions…' : 'No open exceptions.'}</div>
          ) : (
            <div className="home-table-wrap">
              <table className="home-table">
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Domain</th>
                    <th>Issue</th>
                    <th>Detected</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((row) => (
                    <tr key={row.id}>
                      <td className="home-entity">{row.entityName}</td>
                      <td>{domainName(row.domainCode)}</td>
                      <td>{row.exceptionMessage}</td>
                      <td className="home-muted">{relativeTime(row.detectedAt)}</td>
                      <td>
                        <span className={`home-status status-${row.status.toLowerCase()}`}>
                          {STATUS_LABEL[row.status] || row.status}
                        </span>
                      </td>
                      <td>
                        <Link href={`${domainHref(row.domainCode)}/${row.entityId}`}>View</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="home-panel">
          <div className="home-section-title">
            <h2>Recent Activity</h2>
            <span>
              <Link href="/merge">Resolve entities</Link>
              {' · '}
              <Link href="/quality">View all</Link>
            </span>
          </div>
          {stats.activity.length === 0 ? (
            <div className="home-empty">{loading ? 'Loading activity…' : 'No recent activity.'}</div>
          ) : (
            <ul className="home-activity">
              {stats.activity.map((item) => (
                <li key={item.id}>
                  <span className={`home-activity-dot tone-${item.tone}`} aria-hidden />
                  <div>
                    <Link href={item.href || '/quality'}>{item.title}</Link>
                    <div className="home-muted">{item.detail}</div>
                  </div>
                  <time className="home-muted">{relativeTime(item.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
