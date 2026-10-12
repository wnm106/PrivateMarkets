'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ATTRIBUTE_REGISTER_QUERY, graphqlQuery } from '@/lib/graphql';
import { GRID_QUERY, type GridResultPayload } from '@/lib/reporting';

const NO_RELATED: RelatedAttributeColumn[] = [];
const PAGE_SIZE = 20;
const FACET_LIMIT = 200;
const FALLBACK_SCAN = 2000;
const BLANK = '__blank__';

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
}

interface Col {
  code: string;
  name: string;
  kind: 'text' | 'num' | 'date';
  listValues: string[];
}

interface Facet {
  values: string[];
  hasBlank: boolean;
  truncated: boolean;
}

type Filter = { field: string; op: string; value?: any };

const kindOf = (dataType: string): Col['kind'] =>
  ['NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL', 'FLOAT', 'NUMERIC'].includes((dataType || '').toUpperCase())
    ? 'num'
    : ['DATE', 'TIMESTAMP', 'DATETIME'].includes((dataType || '').toUpperCase())
      ? 'date'
      : 'text';

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

function formatCell(value: any, kind: Col['kind']): string {
  const text = cellText(value);
  if (!text) return '';
  if (kind === 'num' || typeof value === 'number') {
    const n = Number(text);
    if (Number.isFinite(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
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

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] || '') !== (b[key] || '')) return false;
  }
  return true;
}

function rowMatchesGlobal(row: Record<string, any>, columns: Col[], term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const hay = [row.entity_code, row.entity_name, ...columns.map((c) => cellText(row[c.code]))]
    .join('\n')
    .toLowerCase();
  return hay.includes(needle);
}

