/**
 * Required parents: the one place that says whether a record may exist without a parent.
 *
 * A relationship type marked required (metadata_register.relationship_types.is_required)
 * means: a record of the type's first entity type must be linked to a record of its second.
 * A Security needs an Issuer; a Deal Covenant needs a Deal. The web create form asked for
 * this, but nothing else did, so records made through the API, an import, a feed, the
 * assistant or a seed could skip it. Every writer now asks here before it creates a record.
 *
 * Two things the rule is deliberately loose about, because the stored data is:
 *  - any link to a record of the required entity type satisfies it, whichever relationship
 *    type or direction stored the link. Securities reach their issuer three ways today.
 *  - a type may name one boolean attribute that lifts the requirement
 *    (required_unless_attribute_code): a library covenant has no deal by design.
 *
 * The difference between entity types is data. This module names none of them.
 */


import { sharedOrClientFilter } from './input-guards';
export interface RelationshipTypeLike {
  relationship_code: string;
  parent_domain_code: string | null;
  child_domain_code: string | null;
  is_required?: boolean | null;
  required_unless_attribute_code?: string | null;
}

export interface RequiredParentRule {
  relationshipCode: string;
  /** The entity type that needs the parent. */
  domainCode: string;
  /** The entity type it must be linked to. */
  requiredDomainCode: string;
  /** A boolean attribute that, when true on the record, lifts the requirement. */
  unlessAttributeCode: string | null;
}

const upper = (text: string | null | undefined) => (text || '').trim().toUpperCase();

/** The parents a record of this entity type must have, from the relationship types. */
export function requiredParentRules(types: readonly RelationshipTypeLike[], domainCode: string): RequiredParentRule[] {
  const domain = upper(domainCode);
  const seen = new Set<string>();
  const rules: RequiredParentRule[] = [];
  for (const type of types) {
    const required = upper(type.child_domain_code);
    if (!type.is_required || upper(type.parent_domain_code) !== domain || !required || required === domain) continue;
    if (seen.has(required)) continue;
    seen.add(required);
    rules.push({
      relationshipCode: type.relationship_code,
      domainCode: domain,
      requiredDomainCode: required,
      unlessAttributeCode: upper(type.required_unless_attribute_code) || null,
    });
  }
  return rules;
}

/** Whether an attribute value means yes. Values arrive as booleans, strings, or { value } objects. */
export function attributeIsTrue(raw: unknown): boolean {
  const value = raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
  if (value === true || value === 1) return true;
  return typeof value === 'string' && /^(true|t|yes|y|1)$/i.test(value.trim());
}

/** The required parents a record does not have, given the entity types of what it is linked to. */
export function unmetRequiredParents(
  rules: readonly RequiredParentRule[],
  linkedDomainCodes: Iterable<string | null | undefined>,
  attributes: Record<string, unknown> | null | undefined = null,
): RequiredParentRule[] {
  const linked = new Set([...linkedDomainCodes].map(upper).filter(Boolean));
  const values = new Map(Object.entries(attributes || {}).map(([code, value]) => [upper(code), value]));
  return rules.filter((rule) => {
    if (linked.has(rule.requiredDomainCode)) return false;
    if (rule.unlessAttributeCode && attributeIsTrue(values.get(rule.unlessAttributeCode))) return false;
    return true;
  });
}

const label = (code: string, names?: Record<string, string>) =>
  names?.[code] || code.toLowerCase().split('_').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');

/** What to tell the person, in one sentence, with what to do about it. */
export function requiredParentMessage(domainCode: string, unmet: readonly RequiredParentRule[], names?: Record<string, string>): string {
  const self = label(upper(domainCode), names);
  const needs = unmet.map((rule) => label(rule.requiredDomainCode, names));
  const opening = `${article(self) === 'an' ? 'An' : 'A'} ${self} needs`;
  if (needs.length === 1) return `${opening} ${article(needs[0])} ${needs[0]}. Link it to the ${needs[0]} it belongs to when you create it.`;
  return `${opening} ${needs.slice(0, -1).map((name) => `${article(name)} ${name}`).join(', ')} and ${article(needs[needs.length - 1])} ${needs[needs.length - 1]}. Link it to each when you create it.`;
}

export class RequiredParentError extends Error {
  readonly code = 'REQUIRED_PARENT_MISSING';
  constructor(message: string, readonly unmet: RequiredParentRule[]) {
    super(message);
    this.name = 'RequiredParentError';
  }
}

/** The part of a Supabase client these reads use. */
export interface RequiredParentClient {
  schema(name: string): { from(table: string): any };
  from(table: string): any;
}

/**
 * The relationship types that make a parent required for this entity type.
 * With a client, only the shared types and that client's own apply; without one,
 * every type the caller can read.
 */
export async function loadRequiredParentRules(supabase: RequiredParentClient, domainCode: string, clientId?: string): Promise<RequiredParentRule[]> {
  let query = supabase
    .schema('metadata_register')
    .from('relationship_types')
    .select('relationship_code, parent_domain_code, child_domain_code, is_required, required_unless_attribute_code')
    .eq('parent_domain_code', upper(domainCode))
    .eq('is_required', true)
    .eq('is_active', true);
  if (clientId) query = query.or(sharedOrClientFilter(clientId));
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return requiredParentRules((data || []) as RelationshipTypeLike[], domainCode);
}

/** The entity type of each record a new record is being linked to. */
export async function domainsOfRecords(supabase: RequiredParentClient, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const { data, error } = await supabase.from('entity_master').select('entity_id, domain_code').in('entity_id', unique.slice(offset, offset + 100));
    if (error) throw new Error(error.message);
    for (const row of (data || []) as Array<{ entity_id: string; domain_code: string }>) out.set(row.entity_id, row.domain_code);
  }
  return out;
}

/**
 * Refuse a record that would be created without a parent its entity type requires.
 * Call it before the record is written. `linkedEntityIds` are the records the new one is
 * being linked to in the same request, on either side of the link.
 */
export async function assertRequiredParents(
  supabase: RequiredParentClient,
  record: { domainCode: string; attributes?: Record<string, unknown> | null; linkedEntityIds: readonly string[] },
): Promise<void> {
  const rules = await loadRequiredParentRules(supabase, record.domainCode);
  if (rules.length === 0) return;
  const domains = await domainsOfRecords(supabase, record.linkedEntityIds);
  const unmet = unmetRequiredParents(rules, domains.values(), record.attributes);
  if (unmet.length) throw new RequiredParentError(requiredParentMessage(record.domainCode, unmet), unmet);
}
