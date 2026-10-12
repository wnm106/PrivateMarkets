/**
 * Data Query Engine
 *
 * Executes declarative "data query" specs stored with dashboards and narratives.
 * A spec describes WHAT to retrieve; the engine resolves it at view time against
 * whichever entity is being viewed plus the user's filter inputs.
 *
 * Execution is set-based in Postgres (`public.report_grid`, migration 00051):
 *  - bi-temporal (as-of date + knowledge date),
 *  - server-side filter / sort / paging / grouping,
 *  - group summaries use each attribute's own aggregation type,
 *  - SECURITY INVOKER, so the CALLER's tenancy / RLS applies.
 *
 * This module only validates specs, binds runtime parameters, and shapes results.
 * No SQL or code is ever stored or executed from a spec. No runtime dependencies.
 */

export type DataQueryAggregation =
  | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'COUNT_DISTINCT' | 'WEIGHTED_AVG';

export type DataQueryOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'contains' | 'startsWith' | 'between' | 'isNull' | 'notNull';

export interface DataQueryHop {
  /** Only follow relationships with this code (or relationship_type). Omit = any. */
  relationshipCode?: string;
  /** DOWN = move to children (current entities are parents). UP = move to parents. */
  direction: 'DOWN' | 'UP';
  /** Only keep targets of this entity type. Omit = any. */
  domainCode?: string;
  /** Follow this hop repeatedly (e.g. fund-of-funds). */
  recursive?: boolean;
  maxDepth?: number;
  /** Keep the entities this hop started from in its output (e.g. a fund AND its sub-funds). */
  includeStart?: boolean;
}

/**
 * A lookup exposes attributes of a RELATED entity on every row, addressed as "<alias>.<ATTRIBUTE>"
 * (e.g. "sec.INDUSTRY", "iss.RATING", "sec.entity_name") in select / filters / groupBy / orderBy / metrics.
 * Lookups can be chained with `from`. If several related entities exist, the one with the lowest
 * entity_code is used (so keep lookups to-one, e.g. position -> security -> issuer).
 */
export interface DataQueryLookup {
  alias: string;
  direction: 'UP' | 'DOWN';
  relationshipCode?: string;
  /** Entity type of the related entity (also drives the attribute list in the grid UI). */
  domainCode?: string;
  /** Alias of an earlier lookup to start from (chain). Omit = start from each row's entity. */
  from?: string;
  /** Display prefix for column names, e.g. "Security". */
  label?: string;
}

export interface DataQueryFilter {
  /** Built-in field (entity_code, entity_name, domain_code) or an attribute code. */
  field: string;
  op: DataQueryOperator;
  value?: any;
  /**
   * Bind to a runtime parameter (dashboard/narrative filter input).
   * If the parameter has no value the filter is skipped (so filters are optional
   * by default) unless `required` is true. `value` acts as the default.
   */
  param?: string;
  required?: boolean;
}

export interface DataQueryMetric {
  alias: string;
  agg: DataQueryAggregation;
  /** Attribute / built-in field to aggregate. Optional for COUNT. */
  field?: string;
  /** For WEIGHTED_AVG. */
  weightField?: string;
}

export interface DataQuerySpec {
  /** Unique name; the HTML (data[key]) or narrative prompt refers to results by it. */
  key: string;
  label?: string;
  description?: string;
  /** CONTEXT = begin at the entity being viewed. DOMAIN = begin with all entities of `domainCode`. */
  start: 'CONTEXT' | 'DOMAIN';
  /** Required for DOMAIN. For CONTEXT it restricts the final result to that entity type. */
  domainCode?: string;
  /** Relationship traversal from the starting set. */
  path?: DataQueryHop[];
  /** Also include the starting entity itself in the result (CONTEXT with a path). */
  includeAnchor?: boolean;
  /** Related-entity attributes available as "<alias>.<ATTRIBUTE>" fields. */
  lookups?: DataQueryLookup[];
  filters?: DataQueryFilter[];
  groupBy?: string[];
  metrics?: DataQueryMetric[];
  /** Row mode only: attribute columns to return. Omit = identifiers + the first attributes of the entity type. */
  select?: string[];
  orderBy?: Array<{ field: string; dir?: 'asc' | 'desc' }>;
  limit?: number;
  /**
   * Presentation hint: render this query as an interactive host data grid
   * (paging, filtering, grouping with summary rows) instead of passing rows into the HTML.
   */
  grid?: boolean;
}

