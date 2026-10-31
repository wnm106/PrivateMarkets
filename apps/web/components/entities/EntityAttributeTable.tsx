'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, FilterChangedEvent, SortChangedEvent } from 'ag-grid-community';
import { attributeDisplayKind, formatAttributeDisplay, type TableCellAlign, tableCellAlign } from '@/lib/attribute-display';
import { AppGrid, type GridApi } from '@/components/grid/AppGrid';
import { ATTRIBUTE_REGISTER_QUERY, graphqlQuery } from '@/lib/graphql';
import { GRID_QUERY, type GridResultPayload } from '@/lib/reporting';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import { isRowAttributeCode } from '@/components/detail/attribute-source';

const NO_RELATED: RelatedAttributeColumn[] = [];
const CLIENT_LIMIT = 10000;
const FALLBACK_SCAN = 10000;
const BLANK = '__blank__';

const TEXT_OPS: Record<string, string> = {
  contains: 'contains',
  equals: 'eq',
  notEqual: 'neq',
  startsWith: 'startsWith',
};
const NUMBER_OPS: Record<string, string> = {
  equals: 'eq',
  notEqual: 'neq',
  greaterThan: 'gt',
  greaterThanOrEqual: 'gte',
  lessThan: 'lt',
  lessThanOrEqual: 'lte',
  inRange: 'between',
};

export interface RelatedAttributeColumn {
  alias: string;
  label: string;
  direction: 'UP' | 'DOWN';
  relationshipCode?: string;
  domainCode?: string;
  /** Attribute code on the related entity, or entity_name / entity_code. */
  field: string;
  header: string;
}

interface CatalogAttr {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  listValues?: string[] | null;
  domainCode?: string | null;
  aggregationType?: string | null;
  weightAttributeCode?: string | null;
}

interface Col {
  code: string;
  name: string;
  kind: 'text' | 'num' | 'date' | 'bool';
  align: TableCellAlign;
  dataType?: string;
  listValues: string[];
  aggregationType?: string | null;
  weightAttributeCode?: string | null;
}

type Filter = { field: string; op: string; value?: any };

function kindOf(dataType: string): Col['kind'] {
  const kind = attributeDisplayKind({ dataType });
  if (kind === 'date') return 'date';
  if (kind === 'boolean') return 'bool';
  if (kind === 'text') return 'text';
  return 'num';
}

function columnMeta(dataType: string): Pick<Col, 'kind' | 'align'> {
  return { kind: kindOf(dataType), align: tableCellAlign(dataType) };
}

function errorText(error: any): string {
  if (!error) return '';
  const gql = Array.isArray(error.graphQLErrors)
    ? error.graphQLErrors.map((e: any) => e?.message).filter(Boolean).join(' ')
    : '';
  return gql || error.message || 'Query failed';
}

function cellText(value: any): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function columnAggFunc(col: Col): string | ((params: any) => number | null) | undefined {
  if (col.kind !== 'num') return undefined;
  const type = String(col.aggregationType || 'NONE').toUpperCase();
  if (type === 'SUM') return 'sum';
  if (type === 'AVG' || type === 'AVERAGE') return 'avg';
  if (type === 'MIN') return 'min';
  if (type === 'MAX') return 'max';
  if (type === 'COUNT') return 'count';
  if (type === 'WEIGHTED_AVG') {
    const weightCode = col.weightAttributeCode;
    if (!weightCode) return 'avg';
    const weightedAvg = (params: any) => {
      let weighted = 0;
      let weightTotal = 0;
      for (const leaf of params.rowNode?.allLeafChildren || []) {
        const value = filterValue(leaf.data?.[col.code], col);
        const weight = Number(leaf.data?.[weightCode]);
        if (typeof value === 'number' && Number.isFinite(weight)) {
          weighted += value * weight;
          weightTotal += weight;
        }
      }
      return weightTotal ? weighted / weightTotal : null;
    };
    Object.defineProperty(weightedAvg, 'name', { value: 'weighted avg' });
    return weightedAvg;
  }
  return undefined;
}

