'use client';

import { useMemo } from 'react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { useAttributeDisplay } from '@/components/forms/AttributeValueInput';
import { formatAttributeDisplay } from '@/lib/attribute-display';
import type { ActivityData } from './types';

function formatWritten(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDay(value: string | null | undefined) {
  if (!value) return '';
  if (value.startsWith('9999')) return 'Open';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ValueCell({ data }: ICellRendererParams<ActivityData>) {
  const meta = useAttributeDisplay(data?.attributeCode);
  const value = data?.value;
  if (value == null || value === '') return <span style={{ color: 'var(--ink-4)' }}>Cleared</span>;
  return <>{formatAttributeDisplay(value, meta) || value}</>;
}

/** Every write to the record, newest first, as a sortable and filterable table. */
export function ActivityGrid({ activities, loading = false }: { activities: ActivityData[]; loading?: boolean }) {
  const columns = useMemo<ColDef<ActivityData>[]>(() => [
    {
      headerName: 'Written',
      field: 'time',
      sort: 'desc',
      minWidth: 170,
      valueFormatter: (params) => formatWritten(params.value),
      filter: 'agDateColumnFilter',
      filterValueGetter: (params) => (params.data?.time ? new Date(params.data.time) : null),
    },
    { headerName: 'Who', field: 'who', minWidth: 140 },
    { headerName: 'Field', field: 'attribute', minWidth: 180, flex: 1 },
    { headerName: 'Value', field: 'value', minWidth: 160, flex: 1, cellRenderer: ValueCell },
    { headerName: 'Source', field: 'sourceName', minWidth: 130 },
    { headerName: 'Effective from', field: 'validFrom', minWidth: 130, valueFormatter: (params) => formatDay(params.value) },
    { headerName: 'Effective to', field: 'validTo', minWidth: 130, valueFormatter: (params) => formatDay(params.value) },
  ], []);

  return (
    <div className="data-table">
      <AppGrid
        rows={activities}
        columns={columns}
        autoHeight={false}
        height={560}
        loading={loading}
        emptyMessage="No activity recorded."
        rowGroupPanelShow="never"
      />
    </div>
  );
}
