'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValueChangedEvent, ColDef, FilterChangedEvent, SortChangedEvent } from 'ag-grid-community';
import { attributeDisplayKind, formatAttributeDisplay, type TableCellAlign, tableCellAlign } from '@/lib/attribute-display';
import { cellEditSeed, inlineCommitValue } from '@/lib/inline-field';
import { withParentNames } from '@/lib/parent-entities';
import { AttributeCellEditor } from '@/components/entities/AttributeCellEditor';
import { AppGrid, type GridApi } from '@/components/grid/AppGrid';
import { columnSearchFilterParams } from '@/lib/grid-filters';
import { ADD_COMPETING_SOURCE_MUTATION, ATTRIBUTE_REGISTER_QUERY, ATTRIBUTE_SECTIONS_QUERY, DATA_SOURCE_QUERY, graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { attributesInDisplayOrder, type AttributeSectionOrder } from '@/lib/attribute-layout';
import { GRID_QUERY, type GridResultPayload } from '@/lib/reporting';
import { aggregateNumber, attributeAggregation, gridAggFunc, numericValue, type GridAggFunc } from '@/lib/grid-aggregation';
import { listFilterToCodes, listLabel, useListLabels } from '@/lib/list-labels';
import { usePublishTab } from '@/lib/view-context';
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
  isEditable?: boolean | null;
  aggregationType?: string | null;
  weightAttributeCode?: string | null;
  displaySection?: string | null;
  displayGroup?: number | null;
  referenceListCode?: string | null;
}