function formatCell(value: any, col: Pick<Col, 'kind' | 'dataType'>): string {
  const text = cellText(value);
  if (!text) return '';
  if (col.kind === 'num' || typeof value === 'number') {
    return formatAttributeDisplay(text, { dataType: col.dataType }) || text;
  }
  if (col.kind === 'date' && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

/** Column search (contains) and value filter (exact or blank), plus an optional search across every column. */
export function buildAttributeFilters(
  columns: Col[],
  globalSearch: string,
  columnSearch: Record<string, string>,
  columnExact: Record<string, string>
): Filter[] {
  const filters: Filter[] = [];
  const global = globalSearch.trim();
  if (global) filters.push({ field: 'entity_code', op: 'searchAny', value: global });
  for (const col of columns) {
    const exact = (columnExact[col.code] || '').trim();
    const search = (columnSearch[col.code] || '').trim();
    if (exact === BLANK) {
      filters.push({ field: col.code, op: 'isNull' });
      continue;
    }
    if (exact) filters.push({ field: col.code, op: 'eq', value: exact });
    if (search) filters.push({ field: col.code, op: 'contains', value: search });
  }
  return filters;
}

function filterValue(value: any, col: Col) {
  if (value == null || value === '') return null;
  if (col.kind === 'num') {
    const numeric = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (col.kind === 'date') {
    const day = dayValue(value);
    return day ? new Date(`${day}T00:00:00`) : null;
  }
  const text = cellText(value);
  return text || null;
}

function dayValue(value: unknown): string {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

/** Translate an AG Grid filter model into the server grid operators. */
function filtersFromGridModel(model: Record<string, any> | null | undefined): Filter[] {
  const filters: Filter[] = [];
  for (const [field, raw] of Object.entries(model || {})) {
    if (!raw || raw.operator === 'OR') continue;
    const conditions = Array.isArray(raw.conditions) ? raw.conditions : [raw];
    for (const condition of conditions) {
      const mapped = mapGridCondition(field, condition);
      if (mapped) filters.push(mapped);
    }
  }
  return filters;
}

function mapGridCondition(field: string, model: any): Filter | null {
  if (!model?.type) return null;
  const type = String(model.type);
  if (type === 'blank') return { field, op: 'isNull' };
  if (type === 'notBlank') return { field, op: 'notNull' };
  if (model.filterType === 'date' || model.dateFrom) {
    const from = dayValue(model.dateFrom || model.filter);
    const to = dayValue(model.dateTo || model.filterTo);
    const op = NUMBER_OPS[type];
    if (!op || !from) return null;
    if (op === 'between') return to ? { field, op, value: [from, to] } : null;
    return { field, op, value: from };
  }
  if (model.filterType === 'number') {
    const op = NUMBER_OPS[type];
    if (!op || model.filter == null || model.filter === '') return null;
    if (op === 'between') {
      if (model.filterTo == null || model.filterTo === '') return null;
      return { field, op, value: [model.filter, model.filterTo] };
    }
    return { field, op, value: model.filter };
  }
  const op = TEXT_OPS[type];
  if (!op || model.filter == null || String(model.filter).trim() === '') return null;
  return { field, op, value: String(model.filter).trim() };
}

function filterChipLabel(filter: Filter, columns: Col[]): string {
  const name = columns.find((col) => col.code === filter.field)?.name || filter.field;
  if (filter.op === 'isNull') return `${name}: blank`;
  if (filter.op === 'notNull') return `${name}: not blank`;
  if (filter.op === 'between' && Array.isArray(filter.value)) return `${name}: ${filter.value[0]} – ${filter.value[1]}`;
  const word: Record<string, string> = {
    contains: 'contains',
    eq: 'equals',
    neq: 'not',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    startsWith: 'starts with',
  };
  return `${name} ${word[filter.op] || filter.op} “${filter.value}”`;
}

function rowMatchesGlobal(row: Record<string, any>, columns: Col[], term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const hay = [row.entity_code, row.entity_name, ...columns.map((c) => cellText(row[c.code]))]
    .join('\n')
    .toLowerCase();
  return hay.includes(needle);
}

function AggregateCell(props: any) {
  const col = props.col as Col;
  if (props.node?.group || props.node?.footer) {
    const value = props.node.aggData?.[props.column?.getColId?.() || col.code] ?? props.value;
    const text = formatCell(value, col);
    return text ? <span>{text}</span> : null;
  }
  return <span>{props.valueFormatted || formatCell(props.value, col) || ''}</span>;
}

function EntityLinkCell(props: any) {
  const code = props.column?.getColId?.() || props.colDef?.colId;
  const text = props.valueFormatted || props.value || '';
  if (!props.data?.entity_id) return <span>{text}</span>;
  const href = `/${props.context.get().domainKey}/${props.data.entity_id}`;
  return (
    <Link href={href} className={code === 'entity_code' ? 'row-id entity-link' : 'row-name entity-link'} onClick={(event) => event.stopPropagation()}>
      {text}
    </Link>
  );
}

export function EntityAttributeTable({
  domainCode,
  domainKey,
  asOfDate,
  refreshKey = 0,
  emptyMessage,
  related = NO_RELATED,
  onTotalChange,
  selectedId,
  onSelect,
}: {
  domainCode: string;
  domainKey: string;
  asOfDate?: string;
  refreshKey?: number;
  emptyMessage: string;
  related?: RelatedAttributeColumn[];
  onTotalChange?: (total: number) => void;
  selectedId?: string | null;
  onSelect?: (entity: { id: string; name: string; code: string }) => void;
}) {
  const router = useRouter();
  const inspect = useAttributeInspect();
  const relatedKey = JSON.stringify(related);
  const stableRelated = useMemo(() => related, [relatedKey]);
  const [catalog, setCatalog] = useState<Col[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [rows, setRows] = useState<Array<Record<string, any>>>([]);
  const [matched, setMatched] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [globalDraft, setGlobalDraft] = useState('');
  const [globalSearch, setGlobalSearch] = useState('');
  const [gridFilters, setGridFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const gridApi = useRef<GridApi<Record<string, any>> | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    gridApi.current?.redrawRows();
  }, [selectedId]);
  const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterKey = useRef('[]');
  const reqId = useRef(0);

  const columns = useMemo<Col[]>(() => {
    const id: Col = { code: 'entity_code', name: 'ID', kind: 'text', align: 'left', listValues: [] };
    const name: Col = { code: 'entity_name', name: 'Name', kind: 'text', align: 'left', listValues: [] };
    const relatedCols: Col[] = stableRelated.map((r) => ({
      code: `${r.alias}.${r.field}`,
      name: r.header,
      kind: 'text',
      align: 'left',
      listValues: [],
    }));
    return [id, name, ...relatedCols, ...catalog];
  }, [catalog, stableRelated]);

  const lookups = useMemo(() => {
    const seen = new Set<string>();
    return stableRelated.filter((r) => {
      if (seen.has(r.alias)) return false;
      seen.add(r.alias);
      return true;
    }).map((r) => ({
      alias: r.alias,
      label: r.label,
      direction: r.direction,
      relationshipCode: r.relationshipCode,
      domainCode: r.domainCode,
    }));
  }, [stableRelated]);

  const attributeColumns = useMemo(
    () => columns.filter((c) => c.code !== 'entity_code' && c.code !== 'entity_name'),
    [columns]
  );

  useEffect(() => {
    const handle = setTimeout(() => {
      const nextGlobal = globalDraft.trim();
      setGlobalSearch((prev) => (prev === nextGlobal ? prev : nextGlobal));
    }, 300);
    return () => clearTimeout(handle);
  }, [globalDraft]);

  useEffect(() => {
    let cancelled = false;
    setCatalogReady(false);
    graphqlQuery<{ attributeRegister: CatalogAttr[] }, { domainCode: string }>(
      ATTRIBUTE_REGISTER_QUERY,
      { domainCode },
      'network-only'
    ).then((res) => {
      if (cancelled) return;
      if (res.error) {
        setError(errorText(res.error));
        setCatalog([]);
      } else {
        const attrs = res.data?.attributeRegister || [];
        const seen = new Set<string>();
        const cols = attrs
          .filter((a) => {
            // The grid reserves "<alias>.<attribute>" for attributes reached through a
            // declared lookup, so a dotted code is not addressable as a plain column and
            // fails the whole query. Related columns come from `related` instead.
            if (!a.attributeCode || a.attributeCode.includes('.') || seen.has(a.attributeCode)) return false;
            seen.add(a.attributeCode);
            return true;
          })
          .map((a) => ({
            code: a.attributeCode,
            name: a.attributeName || a.attributeCode,
            ...columnMeta(a.dataType),
            dataType: a.dataType,
            listValues: (a.listValues || []).map(String).filter(Boolean),
            aggregationType: a.aggregationType,
            weightAttributeCode: a.weightAttributeCode,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCatalog(cols);
      }
      setCatalogReady(true);
    });
    return () => { cancelled = true; };
  }, [domainCode, refreshKey]);

  const filters = useMemo(() => {
    const global = globalSearch.trim();
    const base: Filter[] = global ? [{ field: 'entity_code', op: 'searchAny', value: global }] : [];
    return [...base, ...gridFilters];
  }, [globalSearch, gridFilters]);

  const loadPage = useCallback(async () => {
    if (!catalogReady) return;
    const id = ++reqId.current;
    setLoading(true);
    const base = {
      start: 'DOMAIN',
      domainCode,
      asOfDate: asOfDate || null,
      columns: attributeColumns.map((c) => c.code),
      lookups,
      sort: sort ? [sort] : [{ field: 'entity_name', dir: 'asc' }],
    };
    const pageInput = {
      ...base,
      filters,
      offset: 0,
      limit: CLIENT_LIMIT,
    };
    const res = await graphqlQuery<{ gridQuery: GridResultPayload }, { input: any }>(
      GRID_QUERY,
      { input: pageInput },
      'network-only'
    );
    if (id !== reqId.current) return;

    const failed = errorText(res.error);
    const searchAnyMissing = filters.some((f) => f.op === 'searchAny') && /unsupported operator/i.test(failed);
    if (searchAnyMissing) {
      const without = filters.filter((f) => f.op !== 'searchAny');
      const scan = await graphqlQuery<{ gridQuery: GridResultPayload }, { input: any }>(
        GRID_QUERY,
        { input: { ...base, filters: without, offset: 0, limit: FALLBACK_SCAN, export: true } },
        'network-only'
      );
      if (id !== reqId.current) return;
      if (scan.error) {
        setError(errorText(scan.error));
        setRows([]);
        setMatched(0);
        setLoading(false);
        return;
      }
      const all = scan.data?.gridQuery.rows || [];
      const filtered = all.filter((row) => rowMatchesGlobal(row, columns, globalSearch)).slice(0, CLIENT_LIMIT);
      setRows(filtered);
      setMatched(filtered.length);
      setScanNote(
        (scan.data?.gridQuery.total || 0) > all.length
          ? `Search checked the first ${all.length.toLocaleString()} records. Apply the database migration to search the full set.`
          : null
      );
      setError(null);
      setLoading(false);
      return;
    }

    if (failed) {
      setError(failed);
      setRows([]);
      setMatched(0);
      setScanNote(null);
      setLoading(false);
      return;
    }
    const grid = res.data?.gridQuery;
    const loaded = grid?.rows || [];
    const total = grid?.total || 0;
    setRows(loaded);
    setMatched(total);
    if (filters.length === 0) onTotalChange?.(total);
    setScanNote(total > loaded.length
      ? `Row groups and totals use the first ${loaded.length.toLocaleString()} of ${total.toLocaleString()} matching records.`
      : null);
    setError(null);
    setLoading(false);
  }, [catalogReady, domainCode, asOfDate, attributeColumns, lookups, sort, filters, columns, globalSearch, onTotalChange]);

  useEffect(() => { loadPage(); }, [loadPage, refreshKey]);

  const clearField = (field: string) => {
    const model = { ...(gridApi.current?.getFilterModel() || {}) };
    delete model[field];
    gridApi.current?.setFilterModel(model);
    const next = filtersFromGridModel(model);
    filterKey.current = JSON.stringify(next);
    setGridFilters(next);
  };

  const clearAll = () => {
    gridApi.current?.setFilterModel(null);
    filterKey.current = '[]';
    setGridFilters([]);
    setGlobalDraft('');
    setGlobalSearch('');
  };

  const applyGridFilters = (event: FilterChangedEvent) => {
    if (filterTimer.current) clearTimeout(filterTimer.current);
    filterTimer.current = setTimeout(() => {
      const next = filtersFromGridModel(event.api.getFilterModel());
      const key = JSON.stringify(next);
      if (key === filterKey.current) return;
      filterKey.current = key;
      setGridFilters(next);
    }, 300);
  };

  const applyGridSort = (event: SortChangedEvent) => {
    const sorted = event.api.getColumnState().find((column) => column.sort === 'asc' || column.sort === 'desc');
    const next = sorted?.colId && (sorted.sort === 'asc' || sorted.sort === 'desc')
      ? { field: sorted.colId, dir: sorted.sort }
      : null;
    setSort((current) => (current?.field === next?.field && current?.dir === next?.dir ? current : next));
  };

  const activeChips = gridFilters.map((filter) => ({
    key: `${filter.field}-${filter.op}-${JSON.stringify(filter.value ?? '')}`,
    label: filterChipLabel(filter, columns),
    clear: () => clearField(filter.field),
  }));
  if (globalSearch) {
    activeChips.unshift({
      key: 'global',
      label: `Any attribute contains “${globalSearch}”`,
      clear: () => { setGlobalDraft(''); setGlobalSearch(''); },
    });
  }

  const shown = rows.length;

  const gridActions = useRef({ domainKey });
  gridActions.current = { domainKey };
  const gridContext = useMemo(() => ({ get: () => gridActions.current }), []);
  const columnDefs = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = columns.map((col) => {
      const aggFunc = columnAggFunc(col);
      return {
      colId: col.code,
      headerName: col.name,
      sortable: true,
      filter: col.kind === 'num' ? 'agNumberColumnFilter' : col.kind === 'date' ? 'agDateColumnFilter' : 'agSetColumnFilter',
      floatingFilter: true,
      filterParams: col.kind === 'text' || col.kind === 'bool'
        ? { applyMiniFilterWhileTyping: true, defaultToNothingSelected: false }
        : { maxNumConditions: 2, buttons: ['reset'] },
      enableRowGroup: true,
      enableValue: Boolean(aggFunc),
      aggFunc,
      allowedAggFuncs: aggFunc ? ['sum', 'avg', 'min', 'max', 'count'] : undefined,
      sort: col.code === 'entity_name' ? 'asc' : undefined,
      pinned: col.code === 'entity_code' ? 'left' : undefined,
      minWidth: col.code === 'entity_code' ? 140 : 160,
      flex: 1,
      cellStyle: { textAlign: col.align },
      cellClass: isRowAttributeCode(col.code) ? 'attr-inspectable' : undefined,
      valueGetter: (params) => {
        if (params.node?.group || params.node?.footer) {
          return params.node.aggData?.[col.code];
        }
        return filterValue(params.data?.[col.code], col);
      },
      valueFormatter: (params) => {
        const raw = params.node?.group || params.node?.footer
          ? params.value
          : (params.data ? params.data[col.code] : params.value);
        return formatCell(raw, col) || '';
      },
      cellRenderer: col.code === 'entity_code' || col.code === 'entity_name'
        ? EntityLinkCell
        : aggFunc ? AggregateCell : undefined,
      cellRendererParams: aggFunc ? { col } : undefined,
    };
    });
    defs.push({
      colId: 'status',
      headerName: 'Status',
      sortable: false,
      filter: false,
      width: 110,
      maxWidth: 120,
      valueGetter: () => 'Active',
      cellRenderer: () => <span className="status-chip active">Active</span>,
    });
    return defs;
  }, [columns]);

  return (
    <>
      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <input
          className="attr-global-search"
          value={globalDraft}
          placeholder="Search all attributes"
          aria-label="Search all attributes"
          onChange={(e) => setGlobalDraft(e.target.value)}
        />
        {activeChips.map((chip) => (
          <button key={chip.key} type="button" className="filter-pill active" onClick={chip.clear}>
            {chip.label} <span className="x">×</span>
          </button>
        ))}
        {activeChips.length > 0 && (
          <button type="button" className="filter-pill" onClick={clearAll}>Clear</button>
        )}
        <div className="filter-count">
          Showing <strong>{loading ? '…' : shown}</strong> of {loading ? '…' : matched}
        </div>
      </div>
      {scanNote && <div className="attr-table-note">{scanNote}</div>}
      {error && <div className="attr-table-error">{error}</div>}

      <div className="data-table attr-table-wrap" style={{ opacity: loading && rows.length ? 0.55 : 1 }}>
        <AppGrid
          rows={catalogReady ? rows : []}
          columns={columnDefs}
          getRowId={(row) => String(row.entity_id || row.entity_code || 'row')}
          autoHeight={false}
          height="100%"
          enableSortFilter
          loading={!catalogReady || (loading && rows.length === 0)}
          emptyMessage={!catalogReady || loading ? 'Loading…' : (filters.length > 0 ? 'No records match these filters.' : emptyMessage)}
          context={gridContext}
          onGridReady={(api) => { gridApi.current = api; }}
          onFilterChanged={applyGridFilters}
          onSortChanged={applyGridSort}
          rowGroupPanelShow="always"
          grandTotalRow="bottom"
          autoGroupColumnDef={{ headerName: 'Group', minWidth: 220 }}
          getRowClass={(params) => (
            params.data?.entity_id && String(params.data.entity_id) === selectedIdRef.current
              ? 'entity-row-selected'
              : undefined
          )}
          onRowClicked={(row) => {
            if (!row.entity_id) return;
            if (onSelect) {
              onSelect({
                id: String(row.entity_id),
                name: cellText(row.entity_name),
                code: cellText(row.entity_code),
              });
              return;
            }
            router.push(`/${domainKey}/${row.entity_id}`);
          }}
          onRowDoubleClicked={onSelect ? (row) => {
            if (!row.entity_id) return;
            router.push(`/${domainKey}/${row.entity_id}`);
          } : undefined}
          onCellContextMenu={(event) => {
            const code = event.column?.getColId?.() || '';
            if (!isRowAttributeCode(code) || !event.data) return;
            (event.event as MouseEvent | undefined)?.preventDefault();
            const col = columns.find((item) => item.code === code);
            if (!col) return;
            inspect.open({
              entityId: String(event.data.entity_id),
              entityName: cellText(event.data.entity_name) || cellText(event.data.entity_code),
              attributeCode: col.code,
              attributeName: col.name,
              dataType: col.dataType,
              value: formatCell(event.data[col.code], col),
              domainCode,
              onChanged: () => { void loadPage(); },
            });
          }}
        />
      </div>
    </>
  );
}
