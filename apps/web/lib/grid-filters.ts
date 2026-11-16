import type { ColDef, IMultiFilterParams } from 'ag-grid-community';

/**
 * Column filter used by the standard grids.
 *
 * The value list starts with nothing checked. The grid's default is the opposite:
 * every value starts checked, and the search box only hides rows in that list.
 * Checking one visible value then puts every hidden value back in the selection,
 * the model becomes "all values", and the grid shows every row again.
 *
 * A contains box under the header is the first child filter. The value list is
 * the second, so a text search does not clear a checked value, or the reverse.
 */
export function columnSearchFilterParams(): IMultiFilterParams {
  return {
    filters: [
      {
        filter: 'agTextColumnFilter',
        display: 'subMenu',
        title: 'Contains',
        filterParams: {
          filterOptions: ['contains'],
          defaultOption: 'contains',
          maxNumConditions: 1,
          caseSensitive: false,
          debounceMs: 200,
        },
      },
      {
        filter: 'agSetColumnFilter',
        filterParams: {
          defaultToNothingSelected: true,
          suppressClearModelOnRefreshValues: true,
          caseSensitive: false,
          browserAutoComplete: false,
          buttons: ['reset'],
        },
      },
    ],
  };
}

export interface GridMultiFilterModel {
  filterType: 'multi';
  filterModels: Array<Record<string, unknown> | null>;
}

/** Text currently applied by the contains box. */
export function textFromColumnFilter(model: unknown): string {
  const first = childModel(model, 0);
  const filter = first?.filter;
  return typeof filter === 'string' ? filter : '';
}

/**
 * Contains-search model for one column. Keeps the value-list selection in place.
 * An empty search with no checked values clears the column filter.
 */
export function likeSearchModel(current: unknown, text: string): GridMultiFilterModel | null {
  const existing = childModels(current);
  existing[0] = text ? { filterType: 'text', type: 'contains', filter: text } : null;
  if (existing.every((entry) => entry == null)) return null;
  return { filterType: 'multi', filterModels: existing };
}

/** Sort, group, and the standard search for columns that have not chosen their own filter. */
export function prepareGridColumns<T>(columns: ColDef<T>[], enableSortFilter: boolean): ColDef<T>[] {
  return columns.map((column) => {
    const next: ColDef<T> = { ...column };
    if (next.enableRowGroup == null && (next.field != null || typeof next.valueGetter === 'function')) {
      next.enableRowGroup = true;
    }
    if (!enableSortFilter || next.filter === false) return next;
    if (next.filter != null && next.filter !== true) return next;
    next.filter = 'agMultiColumnFilter';
    next.floatingFilter = true;
    next.filterParams = columnSearchFilterParams();
    return next;
  });
}

function childModels(model: unknown): Array<Record<string, unknown> | null> {
  if (!model || typeof model !== 'object') return [null, null];
  const filters = (model as { filterModels?: unknown }).filterModels;
  if (!Array.isArray(filters)) return [null, null];
  const copy = filters.map((entry) => (entry && typeof entry === 'object' ? { ...(entry as Record<string, unknown>) } : null));
  while (copy.length < 2) copy.push(null);
  return copy;
}

function childModel(model: unknown, index: number): Record<string, unknown> | null {
  return childModels(model)[index] ?? null;
}