export interface DataQueryParams {
  [name: string]: any;
}

export interface DataQueryColumn {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
}

export interface DataQueryResult {
  key: string;
  label?: string;
  mode: 'rows' | 'aggregate';
  columns: DataQueryColumn[];
  rows: Array<Record<string, any>>;
  /** Number of entities that matched the filters. */
  matched: number;
  /** Number of result rows available (entities in row mode, groups in aggregate mode). */
  total: number;
  /** True when more result rows exist than were returned (see `total`). */
  truncated: boolean;
  /** Summary row over all matched entities, using each attribute's aggregation type (row mode). */
  summary?: Record<string, any> | null;
  error?: string;
}

export interface DataQueryRunContext {
  entityId?: string | null;
  entityCode?: string | null;
  params?: DataQueryParams;
  /** Valid-time "as of" date (YYYY-MM-DD). Defaults to params.asOfDate, then today. */
  asOfDate?: string | null;
  /** System-time "as known on" timestamp. Defaults to now. */
  knowledgeDate?: string | null;
}

export interface DataQueryResponse {
  anchor: Record<string, any> | null;
  results: Record<string, DataQueryResult>;
  warnings: string[];
  asOfDate?: string | null;
}

export const DEFAULT_ROW_LIMIT = 100;
/** Max rows per (non-export) request; larger sets must be paged. */
export const MAX_ROW_LIMIT = 500;
const DEFAULT_COLUMN_COUNT = 25;

// ---------------------------------------------------------------------------
// Public documentation string (fed to the AI design assistant)
// ---------------------------------------------------------------------------
export const DATA_QUERY_SPEC_DOC = `
A data query is a JSON object. A dashboard/narrative holds an array of them.

{
  "key": "positions_by_industry",      // unique name. Dashboard HTML reads data.<key>
  "label": "Positions by industry",
  "start": "CONTEXT" | "DOMAIN",        // CONTEXT = start at the entity being viewed; DOMAIN = all entities of domainCode
  "domainCode": "POSITION",             // DOMAIN: required. CONTEXT: keep only this entity type at the end of the path
  "path": [                             // optional relationship traversal (CONTEXT or DOMAIN start)
    { "direction": "DOWN",              // DOWN = to children, UP = to parents
      "relationshipCode": "POSITION_FUND", // optional, omit for any relationship
      "domainCode": "POSITION",         // optional target type filter
      "recursive": false, "maxDepth": 5,
      "includeStart": false }           // true = keep the entities the hop started from (e.g. a fund AND its sub-funds)
  ],
  "includeAnchor": false,               // also include the starting entity
  "lookups": [                          // optional: expose attributes of RELATED entities as "<alias>.<ATTRIBUTE>"
    { "alias": "sec", "direction": "UP", "relationshipCode": "POSITION_SECURITY", "domainCode": "SECURITY", "label": "Security" },
    { "alias": "iss", "from": "sec", "direction": "UP", "relationshipCode": "SECURITY_ISSUER", "domainCode": "ISSUER", "label": "Issuer" }  // chained
  ],
  "filters": [                          // AND-ed
    { "field": "STATUS", "op": "eq", "value": "ACTIVE" },
    { "field": "INDUSTRY", "op": "in", "param": "industries" },   // bound to a user filter input
    { "field": "MARKET_VALUE", "op": "gte", "param": "minValue", "value": 0 } // value = default
  ],
  "groupBy": ["INDUSTRY"],              // optional -> aggregate mode (any attribute)
  "metrics": [                          // optional -> aggregate mode
    { "alias": "total_mv", "agg": "SUM", "field": "MARKET_VALUE" },
    { "alias": "n", "agg": "COUNT" },
    { "alias": "wavg_yield", "agg": "WEIGHTED_AVG", "field": "YIELD", "weightField": "MARKET_VALUE" }
  ],
  "select": ["entity_code", "entity_name", "MARKET_VALUE"],  // row mode only: columns to return
  "orderBy": [{ "field": "total_mv", "dir": "desc" }],
  "limit": 100,                          // default 100, max 500 per request
  "grid": true                           // optional: show as an interactive host data grid
}

Fields: either a built-in (entity_code, entity_name, domain_code), an attribute_code of the entities being queried, or - with "lookups" -
a RELATED entity's attribute as "<alias>.<ATTRIBUTE_CODE>" (e.g. "sec.INDUSTRY", "iss.RATING", "sec.entity_name"). Related fields work everywhere a
field does: select, filters, groupBy (grouping positions by their security's industry), orderBy, metrics, and in the grid UI. Lookups should be to-one
relationships (each row has one security / one issuer); with several related entities the lowest entity_code is used. Lookups are resolved as of the as-of date.
Operators: eq neq gt gte lt lte in nin contains startsWith between isNull notNull.
Aggregations: SUM AVG MIN MAX COUNT COUNT_DISTINCT WEIGHTED_AVG.
A filter with "param" is skipped when the user has not supplied that input (unless "required": true).
Built-in params always available: entityId, entityCode, asOfDate (valid-time as-of date; relationships AND attribute values are evaluated as of that date).
Result of a query: { columns, rows: [ {col: value} ], matched, total, truncated, summary }.
- Row mode: rows are entities; "summary" aggregates every matched entity using each attribute's own aggregation type (sum, avg, min, max, weighted avg).
- Aggregate mode (groupBy and/or metrics): one row per group.
- Large sets (thousands of rows) are paged server-side: results are never silently cut, "total" is the exact size and "truncated" tells you rows were paged.
  Prefer aggregate mode (or "grid": true for people to browse/group/filter) over pulling thousands of rows into the HTML.
Parameters (user filter inputs) are declared separately: [{ "name": "industries", "label": "Industries", "type": "text"|"number"|"date"|"select"|"boolean", "options": ["A","B"], "default": ... }].
`.trim();

