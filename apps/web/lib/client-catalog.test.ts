import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canToggle,
  fieldState,
  fieldSummary,
  filterFields,
  matchedWords,
  mergeSettings,
  nameChanged,
  unusedFields,
  usageLabel,
  type ClientCatalogField,
  type ClientCatalogSettings,
} from './client-catalog';

function field(patch: Partial<ClientCatalogField>): ClientCatalogField {
  return {
    attributeId: patch.attributeCode || 'id',
    attributeCode: 'CODE',
    attributeName: 'Name',
    displaySection: 'General',
    isRequired: false,
    isDerived: false,
    catalogIsVisible: true,
    hidden: false,
    recordsWithValue: 0,
    ...patch,
  };
}

const fields = [
  field({ attributeCode: 'COUNTRY', attributeName: 'Country', isRequired: true, recordsWithValue: 40 }),
  field({ attributeCode: 'RATING', attributeName: 'Rating', displaySection: 'Credit', recordsWithValue: 12 }),
  field({ attributeCode: 'OLD_ID', attributeName: 'Old id', recordsWithValue: 0 }),
  field({ attributeCode: 'FAX', attributeName: 'Fax', hidden: true, recordsWithValue: 0 }),
  field({ attributeCode: 'LEGACY', attributeName: 'Legacy', catalogIsVisible: false, recordsWithValue: 0 }),
];

function settings(patch: Partial<ClientCatalogSettings> = {}): ClientCatalogSettings {
  return {
    clientId: 'c1',
    clientName: 'Client',
    canEdit: true,
    domainCode: 'ISSUER',
    catalogName: 'Issuer',
    displayName: null,
    recordCount: 40,
    aliases: [],
    fields,
    ...patch,
  };
}

describe('client field settings', () => {
  it('says why each field can or cannot be hidden', () => {
    assert.deepEqual(fields.map(fieldState), ['required', 'shown', 'shown', 'hidden', 'catalog-hidden']);
    assert.deepEqual(fields.map(canToggle), [false, true, true, true, false]);
  });

  it('calls a field unused only when it is shown and no record holds a value', () => {
    assert.deepEqual(unusedFields(fields).map((item) => item.attributeCode), ['OLD_ID']);
  });

  it('finds no unused field when usage was not counted', () => {
    assert.deepEqual(unusedFields(fields.map((item) => ({ ...item, recordsWithValue: null }))), []);
  });

  it('filters by hidden, by unused, and by words in the name, code or section', () => {
    assert.deepEqual(filterFields(fields, 'hidden', '').map((item) => item.attributeCode), ['FAX']);
    assert.deepEqual(filterFields(fields, 'unused', '').map((item) => item.attributeCode), ['OLD_ID']);
    assert.deepEqual(filterFields(fields, 'all', 'credit').map((item) => item.attributeCode), ['RATING']);
    assert.deepEqual(filterFields(fields, 'all', ' old_').map((item) => item.attributeCode), ['OLD_ID']);
    assert.equal(filterFields(fields, 'all', '').length, fields.length);
  });

  it('writes how many records hold a value', () => {
    assert.equal(usageLabel(fields[1], 40), '12 of 40');
    assert.equal(usageLabel(fields[2], 40), 'None');
    assert.equal(usageLabel(field({ recordsWithValue: 1234 }), null), '1,234');
    assert.equal(usageLabel(field({ recordsWithValue: null }), 40), '\u2014');
  });

  it('sums the list up in one line', () => {
    assert.equal(fieldSummary(fields), '5 fields \u00b7 1 hidden \u00b7 1 shown with no value');
    assert.equal(
      fieldSummary([field({ recordsWithValue: null })]),
      '1 field \u00b7 0 hidden',
    );
  });
});

describe('the words matched to a type', () => {
  it('lists the client name, the catalog name, the client aliases, then the shared ones', () => {
    const words = matchedWords(settings({
      displayName: 'Borrower',
      aliases: [
        { id: 'a1', label: 'Portfolio company', shared: false },
        { id: 'a2', label: 'Obligor', shared: true },
      ],
    }));
    assert.deepEqual(words.map((word) => `${word.kind}:${word.label}`), [
      'name:Borrower', 'catalog:Issuer', 'own:Portfolio company', 'shared:Obligor',
    ]);
    assert.equal(words[2].id, 'a1');
  });

  it('starts with the catalog name when the client has not named the type', () => {
    assert.deepEqual(matchedWords(settings()).map((word) => word.kind), ['catalog']);
  });
});

describe('client settings after a change', () => {
  it('keeps the counts on screen and takes the new name and flags', () => {
    const changed = settings({
      displayName: 'Borrower',
      recordCount: null,
      fields: fields.map((item) => ({ ...item, recordsWithValue: null, hidden: item.attributeCode === 'OLD_ID' || item.hidden })),
    });
    const merged = mergeSettings(settings(), changed);
    assert.equal(merged.displayName, 'Borrower');
    assert.equal(merged.recordCount, 40);
    assert.equal(merged.fields.find((item) => item.attributeCode === 'OLD_ID')?.hidden, true);
    assert.equal(merged.fields.find((item) => item.attributeCode === 'RATING')?.recordsWithValue, 12);
  });

  it('takes the first answer as it comes', () => {
    assert.deepEqual(mergeSettings(null, settings()), settings());
  });

  it('knows when the name box differs from the saved name', () => {
    assert.equal(nameChanged(settings(), ''), false);
    assert.equal(nameChanged(settings(), ' Borrower '), true);
    assert.equal(nameChanged(settings({ displayName: 'Borrower' }), 'Borrower'), false);
    assert.equal(nameChanged(settings({ displayName: 'Borrower' }), ''), true);
  });
});
