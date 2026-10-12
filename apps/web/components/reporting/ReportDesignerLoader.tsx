'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { graphqlQuery } from '@/lib/graphql';
import { DASHBOARD_QUERY, NARRATIVE_QUERY, type DashboardTemplate, type NarrativeTemplate } from '@/lib/reporting';
import { ReportDesigner } from './ReportDesigner';

/** Loads a template by code and mounts the designer. */
export function ReportDesignerLoader({ kind, code }: { kind: 'dashboard' | 'narrative'; code: string }) {
  const [template, setTemplate] = useState<DashboardTemplate | NarrativeTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const base = kind === 'dashboard' ? '/admin/dashboards' : '/admin/narratives';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    graphqlQuery<any, any>(
      kind === 'dashboard' ? DASHBOARD_QUERY : NARRATIVE_QUERY,
      kind === 'dashboard' ? { dashboardCode: code } : { narrativeCode: code },
      'network-only'
    ).then(({ data }) => {
      if (cancelled) return;
      setTemplate((kind === 'dashboard' ? data?.dashboard : data?.narrative) || null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, code]);

  if (loading) return <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-3)' }}>Loading…</div>;
  if (!template) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ color: 'var(--red)', marginBottom: '12px' }}>Not found: {code}</div>
        <Link href={base} className="btn">← Back</Link>
      </div>
    );
  }
  return <ReportDesigner kind={kind} initial={template} />;
}
