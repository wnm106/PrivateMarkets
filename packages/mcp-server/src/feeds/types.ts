export type FeedColumnRole = 'identity' | 'name' | 'attribute' | 'parent_key';

export interface FeedAttributeColumn {
  column: string;
  attributeCode: string;
}

export interface FeedParentColumn {
  /** Column on this row whose value is the parent domain's identity code. */
  column: string;
  parentDomainCode: string;
  /**
   * The parent is already in the system. Load order does not wait for it,
   * and the loader resolves the code from stored entities.
   */
  existing?: boolean;
}

export interface FeedDomainSpec {
  domainCode: string;
  templateCode: string;
  identityColumn: string;
  nameColumn: string;
  attributes: FeedAttributeColumn[];
  parents: FeedParentColumn[];
}

/**
 * A column map for one source. Parent dependencies live on each domain's
 * `parents` list. Load order is derived from those edges; relationship
 * catalog direction is only used when writing the relationship row.
 */
export type TransformKind = 'none' | 'trim' | 'number' | 'percent' | 'date' | 'uppercase' | 'lowercase' | 'list' | 'replace';

export interface ColumnTransform {
  kind: TransformKind;
  find?: string;
  replaceWith?: string;
  /** Source text replaced before the transform runs. `to` is the value that gets stored. */
  values?: { from: string; to: string }[];
}

export interface FeedMap {
  mapCode: string;
  sourceCode: string;
  name: string;
  description: string;
  asOfHintColumn?: string;
  /** Column whose values are source codes. A blank cell uses the file source. */
  sourceHintColumn?: string;
  rowFilter?: { column: string; equals: string };
  domains: FeedDomainSpec[];
  /** Per source column. Absent means the loader applies its built-in coercions. */
  transforms?: Record<string, ColumnTransform>;
}

/**
 * Where a value sits on a page of the original document. Points, measured from
 * the top left of the page. `precision` says how tight the box is: the value
 * itself, the row it is in, or only the table that holds it.
 */
export interface CellLocation {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  precision: 'cell' | 'row' | 'table';
}

export interface PageSize {
  page: number;
  width: number;
  height: number;
}

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
  /** Same shape as `rows` by `headers`. Present for tables read from a document. */
  locations?: (CellLocation | null)[][];
  pages?: PageSize[];
}

export interface NormalizationHit {
  attributeCode: string;
  listCode: string;
  input: string;
  canonicalCode: string | null;
  canonicalLabel: string | null;
  matchType: 'exact_code' | 'exact_label' | 'synonym' | 'unmapped';
}

export interface DomainPreview {
  domainCode: string;
  templateCode: string;
  identityColumn: string;
  nameColumn: string;
  distinctEntities: number;
  attributeColumns: { column: string; attributeCode: string }[];
  parentColumns: { column: string; parentDomainCode: string; relationshipCode: string | null }[];
}

export interface FeedPreview {
  mapCode: string;
  sourceCode: string;
  fileName: string;
  rowCount: number;
  headers: string[];
  loadWaves: string[][];
  domains: DomainPreview[];
  unmappedColumns: string[];
  contextColumns: { column: string; purpose: string }[];
  suggestedAsOfDate: string | null;
  normalizations: NormalizationHit[];
  warnings: string[];
}

export interface DomainLoadStats {
  domainCode: string;
  distinctEntities: number;
  created: number;
  matched: number;
  failed: number;
  errors: string[];
}

export interface LoadReject {
  kind: 'record' | 'value' | 'link';
  domainCode: string;
  entityCode: string;
  attributeCode?: string;
  value?: string;
  message: string;
  /** Row in the source table, starting at 0, and the column it came from. */
  row?: number;
  column?: string;
}

export interface FeedLoadResult {
  mapCode: string;
  sourceCode: string;
  asOfDate: string;
  fileName: string;
  rowCount: number;
  loadWaves: string[][];
  domains: DomainLoadStats[];
  relationships: { created: number; matched: number; failed: number };
  attributes: { created: number; updated: number; unchanged: number };
  normalizations: NormalizationHit[];
  warnings: string[];
  errors: string[];
  /** True when nothing was written. The counts say what a real load would do. */
  dryRun?: boolean;
  /** Rows or values that were skipped or refused, capped at 500. */
  rejects?: LoadReject[];
  rejectCount?: number;
}
