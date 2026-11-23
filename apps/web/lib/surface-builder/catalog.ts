/**
 * The platform catalog the Surface Builder reasons over, and the matching of a
 * prototype's labels to the attributes that already exist.
 *
 * Matching is deterministic so the model starts from real codes: it confirms,
 * corrects or rejects a candidate; it never invents a code that is not here.
 */
import type { FieldKind } from './prototype';

export interface CatalogAttribute {
  code: string;
  name: string;
  dataType: string;
  domainCode: string | null;
  description?: string | null;
  isDerived?: boolean;
  isTimeVarying?: boolean;
  listValues?: string[] | null;
  referenceDomainCode?: string | null;
}

export interface CatalogDomain {
  code: string;
  name: string;
  parentCode?: string | null;
  description?: string | null;
}

export interface CatalogRelationship {
  code: string;
  name: string;
  fromDomain?: string | null;
  toDomain?: string | null;
}

export interface CatalogTool {
  name: string;
  description: string;
  readOnly: boolean;
  args: string[];
}

export interface CatalogSkill {
  id: string;
  name: string;
  startsWhen: string;
  toolContext: string;
  writeTools: string[];
}

export interface CatalogSurface {
  code: string;
  name: string;
  domainCode?: string | null;
  description?: string | null;
  kind: 'catalog' | 'sdk' | 'experience';
}

export interface PlatformCatalog {
  domains: CatalogDomain[];
  attributes: CatalogAttribute[];
  relationships: CatalogRelationship[];
  tools: CatalogTool[];
  skills: CatalogSkill[];
  surfaces: CatalogSurface[];
  /** Parts of the catalog that could not be read, with the reason. */
  gaps: string[];
}

export interface AttributeCandidate {
  code: string;
  name: string;
  domainCode: string | null;
  dataType: string;
  score: number;
}

export interface LabelMatch {
  label: string;
  kind: FieldKind;
  sample?: string;
  where?: string;
  /** Best existing attributes, best first. Empty when nothing is close. */
  candidates: AttributeCandidate[];
  /** exact: a code or name equals the label. close: worth confirming. none: likely a new attribute or a derived figure. */
  verdict: 'exact' | 'close' | 'none';
  /** The data type the sample suggests, for a new attribute. */
  inferredType: string;
}

const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'to', 'in', 'on', 'for', 'by', 'at', 'per', 'vs', '#', 'no', 'total']);
const SYNONYMS: Record<string, string> = {
  amt: 'amount',
  nav: 'net asset value',
  irr: 'internal rate of return',
  moic: 'multiple',
  tvpi: 'total value paid in',
  dpi: 'distributions paid in',
  ltv: 'loan to value',
  ebitda: 'ebitda',
  pct: 'percent',
  '%': 'percent',
  qty: 'quantity',
  mv: 'market value',
  fv: 'fair value',
  dt: 'date',
  yr: 'year',
  ccy: 'currency',
  cur: 'currency',
  commit: 'commitment',
  committed: 'commitment',
  unfunded: 'unfunded',
  maturity: 'maturity',
  mat: 'maturity',
  coupon: 'coupon',
  spread: 'spread',
  sector: 'sector',
  industry: 'industry',
  name: 'name',
};

function words(text: string): string[] {
  const spaced = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_./\\()\[\]:,-]+/g, ' ')
    .toLowerCase();
  const out: string[] = [];
  for (const raw of spaced.split(/\s+/)) {
    if (!raw || STOP.has(raw)) continue;
    const mapped = SYNONYMS[raw] || raw;
    for (const part of mapped.split(' ')) if (part && !STOP.has(part)) out.push(stem(part));
  }
  return out;
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Similarity of two labels from 0 to 1: shared words, weighted to the shorter label. */
export function labelSimilarity(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  const setB = new Set(b);
  const shared = a.filter((word) => setB.has(word)).length;
  if (shared === 0) {
    const joinedA = a.join('');
    const joinedB = b.join('');
    return joinedA === joinedB ? 0.95 : 0;
  }
  const dice = (2 * shared) / (a.length + b.length);
  const cover = shared / Math.min(a.length, b.length);
  return Math.round(Math.min(0.97, dice * 0.6 + cover * 0.4) * 100) / 100;
}