export function EntityAttributeTable({
  domainCode,
  domainKey,
  asOfDate,
  refreshKey = 0,
  emptyMessage,
  related = NO_RELATED,
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
  const router = useRouter();
  const relatedKey = JSON.stringify(related);
  const stableRelated = useMemo(() => related, [relatedKey]);
  const [catalog, setCatalog] = useState<Col[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [rows, setRows] = useState<Array<Record<string, any>>>([]);
  const [matched, setMatched] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState<Record<string, string>>({});
  const [columnSearch, setColumnSearch] = useState<Record<string, string>>({});
  const [columnExact, setColumnExact] = useState<Record<string, string>>({});
  const [globalDraft, setGlobalDraft] = useState('');
  const [globalSearch, setGlobalSearch] = useState('');
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  const [offset, setOffset] = useState(0);
  const [facets, setFacets] = useState<Record<string, Facet>>({});
  const [facetLoading, setFacetLoading] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const reqId = useRef(0);

  const columns = useMemo<Col[]>(() => {
    const id: Col = { code: 'entity_code', name: 'ID', kind: 'text', listValues: [] };
    const name: Col = { code: 'entity_name', name: 'Name', kind: 'text', listValues: [] };
    const relatedCols: Col[] = stableRelated.map((r) => ({
      code: `${r.alias}.${r.field}`,
      name: r.header,
      kind: 'text',
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
      setColumnSearch((prev) => (sameRecord(prev, searchDraft) ? prev : searchDraft));
      setGlobalSearch((prev) => (prev === nextGlobal ? prev : nextGlobal));
    }, 300);
    return () => clearTimeout(handle);
  }, [searchDraft, globalDraft]);

  useEffect(() => {
    setOffset(0);
  }, [columnSearch, globalSearch, columnExact, refreshKey]);

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
            if (!a.attributeCode || seen.has(a.attributeCode)) return false;
            seen.add(a.attributeCode);
            return true;
          })
          .map((a) => ({
            code: a.attributeCode,
            name: a.attributeName || a.attributeCode,
            kind: kindOf(a.dataType),
            listValues: (a.listValues || []).map(String).filter(Boolean),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCatalog(cols);
      }
      setCatalogReady(true);
    });
    return () => { cancelled = true; };
  }, [domainCode, refreshKey]);

  const filters = useMemo(
    () => buildAttributeFilters(columns, globalSearch, columnSearch, columnExact),
    [columns, globalSearch, columnSearch, columnExact]
  );

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
      offset,
      limit: PAGE_SIZE,
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
      const filtered = all.filter((row) => rowMatchesGlobal(row, columns, globalSearch));
      setRows(filtered.slice(offset, offset + PAGE_SIZE));
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
    setRows(grid?.rows || []);
    setMatched(grid?.total || 0);
    if (filters.length === 0) onTotalChange?.(grid?.total || 0);
    setScanNote(null);
    setError(null);
    setLoading(false);
  }, [catalogReady, domainCode, asOfDate, attributeColumns, lookups, sort, filters, offset, columns, globalSearch, onTotalChange]);

  useEffect(() => { loadPage(); }, [loadPage, refreshKey]);

  useEffect(() => {
    if (!catalogReady) return;
    let cancelled = false;
    graphqlQuery<{ gridQuery: GridResultPayload }, { input: any }>(
      GRID_QUERY,
      {
        input: {
          start: 'DOMAIN',
          domainCode,
          asOfDate: asOfDate || null,
          columns: [],
          offset: 0,
          limit: 1,
        },
      },
      'network-only'
    ).then((res) => {
      if (cancelled || res.error) return;
      onTotalChange?.(res.data?.gridQuery.total || 0);
    });
    return () => { cancelled = true; };
  }, [catalogReady, domainCode, asOfDate, refreshKey, onTotalChange]);

  const facetScope = useMemo(() => JSON.stringify({
    filters: filters.filter((f) => f.op !== 'eq' && f.op !== 'isNull'),
    asOfDate,
    domainCode,
  }), [filters, asOfDate, domainCode]);

  useEffect(() => { setFacets({}); }, [facetScope, refreshKey]);

  const loadFacet = async (col: Col) => {
    if (facets[col.code] || facetLoading === col.code) return;
    setFacetLoading(col.code);
    const others = filters.filter((f) => f.field !== col.code && f.op !== 'searchAny');
    const res = await graphqlQuery<{ gridQuery: GridResultPayload }, { input: any }>(
      GRID_QUERY,
      {
        input: {
          start: 'DOMAIN',
          domainCode,
          asOfDate: asOfDate || null,
          columns: col.code.includes('.') || !col.code.startsWith('entity_') ? [col.code] : [],
          lookups,
          filters: others,
          groupBy: [col.code],
          offset: 0,
          limit: FACET_LIMIT,
        },
      },
      'network-only'
    );
    const grid = res.data?.gridQuery;
    const values = new Set<string>(col.listValues);
    let hasBlank = false;
    for (const row of grid?.rows || []) {
      if (row._key === null || row._key === undefined || row._key === '') hasBlank = true;
      else values.add(cellText(row._key));
    }
    setFacets((prev) => ({
      ...prev,
      [col.code]: {
        values: Array.from(values).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        hasBlank,
        truncated: (grid?.total || 0) > (grid?.rows?.length || 0),
      },
    }));
    setFacetLoading(null);
  };

  const toggleSort = (field: string) => {
    setOffset(0);
    setSort((current) => {
      if (current?.field !== field) return { field, dir: 'asc' };
      if (current.dir === 'asc') return { field, dir: 'desc' };
      return null;
    });
  };

  const clearAll = () => {
    setSearchDraft({});
    setColumnSearch({});
    setColumnExact({});
    setGlobalDraft('');
    setGlobalSearch('');
    setOffset(0);
  };

  const activeChips = columns.flatMap((col) => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];
    const exact = columnExact[col.code];
    const search = (columnSearch[col.code] || '').trim();
    if (exact === BLANK) chips.push({
      key: `${col.code}-blank`,
      label: `${col.name}: blank`,
      clear: () => setColumnExact((f) => ({ ...f, [col.code]: '' })),
    });
    else if (exact) chips.push({
      key: `${col.code}-eq`,
      label: `${col.name}: ${exact}`,
      clear: () => setColumnExact((f) => ({ ...f, [col.code]: '' })),
    });
    if (search) chips.push({
      key: `${col.code}-search`,
      label: `${col.name} contains “${search}”`,
      clear: () => {
        setSearchDraft((f) => ({ ...f, [col.code]: '' }));
        setColumnSearch((f) => ({ ...f, [col.code]: '' }));
      },
    });
    return chips;
  });
  if (globalSearch) {
    activeChips.unshift({
      key: 'global',
      label: `Any attribute contains “${globalSearch}”`,
      clear: () => { setGlobalDraft(''); setGlobalSearch(''); },
    });
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(matched / PAGE_SIZE));
  const shown = rows.length;

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

      <div className="data-table attr-table-wrap">
        <table className="attr-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.code} className={col.code === 'entity_code' ? 'sticky-col' : undefined}>
                  <button type="button" className="attr-sort" onClick={() => toggleSort(col.code)}>
                    {col.name}
                    {sort?.field === col.code ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                  <input
                    className="attr-col-search"
                    value={searchDraft[col.code] || ''}
                    placeholder="Search"
                    aria-label={`Search ${col.name}`}
                    onChange={(e) => setSearchDraft((f) => ({ ...f, [col.code]: e.target.value }))}
                  />
                  <select
                    className="attr-col-filter"
                    aria-label={`Filter ${col.name}`}
                    value={columnExact[col.code] || ''}
                    onFocus={() => loadFacet(col)}
                    onChange={(e) => {
                      setColumnExact((f) => ({ ...f, [col.code]: e.target.value }));
                      setOffset(0);
                    }}
                  >
                    <option value="">All</option>
                    {facetLoading === col.code && <option value="__loading__" disabled>Loading values…</option>}
                    {facets[col.code]?.hasBlank && <option value={BLANK}>(Blank)</option>}
                    {(facets[col.code]?.values || []).map((value) => (
                      <option key={value} value={value}>{formatCell(value, col.kind) || value}</option>
                    ))}
                    {facets[col.code]?.truncated && <option value="__more__" disabled>More values — use search</option>}
                    {columnExact[col.code] && columnExact[col.code] !== BLANK && !(facets[col.code]?.values || []).includes(columnExact[col.code]) && (
                      <option value={columnExact[col.code]}>{columnExact[col.code]}</option>
                    )}
                  </select>
                </th>
              ))}
              <th className="attr-status"><span className="attr-sort">Status</span></th>
            </tr>
          </thead>
            <tbody style={{ opacity: loading ? 0.55 : 1 }}>
            {!catalogReady || (loading && rows.length === 0) ? (
              <tr><td className="attr-empty" colSpan={columns.length + 1}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td className="attr-empty" colSpan={columns.length + 1}>{filters.length > 0 ? 'No records match these filters.' : emptyMessage}</td></tr>
            ) : rows.map((row) => {
              const href = `/${domainKey}/${row.entity_id}`;
              return (
                <tr key={row.entity_id} onClick={() => router.push(href)}>
                  {columns.map((col) => {
                    const text = formatCell(row[col.code], col.kind);
                    if (col.code === 'entity_code') {
                      return (
                        <td key={col.code} className="sticky-col">
                          <Link href={href} className="row-id" onClick={(e) => e.stopPropagation()}>{text || '—'}</Link>
                        </td>
                      );
                    }
                    if (col.code === 'entity_name') {
                      return (
                        <td key={col.code}>
                          <Link href={href} className="row-name" onClick={(e) => e.stopPropagation()}>{text || '—'}</Link>
                        </td>
                      );
                    }
                    return (
                      <td key={col.code} className={col.kind === 'num' ? 'attr-num' : undefined} title={col.code}>
                        {text || '—'}
                      </td>
                    );
                  })}
                  <td className="attr-status"><span className="status-chip active">Active</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {matched > PAGE_SIZE && (
        <div className="attr-pager">
          <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
        </div>
      )}
    </>
  );
}
