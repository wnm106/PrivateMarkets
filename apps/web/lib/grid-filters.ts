import type { ColDef, IMultiFilterParams, ITextFilterParams } from 'ag-grid-community';

/** Substring match. The box under the header uses this. */
export function textContainsFilterParams(): ITextFilterParams {
  return {
    filterOptions: ['contains'],
    defaultOption: 'contains',
    maxNumConditions: 1,
    caseSensitive: false,
    debounceMs: 200,
  };
}

/**
 * Contains search plus the value pick list.
 *
 * The list starts with nothing checked. The grid's default is the opposite:
 * every value starts checked, and choosing one visible value after a search
 * puts the hidden values back in, which clears the filter.
 */
export function columnSearchFilterParams(): IMultiFilterParams {
  return {
    filters: [
      {
        filter: 'agTextColumnFilter',
        display: 'inline',
        title: 'Contains',
        filterParams: textContainsFilterParams(),
      },
      {
        filter: 'agSetColumnFilter',
        display: 'inline',
        title: 'Values',
        filterParams: {
          defaultToNothingSelected: true,
          suppressClearModelOnRefreshValues: true,
          caseSensitive: false,
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
 * Contains-search model for one column. Keeps the pick-list selection in place.
 * An empty search with no checked values clears the column filter.
 */
export function likeSearchModel(current: unknown, text: string): GridMultiFilterModel | null {
  const existing = childModels(current);
  existing[0] = text ? { filterType: 'text', type: 'contains', filter: text } : null;
  if (existing.every((entry) => entry == null)) return null;
  return { filterType: 'multi', filterModels: existing };
}

/** Sort, group, and the standard search for string columns. */
export function prepareGridColumns<T>(columns: ColDef<T>[], enableSortFilter: boolean): ColDef<T>[] {
  return columns.map((column) => {
    const next: ColDef<T> = { ...column };
    if (next.enableRowGroup == null && (next.field != null || typeof next.valueGetter === 'function')) {
      next.enableRowGroup = true;
    }
    if (!enableSortFilter || next.filter === false) return next;
    if (next.filter != null && next.filter !== true && !isStringColumnFilter(next.filter)) return next;
    next.filter = 'agMultiColumnFilter';
    next.floatingFilter = true;
    next.floatingFilterComponent = undefined;
    next.filterParams = columnSearchFilterParams();
    return next;
  });
}

function isStringColumnFilter(filter: ColDef['filter']): boolean {
  return filter === 'agSetColumnFilter' || filter === 'agMultiColumnFilter' || filter === 'agTextColumnFilter';
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
