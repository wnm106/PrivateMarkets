'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { graphqlQuery } from '@/lib/graphql';
import {
  DASHBOARDS_QUERY,
  NARRATIVES_QUERY,
  type DashboardTemplate,
  type NarrativeTemplate,
} from '@/lib/reporting';
import { DashboardRunner } from './DashboardRunner';
import { NarrativeRunner } from './NarrativeRunner';

interface EntityReportsProps {
  domainCode: string;
  entityId: string;
  asOfDate?: string;
  embedded?: boolean;
}

type Selection = { kind: 'dashboard'; id: string } | { kind: 'narrative'; id: string } | null;

/**
 * Shows every active dashboard and narrative attached to this entity's type,
 * rendered for the entity currently being viewed.
 */
export function EntityReports({ domainCode, entityId, asOfDate, embedded = false }: EntityReportsProps) {
  const [dashboards, setDashboards] = useState<DashboardTemplate[]>([]);
  const [narratives, setNarratives] = useState<NarrativeTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selection>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [d, n] = await Promise.all([
        graphqlQuery<{ dashboards: DashboardTemplate[] }, any>(DASHBOARDS_QUERY, { domainCode, isActive: true }, 'network-only'),
        graphqlQuery<{ narratives: NarrativeTemplate[] }, any>(NARRATIVES_QUERY, { domainCode, isActive: true }, 'network-only'),
      ]);
      if (cancelled) return;
      const ds = d.data?.dashboards || [];
      const ns = n.data?.narratives || [];
      setDashboards(ds);
      setNarratives(ns);
      setSelected((prev) => prev ?? (ds[0] ? { kind: 'dashboard', id: ds[0].id } : ns[0] ? { kind: 'narrative', id: ns[0].id } : null));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [domainCode]);

  const activeDashboard = selected?.kind === 'dashboard' ? dashboards.find((d) => d.id === selected.id) : undefined;
  const activeNarrative = selected?.kind === 'narrative' ? narratives.find((n) => n.id === selected.id) : undefined;

  if (loading) {
    return embedded ? <div className="value-timeline-empty">Loading dashboards…</div> : null;
  }

  if (dashboards.length === 0 && narratives.length === 0) {
    return (
      <div style={{ marginTop: '28px', padding: '16px 18px', border: '1px dashed var(--line)', fontSize: '12px', color: 'var(--ink-3)' }}>
        No dashboards or narratives are defined for this entity type yet.{' '}
        <Link href="/admin/dashboards" className="crumb-link">Design a dashboard</Link> or{' '}
        <Link href="/admin/narratives" className="crumb-link">create a narrative</Link>.
      </div>
    );
  }

  const pill = (active: boolean) => ({
    padding: '6px 12px',
    fontSize: '12px',
    border: '1px solid var(--line)',
    background: active ? 'var(--ink)' : 'white',
    color: active ? 'white' : 'var(--ink-2)',
    cursor: 'pointer',
  });

  return (
    <div style={{ marginTop: embedded ? 0 : '28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', marginRight: '8px' }}>
          Dashboards &amp; Narratives
        </div>
        {dashboards.map((d) => (
          <button key={d.id} style={pill(selected?.kind === 'dashboard' && selected.id === d.id)} onClick={() => setSelected({ kind: 'dashboard', id: d.id })}>
            ▦ {d.dashboardName}
          </button>
        ))}
        {narratives.map((n) => (
          <button key={n.id} style={pill(selected?.kind === 'narrative' && selected.id === n.id)} onClick={() => setSelected({ kind: 'narrative', id: n.id })}>
            ✎ {n.narrativeName}
          </button>
        ))}
      </div>

      {activeDashboard && (
        <div>
          {activeDashboard.description && <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '8px' }}>{activeDashboard.description}</div>}
          <DashboardRunner
            key={activeDashboard.id + entityId}
            htmlTemplate={activeDashboard.htmlTemplate}
            dataQueries={activeDashboard.dataQueries}
            parameters={activeDashboard.parameters}
            entityId={entityId}
            asOfDate={asOfDate}
          />
          <div style={{ marginTop: '6px', fontSize: '11px' }}>
            <Link href={`/admin/dashboards/${activeDashboard.dashboardCode}`} className="crumb-link">Edit dashboard</Link>
          </div>
        </div>
      )}

      {activeNarrative && (
        <div>
          {activeNarrative.description && <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '8px' }}>{activeNarrative.description}</div>}
          <NarrativeRunner
            key={activeNarrative.id + entityId}
            narrativeId={activeNarrative.id}
            parameters={activeNarrative.parameters}
            entityId={entityId}
            asOfDate={asOfDate}
          />
          <div style={{ marginTop: '6px', fontSize: '11px' }}>
            <Link href={`/admin/narratives/${activeNarrative.narrativeCode}`} className="crumb-link">Edit narrative</Link>
          </div>
        </div>
      )}
    </div>
  );
}
