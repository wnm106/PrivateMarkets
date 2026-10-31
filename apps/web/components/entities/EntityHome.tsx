'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DataQualityDashboard } from '@/components/quality/DataQualityDashboard';
import { EntityReports } from '@/components/reporting/EntityReports';
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
  const [selected, setSelected] = useState<SelectedEntity | null>(null);

  useEffect(() => {
    setSelected(null);
    setTab('records');
  }, [domainCode]);

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
          {selected ? (
            <>
              <span>Selected record</span>
              <strong>{selected.name || selected.code}</strong>
              {selected.code && selected.name && <span className="mono">{selected.code}</span>}
              <Link href={`/${domainKey}/${selected.id}`}>Open record</Link>
            </>
          ) : (
            <span>Select a row. Dashboards and Data Quality use that record.</span>
          )}
        </div>
      </div>

      {tab === 'records' && (
        <EntityAttributeTable
          domainCode={domainCode}
          domainKey={domainKey}
          asOfDate={asOfDate}
          refreshKey={refreshKey}
          emptyMessage={emptyMessage}
          related={related}
          onTotalChange={onTotalChange}
          selectedId={selected?.id}
          onSelect={setSelected}
        />
      )}

      {tab === 'dashboards' && (
        selected ? (
          <EntityReports domainCode={domainCode} entityId={selected.id} asOfDate={asOfDate} embedded />
        ) : (
          <NeedsSelection onChoose={() => setTab('records')} />
        )
      )}

      {tab === 'quality' && (
        selected ? (
          <DataQualityDashboard embedded domainCode={domainCode} entityId={selected.id} />
        ) : (
          <NeedsSelection onChoose={() => setTab('records')} />
        )
      )}
    </div>
  );
}

function NeedsSelection({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="entity-home-empty">
      <p>Select a record first. Dashboards and data quality run for that record.</p>
      <button type="button" className="btn" onClick={onChoose}>Choose a record</button>
    </div>
  );
}
