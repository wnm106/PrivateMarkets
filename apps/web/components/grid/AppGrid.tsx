'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllEnterpriseModule, LicenseManager } from 'ag-grid-enterprise';
import {
  ModuleRegistry,
  themeQuartz,
  type CellContextMenuEvent,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type FilterChangedEvent,
  type GridReadyEvent,
  type IsFullWidthRow,
  type RowClassParams,
  type RowClickedEvent,
  type RowDoubleClickedEvent,
  type RowHeightParams,
  type SortChangedEvent,
} from 'ag-grid-community';

const enterpriseLicense = process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY;
if (enterpriseLicense) LicenseManager.setLicenseKey(enterpriseLicense);

if (typeof window !== 'undefined' && !(window as Window & { __agGridTrialConsole?: boolean }).__agGridTrialConsole) {
  (window as Window & { __agGridTrialConsole?: boolean }).__agGridTrialConsole = true;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const text = args.map((arg) => String(arg)).join('\n');
    const trialBanner = text.includes('License Key Not Found')
      || text.includes('unlocked for trial')
      || text.includes('hide the watermark')
      || text.includes('AG Grid Enterprise License')
      || /^\*+$/.test(text.trim());
    if (trialBanner) return;
    originalError(...args);
  };
  if (!enterpriseLicense) {
    console.info('AG Grid Enterprise is in trial mode. Features are unlocked and a watermark is shown until NEXT_PUBLIC_AG_GRID_LICENSE_KEY is set.');
  }
}

ModuleRegistry.registerModules([AllEnterpriseModule]);

/** Quartz theme tuned to the tapestr.ai palette. Enterprise runs as a trial until a license key is set. */
export const appGridTheme = themeQuartz.withParams({
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  backgroundColor: '#ffffff',
  foregroundColor: '#0a1628',
  headerBackgroundColor: '#f7f9fc',
  headerTextColor: '#566a88',
  borderColor: '#dde6f1',
  rowHoverColor: '#eef5fc',
  accentColor: '#1a8cff',
  selectedRowBackgroundColor: '#e8f3ff',
  spacing: 6,
  wrapperBorderRadius: 6,
});

export interface GridStore<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

/** Lets custom headers re-render without AG Grid remounting them (which would drop input focus). */
export function createGridStore<T>(initial: T): GridStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useGridStore<T>(store: GridStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
}

function interactiveTarget(target: EventTarget | null | undefined) {
  const element = target as HTMLElement | null;
  return !!element?.closest?.('a, button, input, select, textarea, label');
}

/** Columns with a value can be dragged into the group-by bar. Action columns stay put. */
function withRowGroup<T>(columns: ColDef<T>[]): ColDef<T>[] {
  return columns.map((column) => {
    if (column.enableRowGroup != null) return column;
    const groupable = column.field != null || typeof column.valueGetter === 'function';
    return groupable ? { ...column, enableRowGroup: true } : column;
  });
}

export interface AppGridProps<T> {
  rows: T[];
  columns: ColDef<T>[];
  getRowId?: (row: T) => string;
  /** Grow with the rows. Turn off for large lists so the grid can virtualize. */
  autoHeight?: boolean;
  height?: number | string;
  emptyMessage?: string;
  loading?: boolean;
  context?: unknown;
  onRowClicked?: (row: T) => void;
  onRowDoubleClicked?: (row: T) => void;
  onCellContextMenu?: (event: CellContextMenuEvent<T>) => void;
  getRowClass?: (params: RowClassParams<T>) => string | string[] | undefined;
  className?: string;
  headerHeight?: number;
  /** Client-side column sort and filter. Off for server-paged and inline-edit grids. */
  enableSortFilter?: boolean;
  autoRowHeight?: boolean;
  onGridReady?: (api: GridApi<T>) => void;
  onFilterChanged?: (event: FilterChangedEvent<T>) => void;
  onSortChanged?: (event: SortChangedEvent<T>) => void;
  /** Enterprise: drop zone for row grouping. */
  rowGroupPanelShow?: 'always' | 'onlyWhenGrouping' | 'never';
  grandTotalRow?: 'top' | 'bottom' | 'pinnedTop' | 'pinnedBottom';
  pagination?: boolean;
  paginationPageSize?: number;
  autoGroupColumnDef?: ColDef<T>;
  pinnedTopRowData?: T[];
  isFullWidthRow?: IsFullWidthRow<T>;
  fullWidthCellRenderer?: any;
  getRowHeight?: (params: RowHeightParams<T>) => number | undefined | null;
  /** Changing this asks the grid to remeasure row heights. */
  layoutKey?: string | number;
}

