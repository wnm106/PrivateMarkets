'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { attributeDisplayKind, formatAttributeDisplay, tableCellAlign, type TableCellAlign } from '@/lib/attribute-display';
import { graphqlQuery } from '@/lib/graphql';
import { ATTRIBUTE_REGISTER_QUERY } from '@/lib/graphql';
import { GRID_QUERY, type DataQuerySpec, type GridResultPayload } from '@/lib/reporting';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import { isRowAttributeCode } from '@/components/detail/attribute-source';
import { AppGrid, createGridStore, useGridStore, type GridStore } from '@/components/grid/AppGrid';

interface CatalogAttr {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  numericPrecision?: number | null;
  aggregationType?: string | null;
  isVisible?: boolean | null;
}

interface ColInfo {
  code: string;
  name: string;
  kind: 'text' | 'num' | 'date';
  align: TableCellAlign;
  dataType?: string;
  precision?: number | null;
  aggregation?: string | null;
  builtin?: boolean;
}

const PAGE_SIZE = 50;
const GROUP_LIMIT = 200;

const BUILTINS: ColInfo[] = [
  { code: 'entity_code', name: 'Code', kind: 'text', align: 'left', builtin: true },
  { code: 'entity_name', name: 'Name', kind: 'text', align: 'left', builtin: true },
];

function kindOf(dataType: string): ColInfo['kind'] {
  const kind = attributeDisplayKind({ dataType });
  if (kind === 'date') return 'date';
  if (kind === 'text' || kind === 'boolean') return 'text';
  return 'num';
}

function columnMeta(dataType: string): Pick<ColInfo, 'kind' | 'align'> {
  return { kind: kindOf(dataType), align: tableCellAlign(dataType) };
}

/** "text" -> contains; "=x" exact; "!x" not; numbers/dates: ">5", ">=5", "<5", "a..b", "=5". */
function parseFilter(field: string, kind: ColInfo['kind'], raw: string) {
  const t = (raw || '').trim();
  if (!t) return null;
  if (kind === 'text') {
    if (t.startsWith('!')) return { field, op: 'neq', value: t.slice(1).trim() };
    if (t.startsWith('=')) return { field, op: 'eq', value: t.slice(1).trim() };
    if (t.includes('|')) return { field, op: 'in', value: t.split('|').map((s) => s.trim()).filter(Boolean) };
    return { field, op: 'contains', value: t };
  }
  const range = t.match(/^(.+?)\s*\.\.\s*(.+)$/);
  if (range) return { field, op: 'between', value: [range[1].trim(), range[2].trim()] };
  const m = t.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return null;
  const op = ({ '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt', '=': 'eq' } as Record<string, string>)[m[1] || '='];
  return { field, op, value: m[2].trim() };
}

function fmtValue(v: any, col: ColInfo | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  if (col?.kind === 'num' || typeof v === 'number') {
    return formatAttributeDisplay(String(v), { dataType: col?.dataType, numericPrecision: col?.precision }) || String(v);
  }
  return String(v);
}

export interface DataGridProps {
  spec: DataQuerySpec;
  entityId?: string | null;
  /** Dashboard filter inputs (bound to spec filters via `param`). */
  params?: Record<string, any>;
  asOfDate?: string;
  title?: string;
}

/**
 * Server-side data grid: paging, per-column filters, sorting, hierarchical grouping by ANY
 * attribute with summary rows that use each attribute's defined aggregation type, CSV export.
 * Nothing is loaded client-side beyond the visible page.
 */
