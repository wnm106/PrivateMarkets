import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeList, triggerSummary } from './workflow-triggers';

describe('workflow triggers', () => {
  it('reads codes typed with commas or spaces, once each, upper-cased', () => {
    assert.deepEqual(codeList(' fund, position  FUND\nnav_pack '), ['FUND', 'POSITION', 'NAV_PACK']);
    assert.deepEqual(codeList(''), []);
  });

  it('says what a trigger watches', () => {
    assert.equal(triggerSummary({ source: 'DQ_FAILURES', match: {} }), 'When a data quality scan finds new failures');
    assert.equal(
      triggerSummary({ source: 'DQ_FAILURES', match: { severities: ['CRITICAL', 'HIGH'], ruleCodes: ['MATURITY_REQUIRED'], domainCodes: ['LOAN'] } }),
      'When a data quality scan finds critical or high new failures from MATURITY_REQUIRED on LOAN records',
    );
    assert.equal(triggerSummary({ source: 'FEED', match: { feedCodes: ['NAV_PACK'], kinds: ['FEED_LOADED', 'FEED_LATE'] } }), 'When NAV_PACK loads a file or is late');
    assert.equal(triggerSummary({ source: 'FEED', match: {} }), 'When any feed loads, fails, is late, or has a file for review');
    assert.equal(triggerSummary({ source: 'BREACH', match: { ruleCodes: ['SINGLE_NAME'], statuses: ['HARD_BREACH'] } }), 'When SINGLE_NAME has a new hard breach');
    assert.equal(triggerSummary({ source: 'BREACH', match: {} }), 'When any compliance rule has a new breach');
    assert.equal(triggerSummary({ source: 'VALUE_CHANGE', match: { attributeCodes: ['NAV'], domainCodes: ['FUND'] } }), 'When a new value is recorded for NAV on FUND records');
  });
});
