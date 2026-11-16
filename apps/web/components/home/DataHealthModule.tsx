'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';

interface Health {
  totalRecords: number;
  domainCount: number;
  qualityPercent: number | null;
  openExceptions: number;
  highPriorityExceptions: number;
  sourcesConnected: number;
  totalSources: number;
}

const HEALTH_QUERY = `
  query HomeDataHealth {
    domainTypes { domainCode isActive }
    domainRecordCounts { domainCode totalCount }
    dataSources { id isActive }
    openExceptions: dqExceptions(filter: { status: OPEN }, pagination: { first: 1 }) { totalCount }
    highExceptions: dqExceptions(filter: { status: OPEN, severity: HIGH }, pagination: { first: 1 }) { totalCount }
    criticalExceptions: dqExceptions(filter: { status: OPEN, severity: CRITICAL }, pagination: { first: 1 }) { totalCount }
  }
`;

interface HealthData {
  domainTypes: Array<{ domainCode: string; isActive: boolean }>;
  domainRecordCounts: Array<{ domainCode: string; totalCount: number }>;
  dataSources: Array<{ id: string; isActive: boolean }>;
  openExceptions: { totalCount: number };
  highExceptions: { totalCount: number };
  criticalExceptions: { totalCount: number };
}

/** The platform-wide numbers the old home page led with, now one optional module. */
export function DataHealthModule() {
  const [health, setHealth] = useState<Health | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<HealthData>(HEALTH_QUERY, {}, 'network-only').then((result) => {
      if (cancelled) return;
      if (!result.data) {
        setProblem(result.error?.message || 'Data health could not be loaded.');
        return;
      }
      const active = new Set(result.data.domainTypes.filter((domain) => domain.isActive).map((domain) => domain.domainCode));
      const sources = result.data.dataSources || [];
      setHealth({
        totalRecords: result.data.domainRecordCounts
          .filter((row) => active.has(row.domainCode))
          .reduce((sum, row) => sum + (row.totalCount || 0), 0),
        domainCount: active.size,
        qualityPercent: null,
        openExceptions: result.data.openExceptions?.totalCount || 0,
        highPriorityExceptions: (result.data.highExceptions?.totalCount || 0) + (result.data.criticalExceptions?.totalCount || 0),
        sourcesConnected: sources.filter((source) => source.isActive).length,
        totalSources: sources.length,
      });
    });
    graphqlQuery<{ dataQualityDashboard: { summary: { qualityPercent: number | null } } }>(
      `query { dataQualityDashboard { summary { qualityPercent } } }`,
      {},
      'network-only',
    ).then((result) => {
      const quality = result.data?.dataQualityDashboard?.summary?.qualityPercent;
      if (!cancelled && typeof quality === 'number') {
        setHealth((current) => (current ? { ...current, qualityPercent: quality } : current));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (problem) return <div className="home-empty">{problem}</div>;
  const loading = !health;
  const sourcesHealthy = !!health && health.totalSources > 0 && health.sourcesConnected === health.totalSources;

  return (
    <div className="home-kpis">
      <Link href="/admin/entities" className="home-kpi">
        <div>
          <div className="home-kpi-label">Golden records</div>
          <div className="home-kpi-value">{loading ? '—' : health.totalRecords.toLocaleString()}</div>
          <div className="home-kpi-sub">{loading ? '' : `across ${health.domainCount} domain${health.domainCount === 1 ? '' : 's'}`}</div>
        </div>
      </Link>
      <Link href="/quality" className="home-kpi">
        <div>
          <div className="home-kpi-label">Match confidence</div>
          <div className="home-kpi-value">{health?.qualityPercent != null ? `${health.qualityPercent.toFixed(1)}%` : '—'}</div>
          <div className="home-kpi-sub">{health?.qualityPercent != null ? 'From active quality rules' : 'Not configured yet'}</div>
        </div>
      </Link>
      <Link href="/quality" className="home-kpi">
        <div>
          <div className="home-kpi-label">Open exceptions</div>
          <div className="home-kpi-value">{loading ? '—' : health.openExceptions.toLocaleString()}</div>
          <div className="home-kpi-sub">
            {loading ? '' : health.highPriorityExceptions > 0 ? <span className="warn">{health.highPriorityExceptions} high priority</span> : 'No high-severity items'}
          </div>
        </div>
      </Link>
      <Link href="/admin/sources" className="home-kpi">
        <div>
          <div className="home-kpi-label">Source health</div>
          <div className="home-kpi-value">{loading ? '—' : health.totalSources > 0 ? `${health.sourcesConnected}/${health.totalSources}` : '—'}</div>
          <div className="home-kpi-sub">
            {loading ? '' : health.totalSources === 0 ? 'No sources connected' : sourcesHealthy ? <span className="up">All sources active</span> : `${health.totalSources - health.sourcesConnected} inactive`}
          </div>
        </div>
      </Link>
    </div>
  );
}
