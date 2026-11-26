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
  description?: string | null;
  conditions: Array<Record<string, unknown>>;
}

export interface FilterValidationError {
  field: string;
  message: string;
  code: string;
}

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
      description: text(raw?.description) || null,
      conditions: conditions.slice(0, MAX_FILTER_CONDITIONS),
    },
    errors,
  };
}