export function DataGrid({ spec, entityId, params, asOfDate, title }: DataGridProps) {
  const domainForAttrs = spec.domainCode || (spec.path || []).slice(-1)[0]?.domainCode || null;
  const [catalog, setCatalog] = useState<CatalogAttr[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [filterText, setFilterText] = useState<Record<string, string>>({});
  const [filterDebounced, setFilterDebounced] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  const [groupBy, setGroupBy] = useState<string[]>(spec.groupBy || []);
  const [showCols, setShowCols] = useState(false);
  const [colSearch, setColSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gridTick, setGridTick] = useState(0);
  const reloadGrid = useCallback(() => setGridTick((tick) => tick + 1), []);

  // Attribute catalog -> column chooser + labels + formatting.
  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ attributeRegister: CatalogAttr[] }, any>(ATTRIBUTE_REGISTER_QUERY, { domainCode: domainForAttrs }).then((r) => {
      if (cancelled) return;
      const list = (r.data?.attributeRegister || []).filter((a) => a.isVisible !== false);
      setCatalog(list);
      setColumns((prev) => (prev.length ? prev : defaultColumns(spec, list)));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainForAttrs]);

  // Attributes of RELATED entities (spec.lookups), addressed as "<alias>.<ATTRIBUTE>".
  const lookups = spec.lookups || [];
  const lookupsKey = JSON.stringify(lookups);
  const [lookupCatalogs, setLookupCatalogs] = useState<Record<string, CatalogAttr[]>>({});
  useEffect(() => {
    let cancelled = false;
    lookups.forEach((l) => {
      graphqlQuery<{ attributeRegister: CatalogAttr[] }, any>(ATTRIBUTE_REGISTER_QUERY, { domainCode: l.domainCode || null }).then((r) => {
        if (cancelled) return;
        const list = (r.data?.attributeRegister || []).filter((a) => a.isVisible !== false);
        setLookupCatalogs((prev) => ({ ...prev, [l.alias]: list }));
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupsKey]);

  /** Every selectable related field: { code: 'sec.INDUSTRY', name: 'Security · Industry', group: 'Security' }. */
  const relatedFields = useMemo(() => {
    const out: Array<{ code: string; name: string; group: string; attr?: CatalogAttr }> = [];
    lookups.forEach((l) => {
      const group = l.label || l.alias;
      out.push({ code: `${l.alias}.entity_name`, name: `${group} · Name`, group });
      out.push({ code: `${l.alias}.entity_code`, name: `${group} · Code`, group });
      (lookupCatalogs[l.alias] || []).forEach((a) =>
        out.push({ code: `${l.alias}.${a.attributeCode}`, name: `${group} · ${a.attributeName}`, group, attr: a })
      );
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupsKey, lookupCatalogs]);

  useEffect(() => {
    const h = setTimeout(() => setFilterDebounced(filterText), 350);
    return () => clearTimeout(h);
  }, [filterText]);

  const colInfo = useMemo(() => {
    const map = new Map<string, ColInfo>();
    BUILTINS.forEach((b) => map.set(b.code, b));
    catalog.forEach((a) =>
      map.set(a.attributeCode, {
        code: a.attributeCode, name: a.attributeName || a.attributeCode, ...columnMeta(a.dataType),
        dataType: a.dataType,
        precision: a.numericPrecision, aggregation: a.aggregationType,
      })
    );
    relatedFields.forEach((f) =>
      map.set(
        f.code,
        f.attr
          ? { code: f.code, name: f.name, ...columnMeta(f.attr.dataType), dataType: f.attr.dataType, precision: f.attr.numericPrecision, aggregation: f.attr.aggregationType }
          : { code: f.code, name: f.name, kind: 'text', align: 'left' as const }
      )
    );
    return map;
  }, [catalog, relatedFields]);

  const visible = useMemo(() => [...BUILTINS.map((b) => b.code), ...columns.filter((c) => !BUILTINS.some((b) => b.code === c))], [columns]);

  const userFilters = useMemo(
    () =>
      Object.entries(filterDebounced)
        .map(([field, text]) => parseFilter(field, colInfo.get(field)?.kind || 'text', text))
        .filter(Boolean) as any[],
    [filterDebounced, colInfo]
  );

  const baseInput = useMemo(
    () => ({
      start: spec.start,
      domainCode: spec.domainCode || null,
      entityId: entityId || null,
      path: spec.path || [],
      includeAnchor: !!spec.includeAnchor,
      lookups: spec.lookups || [],
      asOfDate: asOfDate || null,
      params: params || {},
      filters: [...(spec.filters || []), ...userFilters],
      columns: visible.filter((c) => !BUILTINS.some((b) => b.code === c)),
      sort: sort ? [sort] : spec.orderBy || [],
      groupBy,
    }),
    [spec, entityId, asOfDate, params, userFilters, visible, sort, groupBy]
  );
  const baseKey = JSON.stringify(baseInput);

  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const { data, error: e } = await graphqlQuery<{ gridQuery: GridResultPayload }, any>(
        GRID_QUERY, { input: { ...baseInput, groupBy: [], groupKeys: [], export: true, limit: 100000, offset: 0 } }, 'network-only'
      );
      if (e) throw new Error(e.message);
      const rows = data?.gridQuery.rows || [];
      const cols = ['entity_code', 'entity_name', ...baseInput.columns.filter((c) => c !== 'entity_code' && c !== 'entity_name')];
      const esc = (v: any) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = cols.map((c) => esc(colInfo.get(c)?.name || c)).join(',');
      const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
      const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${spec.key || 'export'}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(e.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [baseInput, colInfo, spec.key]);

  const toggleSort = (field: string) =>
    setSort((s) => (s?.field === field ? (s.dir === 'asc' ? { field, dir: 'desc' } : null) : { field, dir: 'asc' }));

  const headerStoreRef = useRef(createGridStore<ReportHeaderState>({ sort: null, filterText: {} }));
  useLayoutEffect(() => {
    headerStoreRef.current.set({ sort, filterText });
  }, [sort, filterText]);

  const available = catalog.filter((a) => !colSearch || (a.attributeName + a.attributeCode).toLowerCase().includes(colSearch.toLowerCase()));

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, margin: '12px 0', background: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{title || spec.label || spec.key}</strong>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: '#555' }}>
          Group by{' '}
          <select
            value=""
            onChange={(e) => e.target.value && setGroupBy((g) => (g.includes(e.target.value) ? g : [...g, e.target.value]))}
            style={{ fontSize: 12 }}
          >
            <option value="">+ add…</option>
            {catalog.map((a) => <option key={a.attributeCode} value={a.attributeCode}>{a.attributeName}</option>)}
            {lookups.map((l) => (
              <optgroup key={l.alias} label={`${l.label || l.alias} (related)`}>
                {relatedFields.filter((f) => f.group === (l.label || l.alias) && f.code.startsWith(l.alias + '.')).map((f) => (
                  <option key={f.code} value={f.code}>{f.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {groupBy.map((g) => (
          <span key={g} style={chip}>
            {colInfo.get(g)?.name || g}
            <button onClick={() => setGroupBy((x) => x.filter((y) => y !== g))} style={chipX} aria-label={`Remove ${g}`}>×</button>
          </span>
        ))}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setShowCols((s) => !s)} style={btn}>Columns ({columns.length})</button>
          {showCols && (
            <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, width: 260, maxHeight: 320, overflow: 'auto', background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: 8, boxShadow: '0 4px 12px rgba(0,0,0,.12)' }}>
              <input placeholder="Search attributes…" value={colSearch} onChange={(e) => setColSearch(e.target.value)} style={{ width: '100%', fontSize: 12, marginBottom: 6 }} />
              {available.map((a) => (
                <label key={a.attributeCode} style={{ display: 'flex', gap: 6, fontSize: 12, padding: '2px 0' }}>
                  <input
                    type="checkbox"
                    checked={columns.includes(a.attributeCode)}
                    onChange={(e) => setColumns((c) => (e.target.checked ? [...c, a.attributeCode] : c.filter((x) => x !== a.attributeCode)))}
                  />
                  {a.attributeName}
                </label>
              ))}
              {relatedFields
                .filter((f) => !colSearch || f.name.toLowerCase().includes(colSearch.toLowerCase()))
                .map((f) => (
                  <label key={f.code} style={{ display: 'flex', gap: 6, fontSize: 12, padding: '2px 0', color: '#334155' }}>
                    <input
                      type="checkbox"
                      checked={columns.includes(f.code)}
                      onChange={(e) => setColumns((c) => (e.target.checked ? [...c, f.code] : c.filter((x) => x !== f.code)))}
                    />
                    {f.name}
                  </label>
                ))}
            </div>
          )}
        </div>
        <button onClick={exportCsv} disabled={exporting} style={btn}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
      </div>

      {error && <div style={{ padding: '6px 10px', color: '#b91c1c', background: '#fdecec', fontSize: 12 }}>{error}</div>}

      <GridLevel
        key={baseKey}
        baseInput={baseInput}
        keys={[]}
        depth={0}
        visible={visible}
        colInfo={colInfo}
        groupBy={groupBy}
        onError={setError}
        showSummary
        domainCode={domainForAttrs || undefined}
        refreshTick={gridTick}
        onDataChanged={reloadGrid}
        headerStore={headerStoreRef.current}
        toggleSort={toggleSort}
        setFilterText={setFilterText}
      />
    </div>
  );
}

function defaultColumns(spec: DataQuerySpec, catalog: CatalogAttr[]): string[] {
  if (spec.select && spec.select.length) return spec.select.filter((c) => c !== 'entity_code' && c !== 'entity_name');
  return catalog.slice(0, 8).map((a) => a.attributeCode);
}

interface LevelProps {
  baseInput: any;
  keys: any[];
  depth: number;
  visible: string[];
  colInfo: Map<string, ColInfo>;
  groupBy: string[];
  onError: (m: string | null) => void;
  showSummary?: boolean;
  domainCode?: string;
  refreshTick?: number;
  onDataChanged?: () => void;
  headerStore: GridStore<ReportHeaderState>;
  toggleSort: (field: string) => void;
  setFilterText: (value: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
}

type ReportHeaderState = {
  sort: { field: string; dir: 'asc' | 'desc' } | null;
  filterText: Record<string, string>;
};

function displayGridValue(data: any, code: string, index: number, colInfo: Map<string, ColInfo>) {
  if (!data || data.__kind === 'detail') return '';
  const info = colInfo.get(code);
  if (data.__kind === 'summary') {
    if (index === 0) return `Total · ${Number(data._count || 0).toLocaleString()} records`;
    return fmtValue(data[code], info);
  }
  if (data.__kind === 'group') {
    if (index === 0) {
      const field = data.__groupField || '';
      return `${colInfo.get(field)?.name || field}: ${data._key ?? '(none)'}  (${Number(data._count || 0).toLocaleString()})`;
    }
    return fmtValue(data[code], info);
  }
  return fmtValue(data?.[code], info);
}

function ExpandCell(props: any) {
  if (props.data?.__kind !== 'group') return null;
  const open = !!props.data.__open;
  return (
    <button
      type="button"
      className="report-grid-sort"
      aria-label={open ? 'Collapse group' : 'Expand group'}
      onClick={() => props.context.get().toggleOpen(props.data.__key)}
    >
      {open ? '▾' : '▸'}
    </button>
  );
}

function ReportHeader(props: any) {
  const code = props.code as string;
  const state = useGridStore<ReportHeaderState>(props.context.headerStore);
  const info = props.context.get().colInfo.get(code) as ColInfo | undefined;
  const active = state.sort?.field === code;
  return (
    <div className="report-grid-header">
      <button type="button" className="report-grid-sort" onClick={() => props.context.get().toggleSort(code)}>
        {info?.name || code}
        {active ? (state.sort?.dir === 'asc' ? ' ▲' : ' ▼') : ''}
        {info?.aggregation && info.aggregation !== 'NONE' ? (
          <span style={{ color: '#888', fontWeight: 400 }}> · {info.aggregation.toLowerCase().replace('_', ' ')}</span>
        ) : null}
      </button>
      <input
        value={state.filterText[code] || ''}
        onChange={(event) => props.context.get().setFilterText((current: Record<string, string>) => ({ ...current, [code]: event.target.value }))}
        placeholder={info?.kind === 'text' ? 'contains…' : '>5, 1..9'}
        aria-label={`Filter ${info?.name || code}`}
      />
    </div>
  );
}

function GroupDetail(props: any) {
  const ctx = props.context.get();
  return (
    <div style={{ height: 392, boxSizing: 'border-box', padding: '8px 8px 8px 28px' }}>
      <GridLevel
        baseInput={ctx.baseInput}
        keys={[...ctx.keys, props.data.__groupKey]}
        depth={ctx.depth + 1}
        visible={ctx.visible}
        colInfo={ctx.colInfo}
        groupBy={ctx.groupBy}
        onError={ctx.onError}
        domainCode={ctx.domainCode}
        refreshTick={ctx.refreshTick}
        onDataChanged={ctx.onDataChanged}
        headerStore={props.context.headerStore}
        toggleSort={ctx.toggleSort}
        setFilterText={ctx.setFilterText}
      />
    </div>
  );
}

/** One level of the grid tree: either a page of entity rows or a page of groups (each expandable). */
function GridLevel({ baseInput, keys, depth, visible, colInfo, groupBy, onError, showSummary, domainCode, refreshTick = 0, onDataChanged, headerStore, toggleSort, setFilterText }: LevelProps) {
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<GridResultPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const reqId = useRef(0);
  const inspect = useAttributeInspect();
  const actions = useRef<any>(null);
  actions.current = {
    baseInput, keys, depth, visible, colInfo, groupBy, onError, domainCode, refreshTick, onDataChanged,
    toggleSort, setFilterText, inspect,
    toggleOpen: (key: string) => setOpen((current) => ({ ...current, [key]: !current[key] })),
  };
  const context = useMemo(() => ({ get: () => actions.current, headerStore }), [headerStore]);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const isGroups = groupBy.length > 0 && keys.length < groupBy.length;
    graphqlQuery<{ gridQuery: GridResultPayload }, any>(
      GRID_QUERY,
      { input: { ...baseInput, groupKeys: keys, offset, limit: isGroups ? GROUP_LIMIT : PAGE_SIZE } },
      'network-only'
    ).then((r) => {
      if (id !== reqId.current) return;
      if (r.error) onError(r.error.message);
      else { onError(null); setRes(r.data?.gridQuery || null); }
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, refreshTick]);

  const columnDefs = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = [];
    if (groupBy.length > 0) {
      defs.push({
        colId: '__expand',
        headerName: '',
        width: 52,
        maxWidth: 52,
        sortable: false,
        filter: false,
        resizable: false,
        cellRenderer: ExpandCell,
      });
    }
    visible.forEach((code, index) => {
      const info = colInfo.get(code);
      defs.push({
        colId: code,
        headerName: info?.name || code,
        flex: 1,
        minWidth: 140,
        sortable: false,
        filter: false,
        headerComponent: depth === 0 ? ReportHeader : undefined,
        headerComponentParams: { code },
        cellStyle: { textAlign: info?.align || 'left' },
        valueGetter: (params) => displayGridValue(params.data, code, index, colInfo),
      });
    });
    return defs;
  }, [colInfo, depth, groupBy.length, visible]);

  if (!res) {
    return <div style={{ padding: 10, color: '#888' }}>{loading ? 'Loading…' : 'No data'}</div>;
  }

  const isGroups = res.mode === 'groups';
  const pages = Math.max(1, Math.ceil(res.total / (isGroups ? GROUP_LIMIT : PAGE_SIZE)));
  const page = Math.floor(offset / (isGroups ? GROUP_LIMIT : PAGE_SIZE)) + 1;
  const step = isGroups ? GROUP_LIMIT : PAGE_SIZE;
  const rows = isGroups
    ? res.rows.flatMap((group) => {
        const key = String(group._key ?? '∅');
        const groupRow = {
          ...group,
          __kind: 'group',
          __key: key,
          __id: `g:${depth}:${key}`,
          __open: !!open[key],
          __groupField: res.groupField,
          __groupKey: group._key ?? null,
        };
        if (!open[key]) return [groupRow];
        return [groupRow, { __kind: 'detail', __key: key, __id: `d:${depth}:${key}`, __groupKey: group._key ?? null }];
      })
    : res.rows.map((row, index) => ({ ...row, __kind: 'leaf', __id: String(row.entity_id ?? `row-${depth}-${index}`) }));
  const pinnedTopRowData = showSummary && res.summary ? [{
    __kind: 'summary',
    __id: `summary:${depth}`,
    _count: (res.summary as any)._count,
    ...Object.fromEntries(visible.map((code) => [code, (res.summary as any)[code]])),
  }] : undefined;

  return (
    <div style={{ opacity: loading ? 0.6 : 1, height: depth === 0 ? undefined : '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: depth === 0 ? undefined : 1, minHeight: depth === 0 ? undefined : 0 }}>
      <AppGrid
        rows={rows}
        columns={columnDefs}
        getRowId={(row: any) => String(row.__id)}
        autoHeight={depth === 0}
        height={depth === 0 ? undefined : '100%'}
        headerHeight={depth === 0 ? 78 : 0}
        enableSortFilter={false}
        rowGroupPanelShow="never"
        loading={false}
        emptyMessage={loading ? 'Loading…' : 'No matching records'}
        context={context}
        pinnedTopRowData={pinnedTopRowData}
        isFullWidthRow={(params) => params.rowNode.data?.__kind === 'detail'}
        fullWidthCellRenderer={GroupDetail}
        getRowHeight={(params) => (params.data?.__kind === 'detail' ? 400 : undefined)}
        getRowClass={(params) => {
          if (params.data?.__kind === 'group') return 'report-group';
          if (params.data?.__kind === 'summary') return 'report-summary';
          return '';
        }}
        onCellContextMenu={(event) => {
          const code = event.column?.getColId?.();
          const row = event.data as any;
          if (!code || !row || row.__kind === 'group' || row.__kind === 'summary' || row.__kind === 'detail') return;
          const col = colInfo.get(code);
          const ownAttribute = isRowAttributeCode(code) && !col?.builtin && Boolean(row.entity_id);
          if (!ownAttribute) return;
          (event.event as MouseEvent | undefined)?.preventDefault();
          inspect.open({
            entityId: String(row.entity_id),
            entityName: String(row.entity_name || row.entity_code || ''),
            attributeCode: code,
            attributeName: col?.name || code,
            dataType: col?.dataType,
            value: fmtValue(row[code], col),
            domainCode,
            onChanged: onDataChanged,
          });
        }}
      />
      </div>
      {res.total > step && (
        <div style={{ padding: '6px 8px', fontSize: 11, color: '#555' }}>
          <button type="button" style={btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - step))}>‹ Prev</button>{' '}
          Page {page} of {pages} · {res.total.toLocaleString()} {isGroups ? 'groups' : 'records'}{' '}
          <button type="button" style={btn} disabled={page >= pages} onClick={() => setOffset(offset + step)}>Next ›</button>
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = { fontSize: 12, padding: '3px 8px', border: '1px solid #ccc', borderRadius: 4, background: '#fff', cursor: 'pointer' };

const chip: React.CSSProperties = { fontSize: 11, background: '#e0e7ef', borderRadius: 10, padding: '2px 8px', display: 'inline-flex', gap: 4, alignItems: 'center' };
const chipX: React.CSSProperties = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, lineHeight: 1 };
