import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dealCheckResults, resultsForAssignedRules, resultsForFund } from './deal-compliance-view';

const children = new Map([
  ['meridian', [{ fundId: 'onshore' }, { fundId: 'offshore' }]],
]);

describe('resultsForFund', () => {
  it('uses the portfolio score when the portfolio itself was scored', () => {
    const byFund = new Map([
      ['meridian', [{ anchorEntityId: 'meridian' }]],
      ['onshore', [{ anchorEntityId: 'onshore' }]],
    ]);
    assert.deepEqual(resultsForFund('meridian', byFund, children), [{ anchorEntityId: 'meridian' }]);
  });

  it('shows the sleeve scores when the portfolio row is empty', () => {
    const byFund = new Map([
      ['onshore', [{ anchorEntityId: 'onshore' }]],
      ['offshore', [{ anchorEntityId: 'offshore' }]],
    ]);
    assert.deepEqual(
      resultsForFund('meridian', byFund, children).map((row) => row.anchorEntityId),
      ['onshore', 'offshore'],
    );
  });
});

describe('resultsForAssignedRules', () => {
  it('keeps a sleeve rule when the portfolio is scored for a different rule', () => {
    const byFund = new Map([
      ['meridian', [{ anchorEntityId: 'meridian', ruleId: 'issuer' }]],
      ['onshore', [{ anchorEntityId: 'onshore', ruleId: 'sector' }]],
      ['offshore', [{ anchorEntityId: 'offshore', ruleId: 'issuer' }]],
    ]);
    assert.deepEqual(
      resultsForAssignedRules('meridian', byFund, children).map((row) => `${row.ruleId}:${row.anchorEntityId}`),
      ['issuer:meridian', 'sector:onshore'],
    );
  });
});

describe('dealCheckResults', () => {
  const funds = [
    { fundId: 'meridian', level: 'PORTFOLIO' },
    { fundId: 'onshore', level: 'SLEEVE' },
    { fundId: 'offshore', level: 'SLEEVE' },
  ];

  it('does not count a sleeve again when the portfolio score includes it', () => {
    const byFund = new Map([
      ['meridian', [{ anchorEntityId: 'meridian' }]],
      ['onshore', [{ anchorEntityId: 'onshore' }]],
      ['offshore', [{ anchorEntityId: 'offshore' }]],
    ]);
    assert.deepEqual(dealCheckResults(funds, byFund, children), [{ anchorEntityId: 'meridian' }]);
  });

  it('counts the sleeves when the portfolio has no score of its own', () => {
    const byFund = new Map([
      ['onshore', [{ anchorEntityId: 'onshore' }]],
      ['offshore', [{ anchorEntityId: 'offshore' }]],
    ]);
    assert.deepEqual(
      dealCheckResults(funds, byFund, children).map((row) => row.anchorEntityId),
      ['onshore', 'offshore'],
    );
  });
});
