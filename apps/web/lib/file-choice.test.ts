import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aboutList, fileChoices, likelyChoice, searchChoices, type StoredFile } from './file-choice';

const file = (id: string, fileName: string, receivedAt: string, extra: Partial<StoredFile> = {}): StoredFile => ({ id, fileName, status: 'READY', receivedAt, rowCount: 10, ...extra });

const FILES: StoredFile[] = [
  file('a', 'northwind-energy-q3-2026.xlsx', '2026-11-20T10:00:00Z'),
  file('b', 'halyard-systems-q3-2026-statements.csv', '2026-11-18T10:00:00Z'),
  file('c', 'halyard-systems-q2-2026-statements.csv', '2026-08-18T10:00:00Z', { status: 'COMPLETED', completedAt: '2026-08-19T09:00:00Z', resultSummary: { created: 0, matched: 1, failed: 0 } }),
  file('d', 'positions.csv', '2026-11-22T10:00:00Z', { status: 'FAILED', errorMessage: 'No rows' }),
];

describe('choosing a stored file for a run', () => {
  it('lists the files that name one of the run’s records first, the unloaded before the loaded', () => {
    const choices = fileChoices(FILES, ['HALY-ISS-HALYARD']);
    assert.deepEqual(choices.map((choice) => choice.file.id), ['b', 'c', 'd', 'a']);
    assert.equal(choices[0].mentions, 'HALY-ISS-HALYARD');
    assert.equal(choices[0].standing, 'Not loaded yet');
    assert.deepEqual([choices[1].loaded, choices[1].standing, choices[1].tone], [true, 'Loaded on 2026-08-19', 'loaded']);
    assert.equal(choices[2].standing, 'Its last load failed');
    assert.equal(choices[3].mentions, null);
  });

  it('is newest first when the run names no record', () => {
    assert.deepEqual(fileChoices(FILES).map((choice) => choice.file.id), ['d', 'a', 'b', 'c']);
    assert.deepEqual(fileChoices(FILES, '').map((choice) => choice.file.id), ['d', 'a', 'b', 'c']);
  });

  it('does not match on a word every file name has', () => {
    const choices = fileChoices([file('x', 'fund-statements-2026.csv', '2026-11-01T00:00:00Z')], ['Harbor Credit Fund']);
    assert.equal(choices[0].mentions, null);
  });

  it('reads the records a step passed as a list or as a line', () => {
    assert.deepEqual(aboutList(['A', ' B ', '']), ['A', 'B']);
    assert.deepEqual(aboutList('Halyard Systems, Northwind Energy'), ['Halyard Systems', 'Northwind Energy']);
    assert.deepEqual(aboutList(null), []);
    // The records a selection step returned are named by their names and matched on name and code.
    const records = [{ entityId: 'i1', entityCode: 'HALY-ISS-HALYARD', entityName: 'Halyard Systems', domainCode: 'ISSUER' }];
    assert.deepEqual(aboutList(records), ['Halyard Systems']);
    assert.equal(fileChoices(FILES, records)[0].mentions, 'Halyard Systems');
    // A word many names share does not make a match.
    assert.equal(fileChoices([file('s', 'systems-export.csv', '2026-11-01T00:00:00Z')], records)[0].mentions, null);
  });

  it('opens a file to start with only when one stands out', () => {
    assert.equal(likelyChoice(fileChoices(FILES, ['HALY-ISS-HALYARD']))?.file.id, 'b');
    const two = [...FILES, file('e', 'halyard-systems-q3-2026-compliance-certificate.pdf', '2026-11-19T10:00:00Z')];
    assert.equal(likelyChoice(fileChoices(two, ['HALY-ISS-HALYARD'])), null);
    assert.equal(likelyChoice(fileChoices(FILES)), null);
  });

  it('narrows the list to what was typed', () => {
    const choices = fileChoices(FILES);
    assert.deepEqual(searchChoices(choices, 'halyard q3').map((choice) => choice.file.id), ['b']);
    assert.equal(searchChoices(choices, '  ').length, 4);
  });
});
