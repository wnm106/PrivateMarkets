import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OTHER_FIELDS_SECTION, recordTemplateLayout, type RecordField, type RecordTemplate } from './record-template-layout';

const field = (attributeCode: string, displaySection = 'General', sortOrder = 1): RecordField => ({
  attributeCode, attributeName: attributeCode, required: false, displaySection, sortOrder, dataType: 'STRING',
});

const register = [field('LABEL', 'General', 1), field('CURRENCY', 'General', 5), field('VINTAGE', 'Terms', 2), field('COUPON', 'Coupon Terms', 3)];

const fund: RecordTemplate = {
  templateCode: 'FUND',
  sections: [{ sectionName: 'Fund terms', displayOrder: 2 }, { sectionName: 'Identification', displayOrder: 1 }],
  attributes: [
    { attribute: { attributeCode: 'LABEL' }, sectionName: 'Identification', displayOrder: 1, displayLabel: 'Fund name', isRequired: false },
    { attribute: { attributeCode: 'CURRENCY' }, sectionName: 'Identification', displayOrder: 2, displayLabel: null, isRequired: true },
    { attribute: { attributeCode: 'VINTAGE' }, sectionName: 'Fund terms', displayOrder: 1 },
  ],
};

describe('record view laid out by its template', () => {
  it('uses the template fields, sections, labels and required flags', () => {
    const layout = recordTemplateLayout(register, fund, ['LABEL', 'VINTAGE']);
    assert.ok(layout);
    assert.deepEqual(layout.fields.map((f) => f.attributeCode), ['LABEL', 'CURRENCY', 'VINTAGE']);
    assert.equal(layout.fields[0].attributeName, 'Fund name');
    assert.equal(layout.fields[0].displaySection, 'Identification');
    assert.equal(layout.fields[1].required, true);
    assert.deepEqual(layout.sections.map((s) => s.sectionName), ['Identification', 'Fund terms']);
  });

  it('still shows a stored value the template leaves out, under Other fields', () => {
    const layout = recordTemplateLayout(register, fund, ['LABEL', 'COUPON']);
    const coupon = layout?.fields.find((f) => f.attributeCode === 'COUPON');
    assert.equal(coupon?.displaySection, OTHER_FIELDS_SECTION);
    assert.equal(layout?.sections.at(-1)?.sectionName, OTHER_FIELDS_SECTION);
  });

  it('keeps the entity type layout for a template without sections, or no template', () => {
    assert.equal(recordTemplateLayout(register, { ...fund, sections: [] }, []), null);
    assert.equal(recordTemplateLayout(register, null, []), null);
  });

  it('skips an assigned field this caller cannot see in the register', () => {
    const layout = recordTemplateLayout(register, { ...fund, attributes: [...(fund.attributes || []), { attribute: { attributeCode: 'HIDDEN' }, sectionName: 'Fund terms' }] }, []);
    assert.ok(!layout?.fields.some((f) => f.attributeCode === 'HIDDEN'));
  });
});