interface Col {
  code: string;
  name: string;
  kind: 'text' | 'num' | 'date' | 'bool';
  align: TableCellAlign;
  dataType?: string;
  listValues: string[];
  /** False for identity columns and attributes the register marks read-only. */
  editable: boolean;
  aggregationType?: string | null;
  weightAttributeCode?: string | null;
  /** Set when the attribute stores a code from a reference list; the grid shows the label. */
  listCode?: string | null;
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

function columnAggFunc(col: Col): GridAggFunc | undefined {
  if (col.kind !== 'num' || col.listCode) return undefined;
  const weightCode = col.weightAttributeCode;
  return gridAggFunc(
    attributeAggregation(col.aggregationType, col.dataType),
    (data) => numericValue(data?.[col.code]),
    weightCode ? (data) => numericValue(data?.[weightCode]) : null,
  );
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

const revertingCells = new Set<string>();
let manualSourceIdPromise: Promise<string> | null = null;

function manualSourceId(): Promise<string> {
  if (!manualSourceIdPromise) {
    manualSourceIdPromise = graphqlQuery<{ dataSource: { id: string } | null }, { code: string }>(
      DATA_SOURCE_QUERY,
      { code: 'MANUAL' },
      'network-only',
    ).then((result) => {
      const id = result.data?.dataSource?.id;
      if (!id) {
        manualSourceIdPromise = null;
        throw new Error(result.error?.message || 'Manual override is not registered');
      }
      return id;
    }).catch((error) => {
      manualSourceIdPromise = null;
      throw error;
    });
  }
  return manualSourceIdPromise;
}

/** A cell edit on the register writes the golden value as a manual override. */
async function commitManualOverride(
  event: CellValueChangedEvent<Record<string, any>>,
  columns: Col[],
  asOfDate: string | undefined,
  setError: (message: string | null) => void,
) {
  const code = event.column.getColId();
  const entityId = String(event.data?.entity_id || '');
  const key = `${entityId}:${code}`;
  if (revertingCells.has(key)) {
    revertingCells.delete(key);
    return;
  }
  if (!entityId || !isRowAttributeCode(code) || event.node?.group || event.node?.footer) return;
  const col = columns.find((item) => item.code === code);
  if (!col?.editable) return;
  const previous = cellEditSeed(event.oldValue);
  const next = inlineCommitValue(cellEditSeed(event.newValue), previous, col?.kind === 'num');
  const restore = () => {
    if (cellEditSeed(event.data?.[code]) === previous) return;
    revertingCells.add(key);
    event.node?.setDataValue(code, event.oldValue);
  };
  if (!next) {
    restore();
    return;
  }
  try {
    const sourceId = await manualSourceId();
    const validFrom = asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
      ? asOfDate
      : new Date().toISOString().slice(0, 10);
    const result = await graphqlMutation<
      { addCompetingSource: { success: boolean; errors: Array<{ message: string }> } },
      { input: { entityId: string; attributeCode: string; sourceId: string; value: string; validFrom: string } }
    >(ADD_COMPETING_SOURCE_MUTATION, {
      input: { entityId, attributeCode: code, sourceId, value: next, validFrom },
    });
    const message = result.error?.message || result.data?.addCompetingSource?.errors?.[0]?.message;
    if (message || !result.data?.addCompetingSource?.success) throw new Error(message || 'Could not save the value');
    setError(null);
  } catch (error) {
    restore();
    setError(error instanceof Error ? error.message : 'Could not save the value');
  }
}

/** Translate an AG Grid filter model into the server grid operators. */
function filtersFromGridModel(model: Record<string, any> | null | undefined): Filter[] {
  const filters: Filter[] = [];
  for (const [field, raw] of Object.entries(model || {})) {
    if (!raw || raw.operator === 'OR') continue;
    const conditions = raw.filterType === 'multi' && Array.isArray(raw.filterModels)
      ? raw.filterModels
      : (Array.isArray(raw.conditions) ? raw.conditions : [raw]);
    for (const condition of conditions) {
      if (!condition || condition.filterType === 'set') continue;
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
    const value = aggregateNumber(props.node.aggData?.[props.column?.getColId?.() || col.code] ?? props.value);
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
  relatedReady = true,
  onTotalChange,
  selectedId,
  onSelect,
  entityIds,
  embedded = false,
  publishAs,
  publishLabel,
}: {
  /** False while the caller is still working out `related`. The grid waits, so it loads once. */
  relatedReady?: boolean;
  /** Publish the register to the assistant under this tab key. Set it when the grid is a tab. */
  publishAs?: string;
  publishLabel?: string;
  domainCode: string;
  domainKey: string;
  asOfDate?: string;
  refreshKey?: number;
  emptyMessage: string;
  related?: RelatedAttributeColumn[];
  onTotalChange?: (total: number) => void;
  selectedId?: string | null;
  onSelect?: (entity: { id: string; name: string; code: string }) => void;
  /** When set, the grid is limited to these records. An empty list shows no rows. */
  entityIds?: readonly string[];
  /** Stacked section: no register chrome, sized to the rows. */
  embedded?: boolean;
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
    const id: Col = { code: 'entity_code', name: 'ID', kind: 'text', align: 'left', listValues: [], editable: false };
    const name: Col = { code: 'entity_name', name: 'Name', kind: 'text', align: 'left', listValues: [], editable: false };
    const relatedCols: Col[] = stableRelated.map((r) => ({
      code: `${r.alias}.${r.field}`,
      name: r.header,
      kind: 'text',
      align: 'left',
      listValues: [],
      editable: false,
    }));
    return [id, name, ...relatedCols, ...catalog];
  }, [catalog, stableRelated]);

  const lookups = useMemo(() => {
    const seen = new Set<string>();
    const primary = stableRelated.filter((r) => {
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
    const opposite = primary.map((lookup) => ({
      ...lookup,
      alias: `${lookup.alias}Alt`,
      direction: lookup.direction === 'UP' ? 'DOWN' as const : 'UP' as const,
    }));
    return [...primary, ...opposite];
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
    Promise.all([
      graphqlQuery<{ attributeRegister: CatalogAttr[] }, { domainCode: string }>(
        ATTRIBUTE_REGISTER_QUERY,
        { domainCode },
        'network-only'
      ),
      graphqlQuery<{ attributeSections: AttributeSectionOrder[] }, { domainCode: string }>(
        ATTRIBUTE_SECTIONS_QUERY,
        { domainCode },
        'network-only'
      ).catch(() => null),
    ]).then(([res, sectionRes]) => {
      if (cancelled) return;
      const sections = sectionRes?.data?.attributeSections || [];
      if (res.error) {
        setError(errorText(res.error));
        setCatalog([]);
      } else {
        const attrs = res.data?.attributeRegister || [];
        const seen = new Set<string>();
        const kept = attrs
          .filter((a) => {
            // The grid reserves "<alias>.<attribute>" for attributes reached through a
            // declared lookup, so a dotted code is not addressable as a plain column and
            // fails the whole query. Related columns come from `related` instead.
            if (!a.attributeCode || a.attributeCode.includes('.') || seen.has(a.attributeCode)) return false;
            seen.add(a.attributeCode);
            return true;
          });
        // Same order as the record editor: sections in their set order, then each
        // attribute's position within its section, then name.
        const ordered = attributesInDisplayOrder(
          kept.map((a) => ({
            attr: a,
            section: a.displaySection || 'General',
            sortOrder: a.displayGroup || 0,
            name: a.attributeName || a.attributeCode,
          })),
          sections,
        ).map((item) => item.attr);
        const cols = ordered
          .map((a) => ({
            code: a.attributeCode,
            name: a.attributeName || a.attributeCode,
            ...columnMeta(a.dataType),
            dataType: a.dataType,
            listValues: (a.listValues || []).map(String).filter(Boolean),
            editable: a.isEditable !== false,
            aggregationType: a.aggregationType,
            weightAttributeCode: a.weightAttributeCode,
            listCode: a.referenceListCode || null,
          }));
        setCatalog(cols);
      }
      setCatalogReady(true);
    });
    return () => { cancelled = true; };
  }, [domainCode, refreshKey]);

  const scopeKey = entityIds == null ? null : entityIds.filter(Boolean).join('\0');
  const scopedIds = useMemo(
    () => (scopeKey == null ? null : (scopeKey ? scopeKey.split('\0') : [])),
    [scopeKey],
  );

  // List columns store a code and show its label.
  const listLabels = useListLabels(columns.map((col) => col.listCode || '').filter(Boolean));
  const shownValue = useCallback((value: any, col: Col) => (
    col.listCode ? listLabel(listLabels[col.listCode], value) : formatCell(value, col)
  ), [listLabels]);

  // The database compares stored codes, so a filter typed on a list column is
  // sent as the codes whose label (or code) matches what was typed.
  const serverGridFilters = useMemo(() => gridFilters.map((filter) => {
    const listCode = columns.find((col) => col.code === filter.field)?.listCode;
    return listCode ? listFilterToCodes(filter, listLabels[listCode]) as Filter : filter;
  }), [gridFilters, columns, listLabels]);

  const filters = useMemo(() => {
    if (scopedIds && scopedIds.length === 0) return [];
    const global = globalSearch.trim();
    const base: Filter[] = global ? [{ field: 'entity_code', op: 'searchAny', value: global }] : [];
    const scope: Filter[] = scopedIds ? [{ field: 'entity_id', op: 'in', value: scopedIds }] : [];
    return [...scope, ...base, ...serverGridFilters];
  }, [globalSearch, serverGridFilters, scopedIds]);

  const loadPage = useCallback(async () => {
    if (!catalogReady || !relatedReady) return;
    if (scopedIds && scopedIds.length === 0) {
      setRows([]);
      setMatched(0);
      setScanNote(null);
      setError(null);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const base = {
      start: 'DOMAIN',
      domainCode,
      asOfDate: asOfDate || null,
      columns: [
        ...attributeColumns.map((c) => c.code),
        ...stableRelated.map((column) => `${column.alias}Alt.${column.field}`),
      ],
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
      const named = withParentNames(all, stableRelated);
      const filtered = named.filter((row) => rowMatchesGlobal(row, columns, globalSearch)).slice(0, CLIENT_LIMIT);
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
    const loaded = withParentNames(grid?.rows || [], stableRelated);
    const total = grid?.total || 0;
    setRows(loaded);
    setMatched(total);
    if (!scopedIds && filters.length === 0) onTotalChange?.(total);
    setScanNote(total > loaded.length
      ? `Row groups and totals use the first ${loaded.length.toLocaleString()} of ${total.toLocaleString()} matching records.`
      : null);
    setError(null);
    setLoading(false);
  }, [catalogReady, relatedReady, domainCode, asOfDate, attributeColumns, lookups, stableRelated, sort, filters, columns, globalSearch, onTotalChange, scopedIds]);

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

  usePublishTab(publishAs || 'records', publishAs ? {
    label: publishLabel || 'Records',
    purpose: `The ${domainCode} records in the register, one row per record with its attribute values as of the selected dates.`,
    howToRead: 'Values are shown as the grid shows them. matched is every record that fits the current filters; rows is the first part of them. A blank means no value was known.',
    data: catalogReady && !loading ? {
      matched,
      shown: rows.length,
      filters: activeChips.map((chip) => chip.label),
      columns: columns.map((col) => col.name),
      rows: rows.slice(0, 60).map((row) => Object.fromEntries(
        columns.map((col) => [col.name, shownValue(row[col.code], col) || null]).filter(([, value]) => value !== null),
      )),
    } : null,
  } : null);

  const shown = rows.length;
  const scopeOnly = scopedIds != null && filters.every((filter) => filter.field === 'entity_id' && filter.op === 'in');
  const embeddedAuto = embedded && !(loading && rows.length === 0) && rows.length <= 12;
  const embeddedHeight = rows.length > 12 ? 520 : 240;

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
      filter: col.kind === 'num' ? 'agNumberColumnFilter' : col.kind === 'date' ? 'agDateColumnFilter' : 'agMultiColumnFilter',
      floatingFilter: true,
      filterParams: col.kind === 'num' || col.kind === 'date'
        ? { maxNumConditions: 2, buttons: ['reset'] }
        : columnSearchFilterParams(),
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
      // The cell keeps the stored code (the editor saves codes); filters and the
      // value list read the label the cell shows.
      filterValueGetter: col.listCode
        ? (params) => shownValue(params.data?.[col.code], col) || null
        : undefined,
      valueFormatter: (params) => {
        const raw = params.node?.group || params.node?.footer
          ? aggregateNumber(params.value)
          : (params.data ? params.data[col.code] : params.value);
        return shownValue(raw, col) || '';
      },
      valueSetter: (params) => {
        if (!params.data || params.node?.group || params.node?.footer) return false;
        params.data[col.code] = params.newValue;
        return true;
      },
      editable: (params) => col.editable && Boolean(params.data?.entity_id) && !params.node?.group && !params.node?.footer && isRowAttributeCode(col.code),
      cellEditor: col.editable ? AttributeCellEditor : undefined,
      cellRenderer: col.code === 'entity_code' || col.code === 'entity_name'
        ? EntityLinkCell
        : aggFunc ? AggregateCell : undefined,
      cellRendererParams: aggFunc ? { col } : undefined,
    };
    });
    if (!embedded) {
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
    }
    return defs;
  }, [columns, embedded, shownValue]);

  return (
    <>
      {!embedded && <div className="filter-bar">
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
      </div>}
      {scanNote && <div className="attr-table-note">{scanNote}</div>}
      {error && <div className="attr-table-error">{error}</div>}

      <div className="data-table attr-table-wrap" style={{ opacity: loading && rows.length ? 0.55 : 1 }}>
        <AppGrid
          rows={catalogReady ? rows : []}
          columns={columnDefs}
          getRowId={(row) => String(row.entity_id || row.entity_code || 'row')}
          autoHeight={embedded ? embeddedAuto : false}
          height={embedded ? (embeddedAuto ? undefined : embeddedHeight) : '100%'}
          enableSortFilter
          loading={!catalogReady || (loading && rows.length === 0)}
          emptyMessage={!catalogReady || loading ? 'Loading…' : (!scopeOnly && filters.length > 0 ? 'No records match these filters.' : emptyMessage)}
          context={gridContext}
          onGridReady={(api) => { gridApi.current = api; }}
          onFilterChanged={applyGridFilters}
          onSortChanged={applyGridSort}
          singleClickEdit
          onCellValueChanged={(event) => { void commitManualOverride(event, columns, asOfDate, setError); }}
          rowGroupPanelShow={embedded ? 'never' : 'always'}
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
              entityCode: cellText(event.data.entity_code) || undefined,
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