// ---------------------------------------------------------------------------
// Grid request / result (the server-side contract of public.report_grid)
// ---------------------------------------------------------------------------

export interface GridRequest {
  start: 'CONTEXT' | 'DOMAIN';
  domainCode?: string | null;
  contextEntityId?: string | null;
  path?: DataQueryHop[];
  includeAnchor?: boolean;
  lookups?: DataQueryLookup[];
  asOfDate?: string | null;
  knowledgeDate?: string | null;
  filters?: Array<{ field: string; op: DataQueryOperator; value?: any }>;
  columns?: string[];
  sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>;
  groupBy?: string[];
  /** Keys of already-expanded parent groups (drill-down), aligned with groupBy. */
  groupKeys?: any[];
  metrics?: DataQueryMetric[];
  flat?: boolean;
  offset?: number;
  limit?: number;
  export?: boolean;
}

export interface GridColumnMeta {
  code: string;
  name?: string;
  kind?: string;
  aggregation?: string;
  weight?: string | null;
  unit?: string | null;
  precision?: number | null;
}

export interface GridResult {
  mode: 'rows' | 'groups' | 'aggregate';
  level?: number;
  groupField?: string | null;
  total: number;
  matched: number;
  rows: Array<Record<string, any>>;
  summary?: Record<string, any> | null;
  columns: GridColumnMeta[];
  groupBy: string[];
  asOfDate?: string;
  knowledgeDate?: string;
  entityCount?: number;
}

/** Calls the set-based SQL grid as the caller (RLS applies). Throws on error. */
export async function runGrid(supabase: any, request: GridRequest): Promise<GridResult> {
  const { data, error } = await supabase.rpc('report_grid', { p_request: request });
  if (error) throw new Error(cleanDbError(error.message));
  return data as GridResult;
}

function cleanDbError(message: string): string {
  return String(message || 'Query failed').replace(/^.*?(Unknown attribute|Unknown field|Invalid number|Invalid date|Unsupported operator|A filter value|Each filter|between needs|Metric|groupKeys)/, '$1');
}

