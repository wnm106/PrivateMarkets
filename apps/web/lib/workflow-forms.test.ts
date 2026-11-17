import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerProblems, asFields, cleanRaw, normalizeAnswers } from './workflow-forms';

const fields = asFields([
  { key: 'nav', label: 'NAV', type: 'number', required: true },
  { key: 'asOf', label: 'As of', type: 'date', required: true },
  { key: 'basis', label: 'Basis', type: 'choice', options: ['Estimate', 'Final'] },
  { key: 'audited', label: 'Audited', type: 'yesno' },
  { key: 'notes', type: 'longtext' },
  { label: 'no key' },
]);

describe('workflow forms', () => {
  it('reads fields, dropping any without a key', () => {
    assert.deepEqual(fields.map((field) => field.key), ['nav', 'asOf', 'basis', 'audited', 'notes']);
    assert.equal(fields[4].label, 'notes');
    assert.equal(fields[4].type, 'longtext');
  });

  it('says what is missing or malformed, field by field', () => {
    assert.deepEqual(answerProblems(fields, {}), { nav: 'Required.', asOf: 'Required.' });
    assert.deepEqual(answerProblems(fields, { nav: 'ten', asOf: '30/09/2026', basis: 'Guess', audited: 'maybe' }), {
      nav: 'Enter a number.',
      asOf: 'Enter a date, YYYY-MM-DD.',
      basis: 'Choose one of the options.',
      audited: 'Choose yes or no.',
    });
    assert.deepEqual(answerProblems(fields, { nav: '125,000,000.50', asOf: '2026-09-30', basis: 'Final', audited: 'no' }), {});
  });

  it('sends numbers as numbers, yes or no as booleans, and leaves blanks out', () => {
    const raw = cleanRaw(fields, { nav: '125,000,000.50', asOf: '2026-09-30', basis: 'Final', audited: 'no', notes: '  ' });
    assert.deepEqual(normalizeAnswers(fields, raw), { nav: 125000000.5, asOf: '2026-09-30', basis: 'Final', audited: false });
  });
});
