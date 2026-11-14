import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignParentSlot,
  createParentSlots,
  createParentSummary,
  selectedParent,
  unfilledRequiredParents,
  type ParentSelection,
} from './create-parents';
import type { ParentLinkCount } from './parent-entities';

const relationships = [
  { relationshipCode: 'POSITION_FUND', relationshipName: 'Position held in fund', parentDomainCode: 'FUND', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY', isRequired: false },
  { relationshipCode: 'POSITION_SECURITY', relationshipName: 'Position in security', parentDomainCode: 'SECURITY', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY', isRequired: false },
  { relationshipCode: 'SECURITY_POSITION', relationshipName: 'Security position', parentDomainCode: 'SECURITY', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY', isRequired: false },
  { relationshipCode: 'SECURITY_ISSUER', relationshipName: 'Security issued by', parentDomainCode: 'SECURITY', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE', isRequired: true },
  { relationshipCode: 'DEAL_ISSUER', relationshipName: 'Deal with issuer', parentDomainCode: 'DEAL', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE', isRequired: false },
  { relationshipCode: 'ACTIVITY_FUND', relationshipName: 'Activity in fund', parentDomainCode: 'CAPITAL_ACTIVITY', childDomainCode: 'FUND', cardinality: 'MANY_TO_ONE', isRequired: false },
];

const names = { FUND: 'Fund', SECURITY: 'Security', ISSUER: 'Issuer', DEAL: 'Deal' };

const positionMembers = [
  { domainCode: 'FUND', memberRole: 'FUND', isRequired: true, displayOrder: 1 },
  { domainCode: 'SECURITY', memberRole: 'SECURITY', isRequired: true, displayOrder: 2 },
  { domainCode: 'ISSUER', memberRole: 'ISSUER', isRequired: false, displayOrder: 3 },
  { domainCode: 'DEAL', memberRole: 'DEAL', isRequired: false, displayOrder: 4 },
];

describe('createParentSlots', () => {
  it('does not add a deal tranche beside a position’s fund and security', () => {
    const slots = createParentSlots('POSITION', [
      ...relationships,
      { relationshipCode: 'POSITION_TRANCHE', relationshipName: 'Position in tranche', parentDomainCode: 'POSITION', childDomainCode: 'DEAL_TRANCHE', cardinality: 'MANY_TO_ONE', isRequired: false },
    ], { names: { ...names, DEAL_TRANCHE: 'Deal Tranche' }, intersectionMembers: positionMembers });
    assert.deepEqual(slots.map((slot) => slot.label), ['Fund', 'Security']);
  });

  it('puts a position’s fund and security first, and skips members with no relationship', () => {
    const slots = createParentSlots('POSITION', relationships, { names, intersectionMembers: positionMembers });
    assert.deepEqual(slots.map((slot) => ({ label: slot.label, required: slot.required, direction: slot.direction, relationshipCode: slot.relationshipCode })), [
      { label: 'Fund', required: true, direction: 'UP', relationshipCode: 'POSITION_FUND' },
      { label: 'Security', required: true, direction: 'UP', relationshipCode: 'POSITION_SECURITY' },
    ]);
    assert.equal(createParentSummary(slots), 'Fund and Security are required.');
  });

  it('keeps an optional intersection member when a relationship can store it', () => {
    const slots = createParentSlots('POSITION', [
      ...relationships,
      { relationshipCode: 'POSITION_DEAL', relationshipName: 'Position in deal', parentDomainCode: 'DEAL', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY', isRequired: false },
    ], { names, intersectionMembers: positionMembers });
    assert.deepEqual(slots.map((slot) => [slot.label, slot.required]), [
      ['Fund', true],
      ['Security', true],
      ['Deal', false],
    ]);
    assert.equal(createParentSummary(slots), 'Fund and Security are required. Deal is optional.');
  });

  it('follows stored links when the catalog parent and child are reversed', () => {
    const counts: ParentLinkCount[] = [
      { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', linkCount: 302, maxPerParent: 9, maxPerChild: 1 },
    ];
    const slots = createParentSlots('SECURITY', relationships, { names, linkCounts: counts });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].domainCode, 'ISSUER');
    assert.equal(slots[0].direction, 'UP');
    assert.equal(slots[0].required, true);
    assert.equal(slots[0].relationshipCode, 'SECURITY_ISSUER');
  });

  it('offers a single optional parent without marking it required', () => {
    const slots = createParentSlots('DEAL', relationships, { names });
    assert.deepEqual(slots.map((slot) => ({ label: slot.label, required: slot.required, direction: slot.direction })), [
      { label: 'Issuer', required: false, direction: 'DOWN' },
    ]);
    assert.equal(createParentSummary(slots), 'Select the issuer.');
  });

  it('does not ask a fund to pick its many positions', () => {
    assert.deepEqual(createParentSlots('FUND', relationships, { names }), []);
  });

  it('asks a capital activity for its fund on the child side of the stored link', () => {
    const slots = createParentSlots('CAPITAL_ACTIVITY', relationships, { names });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].domainCode, 'FUND');
    assert.equal(slots[0].direction, 'DOWN');
    assert.equal(slots[0].required, false);
  });
});

describe('assignParentSlot', () => {
  const fund = slot('POSITION_FUND', 'UP');

  it('stores the chosen parent and replaces an earlier choice', () => {
    const first = selection('POSITION_FUND', 'fund-1', 'Fund I');
    const next = selection('POSITION_FUND', 'fund-2', 'Fund II');
    const assigned = assignParentSlot([first], [], fund, next);
    assert.deepEqual(assigned.parentRelationships.map((row) => row.entityId), ['fund-2']);
    assert.equal(selectedParent(assigned.parentRelationships, assigned.childRelationships, fund)?.entityName, 'Fund II');
  });

  it('writes a downward parent onto the child list and reports what is still required', () => {
    const activity = createParentSlots('CAPITAL_ACTIVITY', relationships, { names })[0];
    const chosen = selection('ACTIVITY_FUND', 'fund-1', 'Fund I');
    const assigned = assignParentSlot([], [], activity, chosen);
    assert.equal(assigned.parentRelationships.length, 0);
    assert.equal(assigned.childRelationships[0].entityId, 'fund-1');
    const slots = createParentSlots('POSITION', relationships, { names, intersectionMembers: positionMembers });
    assert.deepEqual(unfilledRequiredParents(slots, assigned.parentRelationships, assigned.childRelationships).map((row) => row.label), ['Fund', 'Security']);
    const filled = assignParentSlot(assigned.parentRelationships, assigned.childRelationships, slots[0], selection('POSITION_FUND', 'fund-1', 'Fund I'));
    assert.deepEqual(unfilledRequiredParents(slots, filled.parentRelationships, filled.childRelationships).map((row) => row.label), ['Security']);
  });

  it('clears a parent from either side', () => {
    const cleared = assignParentSlot([selection('POSITION_FUND', 'fund-1', 'Fund I')], [selection('POSITION_FUND', 'fund-1', 'Fund I')], fund, null);
    assert.deepEqual(cleared, { parentRelationships: [], childRelationships: [] });
  });
});

function slot(relationshipCode: string, direction: 'UP' | 'DOWN') {
  return { relationshipCode, direction, label: relationshipCode === 'POSITION_FUND' ? 'Fund' : 'Security', required: true } as const;
}

function selection(relationshipCode: string, entityId: string, entityName: string): ParentSelection {
  return {
    entityId,
    entityCode: entityId,
    entityName,
    domainCode: 'FUND',
    relationshipCode,
    relationshipName: relationshipCode,
    isPrimary: true,
    validFrom: '2026-11-08',
  };
}
