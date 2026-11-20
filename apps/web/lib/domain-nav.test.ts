import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nestDomainLinks, type DomainNavItem } from './domain-nav';

function item(partial: Partial<DomainNavItem> & Pick<DomainNavItem, 'code' | 'name'>): DomainNavItem {
  return {
    groupName: 'Funds & investors',
    groupOrder: 20,
    displayOrder: 0,
    parentCode: null,
    ...partial,
  };
}

describe('nestDomainLinks', () => {
  it('places fund-close and position records under their directory parents', () => {
    const rows = nestDomainLinks([
      item({ code: 'INVESTOR', name: 'Investor', displayOrder: 20 }),
      item({ code: 'REC_DISPOSITION', name: 'Rec Disposition', displayOrder: 21, parentCode: 'FUND_CLOSE' }),
      item({ code: 'REC_EVIDENCE', name: 'Rec Evidence', displayOrder: 22, parentCode: 'FUND' }),
      item({ code: 'POSITION_ROLL', name: 'Position Roll-forward', displayOrder: 23, parentCode: 'POSITION' }),
      item({ code: 'FUND', name: 'Fund', displayOrder: 10 }),
      item({ code: 'POSITION', name: 'Position', displayOrder: 18 }),
      item({ code: 'CASH_FLOW', name: 'Cash Flow', displayOrder: 19, parentCode: 'POSITION' }),
      item({ code: 'FUND_CLOSE', name: 'Fund Close', displayOrder: 20, parentCode: 'FUND' }),
      item({ code: 'INVESTOR_COMMITMENT', name: 'Investor Commitment', displayOrder: 30, parentCode: 'INVESTOR' }),
      item({ code: 'BANK_ACCOUNT', name: 'Bank Account', displayOrder: 30, parentCode: 'FUND' }),
      item({ code: 'BANK_TRANSACTION', name: 'Bank Transaction', displayOrder: 31, parentCode: 'BANK_ACCOUNT' }),
      item({ code: 'ORDER', name: 'Order', displayOrder: 210, parentCode: 'FUND' }),
      item({ code: 'ACCOUNT', name: 'Custody Account', displayOrder: 220, parentCode: 'FUND' }),
      item({ code: 'CUSTODIAN', name: 'Custodian', displayOrder: 230 }),
      item({ code: 'COUNTERPARTY', name: 'Counterparty', displayOrder: 240 }),
      item({ code: 'TRADE', name: 'Trade', displayOrder: 250, parentCode: 'ORDER' }),
    ]);

    const placed = rows.map((row) => `${row.depth}:${row.domain.code}`);
    assert.deepEqual(placed, [
      '0:FUND',
      '1:FUND_CLOSE',
      '2:REC_DISPOSITION',
      '1:REC_EVIDENCE',
      '1:BANK_ACCOUNT',
      '2:BANK_TRANSACTION',
      '1:ORDER',
      '2:TRADE',
      '1:ACCOUNT',
      '0:POSITION',
      '1:CASH_FLOW',
      '1:POSITION_ROLL',
      '0:INVESTOR',
      '1:INVESTOR_COMMITMENT',
      '0:CUSTODIAN',
      '0:COUNTERPARTY',
    ]);
    assert.equal(rows.filter((row) => row.showGroup).length, 1);
  });

  it('lists a security under its issuer, and the security schedules under the security', () => {
    const rows = nestDomainLinks([
      item({ code: 'ISSUER', name: 'Issuer', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 10 }),
      item({ code: 'FINANCIAL_PERIOD', name: 'Financial Period', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 11, parentCode: 'ISSUER' }),
      item({ code: 'STATEMENT_PERIOD', name: 'Statement Period', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 12, parentCode: 'ISSUER' }),
      item({ code: 'SECURITY', name: 'Security', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 20, parentCode: 'ISSUER' }),
      item({ code: 'INTEREST_CONTRACT', name: 'Contract', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 21, parentCode: 'SECURITY' }),
      item({ code: 'AMORTIZATION', name: 'Principal Schedule', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 22, parentCode: 'SECURITY' }),
      item({ code: 'FACTOR_SCHEDULE', name: 'Factor Schedule', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 23, parentCode: 'SECURITY' }),
      item({ code: 'CALL_SCHEDULE', name: 'Call Schedule', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 24, parentCode: 'SECURITY' }),
      item({ code: 'PRICE', name: 'Price', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 25, parentCode: 'SECURITY' }),
    ]);
    assert.deepEqual(rows.map((row) => `${row.depth}:${row.domain.code}`), [
      '0:ISSUER',
      '1:FINANCIAL_PERIOD',
      '1:STATEMENT_PERIOD',
      '1:SECURITY',
      '2:INTEREST_CONTRACT',
      '2:AMORTIZATION',
      '2:FACTOR_SCHEDULE',
      '2:CALL_SCHEDULE',
      '2:PRICE',
    ]);
  });

  it('keeps a type whose parent is in another band at the root of its own band', () => {
    const rows = nestDomainLinks([
      item({ code: 'SECURITY', name: 'Security', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 20 }),
      item({ code: 'PRICE', name: 'Price', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 25, parentCode: 'SECURITY' }),
      item({ code: 'FUND', name: 'Fund', displayOrder: 10 }),
      item({ code: 'CAPITAL_ACTIVITY', name: 'Capital Activity', displayOrder: 11, parentCode: 'FUND' }),
    ]);
    assert.deepEqual(rows.map((row) => `${row.domain.groupName}:${row.depth}:${row.domain.code}`), [
      'Securities & market data:0:SECURITY',
      'Securities & market data:1:PRICE',
      'Funds & investors:0:FUND',
      'Funds & investors:1:CAPITAL_ACTIVITY',
    ]);
  });

  it('lists the forward rate under the curve in Market data', () => {
    const rows = nestDomainLinks([
      item({ code: 'SECURITY', name: 'Security', groupName: 'Securities & market data', groupOrder: 10, displayOrder: 20 }),
      item({ code: 'FX_RATE', name: 'FX Rate', groupName: 'Market data', groupOrder: 15, displayOrder: 10 }),
      item({ code: 'FORWARD_CURVE', name: 'Forward Curve', groupName: 'Market data', groupOrder: 15, displayOrder: 20 }),
      item({ code: 'FORWARD_RATE', name: 'Forward Rate', groupName: 'Market data', groupOrder: 15, displayOrder: 21, parentCode: 'FORWARD_CURVE' }),
    ]);
    assert.deepEqual(rows.map((row) => `${row.domain.groupName}:${row.depth}:${row.domain.code}`), [
      'Securities & market data:0:SECURITY',
      'Market data:0:FX_RATE',
      'Market data:0:FORWARD_CURVE',
      'Market data:1:FORWARD_RATE',
    ]);
    assert.equal(rows.filter((row) => row.showGroup && row.domain.groupName === 'Market data').length, 1);
  });

  it('still lists a cycle, once each', () => {
    const rows = nestDomainLinks([
      item({ code: 'A', name: 'A', displayOrder: 2, parentCode: 'B' }),
      item({ code: 'B', name: 'B', displayOrder: 1, parentCode: 'A' }),
    ]);
    assert.deepEqual(rows.map((row) => row.domain.code), ['B', 'A']);
    assert.equal(new Set(rows.map((row) => row.domain.code)).size, 2);
  });
});
