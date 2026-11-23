import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attributeSectionLinks, attributesInDisplayOrder, fieldsForVisibility, fieldsMatchingSearch, planAttributeMove, sectionAnchor, sectionsForDisplay } from './attribute-layout';

describe('attributes in display order', () => {
  it('orders by section, then position, then name, like the record editor', () => {
    const items = [
      { name: 'Zeta', section: 'General', sortOrder: 2 },
      { name: 'Coupon', section: 'Terms', sortOrder: 1 },
      { name: 'Alpha', section: 'General', sortOrder: 2 },
      { name: 'First', section: 'General', sortOrder: 1 },
      { name: 'Loose', section: 'Unranked', sortOrder: 0 },
    ];
    const sections = [
      { sectionName: 'Terms', displayOrder: 1 },
      { sectionName: 'General', displayOrder: 2 },
    ];
    assert.deepEqual(attributesInDisplayOrder(items, sections).map((item) => item.name), [
      'Coupon',
      'First',
      'Alpha',
      'Zeta',
      'Loose',
    ]);
  });
});

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
    { name: 'Country', populated: false, required: true },
    { name: 'Sector', populated: true, required: true },
    { name: 'Industry', populated: false },
  ];

  it('keeps required fields, filled or blank', () => {
    assert.deepEqual(fieldsForVisibility(items, 'required').map((item) => item.name), ['Country', 'Sector']);
  });

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

describe('fields matching a search', () => {
  const items = [
    { key: 'LEGAL_NAME', name: 'Legal name', section: 'Identity', value: 'Acme Fund II' },
    { key: 'NAV', name: 'Net asset value', section: 'Valuation', value: '125000000' },
    { key: 'DOMICILE', name: 'Domicile', section: 'Identity', value: null },
  ];

  it('keeps every field for a blank search', () => {
    assert.equal(fieldsMatchingSearch(items, '  ').length, 3);
  });

  it('matches name, code, section and value, ignoring case', () => {
    assert.deepEqual(fieldsMatchingSearch(items, 'asset').map((item) => item.key), ['NAV']);
    assert.deepEqual(fieldsMatchingSearch(items, 'legal_name').map((item) => item.key), ['LEGAL_NAME']);
    assert.deepEqual(fieldsMatchingSearch(items, 'identity').map((item) => item.key), ['LEGAL_NAME', 'DOMICILE']);
    assert.deepEqual(fieldsMatchingSearch(items, 'acme').map((item) => item.key), ['LEGAL_NAME']);
  });

  it('needs every word to match', () => {
    assert.deepEqual(fieldsMatchingSearch(items, 'identity acme').map((item) => item.key), ['LEGAL_NAME']);
  });
});
