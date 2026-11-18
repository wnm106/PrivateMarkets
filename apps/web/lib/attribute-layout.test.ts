import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attributeSectionLinks, fieldsForVisibility, planAttributeMove, sectionAnchor, sectionsForDisplay } from './attribute-layout';

describe('attribute section anchors', () => {
  it('slugs a section name into a stable id fragment', () => {
    assert.equal(sectionAnchor(' Sources & Uses '), 'sources-uses');
    assert.equal(sectionAnchor(''), 'general');
    assert.equal(sectionAnchor('   '), 'general');
  });

  it('keeps each link id unique when names share a slug', () => {
    assert.deepEqual(attributeSectionLinks(['General', 'A B', 'a-b']).map((link) => link.id), [
      'attr-general',
      'attr-a-b',
      'attr-a-b-2',
    ]);
  });
});

describe('field visibility', () => {
  const items = [
    { name: 'Country', populated: false },
    { name: 'Sector', populated: true },
    { name: 'Industry', populated: false },
  ];

  it('keeps every field', () => {
    assert.deepEqual(fieldsForVisibility(items, 'all').map((item) => item.name), ['Country', 'Sector', 'Industry']);
  });

  it('keeps fields that have a stored value', () => {
    assert.deepEqual(fieldsForVisibility(items, 'populated').map((item) => item.name), ['Sector']);
  });

  it('keeps fields that are blank', () => {
    assert.deepEqual(fieldsForVisibility(items, 'missing').map((item) => item.name), ['Country', 'Industry']);
  });
});

describe('attribute section grouping', () => {
  const sections = [
    { sectionName: 'Identity', displayOrder: 10 },
    { sectionName: 'Financials', displayOrder: 20 },
    { sectionName: 'Notes', displayOrder: 30 },
  ];
  const items = [
    { id: 'name', section: 'Identity', sortOrder: 20, name: 'Name', owned: true },
    { id: 'code', section: 'Identity', sortOrder: 10, name: 'Code', owned: true },
    { id: 'revenue', section: 'Financials', sortOrder: 10, name: 'Revenue', owned: true },
    { id: 'shared', section: 'Financials', sortOrder: 5, name: 'Shared', owned: false },
  ];

  it('keeps an empty section so an attribute can be dropped into it', () => {
    const grouped = sectionsForDisplay(items, sections);
    assert.deepEqual(grouped.map((group) => [group.section, group.items.map((item) => item.id)]), [
      ['Identity', ['code', 'name']],
      ['Financials', ['shared', 'revenue']],
      ['Notes', []],
    ]);
  });

  it('moves an attribute within its section', () => {
    const groups = sectionsForDisplay(items, sections);
    const plan = planAttributeMove(groups, 'name', { kind: 'before', attributeId: 'code' });
    assert.deepEqual(plan, { section: 'Identity', attributeIds: ['name', 'code'] });
  });

  it('moves an attribute into another section ahead of the drop target', () => {
    const groups = sectionsForDisplay(items, sections);
    const plan = planAttributeMove(groups, 'name', { kind: 'before', attributeId: 'revenue' });
    assert.deepEqual(plan, { section: 'Financials', attributeIds: ['name', 'revenue'] });
  });

  it('appends an attribute when it is dropped on a section', () => {
    const groups = sectionsForDisplay(items, sections);
    const plan = planAttributeMove(groups, 'code', { kind: 'section', section: 'Notes' });
    assert.deepEqual(plan, { section: 'Notes', attributeIds: ['code'] });
  });

  it('leaves the order alone when the attribute is already in that spot', () => {
    const groups = sectionsForDisplay(items, sections);
    assert.equal(planAttributeMove(groups, 'revenue', { kind: 'section', section: 'Financials' }), null);
    assert.equal(planAttributeMove(groups, 'code', { kind: 'before', attributeId: 'code' }), null);
    assert.equal(planAttributeMove(groups, 'shared', { kind: 'before', attributeId: 'name' }), null);
  });
});
