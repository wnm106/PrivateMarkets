import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapCovenantTest } from '@tapestrai/graphql/src/lib/covenant-test';
import { covenantTabPayload } from './covenant-tab';

const test = mapCovenantTest({
  covenantId: 'c1',
  code: 'HALY-COV-HALYARD-1',
  name: 'Maximum net leverage',
  dealName: 'Project Halyard',
  metric: 'NET_LEVERAGE',
  direction: 'MAX',
  unit: 'MULTIPLE',
  level: 3.25,
  firstTest: '2025-09-30',
  asOf: '2026-11-19',
  testDate: '2026-09-30',
  value: 2.970628,
  numerator: 135062000.4,
  denominator: 45465809.01,
  stored: 2.970628,
  house: 2.569848,
  houseId: 'h1',
  houseName: 'House standard: net leverage',
  sources: [{ id: 'not for the assistant' }],
  reported: [{ sourceCode: 'BORROWER_CERTIFICATE', sourceName: 'Borrower Compliance Certificate', value: 2.76, validFrom: '2026-09-30' }],
  components: [
    { id: 'x1', name: 'Old cash cap', side: 'NUMERATOR', sign: 'SUBTRACT', measure: 'POINT', capType: 'AMOUNT', capValue: 10000000, active: false, effectiveTo: '2026-03-31' },
    { id: 'x2', name: 'Unrestricted cash, up to $25m', side: 'NUMERATOR', sign: 'SUBTRACT', line: 'STATEMENT_UNRESTRICTED_CASH', lineName: 'Unrestricted Cash', measure: 'POINT', capType: 'AMOUNT', capValue: 25000000, active: true, raw: 47466400.12, capLimit: 25000000, allowed: 25000000, applied: -25000000, capped: true },
  ],
  history: [
    { testDate: '2025-06-30', value: 3.4939, house: 3.52, level: 4, tested: false },
    { testDate: '2026-09-30', value: 2.9706, house: 2.57, level: 3.25, tested: true },
  ],
});

describe('covenantTabPayload', () => {
  it('publishes null data until the test loads', () => {
    const payload = covenantTabPayload('Test', null);
    assert.equal(payload.label, 'Test');
    assert.equal(payload.data, null);
    assert.ok(payload.purpose && payload.howToRead);
  });

  it('tells the test the way the tab shows it', () => {
    const data = covenantTabPayload('Test', test).data as Record<string, any>;
    assert.equal(data.value, 2.97);
    assert.equal(data.status, 'WATCH');
    assert.deepEqual(data.certificate, { source: 'Borrower Compliance Certificate', value: 2.76, difference: -0.21, received: '2026-09-30' });
    assert.deepEqual(data.house, { definition: 'House standard: net leverage', value: 2.57 });
    assert.equal(data.metric, 'Net leverage');
  });

  it('lists lines in force first, with what each counted', () => {
    const data = covenantTabPayload('Test', test).data as Record<string, any>;
    assert.equal(data.lines[0].line, 'Unrestricted cash, up to $25m');
    assert.equal(data.lines[0].applied, -25000000);
    assert.equal(data.lines[0].capped, true);
    assert.equal(data.lines[0].period, 'At test date');
    assert.equal(data.lines[1].inForce, false);
    assert.equal(data.lines[1].applied, null);
  });

  it('marks quarters before the first test instead of scoring them', () => {
    const data = covenantTabPayload('Test', test).data as Record<string, any>;
    assert.equal(data.history[0].status, 'BEFORE_FIRST_TEST');
    assert.equal(data.history[1].status, 'WATCH');
    assert.equal(data.history[1].level, 3.25);
  });

  it('carries no ids or source references', () => {
    const text = JSON.stringify(covenantTabPayload('Test', test));
    assert.ok(!text.includes('x2'));
    assert.ok(!text.includes('not for the assistant'));
  });
});
