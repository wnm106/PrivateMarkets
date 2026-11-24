import { describe, expect, it } from 'vitest';
import {
  RequiredParentError,
  assertRequiredParents,
  attributeIsTrue,
  requiredParentMessage,
  requiredParentRules,
  unmetRequiredParents,
  type RelationshipTypeLike,
  type RequiredParentClient,
} from './required-parents';

const TYPES: RelationshipTypeLike[] = [
  { relationship_code: 'SECURITY_ISSUER', parent_domain_code: 'SECURITY', child_domain_code: 'ISSUER', is_required: true },
  { relationship_code: 'ISSUER_SECURITY', parent_domain_code: 'ISSUER', child_domain_code: 'SECURITY', is_required: false },
  { relationship_code: 'COVENANT_DEAL', parent_domain_code: 'DEAL_COVENANT', child_domain_code: 'DEAL', is_required: true, required_unless_attribute_code: 'COVENANT_IS_LIBRARY' },
  { relationship_code: 'FUNDING_DEAL', parent_domain_code: 'DEAL_FUNDING_PLAN', child_domain_code: 'DEAL', is_required: true },
  { relationship_code: 'FUNDING_FUND', parent_domain_code: 'DEAL_FUNDING_PLAN', child_domain_code: 'FUND', is_required: true },
  { relationship_code: 'POSITION_FUND', parent_domain_code: 'POSITION', child_domain_code: 'FUND', is_required: false },
  { relationship_code: 'FUND_PARENT', parent_domain_code: 'FUND', child_domain_code: 'FUND', is_required: true },
];

describe('required parents', () => {
  it('reads the rule from the relationship types: the first entity type needs the second', () => {
    expect(requiredParentRules(TYPES, 'security')).toEqual([{ relationshipCode: 'SECURITY_ISSUER', domainCode: 'SECURITY', requiredDomainCode: 'ISSUER', unlessAttributeCode: null }]);
    expect(requiredParentRules(TYPES, 'DEAL_FUNDING_PLAN').map((rule) => rule.requiredDomainCode)).toEqual(['DEAL', 'FUND']);
    // The issuer does not need a security, an optional link asks for nothing, and a type cannot require itself.
    expect(requiredParentRules(TYPES, 'ISSUER')).toEqual([]);
    expect(requiredParentRules(TYPES, 'POSITION')).toEqual([]);
    expect(requiredParentRules(TYPES, 'FUND')).toEqual([]);
  });

  it('is met by any link to a record of the required type, and only by that', () => {
    const rules = requiredParentRules(TYPES, 'SECURITY');
    expect(unmetRequiredParents(rules, ['ISSUER'])).toEqual([]);
    expect(unmetRequiredParents(rules, ['fund', 'issuer'])).toEqual([]);
    expect(unmetRequiredParents(rules, ['FUND']).map((rule) => rule.requiredDomainCode)).toEqual(['ISSUER']);
    expect(unmetRequiredParents(rules, [])).toHaveLength(1);
    const plan = requiredParentRules(TYPES, 'DEAL_FUNDING_PLAN');
    expect(unmetRequiredParents(plan, ['DEAL']).map((rule) => rule.requiredDomainCode)).toEqual(['FUND']);
  });

  it('steps aside when the attribute the type names is true', () => {
    const rules = requiredParentRules(TYPES, 'DEAL_COVENANT');
    expect(unmetRequiredParents(rules, [], { COVENANT_IS_LIBRARY: 'true' })).toEqual([]);
    expect(unmetRequiredParents(rules, [], { covenant_is_library: { value: true } })).toEqual([]);
    expect(unmetRequiredParents(rules, [], { COVENANT_IS_LIBRARY: 'false' })).toHaveLength(1);
    expect(unmetRequiredParents(rules, [], {})).toHaveLength(1);
    // The exemption belongs to the type that names it. A security has none.
    expect(unmetRequiredParents(requiredParentRules(TYPES, 'SECURITY'), [], { COVENANT_IS_LIBRARY: 'true' })).toHaveLength(1);
    expect([true, 1, 'Yes', 'y', 'TRUE'].every(attributeIsTrue)).toBe(true);
    expect([false, 0, '', 'no', null, undefined, 'maybe'].some(attributeIsTrue)).toBe(false);
  });

  it('says what is missing and what to do', () => {
    expect(requiredParentMessage('SECURITY', requiredParentRules(TYPES, 'SECURITY')))
      .toBe('A Security needs an Issuer. Link it to the Issuer it belongs to when you create it.');
    expect(requiredParentMessage('DEAL_FUNDING_PLAN', requiredParentRules(TYPES, 'DEAL_FUNDING_PLAN')))
      .toBe('A Deal Funding Plan needs a Deal and a Fund. Link it to each when you create it.');
  });
});

/** A stand-in for the two reads the check makes: relationship types, then the linked records' types. */
function client(domainOf: Record<string, string>): RequiredParentClient & { reads: string[] } {
  const reads: string[] = [];
  const types = {
    select: () => types,
    eq(column: string, value: unknown) { if (column === 'parent_domain_code') (types as any).domain = value; return types; },
    then(resolve: (result: unknown) => void) {
      resolve({ data: TYPES.filter((type) => type.parent_domain_code === (types as any).domain && type.is_required), error: null });
    },
  };
  return {
    reads,
    schema: (name: string) => ({ from: (table: string) => { reads.push(`${name}.${table}`); return types; } }),
    from: (table: string) => {
      reads.push(table);
      return { select: () => ({ in: async (_column: string, ids: string[]) => ({ data: ids.filter((id) => domainOf[id]).map((id) => ({ entity_id: id, domain_code: domainOf[id] })), error: null }) }) };
    },
  };
}

describe('refusing a record before it is written', () => {
  it('refuses a security with no issuer, and one linked only to something else', async () => {
    const db = client({ fund1: 'FUND', issuer1: 'ISSUER' });
    await expect(assertRequiredParents(db, { domainCode: 'SECURITY', linkedEntityIds: [] })).rejects.toBeInstanceOf(RequiredParentError);
    await expect(assertRequiredParents(db, { domainCode: 'SECURITY', linkedEntityIds: ['fund1'] })).rejects.toThrow('A Security needs an Issuer.');
    // An id that is not a record the caller can see does not count as a parent.
    await expect(assertRequiredParents(db, { domainCode: 'SECURITY', linkedEntityIds: ['made-up'] })).rejects.toBeInstanceOf(RequiredParentError);
  });

  it('lets through a record with its parent, an exempt record, and a type that needs none', async () => {
    const db = client({ issuer1: 'ISSUER', deal1: 'DEAL', fund1: 'FUND' });
    await expect(assertRequiredParents(db, { domainCode: 'SECURITY', linkedEntityIds: ['issuer1'] })).resolves.toBeUndefined();
    await expect(assertRequiredParents(db, { domainCode: 'DEAL_FUNDING_PLAN', linkedEntityIds: ['deal1', 'fund1'] })).resolves.toBeUndefined();
    await expect(assertRequiredParents(db, { domainCode: 'DEAL_COVENANT', attributes: { COVENANT_IS_LIBRARY: true }, linkedEntityIds: [] })).resolves.toBeUndefined();
    const none = client({});
    await expect(assertRequiredParents(none, { domainCode: 'ISSUER', linkedEntityIds: [] })).resolves.toBeUndefined();
    // A type with no required parent never looks up records at all.
    expect(none.reads).toEqual(['metadata_register.relationship_types']);
  });
});
