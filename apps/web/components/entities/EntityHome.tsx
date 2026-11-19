'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DataQualityDashboard } from '@/components/quality/DataQualityDashboard';
import { EntityReports } from '@/components/reporting/EntityReports';
import { DOMAIN_TYPES_QUERY, INTERSECTION_TYPES_QUERY, RELATIONSHIP_TYPES_QUERY, graphqlQuery } from '@/lib/graphql';
import { definingParentDomains, mergeParentColumns, parentEntityColumns, toParentLinkCounts, type ParentEntityColumn } from '@/lib/parent-entities';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { useWarmTabs } from '@/lib/view-context';
import { EntityAttributeTable, type RelatedAttributeColumn } from './EntityAttributeTable';

type HomeTab = 'records' | 'dashboards' | 'quality';

interface SelectedEntity {
  id: string;
  name: string;
  code: string;
}

export function EntityHome({
  domainCode,
  domainKey,
  asOfDate,
  refreshKey = 0,
  emptyMessage,
  related,
  onTotalChange,
}: {
  domainCode: string;
  domainKey: string;
  asOfDate?: string;
  refreshKey?: number;
  emptyMessage: string;
  related?: RelatedAttributeColumn[];
  onTotalChange?: (total: number) => void;
}) {
  const [tab, setTab] = useState<HomeTab>('records');
  const warmed = useWarmTabs(['records', 'dashboards', 'quality'], tab);
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
  const [discovered, setDiscovered] = useState<ParentEntityColumn[]>([]);

  useEffect(() => {
    setSelected(null);
    setTab('records');
  }, [domainCode]);

  useEffect(() => {
    let cancelled = false;
    setDiscovered([]);
    Promise.all([
      graphqlQuery<
        { relationshipTypes: Array<{ relationshipCode: string; parentDomainCode?: string | null; childDomainCode?: string | null; cardinality?: string | null }> },
        Record<string, never>
      >(RELATIONSHIP_TYPES_QUERY, {}, 'network-only'),
      graphqlQuery<
        { domainTypes: Array<{ domainCode: string; domainName: string }> },
        Record<string, never>
      >(DOMAIN_TYPES_QUERY, {}, 'network-only'),
      graphqlQuery<
        { intersectionTypes: Array<{ intersectionCode: string; isActive: boolean; members: Array<{ domainCode: string }> }> },
        Record<string, never>
      >(INTERSECTION_TYPES_QUERY, {}, 'network-only'),
      supabaseBrowserClient().rpc('relationship_link_counts'),
    ]).then(([relationships, domains, intersections, counts]) => {
      if (cancelled) return;
      const names: Record<string, string> = {};
      for (const domain of domains.data?.domainTypes || []) names[domain.domainCode] = domain.domainName;
      const linkCounts = toParentLinkCounts((counts.data || []) as Array<Record<string, unknown>>);
      const types = relationships.data?.relationshipTypes || [];
      const parents = definingParentDomains(domainCode, intersections.data?.intersectionTypes || []);
      setDiscovered(parentEntityColumns(domainCode, types, names, linkCounts, parents));
    }).catch(() => {
      if (!cancelled) setDiscovered([]);
    });
    return () => { cancelled = true; };
  }, [domainCode]);

  const parentColumns = useMemo(
    () => mergeParentColumns(related, discovered),
    [related, discovered],
  );

  return (
    <div className="entity-home">
      <div className="entity-home-tabs">
        <div className="xp-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'records'} className={`xp-tab ${tab === 'records' ? 'active' : ''}`} onClick={() => setTab('records')}>
            Records
          </button>
          <button type="button" role="tab" aria-selected={tab === 'dashboards'} className={`xp-tab ${tab === 'dashboards' ? 'active' : ''}`} onClick={() => setTab('dashboards')}>
            Dashboards
          </button>
          <button type="button" role="tab" aria-selected={tab === 'quality'} className={`xp-tab ${tab === 'quality' ? 'active' : ''}`} onClick={() => setTab('quality')}>
            Data Quality
          </button>
        </div>
        <div className="entity-home-scope">
          {tab === 'quality' ? (
            <span>Every record of this type</span>
          ) : selected ? (
            <>
              <span>Selected record</span>
              <strong>{selected.name || selected.code}</strong>
              {selected.code && selected.name && <span className="mono">{selected.code}</span>}
              <Link href={`/${domainKey}/${selected.id}`}>Open record</Link>
            </>
          ) : (
            <span>Select a row. Dashboards use that record.</span>
          )}
        </div>
      </div>

      {/* Every tab stays mounted once warmed so the assistant sees all of them. */}
      {warmed.has('records') && (
        <div hidden={tab !== 'records'} className="entity-home-pane">
          <EntityAttributeTable
            domainCode={domainCode}
            domainKey={domainKey}
            asOfDate={asOfDate}
            refreshKey={refreshKey}
            emptyMessage={emptyMessage}
            related={parentColumns}
            onTotalChange={onTotalChange}
            selectedId={selected?.id}
            onSelect={setSelected}
            publishAs="records"
            publishLabel="Records"
          />
        </div>
      )}

      {warmed.has('dashboards') && selected && (
        <div hidden={tab !== 'dashboards'}>
          <EntityReports domainCode={domainCode} entityId={selected.id} asOfDate={asOfDate} embedded />
        </div>
      )}
      {tab === 'dashboards' && !selected && (
        <NeedsSelection onChoose={() => setTab('records')} />
      )}

      {warmed.has('quality') && (
        <div hidden={tab !== 'quality'}>
          <DataQualityDashboard embedded active={tab === 'quality'} domainCode={domainCode} />
        </div>
      )}
    </div>
  );
}

function NeedsSelection({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="entity-home-empty">
      <p>Select a record first. Dashboards run for that record.</p>
      <button type="button" className="btn" onClick={onChoose}>Choose a record</button>
    </div>
  );
}