export function AppGrid<T>({
  rows,
  columns,
  getRowId,
  autoHeight = true,
  height = 480,
  emptyMessage = 'No rows',
  loading = false,
  context,
  onRowClicked,
  onRowDoubleClicked,
  onCellContextMenu,
  getRowClass,
  className,
  headerHeight,
  enableSortFilter = true,
  autoRowHeight = false,
  onGridReady,
  onFilterChanged,
  onSortChanged,
  rowGroupPanelShow = 'always',
  grandTotalRow,
  pagination,
  paginationPageSize,
  autoGroupColumnDef,
  pinnedTopRowData,
  isFullWidthRow,
  fullWidthCellRenderer,
  getRowHeight,
  layoutKey,
}: AppGridProps<T>) {
  const [popupParent, setPopupParent] = useState<HTMLElement | undefined>(undefined);
  const [api, setApi] = useState<GridApi<T> | null>(null);

  useEffect(() => {
    setPopupParent(document.body);
  }, []);

  useEffect(() => {
    api?.resetRowHeights();
  }, [api, layoutKey]);

  const defaultColDef = useMemo<ColDef<T>>(() => ({
    sortable: enableSortFilter,
    filter: enableSortFilter,
    resizable: true,
    minWidth: 110,
    autoHeight: autoRowHeight,
    wrapText: autoRowHeight,
    suppressKeyboardEvent: (params) => interactiveTarget(params.event.target),
  }), [autoRowHeight, enableSortFilter]);

  const columnDefs = useMemo(() => withRowGroup(columns), [columns]);
  const groupColumn = autoGroupColumnDef ?? { headerName: 'Group', minWidth: 220, flex: 1 };

  const handleReady = (event: GridReadyEvent<T>) => {
    setApi(event.api);
    onGridReady?.(event.api);
  };

  const handleRowClicked = (event: RowClickedEvent<T>) => {
    if (!onRowClicked || !event.data) return;
    if (interactiveTarget(event.event?.target)) return;
    onRowClicked(event.data);
  };

  const handleRowDoubleClicked = (event: RowDoubleClickedEvent<T>) => {
    if (!onRowDoubleClicked || !event.data) return;
    if (interactiveTarget(event.event?.target)) return;
    onRowDoubleClicked(event.data);
  };

  return (
    <div
      className={`app-grid${onRowClicked ? ' is-clickable' : ''}${className ? ` ${className}` : ''}`}
      style={autoHeight ? undefined : { height, width: '100%' }}
    >
      <AgGridReact<T>
        modules={[AllEnterpriseModule]}
        theme={appGridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={getRowId ? (params: GetRowIdParams<T>) => getRowId(params.data) : undefined}
        domLayout={autoHeight ? 'autoHeight' : 'normal'}
        headerHeight={headerHeight}
        loading={loading}
        overlayNoRowsTemplate={`<span class="app-grid-empty">${escapeHtml(emptyMessage)}</span>`}
        context={context}
        onGridReady={handleReady}
        onFilterChanged={onFilterChanged}
        onSortChanged={onSortChanged}
        rowGroupPanelShow={rowGroupPanelShow}
        grandTotalRow={grandTotalRow}
        pagination={pagination}
        paginationPageSize={paginationPageSize}
        paginationPageSizeSelector={pagination ? [20, 50, 100] : undefined}
        autoGroupColumnDef={rowGroupPanelShow === 'never' ? autoGroupColumnDef : groupColumn}
        onRowClicked={onRowClicked ? handleRowClicked : undefined}
        onRowDoubleClicked={onRowDoubleClicked ? handleRowDoubleClicked : undefined}
        onCellContextMenu={onCellContextMenu}
        getRowClass={getRowClass}
        pinnedTopRowData={pinnedTopRowData}
        isFullWidthRow={isFullWidthRow}
        fullWidthCellRenderer={fullWidthCellRenderer}
        getRowHeight={getRowHeight}
        popupParent={popupParent}
        enableCellTextSelection
        ensureDomOrder
        animateRows={false}
        suppressDragLeaveHidesColumns
        suppressCellFocus={false}
      />
    </div>
  );
}

export type { CellContextMenuEvent, ColDef, FilterChangedEvent, GridApi, SortChangedEvent };
