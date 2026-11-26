/**
 * Population filters: reusable conditions that narrow which records a view reads.
 *
 * A filter's conditions are the rows the condition builder edits (the same ones
 * a rule has). Which records they select is decided by the database, in
 * compliance.entity_matches_condition_set, reached through reporting.grid.
 * This file only cleans a filter before it is saved.
 */

export const MAX_FILTER_CONDITIONS = 60;

export interface PopulationFilterInput {
  domainCode: string;
  filterName: string;
  /** Stable name an agent asks for. Letters, digits and _, starting with a letter. */
  populationCode?: string | null;
  description?: string | null;
  conditions: Array<Record<string, unknown>>;
}

export interface FilterValidationError {
  field: string;
  message: string;
  code: string;
}

const POPULATION_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const invalid = (field: string, message: string): FilterValidationError => ({ field, message, code: 'VALIDATION_ERROR' });

/** Clean a filter and list what is wrong with it. Lines with no attribute chosen are dropped. */
export function normalizePopulationFilter(raw: any): { value: PopulationFilterInput; errors: FilterValidationError[] } {
  const errors: FilterValidationError[] = [];
  const domainCode = text(raw?.domainCode);
  const filterName = text(raw?.filterName);
  if (!domainCode) errors.push(invalid('domainCode', 'Choose the entity type the filter belongs to.'));
  if (!filterName) errors.push(invalid('filterName', 'Give the filter a name.'));
  if (filterName.length > 200) errors.push(invalid('filterName', 'Keep the name under 200 characters.'));

  const populationCode = text(raw?.populationCode).toUpperCase().replace(/[\s-]+/g, '_');
  if (populationCode && !POPULATION_CODE.test(populationCode)) {
    errors.push(invalid('populationCode', 'A code is letters, digits and _, starting with a letter.'));
  }

  const rawConditions: any[] = Array.isArray(raw?.conditions) ? raw.conditions : [];
  const conditions = rawConditions.filter((c) => text(c?.attributeCode));
  if (conditions.length === 0) errors.push(invalid('conditions', 'Add at least one condition.'));
  if (conditions.length > MAX_FILTER_CONDITIONS) {
    errors.push(invalid('conditions', `A filter can have at most ${MAX_FILTER_CONDITIONS} conditions.`));
  }
  return {
    value: {
      domainCode,
      filterName,
      populationCode: populationCode || null,
      description: text(raw?.description) || null,
      conditions: conditions.slice(0, MAX_FILTER_CONDITIONS),
    },
    errors,
  };
}

const OPERATOR_WORDS: Record<string, string> = {
  equals: 'equals', not_equals: 'does not equal', gt: 'is greater than', gte: 'is at least', lt: 'is less than',
  lte: 'is at most', in: 'is one of', not_in: 'is not one of', is_null: 'is blank', is_not_null: 'is present',
};

/**
 * A population's conditions in words, for an agent or a person. Lines in one
 * group are joined as written (and / or); a record needs to match any one group.
 */
export function describeConditions(rows: Array<Record<string, any>>): string {
  const lines = (rows || []).filter((r) => r?.attributeCode)
    .sort((a, b) => (a.conditionGroup || 1) - (b.conditionGroup || 1) || (a.conditionOrder || 0) - (b.conditionOrder || 0));
  if (!lines.length) return 'Every record.';
  let out = '';
  lines.forEach((r, i) => {
    if (i > 0) out += lines[i - 1].conditionGroup !== r.conditionGroup ? '; OR ' : r.logicOperator === 'OR' ? ' or ' : ' and ';
    const hops: any[] = r.attributeDimension?.relationshipPath || [];
    const via = hops.length ? ` of the related record reached by ${hops.map((h) => `${h.relationshipCode} ${String(h.direction || 'UP').toUpperCase()}`).join(' then ')}` : '';
    const value = r.compareAttributeCode ? ` ${r.compareAttributeCode}` : r.value != null && r.value !== '' ? ` ${String(r.value)}` : '';
    out += `${r.attributeCode}${via} ${OPERATOR_WORDS[r.operator] || r.operator}${value}`;
  });
  return `${out}.`;
}

/** A certified population as an agent reads it. */
export interface CertifiedPopulation {
  populationCode: string;
  name: string;
  domainCode: string;
  description: string;
  definition: string;
  conditions: Array<Record<string, any>>;
  certifiedAt: string;
  certificationNote: string | null;
}

const POPULATION_COLUMNS = 'population_code, filter_name, domain_code, description, conditions, certified_at, certification_note';

function toCertified(row: any): CertifiedPopulation {
  return {
    populationCode: row.population_code,
    name: row.filter_name,
    domainCode: row.domain_code,
    description: row.description,
    definition: describeConditions(row.conditions || []),
    conditions: row.conditions || [],
    certifiedAt: row.certified_at,
    certificationNote: row.certification_note ?? null,
  };
}

/** The certified populations the caller can read (row security keeps each client to its own). */
export async function listCertifiedPopulations(supabase: any, domainCode?: string | null): Promise<CertifiedPopulation[]> {
  let query = supabase.from('population_filters').select(POPULATION_COLUMNS).not('certified_at', 'is', null).order('population_code');
  if (domainCode) query = query.eq('domain_code', domainCode);
  const { data, error } = await query;
  if (error) throw new Error(`Could not read populations: ${error.message}`);
  return (data || []).map(toCertified);
}

/**
 * One certified population by code. An unknown code and an uncertified one are
 * refused alike, so a draft definition is never used as if it were certified.
 */
export async function loadCertifiedPopulation(supabase: any, code: string): Promise<CertifiedPopulation> {
  const wanted = String(code || '').trim().toUpperCase();
  const { data, error } = await supabase.from('population_filters').select(POPULATION_COLUMNS).eq('population_code', wanted).maybeSingle();
  if (error) throw new Error(`Could not read populations: ${error.message}`);
  if (!data || !data.certified_at) {
    throw new Error(`No certified population "${code}". Call list_populations for the certified ones; do not substitute your own filter for a population.`);
  }
  return toCertified(data);
}
