'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DataQualityDashboard, unopenedQualityTabs } from '@/components/quality/DataQualityDashboard';
import { EntityReports } from '@/components/reporting/EntityReports';
import { DOMAIN_TYPES_QUERY, INTERSECTION_TYPES_QUERY, RELATIONSHIP_TYPES_QUERY, graphqlQuery } from '@/lib/graphql';
import { definingParentDomains, mergeParentColumns, parentEntityColumns, toParentLinkCounts, type ParentEntityColumn } from '@/lib/parent-entities';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { useTemporalStore } from '@/lib/store';
import { usePublishTab, usePublishTabs, useWarmTabs } from '@/lib/view-context';
import { EntityAttributeTable, type RelatedAttributeColumn } from './EntityAttributeTable';
import { EntityViews } from './EntityViews';

type HomeTab = 'records' | 'views' | 'dashboards' | 'quality';

const NO_PARENTS: ParentEntityColumn[] = [];
/** How long the grid waits for the parent columns before it loads without them. */
const PARENT_WAIT_MS = 2000;

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
  // Data Quality is not warmed: its figures are read only when the user opens that tab.
  // Until then the page publishes the tab's name and purpose with a note saying so.
  const warmed = useWarmTabs(['records', 'views', 'dashboards'], tab);
  const qualityOpened = warmed.has('quality');
  usePublishTabs(qualityOpened ? {} : unopenedQualityTabs({ domainCode }));
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
  // The parent columns found for one entity type. Kept with the type they belong to, so a
  // change of type never shows, or loads the grid with, the previous type's columns.
  const [parents, setParents] = useState<{ domainCode: string; columns: ParentEntityColumn[] } | null>(null);
  const [parentWaitOver, setParentWaitOver] = useState<string | null>(null);
  const discovered = parents?.domainCode === domainCode ? parents.columns : NO_PARENTS;
  // The grid waits for the parent columns so it loads once, with them. If they are slow it
  // goes ahead without them and loads again when they arrive.
  const parentsReady = parents?.domainCode === domainCode || parentWaitOver === domainCode;
  // With a record chosen, EntityReports publishes the Dashboards tab. Without one the
  // tab shows only a prompt, and says so (docs/SURFACE_TABS.md).
  usePublishTab('dashboards', selected ? null : {
    label: 'Dashboards',
    purpose: 'The dashboards and narratives defined for this type of record, run for the record being viewed.',
    data: { note: 'No record is chosen. Dashboards and narratives run for one record: choose one on the Records tab.' },
  });

  useEffect(() => {
    setSelected(null);
    setTab('records');
  }, [domainCode]);

  useEffect(() => {
    let cancelled = false;
    const waitTimer = window.setTimeout(() => {
      if (!cancelled) setParentWaitOver(domainCode);
    }, PARENT_WAIT_MS);
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
      const definingParents = definingParentDomains(domainCode, intersections.data?.intersectionTypes || []);
      setParents({ domainCode, columns: parentEntityColumns(domainCode, types, names, linkCounts, definingParents) });
    }).catch(() => {
      if (!cancelled) setParents({ domainCode, columns: [] });
    }).finally(() => window.clearTimeout(waitTimer));
    return () => {
      cancelled = true;
      window.clearTimeout(waitTimer);
    };
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
          <button type="button" role="tab" aria-selected={tab === 'views'} className={`xp-tab ${tab === 'views' ? 'active' : ''}`} onClick={() => setTab('views')}>
            Views
          </button>
          <button type="button" role="tab" aria-selected={tab === 'dashboards'} className={`xp-tab ${tab === 'dashboards' ? 'active' : ''}`} onClick={() => setTab('dashboards')}>
            Dashboards
          </button>
          <button type="button" role="tab" aria-selected={tab === 'quality'} className={`xp-tab ${tab === 'quality' ? 'active' : ''}`} onClick={() => setTab('quality')}>
            Data Quality
          </button>
        </div>
        <div className="entity-home-scope">
          {tab === 'quality' || tab === 'views' ? (
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
            relatedReady={parentsReady}
            onTotalChange={onTotalChange}
            selectedId={selected?.id}
            onSelect={setSelected}
            publishAs="records"
            publishLabel="Records"
          />
        </div>
      )}

      {warmed.has('views') && (
        <div hidden={tab !== 'views'} className="entity-home-pane">
          <EntityViews domainCode={domainCode} domainKey={domainKey} asOfDate={asOfDate} knowledgeDate={knowledgeDate} />
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

      {qualityOpened && (
        <div hidden={tab !== 'quality'}>
          <DataQualityDashboard active={tab === 'quality'} domainCode={domainCode} />
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
