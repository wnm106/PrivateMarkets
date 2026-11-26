'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellContextMenuEvent, ColDef } from 'ag-grid-community';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import { AppGrid } from '@/components/grid/AppGrid';
import { attributeDisplayKind, formatAttributeDisplay, tableCellAlign } from '@/lib/attribute-display';
import {
  ATTRIBUTE_REGISTER_QUERY,
  DATA_SOURCES_QUERY,
  DOMAIN_TYPES_QUERY,
  RELATIONSHIP_TYPES_QUERY,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { columnSearchFilterParams } from '@/lib/grid-filters';
import { domainLabel } from '@/lib/parent-entities';
import { GRID_QUERY, type GridResultPayload } from '@/lib/reporting';
import { aggregateNumber, attributeAggregation, gridAggFunc, numericValue } from '@/lib/grid-aggregation';
import { listLabel, useListLabels } from '@/lib/list-labels';
import { usePublishTab } from '@/lib/view-context';
import type { ComplianceCondition } from '@/components/forms/ComplianceRuleForm';
import {
  CERTIFY_POPULATION_FILTER_MUTATION,
  DELETE_POPULATION_FILTER_MUTATION,
  WITHDRAW_POPULATION_CERTIFICATION_MUTATION,
  POPULATION_FILTERS_QUERY,
  SAVE_POPULATION_FILTER_MUTATION,
  conditionsToInput,
  filterSummary,
  type PopulationConditionInput,
  type PopulationFilter,
} from '@/lib/population-filters';
import { ViewFilterPanel } from './ViewFilterPanel';
import {
  DELETE_ENTITY_VIEW_MUTATION,
  ENTITY_VIEWS_QUERY,
  GOLDEN,
  SAVE_ENTITY_VIEW_MUTATION,
  columnAlias,
  columnCode,
  ensureLookup,
  findLookup,
  pruneLookups,
  relatedEntities,
  viewGridField,
  viewGridRequest,
  viewRows,
  VIEW_ROW_RECORDS,
  type EntityView,
  type EntityViewColumn,
  type EntityViewDraft,
  type RelatedEntity,
  type ViewCellRecord,
  type ViewRelationshipType,
} from '@/lib/entity-views';

interface Attr {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  /** Set when the attribute stores a code from a reference list. */
  referenceListCode?: string | null;
  /** How the attribute totals when the grid is grouped. */
  aggregationType?: string | null;
  weightAttributeCode?: string | null;
}

interface Source {
  sourceCode: string;
  sourceName: string;
}

/** The record's own name and code: shown, but they have no sources to open. */
function builtinCode(code: string): boolean {
  return code === 'entity_name' || code === 'entity_code';
}

const BUILTIN_FIELDS: Attr[] = [
  { attributeCode: 'entity_name', attributeName: 'Name', dataType: 'TEXT' },
  { attributeCode: 'entity_code', attributeName: 'ID', dataType: 'TEXT' },
];

function errorText(error: any): string {
  if (!error) return '';
  const gql = Array.isArray(error.graphQLErrors)
    ? error.graphQLErrors.map((e: any) => e?.message).filter(Boolean).join(' ')
    : '';
  return gql || error.message || 'Request failed';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatValue(value: unknown, dataType?: string): string {
  const text = cellText(value);
  if (!text) return '';
  const kind = attributeDisplayKind({ dataType: dataType || 'TEXT' });
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
  if (kind === 'text' || kind === 'boolean') return text;
  return formatAttributeDisplay(text, { dataType }) || text;
}

function emptyDraft(domainCode: string): EntityViewDraft {
  return {
    id: null,
    domainCode,
    viewName: '',
    description: '',
    columns: [{ field: 'entity_name' }],
    lookups: [],
    sort: [],
    filterId: null,
  };
}

export function EntityViews({
  domainCode,
  domainKey,
  asOfDate,
  knowledgeDate,
}: {
  domainCode: string;
  domainKey: string;
  asOfDate?: string;
  knowledgeDate?: string;
}) {
  const [views, setViews] = useState<EntityView[]>([]);
  const [viewsReady, setViewsReady] = useState(false);
  const [viewsError, setViewsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntityViewDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- population filters: saved ones, the one in use, and a temporary change to it ----
  const [filters, setFilters] = useState<PopulationFilter[]>([]);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  /** Conditions edited for this visit only. Null means the saved filter, as saved. */
  const [working, setWorking] = useState<ComplianceCondition[] | null>(null);

  const [sources, setSources] = useState<Source[]>([]);
  const [relTypes, setRelTypes] = useState<ViewRelationshipType[]>([]);
  const [domainNames, setDomainNames] = useState<Record<string, string>>({});
  const [attrsByDomain, setAttrsByDomain] = useState<Record<string, Attr[]>>({});

  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [matched, setMatched] = useState(0);
  const [loading, setLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  // Bumped after a value is changed from the sources panel, so the table reads again.
  const [refreshKey, setRefreshKey] = useState(0);
  const inspect = useAttributeInspect();

  /** The entity whose attributes the builder lists: a chain of related entity types from this one. Empty is this entity type. */
  const [focus, setFocus] = useState<string[]>([]);
  const [attrSearch, setAttrSearch] = useState('');

  // ---- catalogs: views, sources, relationships, entity type names ----
  const loadViews = useCallback(async (keep?: string | null) => {
    const res = await graphqlQuery<{ entityViews: EntityView[] }, { domainCode: string }>(
      ENTITY_VIEWS_QUERY, { domainCode }, 'network-only',
    );
    if (res.error) {
      setViewsError(/entityViews|entity_views/i.test(errorText(res.error))
        ? 'Views are not set up on this database yet. Apply migration 20261122160000_entity_views.sql.'
        : errorText(res.error));
      setViews([]);
    } else {
      const list = res.data?.entityViews || [];
      setViews(list);
      setViewsError(null);
      setSelectedId((current) => {
        const wanted = keep !== undefined ? keep : current;
        return wanted && list.some((view) => view.id === wanted) ? wanted : list[0]?.id ?? null;
      });
    }
    setViewsReady(true);
  }, [domainCode]);

  useEffect(() => {
    setViewsReady(false);
    setDraft(null);
    setSelectedId(null);
    void loadViews(null);
  }, [loadViews]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      graphqlQuery<{ dataSources: Source[] }, { isActive: boolean }>(DATA_SOURCES_QUERY, { isActive: true }, 'cache-first'),
      graphqlQuery<{ relationshipTypes: ViewRelationshipType[] }, Record<string, never>>(RELATIONSHIP_TYPES_QUERY, {}, 'cache-first'),
      graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string }> }, Record<string, never>>(DOMAIN_TYPES_QUERY, {}, 'cache-first'),
    ]).then(([src, rel, dom]) => {
      if (cancelled) return;
      setSources([...(src.data?.dataSources || [])].sort((a, b) => a.sourceName.localeCompare(b.sourceName)));
      setRelTypes(rel.data?.relationshipTypes || []);
      const names: Record<string, string> = {};
      for (const domain of dom.data?.domainTypes || []) names[domain.domainCode] = domain.domainName;
      setDomainNames(names);
    });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(() => views.find((view) => view.id === selectedId) || null, [views, selectedId]);

  const loadFilters = useCallback(async () => {
    const res = await graphqlQuery<{ populationFilters: PopulationFilter[] }, { domainCode: string }>(
      POPULATION_FILTERS_QUERY, { domainCode }, 'network-only',
    );
    if (res.error) {
      setFilterError(/populationFilters|population_filters/i.test(errorText(res.error))
        ? 'Filters are not set up on this database yet. Apply migration 20261125090000_population_filters.sql.'
        : errorText(res.error));
      setFilters([]);
    } else {
      setFilters(res.data?.populationFilters || []);
      setFilterError(null);
    }
  }, [domainCode]);
  useEffect(() => { void loadFilters(); }, [loadFilters]);

  // Opening a view starts from the filter it was saved with, and drops any temporary change.
  useEffect(() => {
    setActiveFilterId(selected?.filterId ?? null);
    setWorking(null);
    // Only a different view resets the filter, not a re-read of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const savedFilter = useMemo(() => filters.find((filter) => filter.id === activeFilterId) || null, [filters, activeFilterId]);
  /** What narrows the records now: the temporary conditions if there are any, else the saved filter. */
  const populationConditions = useMemo<PopulationConditionInput[]>(
    () => (working ? conditionsToInput(working) : savedFilter?.conditions ?? []),
    [working, savedFilter],
  );

  const saveFilter = async ({ id, name, populationCode, description, conditions }: { id: string | null; name: string; populationCode?: string | null; description?: string | null; conditions: PopulationConditionInput[] }) => {
    setFilterError(null);
    const res = await graphqlMutation<
      { savePopulationFilter: { filter: PopulationFilter | null; errors: Array<{ message: string }> } },
      { id: string | null; input: any }
    >(SAVE_POPULATION_FILTER_MUTATION, { id, input: { domainCode, filterName: name, populationCode: populationCode || null, description: description || null, conditions } });
    const message = errorText(res.error) || res.data?.savePopulationFilter.errors.map((e) => e.message).join(' ');
    const savedRow = res.data?.savePopulationFilter.filter;
    if (message || !savedRow) {
      setFilterError(message || 'Could not save the filter.');
      return null;
    }
    setFilters((current) => [...current.filter((item) => item.id !== savedRow.id), savedRow].sort((a, b) => a.filterName.localeCompare(b.filterName)));
    setActiveFilterId(savedRow.id);
    setWorking(null);
    return savedRow.id;
  };

  const replaceFilter = (row: PopulationFilter) => setFilters((current) => current.map((item) => (item.id === row.id ? row : item)));

  /** Set the code and description the assistant reads, then certify. The database allows only administrators. */
  const certifyFilter = async ({ filter, populationCode, description, note }: { filter: PopulationFilter; populationCode: string; description: string; note: string }) => {
    setFilterError(null);
    const saved = await saveFilter({ id: filter.id, name: filter.filterName, populationCode, description, conditions: filter.conditions });
    if (!saved) return false;
    const res = await graphqlMutation<
      { certifyPopulationFilter: { filter: PopulationFilter | null; errors: Array<{ message: string }> } },
      { id: string; note: string | null }
    >(CERTIFY_POPULATION_FILTER_MUTATION, { id: filter.id, note: note || null });
    const message = errorText(res.error) || res.data?.certifyPopulationFilter.errors.map((e) => e.message).join(' ');
    const row = res.data?.certifyPopulationFilter.filter;
    if (message || !row) { setFilterError(message || 'Could not certify the filter.'); return false; }
    replaceFilter(row);
    return true;
  };

  const withdrawFilter = async (id: string) => {
    setFilterError(null);
    const res = await graphqlMutation<
      { withdrawPopulationCertification: { filter: PopulationFilter | null; errors: Array<{ message: string }> } },
      { id: string }
    >(WITHDRAW_POPULATION_CERTIFICATION_MUTATION, { id });
    const message = errorText(res.error) || res.data?.withdrawPopulationCertification.errors.map((e) => e.message).join(' ');
    const row = res.data?.withdrawPopulationCertification.filter;
    if (message || !row) { setFilterError(message || 'Could not withdraw the certification.'); return; }
    replaceFilter(row);
  };

  const deleteFilter = async (id: string) => {
    const res = await graphqlMutation<{ deletePopulationFilter: { success: boolean; errors: Array<{ message: string }> } }, { id: string }>(
      DELETE_POPULATION_FILTER_MUTATION, { id },
    );
    const message = errorText(res.error) || res.data?.deletePopulationFilter.errors.map((e) => e.message).join(' ');
    if (message) { setFilterError(message); return; }
    setFilters((current) => current.filter((item) => item.id !== id));
    setViews((current) => current.map((view) => (view.filterId === id ? { ...view, filterId: null } : view)));
    setActiveFilterId(null);
    setWorking(null);
  };
  const shown: EntityViewDraft | null = draft || selected;

  // Attribute lists for this entity type and every related type the shown view reaches.
  const neededDomains = useMemo(() => {
    const set = new Set([domainCode]);
    for (const lookup of shown?.lookups || []) if (lookup.domainCode) set.add(lookup.domainCode);
    for (const code of focus) set.add(code);
    return [...set].sort().join('|');
  }, [domainCode, shown, focus]);

  // Each entity type's attributes are fetched once. Editing the view must not
  // restart a fetch that is still running, or a slow list never arrives.
  const requestedDomains = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A remount (React does one in development) asks again for anything that did not arrive.
      requestedDomains.current.clear();
    };
  }, []);

  useEffect(() => {
    for (const code of neededDomains.split('|')) {
      if (!code || requestedDomains.current.has(code)) continue;
      requestedDomains.current.add(code);
      void graphqlQuery<{ attributeRegister: Attr[] }, { domainCode: string }>(
        ATTRIBUTE_REGISTER_QUERY, { domainCode: code }, 'cache-first',
      ).then((res) => {
        if (!mounted.current) return;
        if (res.error) requestedDomains.current.delete(code);
        const seen = new Set<string>();
        const attrs = (res.data?.attributeRegister || [])
          .filter((attr) => attr.attributeCode && !attr.attributeCode.includes('.') && !seen.has(attr.attributeCode) && seen.add(attr.attributeCode))
          .sort((a, b) => (a.attributeName || a.attributeCode).localeCompare(b.attributeName || b.attributeCode));
        setAttrsByDomain((current) => ({ ...current, [code]: attrs }));
      });
    }
  }, [neededDomains]);

  const sourceName = useCallback((code?: string) => (
    !code || code === GOLDEN ? 'Golden' : sources.find((source) => source.sourceCode === code)?.sourceName || code
  ), [sources]);

  const lookupOf = useCallback((view: EntityViewDraft, alias: string | null) => (
    alias ? view.lookups.find((lookup) => lookup.alias === alias) || null : null
  ), []);

  const attrOf = useCallback((view: EntityViewDraft, field: string): Attr | undefined => {
    const lookup = lookupOf(view, columnAlias(field));
    const code = columnCode(field);
    const builtin = BUILTIN_FIELDS.find((attr) => attr.attributeCode === code);
    if (builtin) return builtin;
    return (attrsByDomain[lookup?.domainCode || domainCode] || []).find((attr) => attr.attributeCode === code);
  }, [attrsByDomain, domainCode, lookupOf]);

  /** A column heading: the attribute's name, plus the source when it is not Golden. */
  const headerOf = useCallback((view: EntityViewDraft, column: EntityViewColumn) => {
    if (column.label) return column.label;
    const name = attrOf(view, column.field)?.attributeName || columnCode(column.field);
    return column.source && column.source !== GOLDEN ? `${name} (${sourceName(column.source)})` : name;
  }, [attrOf, sourceName]);

  /** The column's attribute with the related record it comes from, for the builder and tooltips. */
  const pathOf = useCallback((view: EntityViewDraft, column: EntityViewColumn) => {
    const lookup = lookupOf(view, columnAlias(column.field));
    const name = attrOf(view, column.field)?.attributeName || columnCode(column.field);
    return lookup ? `${lookup.label || domainLabel(lookup.domainCode || lookup.alias)} · ${name}` : name;
  }, [attrOf, lookupOf]);

  // ---- rows ----
  // The table shows the saved view. While a view is edited the editor takes its place.
  const gridView: EntityViewDraft | null = draft ? null : selected;

  const requestKey = gridView && gridView.columns.length
    ? JSON.stringify(viewGridRequest(gridView, { asOfDate, knowledgeDate }, 10000, populationConditions))
    : '';

  useEffect(() => {
    if (!requestKey || !gridView) {
      setRows([]);
      setMatched(0);
      setGridError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const view = gridView;
    graphqlQuery<{ gridQuery: GridResultPayload }, { input: any }>(GRID_QUERY, { input: JSON.parse(requestKey) }, 'network-only')
      .then((res) => {
        if (cancelled) return;
        if (res.error) {
          setGridError(errorText(res.error));
          setRows([]);
          setMatched(0);
        } else {
          setGridError(null);
          setRows(viewRows(res.data?.gridQuery.rows || [], view));
          setMatched(res.data?.gridQuery.total || 0);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
    // gridView is captured through requestKey; its columns and lookups are all in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, refreshKey]);

  // List attributes store a code; the grid shows the list's label for it.
  const listCodes = useMemo(() => (gridView?.columns || [])
    .map((column) => attrOf(gridView!, column.field)?.referenceListCode || '')
    .filter(Boolean), [gridView, attrOf]);
  const listLabels = useListLabels(listCodes);

  /** What a cell shows: the list label for a list attribute, else the formatted value. */
  const displayValue = useCallback((view: EntityViewDraft, column: EntityViewColumn, value: unknown) => {
    const attr = attrOf(view, column.field);
    if (attr?.referenceListCode) return listLabel(listLabels[attr.referenceListCode], value);
    return formatValue(value, attr?.dataType);
  }, [attrOf, listLabels]);

  const columnDefs = useMemo<ColDef<Record<string, unknown>>[]>(() => {
    if (!gridView) return [];
    return gridView.columns.map((column) => {
      const field = viewGridField(column);
      const attr = attrOf(gridView, column.field);
      const listed = Boolean(attr?.referenceListCode);
      const kind = listed ? 'text' : attributeDisplayKind({ dataType: attr?.dataType || 'TEXT' });
      const numeric = kind !== 'text' && kind !== 'date' && kind !== 'boolean';
      const own = !columnAlias(column.field);
      const code = columnCode(column.field);
      // Grouped rows total the column the way its attribute says.
      const weightColumn = attr?.weightAttributeCode
        ? gridView.columns.find((other) => columnAlias(other.field) === columnAlias(column.field)
          && columnCode(other.field) === attr.weightAttributeCode
          && (other.source || GOLDEN) === (column.source || GOLDEN))
        : undefined;
      const weightField = weightColumn ? viewGridField(weightColumn) : null;
      const aggFunc = numeric
        ? gridAggFunc(
          attributeAggregation(attr?.aggregationType, attr?.dataType),
          (data) => numericValue(data?.[field]),
          weightField ? (data) => numericValue(data?.[weightField]) : null,
        )
        : undefined;
      return {
        colId: field,
        headerName: headerOf(gridView, column),
        headerTooltip: `${pathOf(gridView, column)} · ${sourceName(column.source)}`,
        filter: numeric ? 'agNumberColumnFilter' : kind === 'date' ? 'agDateColumnFilter' : 'agMultiColumnFilter',
        filterParams: numeric || kind === 'date' ? { maxNumConditions: 2, buttons: ['reset'] } : columnSearchFilterParams(),
        enableRowGroup: true,
        enableValue: numeric,
        aggFunc,
        allowedAggFuncs: numeric ? ['sum', 'avg', 'min', 'max', 'count'] : undefined,
        minWidth: 140,
        flex: 1,
        // null, not undefined: the grid keeps an earlier pin when the value is left out.
        pinned: column.pinned ? 'left' : null,
        cellStyle: { textAlign: listed ? 'left' : tableCellAlign(attr?.dataType || 'TEXT') },
        cellClass: builtinCode(code) ? undefined : 'attr-inspectable',
        valueGetter: (params) => {
          if (params.node?.group || params.node?.footer) return params.node.aggData?.[field] ?? null;
          const value = params.data?.[field];
          if (value == null || value === '') return null;
          if (numeric) return numericValue(value);
          // Filters and sorting work on what the cell shows, so a list column filters by label.
          return listed ? displayValue(gridView, column, value) : cellText(value);
        },
        valueFormatter: (params) => displayValue(gridView, column, params.data ? params.data[field] : aggregateNumber(params.value)),
        cellRenderer: own && (code === 'entity_name' || code === 'entity_code')
          ? (params: any) => params.data?.entity_id
            ? <Link href={`/${domainKey}/${params.data.entity_id}`} className="entity-link">{params.valueFormatted || params.value}</Link>
            : <span>{params.valueFormatted || params.value}</span>
          : undefined,
      } satisfies ColDef<Record<string, unknown>>;
    });
  }, [gridView, attrOf, headerOf, pathOf, sourceName, domainKey, displayValue]);

  /** Right-click an attribute cell: open the sources of the record its value came from. */
  const openCellSources = (event: CellContextMenuEvent<Record<string, unknown>>) => {
    const field = event.column?.getColId?.() || '';
    const row = event.data;
    if (!gridView || !row || event.node?.group || event.node?.footer) return;
    const column = gridView.columns.find((item) => viewGridField(item) === field);
    if (!column || builtinCode(columnCode(column.field))) return;
    const alias = columnAlias(column.field);
    const records = row[VIEW_ROW_RECORDS] as Record<string, ViewCellRecord> | undefined;
    const record = alias
      ? records?.[field]
      : { id: cellText(row.entity_id), name: cellText(row.entity_name) || cellText(row.entity_code) };
    if (!record?.id) return;
    (event.event as MouseEvent | undefined)?.preventDefault();
    const attr = attrOf(gridView, column.field);
    inspect.open({
      entityId: record.id,
      entityName: record.name,
      // Own columns know the code; a related record's is read from its id.
      entityCode: alias ? undefined : cellText(row.entity_code) || undefined,
      attributeCode: columnCode(column.field),
      attributeName: attr?.attributeName || columnCode(column.field),
      dataType: attr?.dataType,
      value: displayValue(gridView, column, row[field]),
      domainCode: lookupOf(gridView, alias)?.domainCode || domainCode,
      onChanged: () => setRefreshKey((key) => key + 1),
    });
  };

  // ---- assistant ----
  usePublishTab('views', {
    label: 'Views',
    purpose: `Saved data tables for ${domainNames[domainCode] || domainLabel(domainCode)} records: each view picks attributes of the record and of related records, and can read a named source instead of the golden value.`,
    howToRead: 'Each column header names the attribute; a source in brackets means the column shows the value that source supplied, otherwise it is the golden value. A related record column shows one related record per row. matched is every record of this type that passes the population filter (none means every record); the filter named is saved, and changedForThisVisit means it was edited on the spot and not saved; rows is the first part of them, with blanks left out.',
    data: viewsReady && (!gridView || !loading) ? {
      views: views.map((view) => view.viewName),
      open: shown ? (shown.viewName || 'Unsaved view') : null,
      editing: Boolean(draft),
      columns: shown ? shown.columns.map((column) => ({ header: headerOf(shown, column), attribute: pathOf(shown, column), source: sourceName(column.source), lockedLeft: Boolean(column.pinned) })) : [],
      filter: {
        saved: savedFilter?.filterName ?? null,
        certified: Boolean(savedFilter?.certifiedAt),
        populationCode: savedFilter?.populationCode ?? null,
        changedForThisVisit: Boolean(working),
        asks: filterSummary(populationConditions),
        conditions: populationConditions.length,
      },
      matched,
      shown: rows.length,
      error: gridError || viewsError || null,
      rows: gridView ? rows.slice(0, 60).map((row) => Object.fromEntries(
        gridView.columns
          .map((column) => [headerOf(gridView, column), displayValue(gridView, column, row[viewGridField(column)]) || null])
          .filter(([, value]) => value !== null),
      )) : [],
    } : null,
  });

  // ---- editing ----
  const update = (patch: Partial<EntityViewDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const entityName = useCallback((code: string) => domainNames[code] || domainLabel(code), [domainNames]);

  /** Related entity types one step on from a chain, leaving out the one it came from. */
  const childrenOf = useCallback((path: string[]): RelatedEntity[] => {
    const here = path.length ? path[path.length - 1] : domainCode;
    const back = path.length > 1 ? path[path.length - 2] : (path.length === 1 ? domainCode : null);
    return relatedEntities(here, relTypes, domainNames)
      .filter((entity) => entity.domainCode !== back)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [domainCode, relTypes, domainNames]);

  /** The lookup alias that reaches the end of a chain, or null if the view does not reach it yet. */
  const aliasFor = useCallback((view: EntityViewDraft, path: string[]): string | null => {
    let from: string | null = null;
    for (const code of path) {
      const lookup = findLookup(view, from, code);
      if (!lookup) return null;
      from = lookup.alias;
    }
    return from;
  }, []);

  const columnsAt = useCallback((view: EntityViewDraft, path: string[]) => {
    const alias = aliasFor(view, path);
    if (path.length && !alias) return [] as EntityViewColumn[];
    return view.columns.filter((column) => (columnAlias(column.field) || null) === (alias || null));
  }, [aliasFor]);

  const focusDomain = focus.length ? focus[focus.length - 1] : domainCode;
  const focusAttrs = useMemo(() => {
    const needle = attrSearch.trim().toLowerCase();
    return [...BUILTIN_FIELDS, ...(attrsByDomain[focusDomain] || [])]
      .filter((attr) => !needle
        || (attr.attributeName || '').toLowerCase().includes(needle)
        || attr.attributeCode.toLowerCase().includes(needle))
      .sort((a, b) => (a.attributeName || a.attributeCode).localeCompare(b.attributeName || b.attributeCode));
  }, [attrSearch, attrsByDomain, focusDomain]);

  const chosenAtFocus = useMemo(() => new Set(
    draft ? columnsAt(draft, focus).map((column) => columnCode(column.field)) : [],
  ), [draft, focus, columnsAt]);

  const openEntity = (path: string[]) => {
    setFocus(path);
    setAttrSearch('');
  };

  /** Tick an attribute of the focused entity on or off. Off removes it from every source. */
  const toggleAttribute = (code: string) => {
    if (!draft) return;
    if (chosenAtFocus.has(code)) {
      const alias = aliasFor(draft, focus);
      const field = alias ? `${alias}.${code}` : code;
      const columns = draft.columns.filter((column) => column.field !== field);
      const keys = new Set(columns.map(viewGridField));
      setDraft(pruneLookups({ ...draft, columns, sort: draft.sort.filter((item) => keys.has(item.field)) }));
      return;
    }
    let next = draft;
    let from: string | null = null;
    const walked: string[] = [];
    for (const target of focus) {
      const entity = childrenOf(walked).find((item) => item.domainCode === target)
        || { domainCode: target, label: entityName(target), direction: 'UP' as const };
      const step: { view: EntityViewDraft; alias: string } = ensureLookup(next, from, entity);
      next = step.view;
      from = step.alias;
      walked.push(target);
    }
    const field = from ? `${from}.${code}` : code;
    setSaveError(null);
    setDraft({ ...next, columns: [...next.columns, { field }] });
  };

  /** The same attribute again, from the next source the view does not show yet. */
  const addSource = (index: number) => {
    if (!draft) return;
    const column = draft.columns[index];
    const used = new Set(draft.columns.filter((item) => item.field === column.field).map((item) => item.source || GOLDEN));
    const next = [GOLDEN, ...sources.map((source) => source.sourceCode)].find((code) => !used.has(code));
    if (!next) return;
    const columns = [...draft.columns];
    columns.splice(index + 1, 0, { field: column.field, ...(next !== GOLDEN ? { source: next } : {}) });
    update({ columns });
  };

  const setColumn = (index: number, patch: Partial<EntityViewColumn>) => {
    if (!draft) return;
    const columns = draft.columns.map((column, i) => {
      if (i !== index) return column;
      const next = { ...column, ...patch };
      if (next.source === GOLDEN || next.source === '') delete next.source;
      if (next.label === '') delete next.label;
      if (!next.pinned) delete next.pinned;
      return next;
    });
    update({ columns });
  };

  /** Move a column so it sits before position `before` (0 to the number of columns). */
  const moveColumnTo = (from: number, before: number) => {
    if (!draft) return;
    const target = before > from ? before - 1 : before;
    if (target === from || target < 0 || target >= draft.columns.length) return;
    const columns = [...draft.columns];
    const [moved] = columns.splice(from, 1);
    columns.splice(target, 0, moved);
    update({ columns });
  };

  // Dragging a column: where it came from, and the gap it would drop into.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropBefore, setDropBefore] = useState<number | null>(null);
  const endDrag = () => { setDragFrom(null); setDropBefore(null); };

  const removeColumn = (index: number) => {
    if (!draft) return;
    const removed = viewGridField(draft.columns[index]);
    setDraft(pruneLookups({
      ...draft,
      columns: draft.columns.filter((_, i) => i !== index),
      sort: draft.sort.filter((item) => item.field !== removed),
    }));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    const keys = new Set(draft.columns.map(viewGridField));
    const res = await graphqlMutation<
      { saveEntityView: { view: EntityView | null; errors: Array<{ field: string; message: string }> } },
      { id: string | null; input: any }
    >(SAVE_ENTITY_VIEW_MUTATION, {
      id: draft.id || null,
      input: {
        domainCode,
        viewName: draft.viewName,
        description: draft.description || null,
        columns: draft.columns,
        lookups: pruneLookups(draft).lookups,
        sort: draft.sort.filter((item) => keys.has(item.field)),
        filterId: draft.filterId || null,
        ...(draft.displayOrder != null ? { displayOrder: draft.displayOrder } : {}),
      },
    });
    setSaving(false);
    const message = errorText(res.error) || res.data?.saveEntityView.errors.map((e) => e.message).join(' ');
    const savedView = res.data?.saveEntityView.view;
    if (message || !savedView) {
      setSaveError(message || 'Could not save the view.');
      return;
    }
    // Keep the saved row as the mutation returned it. A list read right after a
    // write can come back from the client cache without the new view.
    setViews((current) => [...current.filter((view) => view.id !== savedView.id), savedView]
      .sort((a, b) => (a.displayOrder - b.displayOrder) || a.viewName.localeCompare(b.viewName)));
    setSelectedId(savedView.id);
    setActiveFilterId(savedView.filterId ?? null);
    setWorking(null);
    setViewsError(null);
    setDraft(null);
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete the view "${selected.viewName}"? This cannot be undone.`)) return;
    const res = await graphqlMutation<{ deleteEntityView: { success: boolean; errors: Array<{ message: string }> } }, { id: string }>(
      DELETE_ENTITY_VIEW_MUTATION, { id: selected.id },
    );
    const message = errorText(res.error) || res.data?.deleteEntityView.errors.map((e) => e.message).join(' ');
    if (message) {
      setViewsError(message);
      return;
    }
    const rest = views.filter((view) => view.id !== selected.id);
    setViews(rest);
    setSelectedId(rest[0]?.id ?? null);
  };

  const sortField = shown?.sort?.[0]?.field || '';
  const sortDir = shown?.sort?.[0]?.dir || 'asc';

  return (
    <div className="entity-views">
      <div className="entity-views-bar">
        <label className="entity-views-picker">
          <span>View</span>
          <select
            className="xp-input"
            value={draft ? '' : selectedId || ''}
            disabled={Boolean(draft) || views.length === 0}
            onChange={(event) => setSelectedId(event.target.value || null)}
            aria-label="Choose a view"
          >
            {draft && <option value="">{draft.id ? `Editing ${draft.viewName}` : 'New view'}</option>}
            {!draft && views.length === 0 && <option value="">No views yet</option>}
            {views.map((view) => <option key={view.id} value={view.id}>{view.viewName}</option>)}
          </select>
        </label>
        {!draft && (
          <>
            <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(viewsError) && !views.length && /migration/.test(viewsError || '')} onClick={() => { setDraft(emptyDraft(domainCode)); openEntity([]); setSaveError(null); }}>
              New view
            </button>
            {selected && (
              <>
                <button type="button" className="btn btn-sm" onClick={() => { setDraft({ ...selected }); openEntity([]); setSaveError(null); }}>Edit</button>
                <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...selected, id: null, viewName: `${selected.viewName} copy` })}>Copy</button>
                <button type="button" className="btn btn-sm" onClick={() => { void remove(); }}>Delete</button>
              </>
            )}
          </>
        )}
        <div className="entity-views-count">
          {gridView ? <>Showing <strong>{loading ? '…' : rows.length.toLocaleString()}</strong> of {loading ? '…' : matched.toLocaleString()}</> : null}
        </div>
      </div>

      {viewsError && <div className="attr-table-error">{viewsError}</div>}

      {!draft && selected && (
        <ViewFilterPanel
          domainCode={domainCode}
          filters={filters}
          savedId={activeFilterId}
          onPickSaved={setActiveFilterId}
          working={working}
          onWorking={setWorking}
          onSave={saveFilter}
          onDeleteSaved={(id) => { void deleteFilter(id); }}
          onCertify={certifyFilter}
          onWithdraw={(id) => { void withdrawFilter(id); }}
          error={filterError}
        />
      )}

      {draft && (
        <div className="entity-views-editor">
          <div className="entity-views-row">
            <label className="entity-views-field grow">
              <span>Name</span>
              <input className="xp-input" value={draft.viewName} placeholder="e.g. Prices by source" onChange={(event) => update({ viewName: event.target.value })} />
            </label>
            <label className="entity-views-field">
              <span>Opens with filter</span>
              <select
                className="xp-input"
                value={draft.filterId || ''}
                onChange={(event) => update({ filterId: event.target.value || null })}
              >
                <option value="">No filter</option>
                {filters.map((filter) => <option key={filter.id} value={filter.id}>{filter.filterName}</option>)}
              </select>
            </label>
            <label className="entity-views-field">
              <span>Sort by</span>
              <select
                className="xp-input"
                value={sortField}
                onChange={(event) => update({ sort: event.target.value ? [{ field: event.target.value, dir: sortDir }] : [] })}
              >
                <option value="">Name</option>
                {draft.columns.map((column) => (
                  <option key={viewGridField(column)} value={viewGridField(column)}>{headerOf(draft, column)}</option>
                ))}
              </select>
            </label>
            <label className="entity-views-field">
              <span>Order</span>
              <select
                className="xp-input"
                value={sortDir}
                disabled={!sortField}
                onChange={(event) => update({ sort: sortField ? [{ field: sortField, dir: event.target.value === 'desc' ? 'desc' : 'asc' }] : [] })}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
            <div className="entity-views-editor-actions">
              <button type="button" className="btn btn-sm" onClick={() => { setDraft(null); setSaveError(null); endDrag(); }}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={saving || !draft.viewName.trim() || draft.columns.length === 0} onClick={() => { void save(); }}>
                {saving ? 'Saving…' : 'Save view'}
              </button>
            </div>
          </div>
          {saveError && <div className="attr-table-error">{saveError}</div>}

          <div className="entity-views-panes">
            <div className="entity-views-entities" role="tree" aria-label="Entities">
              <h4>Entities</h4>
              <EntityNode
                path={[]}
                label={entityName(domainCode)}
                focus={focus}
                count={columnsAt(draft, []).length}
                onOpen={openEntity}
              />
              <ul className="entity-views-tree">
                {childrenOf([]).map((entity) => (
                  <RelatedNode
                    key={entity.domainCode}
                    path={[entity.domainCode]}
                    label={entity.label}
                    focus={focus}
                    countAt={(path) => columnsAt(draft, path).length}
                    childrenOf={childrenOf}
                    onOpen={openEntity}
                  />
                ))}
              </ul>
              {childrenOf([]).length === 0 && <p className="entity-views-hint">No related entity types are defined for {entityName(domainCode)}.</p>}
            </div>
            <div className="entity-views-attributes">
              <h4>{focus.length ? [entityName(domainCode), ...focus.map(entityName)].join(' > ') : entityName(domainCode)} attributes</h4>
              <input className="xp-input" value={attrSearch} placeholder="Find an attribute" aria-label="Find an attribute" onChange={(event) => setAttrSearch(event.target.value)} />
              {focus.length > 0 && <p className="entity-views-hint">Each row shows one related {entityName(focusDomain).toLowerCase()} record.</p>}
              <ul className="entity-views-attr-list">
                {!attrsByDomain[focusDomain] && <li className="entity-views-hint">Loading attributes...</li>}
                {attrsByDomain[focusDomain] && focusAttrs.length === 0 && <li className="entity-views-hint">No attribute matches.</li>}
                {focusAttrs.map((attr) => (
                  <li key={attr.attributeCode}>
                    <label>
                      <input type="checkbox" checked={chosenAtFocus.has(attr.attributeCode)} onChange={() => toggleAttribute(attr.attributeCode)} />
                      <span>{attr.attributeName || attr.attributeCode}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            <div className="entity-views-columns-pane">
              <h4>Columns <span className="entity-views-node-count">{draft.columns.length}</span></h4>
              <p className="entity-views-hint">Drag to change the order.</p>
              {draft.columns.length > 0 && (
                <div className="entity-views-col entity-views-col-labels" aria-hidden="true">
                  <span />
                  <span>Attribute</span>
                  <span>Alias</span>
                  <span>Source</span>
                  <span title="Keep the column at the left edge while the table scrolls">Lock left</span>
                  <span />
                  <span />
                </div>
              )}
              <ol
                className="entity-views-col-list"
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropBefore(null);
                }}
              >
                {draft.columns.map((column, index) => {
                  const builtin = BUILTIN_FIELDS.some((attr) => attr.attributeCode === columnCode(column.field));
                  const heading = headerOf(draft, column);
                  const classes = ['entity-views-col'];
                  if (dragFrom === index) classes.push('dragging');
                  if (dragFrom !== null && dropBefore === index) classes.push('drop-before');
                  if (dragFrom !== null && dropBefore === draft.columns.length && index === draft.columns.length - 1) classes.push('drop-after');
                  return (
                    <li
                      key={`${viewGridField(column)}-${index}`}
                      className={classes.join(' ')}
                      onDragOver={(event) => {
                        if (dragFrom === null) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        const box = event.currentTarget.getBoundingClientRect();
                        setDropBefore(event.clientY < box.top + box.height / 2 ? index : index + 1);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragFrom !== null && dropBefore !== null) moveColumnTo(dragFrom, dropBefore);
                        endDrag();
                      }}
                    >
                      <button
                        type="button"
                        className="entity-views-grip"
                        draggable
                        title="Drag to move. Arrow keys move it too."
                        aria-label={`Move ${heading}. Use the up and down arrow keys.`}
                        onDragStart={(event) => {
                          const row = event.currentTarget.closest('li');
                          if (row) event.dataTransfer.setDragImage(row, 12, 12);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', String(index));
                          setDragFrom(index);
                        }}
                        onDragEnd={endDrag}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); moveColumnTo(index, index - 1); }
                          if (event.key === 'ArrowDown' && index < draft.columns.length - 1) { event.preventDefault(); moveColumnTo(index, index + 2); }
                        }}
                      >
                        <span aria-hidden="true">⠿</span>
                      </button>
                      <span className="entity-views-col-name" title={pathOf(draft, column)}>{pathOf(draft, column)}</span>
                      <input className="xp-input" value={column.label || ''} placeholder={headerOf(draft, { ...column, label: undefined })} onChange={(event) => setColumn(index, { label: event.target.value })} aria-label={`Alias for ${pathOf(draft, column)}`} title="The column heading. Leave blank to use the attribute's name." />
                      <select className="xp-input" value={column.source || GOLDEN} disabled={builtin} onChange={(event) => setColumn(index, { source: event.target.value })} aria-label={`Source for ${heading}`}>
                        <option value={GOLDEN}>Golden</option>
                        {sources.map((source) => <option key={source.sourceCode} value={source.sourceCode}>{source.sourceName}</option>)}
                      </select>
                      <input type="checkbox" className="entity-views-col-lock" checked={Boolean(column.pinned)} onChange={(event) => setColumn(index, { pinned: event.target.checked })} aria-label={`Lock ${heading} to the left`} title="Keep the column at the left edge while the table scrolls" />
                      <button type="button" className="btn btn-sm" disabled={builtin} onClick={() => addSource(index)} title="Show this attribute again from another source">+ source</button>
                      <button type="button" className="entity-views-col-remove" onClick={() => removeColumn(index)} aria-label={`Remove ${heading}`} title="Remove">×</button>
                    </li>
                  );
                })}
              </ol>
              {draft.columns.length === 0 && <p className="entity-views-hint">Tick attributes to add columns.</p>}
            </div>
          </div>
        </div>
      )}

      {gridError && <div className="attr-table-error">{gridError}</div>}

      {gridView ? (
        <div className="data-table attr-table-wrap entity-views-grid" style={{ opacity: loading && rows.length ? 0.55 : 1 }}>
          <AppGrid
            rows={rows}
            columns={columnDefs}
            getRowId={(row) => String(row.entity_id || row.entity_code)}
            autoHeight={false}
            height="100%"
            loading={loading && rows.length === 0}
            emptyMessage={loading ? 'Loading…' : 'No records.'}
            grandTotalRow="bottom"
            autoGroupColumnDef={{ headerName: 'Group', minWidth: 220 }}
            onCellContextMenu={openCellSources}
          />
        </div>
      ) : viewsReady && !viewsError && !draft ? (
        <div className="entity-home-empty">
          <p>No views yet. A view is a table of the attributes you choose, from these records or related ones, each from Golden or a named source.</p>
          <button type="button" className="btn" onClick={() => { setDraft(emptyDraft(domainCode)); openEntity([]); }}>New view</button>
        </div>
      ) : null}
    </div>
  );
}

function EntityNode({ path, label, focus, count, onOpen }: {
  path: string[];
  label: string;
  focus: string[];
  count: number;
  onOpen: (path: string[]) => void;
}) {
  const active = focus.join('>') === path.join('>');
  return (
    <button type="button" role="treeitem" aria-selected={active} className={`entity-views-node${active ? ' active' : ''}`} onClick={() => onOpen(path)}>
      <span>{label}</span>
      {count > 0 && <span className="entity-views-node-count">{count}</span>}
    </button>
  );
}

/** A related entity type. Its own related types show once it is opened or has columns, up to three steps out. */
function RelatedNode({ path, label, focus, countAt, childrenOf, onOpen }: {
  path: string[];
  label: string;
  focus: string[];
  countAt: (path: string[]) => number;
  childrenOf: (path: string[]) => RelatedEntity[];
  onOpen: (path: string[]) => void;
}) {
  const key = path.join('>');
  const onFocusPath = focus.join('>') === key || focus.join('>').startsWith(`${key}>`);
  const count = countAt(path);
  const deeper = path.length < 3 && (onFocusPath || count > 0) ? childrenOf(path) : [];
  return (
    <li>
      <EntityNode path={path} label={label} focus={focus} count={count} onOpen={onOpen} />
      {deeper.length > 0 && (
        <ul className="entity-views-tree">
          {deeper.map((entity) => (
            <RelatedNode
              key={entity.domainCode}
              path={[...path, entity.domainCode]}
              label={entity.label}
              focus={focus}
              countAt={countAt}
              childrenOf={childrenOf}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
