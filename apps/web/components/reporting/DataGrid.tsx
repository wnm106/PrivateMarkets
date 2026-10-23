'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attributeDisplayKind, tableCellAlign, type TableCellAlign } from '@/lib/attribute-display';
import { graphqlQuery } from '@/lib/graphql';
import { ATTRIBUTE_REGISTER_QUERY } from '@/lib/graphql';
import { GRID_QUERY, type DataQuerySpec, type GridResultPayload } from '@/lib/reporting';

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
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const d = col?.precision ?? 2;
    return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(d, 6) });
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
        precision: a.numericPrecision, aggregation: a.aggregationType,
      })
    );
    relatedFields.forEach((f) =>
      map.set(
        f.code,
        f.attr
          ? { code: f.code, name: f.name, ...columnMeta(f.attr.dataType), precision: f.attr.numericPrecision, aggregation: f.attr.aggregationType }
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

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr>
              {groupBy.length > 0 && <th style={{ ...th, width: 24 }} />}
              {visible.map((c) => (
                <th key={c} style={{ ...th, textAlign: colInfo.get(c)?.align || 'left' }} onClick={() => toggleSort(c)}>
                  {colInfo.get(c)?.name || c}
                  {sort?.field === c ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  {colInfo.get(c)?.aggregation && colInfo.get(c)?.aggregation !== 'NONE' ? (
                    <span style={{ color: '#888', fontWeight: 400 }}> · {colInfo.get(c)!.aggregation!.toLowerCase().replace('_', ' ')}</span>
                  ) : null}
                </th>
              ))}
            </tr>
            <tr>
              {groupBy.length > 0 && <th style={fth} />}
              {visible.map((c) => (
                <th key={c} style={fth}>
                  <input
                    value={filterText[c] || ''}
                    onChange={(e) => setFilterText((f) => ({ ...f, [c]: e.target.value }))}
                    placeholder={colInfo.get(c)?.kind === 'text' ? 'contains…' : '>5, 1..9'}
                    style={{ width: '100%', fontSize: 11, padding: '2px 4px', boxSizing: 'border-box' }}
                  />
                </th>
              ))}
            </tr>
          </thead>
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
          />
        </table>
      </div>
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
}

/** One level of the grid tree: either a page of entity rows or a page of groups (each expandable). */
function GridLevel({ baseInput, keys, depth, visible, colInfo, groupBy, onError, showSummary }: LevelProps) {
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<GridResultPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const reqId = useRef(0);
  const span = visible.length + (groupBy.length > 0 ? 1 : 0);

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
  }, [offset]);

  if (!res) {
    return <tbody><tr><td colSpan={span} style={{ padding: 10, color: '#888' }}>{loading ? 'Loading…' : 'No data'}</td></tr></tbody>;
  }

  const pad = depth * 16;
  const isGroups = res.mode === 'groups';
  const pages = Math.max(1, Math.ceil(res.total / (isGroups ? GROUP_LIMIT : PAGE_SIZE)));
  const page = Math.floor(offset / (isGroups ? GROUP_LIMIT : PAGE_SIZE)) + 1;
  const step = isGroups ? GROUP_LIMIT : PAGE_SIZE;

  return (
    <tbody style={{ opacity: loading ? 0.6 : 1 }}>
      {showSummary && res.summary && (
        <tr style={{ background: '#f3f4f6', fontWeight: 600 }}>
          {groupBy.length > 0 && <td style={td} />}
          {visible.map((c, i) => (
            <td key={c} style={numStyle(colInfo.get(c))}>
              {i === 0 ? `Total · ${(res.summary as any)._count?.toLocaleString?.() ?? ''} records` : fmtValue((res.summary as any)[c], colInfo.get(c))}
            </td>
          ))}
        </tr>
      )}
      {isGroups
        ? res.rows.map((g) => {
            const k = String(g._key ?? '∅');
            const isOpen = !!open[k];
            return (
              <Fragment key={k}>
                <tr style={{ background: depth % 2 ? '#fafafa' : '#f9fafb', fontWeight: 600, cursor: 'pointer' }} onClick={() => setOpen((o) => ({ ...o, [k]: !o[k] }))}>
                  <td style={{ ...td, paddingLeft: 6 + pad }}>{isOpen ? '▾' : '▸'}</td>
                  {visible.map((c, i) => (
                    <td key={c} style={numStyle(colInfo.get(c))}>
                      {i === 0
                        ? `${colInfo.get(res.groupField || '')?.name || res.groupField}: ${g._key ?? '(none)'}  (${Number(g._count).toLocaleString()})`
                        : fmtValue(g[c], colInfo.get(c))}
                    </td>
                  ))}
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={span} style={{ padding: 0 }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                        <GridLevel
                          baseInput={baseInput}
                          keys={[...keys, g._key ?? null]}
                          depth={depth + 1}
                          visible={visible}
                          colInfo={colInfo}
                          groupBy={groupBy}
                          onError={onError}
                        />
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })
        : res.rows.map((r) => (
            <tr key={r.entity_id} style={{ borderBottom: '1px solid #f0f0f0' }}>
              {groupBy.length > 0 && <td style={td} />}
              {visible.map((c, i) => (
                <td key={c} style={{ ...numStyle(colInfo.get(c)), paddingLeft: i === 0 ? 8 + pad : 8 }}>
                  {fmtValue(r[c], colInfo.get(c))}
                </td>
              ))}
            </tr>
          ))}
      {res.rows.length === 0 && (
        <tr><td colSpan={span} style={{ padding: 10, color: '#888' }}>No matching records</td></tr>
      )}
      {res.total > step && (
        <tr>
          <td colSpan={span} style={{ padding: '6px 8px', fontSize: 11, color: '#555', paddingLeft: 8 + pad }}>
            <button style={btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - step))}>‹ Prev</button>{' '}
            Page {page} of {pages} · {res.total.toLocaleString()} {isGroups ? 'groups' : 'records'}{' '}
            <button style={btn} disabled={page >= pages} onClick={() => setOffset(offset + step)}>Next ›</button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #ddd', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', background: '#fff' };
const fth: React.CSSProperties = { padding: '2px 6px', borderBottom: '1px solid #e5e7eb' };
const td: React.CSSProperties = { padding: '5px 8px' };
const btn: React.CSSProperties = { fontSize: 12, padding: '3px 8px', border: '1px solid #ccc', borderRadius: 4, background: '#fff', cursor: 'pointer' };
const chip: React.CSSProperties = { fontSize: 11, background: '#e0e7ef', borderRadius: 10, padding: '2px 8px', display: 'inline-flex', gap: 4, alignItems: 'center' };
const chipX: React.CSSProperties = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, lineHeight: 1 };
function numStyle(col?: ColInfo): React.CSSProperties {
  const align = col?.align || 'left';
  return {
    ...td,
    textAlign: align,
    fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined,
    whiteSpace: 'nowrap',
  };
}