/** Attribute catalog (code + aggregation info) for an entity type; used for default columns and the grid UI. */
export async function getAttributeCatalog(supabase: any, domainCode?: string | null): Promise<any[]> {
  const { data, error } = await supabase.rpc('get_attributes_with_aggregation', { p_domain_code: domainCode || null });
  if (error) throw new Error(`Failed to load attribute catalog: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDataQueries(
  supabase: any,
  specs: DataQuerySpec[],
  ctx: DataQueryRunContext = {}
): Promise<DataQueryResponse> {
  const warnings: string[] = [];
  const results: Record<string, DataQueryResult> = {};
  const params: DataQueryParams = { ...(ctx.params || {}) };

  let anchorRow: any = null;
  if (ctx.entityId || ctx.entityCode) {
    anchorRow = await fetchAnchor(supabase, ctx.entityId, ctx.entityCode);
    if (!anchorRow) warnings.push('The context entity could not be found or is not accessible.');
  }
  if (anchorRow) {
    params.entityId = params.entityId ?? anchorRow.entity_id;
    params.entityCode = params.entityCode ?? anchorRow.entity_code;
  }

  const asOfDate = normalizeDate(ctx.asOfDate ?? params.asOfDate);
  const knowledgeDate = ctx.knowledgeDate || params.knowledgeDate || null;
  if (asOfDate) params.asOfDate = asOfDate;

  const catalogCache = new Map<string, any[]>();
  const list = Array.isArray(specs) ? specs : [];

  for (const spec of list) {
    const key = spec?.key || `query_${Object.keys(results).length + 1}`;
    try {
      results[key] = await runOne(supabase, { ...spec, key }, anchorRow, params, asOfDate, knowledgeDate, catalogCache);
    } catch (err: any) {
      results[key] = {
        key,
        label: spec?.label,
        mode: 'rows',
        columns: [],
        rows: [],
        matched: 0,
        total: 0,
        truncated: false,
        error: err?.message || String(err),
      };
    }
  }

  return { anchor: anchorRow ? summarizeAnchor(anchorRow) : null, results, warnings, asOfDate };
}

function normalizeDate(v: any): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

async function fetchAnchor(supabase: any, id?: string | null, code?: string | null) {
  let q = supabase.from('entity_master').select('*');
  if (id) q = q.eq('entity_id', id);
  else if (code) q = q.eq('entity_code', code);
  else return null;
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`Failed to load context entity: ${error.message}`);
  return data?.[0] || null;
}

/** Resolves an entity id from id or code (as the caller). */
export async function resolveEntityId(supabase: any, id?: string | null, code?: string | null): Promise<string | null> {
  if (id) return id;
  if (!code) return null;
  const row = await fetchAnchor(supabase, null, code);
  return row?.entity_id ?? null;
}

function summarizeAnchor(row: any) {
  return {
    entityId: row.entity_id,
    entityCode: row.entity_code,
    entityName: row.entity_name,
    domainCode: row.domain_code,
    domainName: row.domain_name,
    templateName: row.template_name,
    description: row.description,
    attributes: flattenAttributes(row),
  };
}

function flattenAttributes(row: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [code, v] of Object.entries(row.attributes || {})) out[code] = attrValue(v);
  return out;
}

function attrValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return coerceNumeric(v);
  if (v.value_numeric !== null && v.value_numeric !== undefined) return Number(v.value_numeric);
  if (v.value_date) return v.value_date;
  if (v.value_timestamp) return v.value_timestamp;
  return coerceNumeric(v.value ?? null);
}

function coerceNumeric(v: any): any {
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
}

// ---------------------------------------------------------------------------
// Parameter binding
// ---------------------------------------------------------------------------

/**
 * Resolves `param` bindings. Filters whose parameter has no value are dropped
 * (unless required). Returns only the fields the SQL grid needs.
 */
export function bindFilters(
  filters: DataQueryFilter[] | undefined,
  params: DataQueryParams
): Array<{ field: string; op: DataQueryOperator; value?: any }> {
  const out: Array<{ field: string; op: DataQueryOperator; value?: any }> = [];
  for (const f of filters || []) {
    if (!f || !f.field || !f.op) continue;
    let value = f.value;
    if (f.param) {
      const p = params[f.param];
      const empty = p === undefined || p === null || p === '' || (Array.isArray(p) && p.length === 0);
      if (!empty) value = p;
      else if (value === undefined && f.op !== 'isNull' && f.op !== 'notNull') {
        if (f.required) throw new Error(`Required parameter "${f.param}" was not supplied`);
        continue; // optional filter, no input -> skipped
      }
    }
    out.push({ field: f.field, op: f.op, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/** Translates a stored spec + runtime context into a grid request. */
export function specToGridRequest(
  spec: DataQuerySpec,
  anchorEntityId: string | null,
  params: DataQueryParams,
  asOfDate: string | null,
  knowledgeDate: string | null
): GridRequest {
  if (spec.start === 'DOMAIN' && !spec.domainCode) throw new Error('start=DOMAIN requires domainCode');
  if (spec.start === 'CONTEXT' && !anchorEntityId) throw new Error('start=CONTEXT requires an entity context (none supplied).');
  const aggregate = (spec.metrics && spec.metrics.length > 0);
  const limit = clamp(spec.limit ?? DEFAULT_ROW_LIMIT, 1, MAX_ROW_LIMIT);
  return {
    start: spec.start,
    domainCode: spec.domainCode || null,
    contextEntityId: spec.start === 'CONTEXT' ? anchorEntityId : null,
    path: spec.path || [],
    includeAnchor: !!spec.includeAnchor,
    lookups: spec.lookups || [],
    asOfDate,
    knowledgeDate,
    filters: bindFilters(spec.filters, params),
    sort: spec.orderBy || [],
    groupBy: spec.groupBy || [],
    metrics: spec.metrics || [],
    // groupBy without metrics in a spec = flat aggregate (counts per group)
    flat: !!(spec.groupBy && spec.groupBy.length > 0) || aggregate,
    columns: spec.select ? spec.select.filter((c) => !['entity_id', 'entity_code', 'entity_name', 'domain_code'].includes(c)) : undefined,
    offset: 0,
    limit,
  };
}

async function runOne(
  supabase: any,
  spec: DataQuerySpec,
  anchorRow: any,
  params: DataQueryParams,
  asOfDate: string | null,
  knowledgeDate: string | null,
  catalogCache: Map<string, any[]>
): Promise<DataQueryResult> {
  const req = specToGridRequest(spec, anchorRow?.entity_id ?? null, params, asOfDate, knowledgeDate);
  const isAggregate = !!req.flat;

  // Row mode without an explicit select: identifiers + the first attributes of the entity type.
  if (!isAggregate && !spec.select) {
    const lastHop = (spec.path || [])[ (spec.path || []).length - 1 ];
    const domain = spec.domainCode || lastHop?.domainCode || null;
    const cacheKey = domain || '*';
    if (!catalogCache.has(cacheKey)) catalogCache.set(cacheKey, await getAttributeCatalog(supabase, domain));
    req.columns = (catalogCache.get(cacheKey) || [])
      .filter((a) => a.is_visible !== false)
      .slice(0, DEFAULT_COLUMN_COUNT)
      .map((a) => a.attribute_code);
  }

  const res = await runGrid(supabase, req);
  const rows = res.rows || [];

  if (isAggregate) {
    const names = [...(req.groupBy || []), ...(req.metrics && req.metrics.length ? req.metrics.map((m) => m.alias) : ['count'])];
    return {
      key: spec.key,
      label: spec.label,
      mode: 'aggregate',
      columns: names.map((name, i) => ({
        name,
        type: i < (req.groupBy || []).length ? guessType(rows.map((r) => r[name])) : 'number',
      })),
      rows,
      matched: res.matched,
      total: res.total,
      truncated: res.total > rows.length,
    };
  }

  const names = ['entity_id', 'entity_code', 'entity_name', 'domain_code', ...(req.columns || [])];
  return {
    key: spec.key,
    label: spec.label,
    mode: 'rows',
    columns: names.map((name) => ({ name, type: guessType(rows.map((r) => r[name])) })),
    rows,
    matched: res.matched,
    total: res.total,
    truncated: res.total > rows.length,
    summary: res.summary ?? null,
  };
}

function guessType(values: any[]): DataQueryColumn['type'] {
  const v = values.find((x) => x !== null && x !== undefined);
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
  return 'string';
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

// ---------------------------------------------------------------------------
// Validation (cheap structural check used by the designer + AI tools)
// ---------------------------------------------------------------------------

export function validateDataQueries(specs: any): string[] {
  const errors: string[] = [];
  if (!Array.isArray(specs)) return ['dataQueries must be an array'];
  const keys = new Set<string>();
  specs.forEach((s, i) => {
    const where = `query[${i}]${s?.key ? ` (${s.key})` : ''}`;
    if (!s || typeof s !== 'object') return errors.push(`${where}: must be an object`);
    if (!s.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.key)) errors.push(`${where}: "key" must be an identifier (letters, digits, _)`);
    else if (keys.has(s.key)) errors.push(`${where}: duplicate key`);
    else keys.add(s.key);
    if (s.start !== 'CONTEXT' && s.start !== 'DOMAIN') errors.push(`${where}: "start" must be CONTEXT or DOMAIN`);
    if (s.start === 'DOMAIN' && !s.domainCode) errors.push(`${where}: DOMAIN start requires domainCode`);
    (s.path || []).forEach((h: any, j: number) => {
      if (h.direction !== 'DOWN' && h.direction !== 'UP') errors.push(`${where}.path[${j}]: direction must be DOWN or UP`);
    });
    const aliases = new Set<string>();
    (s.lookups || []).forEach((l: any, j: number) => {
      if (!l?.alias || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(l.alias)) errors.push(`${where}.lookups[${j}]: alias must be an identifier`);
      else if (aliases.has(l.alias)) errors.push(`${where}.lookups[${j}]: duplicate alias`);
      if (l?.direction !== 'DOWN' && l?.direction !== 'UP') errors.push(`${where}.lookups[${j}]: direction must be DOWN or UP`);
      if (l?.from && !aliases.has(l.from)) errors.push(`${where}.lookups[${j}]: "from" must be an earlier lookup alias`);
      if (l?.alias) aliases.add(l.alias);
    });
    (s.metrics || []).forEach((m: any, j: number) => {
      if (!m.alias) errors.push(`${where}.metrics[${j}]: alias required`);
      if (!['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT', 'WEIGHTED_AVG'].includes(m.agg)) errors.push(`${where}.metrics[${j}]: invalid agg`);
      if (m.agg !== 'COUNT' && m.agg !== 'COUNT_DISTINCT' && !m.field) errors.push(`${where}.metrics[${j}]: field required for ${m.agg}`);
      if (m.agg === 'WEIGHTED_AVG' && !m.weightField) errors.push(`${where}.metrics[${j}]: weightField required`);
    });
    (s.filters || []).forEach((f: any, j: number) => {
      if (!f.field || !f.op) errors.push(`${where}.filters[${j}]: field and op required`);
    });
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Compact representation for LLM prompts
// ---------------------------------------------------------------------------

export function summarizeResultsForLLM(response: DataQueryResponse, maxRowsPerQuery = 60): any {
  const out: Record<string, any> = {};
  for (const [key, r] of Object.entries(response.results)) {
    out[key] = {
      label: r.label,
      mode: r.mode,
      columns: r.columns.map((c) => c.name),
      matchedEntities: r.matched,
      totalRows: r.total,
      rowsShown: Math.min(r.rows.length, maxRowsPerQuery),
      truncated: r.total > Math.min(r.rows.length, maxRowsPerQuery),
      // exact summary over ALL matched entities (not just the rows shown)
      summaryOverAllMatched: r.summary ?? undefined,
      error: r.error,
      rows: r.rows.slice(0, maxRowsPerQuery),
    };
  }
  return { entity: response.anchor, asOfDate: response.asOfDate, datasets: out, warnings: response.warnings };
}