/** The data type a sample value suggests. */
export function inferDataType(label: string, sample?: string): string {
  const value = (sample || '').trim();
  const name = label.toLowerCase();
  if (/%$/.test(value) || /\b(rate|yield|pct|percent|margin|ltv|irr|spread|coupon)\b/.test(name)) return 'PERCENTAGE';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value) || /\b(date|maturity|as of|closed|vintage)\b/.test(name)) return 'DATE';
  if (/^[-+(]?[$\u20ac\u00a3]/.test(value) || /\b(amount|value|nav|commitment|balance|cost|price|proceeds|ebitda|revenue|fee|cash)\b/.test(name)) return 'CURRENCY';
  if (/x$/i.test(value) || /\b(multiple|moic|tvpi|dpi|leverage|coverage)\b/.test(name)) return 'DECIMAL';
  if (/^[-+]?[\d,]+(\.\d+)?$/.test(value) || /\b(count|number|qty|quantity|shares|units)\b/.test(name)) return 'NUMBER';
  if (/\b(status|type|stage|rating|sector|industry|class|strategy|region|country|currency)\b/.test(name)) return 'LIST';
  if (/\b(is|has)\b/.test(name) || /^(yes|no|true|false)$/i.test(value)) return 'BOOLEAN';
  return 'TEXT';
}

/** Suggested attribute code for a new attribute: upper snake case of the label. */
export function suggestCode(label: string): string {
  return label
    .replace(/%/g, ' pct ')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 48) || 'NEW_ATTRIBUTE';
}

/**
 * Match each label to the attributes that already exist. Attributes of the
 * surface's own entity type, and its parents, rank ahead of others.
 */
export function matchLabels(
  labels: Array<{ label: string; kind: FieldKind; sample?: string; where?: string }>,
  catalog: Pick<PlatformCatalog, 'attributes' | 'domains'>,
  domainCode?: string | null,
): LabelMatch[] {
  const lineage = new Set<string>();
  let cursor = domainCode || null;
  for (let depth = 0; cursor && depth < 8; depth += 1) {
    lineage.add(cursor);
    cursor = catalog.domains.find((domain) => domain.code === cursor)?.parentCode || null;
  }

  return labels.map((item) => {
    const scored: AttributeCandidate[] = [];
    for (const attribute of catalog.attributes) {
      const byName = labelSimilarity(item.label, attribute.name);
      const byCode = labelSimilarity(item.label, attribute.code);
      let score = Math.max(byName, byCode);
      if (score < 0.5) continue;
      if (lineage.size > 0) {
        if (attribute.domainCode && lineage.has(attribute.domainCode)) score = Math.min(1, score + 0.05);
        else if (attribute.domainCode) score -= 0.08;
      }
      if (score < 0.5) continue;
      scored.push({
        code: attribute.code,
        name: attribute.name,
        domainCode: attribute.domainCode,
        dataType: attribute.dataType,
        score: Math.round(score * 100) / 100,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
    const candidates = scored.slice(0, 3);
    const best = candidates[0]?.score ?? 0;
    return {
      ...item,
      candidates,
      verdict: best >= 0.95 ? 'exact' : best >= 0.6 ? 'close' : 'none',
      inferredType: inferDataType(item.label, item.sample),
    };
  });
}

/** Tools whose name or description shares words with the text, best first. */
export function relatedTools(text: string, tools: CatalogTool[], limit = 12): CatalogTool[] {
  const want = new Set(words(text));
  if (want.size === 0) return [];
  return tools
    .map((tool) => {
      const have = new Set([...words(tool.name), ...words(tool.description).slice(0, 40)]);
      let shared = 0;
      for (const word of want) if (have.has(word)) shared += 1;
      return { tool, shared };
    })
    .filter((row) => row.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((row) => row.tool);
}
