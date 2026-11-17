import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindingLabel, reachablePlaces, type CalcRelationship } from './calc-fields';

const DEAL_LINKS: CalcRelationship[] = [
  { relationshipCode: 'TRANCHE_DEAL', relationshipName: 'Tranche of deal', parentDomainCode: 'DEAL_TRANCHE', childDomainCode: 'DEAL' },
  { relationshipCode: 'POSITION_TRANCHE', relationshipName: 'Position in tranche', parentDomainCode: 'POSITION', childDomainCode: 'DEAL_TRANCHE' },
  { relationshipCode: 'POSITION_CASHFLOW', relationshipName: 'Position cash flows', parentDomainCode: 'POSITION', childDomainCode: 'CASH_FLOW' },
];

describe('performance field paths', () => {
  it('reaches a deal cash flow by reversing the last hop', () => {
    const cash = reachablePlaces('DEAL', DEAL_LINKS).find((place) => place.domainCode === 'CASH_FLOW');
    assert.ok(cash);
    assert.equal(cash.traversal, 'UP');
    assert.deepEqual(cash.relationshipCodes, ['TRANCHE_DEAL', 'POSITION_TRANCHE', '~POSITION_CASHFLOW']);
    assert.equal(bindingLabel(
      { attributeCode: 'CASHFLOW_INVESTOR_AMOUNT', traversal: cash.traversal, relationshipCodes: cash.relationshipCodes },
      'DEAL',
      DEAL_LINKS,
      { CASH_FLOW: 'Cash flow' },
    ), 'Cash flow via Tranche of deal → Position in tranche → Position cash flows');
  });

  it('reaches fund fees and capital activity on separate paths', () => {
    const links: CalcRelationship[] = [
      { relationshipCode: 'FUND_CAPITAL', relationshipName: 'Capital', parentDomainCode: 'FUND', childDomainCode: 'CAPITAL_ACTIVITY' },
      { relationshipCode: 'FUND_FEE', relationshipName: 'Fee', parentDomainCode: 'FUND', childDomainCode: 'FEE' },
    ];
    const places = reachablePlaces('FUND', links);
    assert.equal(places.find((place) => place.domainCode === 'CAPITAL_ACTIVITY')?.relationshipCodes.join(','), 'FUND_CAPITAL');
    assert.equal(places.find((place) => place.domainCode === 'FEE')?.relationshipCodes.join(','), 'FUND_FEE');
  });
});
