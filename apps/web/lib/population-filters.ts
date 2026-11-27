/**
 * Population filters: conditions that narrow which records a view reads.
 *
 * A filter is the same conditions a rule has, edited by the same condition
 * builder, over the same entity tree as the view (paths follow relationships
 * from the view's entity type). Which records they select is decided in the
 * database by compliance.entity_matches_condition_set, through the grid's
 * populationConditions. Nothing is matched here.
 *
 * A view can open with a saved filter. In the table, the filter can be changed
 * for this visit only (a "working filter"), or replaced by one built on the
 * spot, without touching the saved one.
 */
import { dimensionFromDto, dimensionToInput } from './condition-dimension';
import type { ComplianceCondition } from '@/components/forms/ComplianceRuleForm';

export interface PopulationFilter {
  id: string;
  domainCode: string;
  filterName: string;
  /** What an agent passes to ask for this population. */
  populationCode?: string | null;
  description?: string | null;
  /** Condition rows as the condition builder sends them (see conditionsToInput). */
  conditions: PopulationConditionInput[];
  /** Set when an administrator certified it. Cleared by the database when the definition changes. */
  certifiedAt?: string | null;
  certificationNote?: string | null;
  updatedAt?: string | null;
}

export type PopulationConditionInput = Record<string, any>;

export type PopulationFilterDraft = {
  id?: string | null;
  domainCode: string;
  filterName: string;
  description?: string | null;
  conditions: PopulationConditionInput[];
};

const FILTER_FIELDS = 'id domainCode filterName populationCode description conditions certifiedAt certificationNote updatedAt';

export const POPULATION_FILTERS_QUERY = `
  query PopulationFilters($domainCode: String!) {
    populationFilters(domainCode: $domainCode) { ${FILTER_FIELDS} }
  }
`;

export const SAVE_POPULATION_FILTER_MUTATION = `
  mutation SavePopulationFilter($id: ID, $input: PopulationFilterInput!) {
    savePopulationFilter(id: $id, input: $input) {
      filter { ${FILTER_FIELDS} }
      errors { field message code }
    }
  }
`;

export const CERTIFY_POPULATION_FILTER_MUTATION = `
  mutation CertifyPopulationFilter($id: ID!, $note: String) {
    certifyPopulationFilter(id: $id, note: $note) {
      filter { ${FILTER_FIELDS} }
      errors { field message code }
    }
  }
`;

export const WITHDRAW_POPULATION_CERTIFICATION_MUTATION = `
  mutation WithdrawPopulationCertification($id: ID!) {
    withdrawPopulationCertification(id: $id) {
      filter { ${FILTER_FIELDS} }
      errors { field message code }
    }
  }
`;

/** A code an agent can pass, from a name: "Active EU funds" becomes ACTIVE_EU_FUNDS. */
export function suggestPopulationCode(name: string): string {
  const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Z]/.test(code) ? code.slice(0, 80) : '';
}

export const DELETE_POPULATION_FILTER_MUTATION = `
  mutation DeletePopulationFilter($id: ID!) {
    deletePopulationFilter(id: $id) { success errors { field message code } }
  }
`;

const picked = (code?: string) => !!code && code !== '__PICK__';

/** The conditions the builder edits, as the API stores and matches them. Lines with no attribute are left out. */
export function conditionsToInput(conditions: ComplianceCondition[]): PopulationConditionInput[] {
  return conditions
    .filter((c) => c.attributeCode)
    .map((c, index) => {
      const compare = picked(c.compareAttributeCode);
      let value: string | undefined = c.rightExpression ? undefined : (c.value || '').trim() || undefined;
      if (compare || c.operator === 'is_null' || c.operator === 'is_not_null') value = undefined;
      else if (value && (c.operator === 'in' || c.operator === 'not_in') && !value.startsWith('[')) {
        value = JSON.stringify(value.split(',').map((part) => part.trim()).filter(Boolean));
      }
      return {
        appliesTo: 'BASE',
        conditionGroup: c.conditionGroup,
        conditionOrder: index + 1,
        attributeCode: c.attributeCode,
        attributeDimension: dimensionToInput(c.attributeDimension, c.attributePath),
        operator: c.operator,
        value,
        leftExpression: c.leftExpression || undefined,
        rightExpression: c.rightExpression || undefined,
        compareAttributeCode: compare ? c.compareAttributeCode : undefined,
        compareDimension: compare ? dimensionToInput(c.compareDimension, c.compareAttributePath) : undefined,
        logicOperator: c.logicOperator,
      };
    });
}

/** Stored conditions back into the rows the builder edits. */
export function conditionsFromInput(rows: PopulationConditionInput[]): ComplianceCondition[] {
  const hops = (dim: any) => (dim?.relationshipPath || []).map((hop: any) => ({
    relationshipCode: hop.relationshipCode,
    direction: String(hop.direction || 'UP').toUpperCase() as 'UP' | 'DOWN',
  }));
  return (rows || []).map((row, index) => ({
    appliesTo: 'BASE',
    conditionGroup: row.conditionGroup || 1,
    conditionOrder: row.conditionOrder || index + 1,
    attributeCode: row.attributeCode || '',
    attributePath: hops(row.attributeDimension),
    attributeDimension: dimensionFromDto(row.attributeDimension),
    operator: row.operator || 'equals',
    value: row.value ?? '',
    compareAttributeCode: row.compareAttributeCode || '',
    compareAttributePath: hops(row.compareDimension),
    compareDimension: dimensionFromDto(row.compareDimension),
    leftExpression: row.leftExpression || null,
    rightExpression: row.rightExpression || null,
    logicOperator: row.logicOperator === 'OR' ? 'OR' : 'AND',
  }));
}

/** Whether two sets of conditions say the same thing, for "changed from the saved filter". */
export function sameConditions(a: PopulationConditionInput[], b: PopulationConditionInput[]): boolean {
  const stable = (value: unknown): unknown => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as object).filter(([, v]) => v !== undefined && v !== null).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, stable(v)]))
      : value;
  return JSON.stringify(stable(a || [])) === JSON.stringify(stable(b || []));
}

/** The first thing a person needs to see about a filter: what it asks, in a line. */
export function filterSummary(rows: PopulationConditionInput[], nameOf: (code: string) => string = (c) => c): string {
  const OPS: Record<string, string> = {
    equals: '=', not_equals: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', not_in: 'not in', is_null: 'is blank', is_not_null: 'is present',
  };
  const lines = rows.filter((r) => r.attributeCode);
  if (!lines.length) return 'No conditions';
  return lines.map((r, i) => {
    const join = i === 0 ? '' : `${r.conditionGroup && r.conditionGroup !== lines[i - 1].conditionGroup ? ' OR ' : r.logicOperator === 'OR' ? ' or ' : ' and '}`;
    const through = (r.attributeDimension?.relationshipPath || []).length ? ' (related)' : '';
    const val = r.value != null && r.value !== '' ? ` ${String(r.value).replace(/^\[|\]$/g, '').replace(/"/g, '')}` : r.compareAttributeCode ? ` ${nameOf(r.compareAttributeCode)}` : '';
    return `${join}${nameOf(r.attributeCode)}${through} ${OPS[r.operator] || r.operator}${val}`;
  }).join('');
}

