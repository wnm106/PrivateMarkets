export type FeedColumnRole = 'identity' | 'name' | 'attribute' | 'parent_key';

export interface FeedAttributeColumn {
  column: string;
  attributeCode: string;
}

export interface FeedParentColumn {
  /** Column on this row whose value is the parent domain's identity code. */
  column: string;
  parentDomainCode: string;
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
}

export interface FeedMap {
  mapCode: string;
  sourceCode: string;
  name: string;
  description: string;
  asOfHintColumn?: string;
  rowFilter?: { column: string; equals: string };
  domains: FeedDomainSpec[];
  /** Per source column. Absent means the loader applies its built-in coercions. */
  transforms?: Record<string, ColumnTransform>;
}

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
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
}
