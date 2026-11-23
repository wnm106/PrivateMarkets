import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { figure, standing, standingsForFund, type CapacityReading } from './capacity-view';

const sector: CapacityReading = {
  fundId: 'inst',
  ruleCode: 'FUND_SECTOR_BOOK_PCT',
  ruleName: 'Sector share of invested book',
  groupValue: 'Consumer brands',
  trancheIds: ['tl', 'ddtl'],
  room: 16.65e6,
  numerator: 20.59e6,
  denominator: 132.32e6,
  hardLimit: 25,
  softLimit: 20,
  resultUnit: 'PERCENTAGE',
  denominatorGrows: true,
};

describe('capacity view', () => {
  it('reads the current share and the share with the allocation counted on both sides', () => {
    assert.ok(Math.abs((figure(sector, 0) ?? 0) - 15.5607) < 1e-3);
    // Taking all of the room lands on the limit.
    assert.ok(Math.abs((figure(sector, sector.room) ?? 0) - 25) < 0.01);
  });

  it('calls the full room at limit, part of it over the soft limit, and more than it over limit', () => {
    assert.equal(standing(sector, sector.room).label, 'At limit');
    // compliance.evaluate_rule passes a figure exactly at the hard limit, so the grid does too.
    assert.notEqual(standing(sector, sector.room).tone, 'breach');
    assert.equal(standing(sector, 12.49e6).label, 'Over soft limit');
    assert.equal(standing(sector, 0).currentLabel, 'Within limit');
    assert.equal(standing(sector, 20e6).tone, 'breach');
  });

  it('reads an amount rule as the numerator plus the allocation', () => {
    const gross: CapacityReading = { ...sector, ruleName: 'Gross invested exposure', groupValue: null, resultUnit: 'CURRENCY', numerator: 132.32e6, denominator: null, hardLimit: 1250e6, softLimit: null, room: 1117.68e6, denominatorGrows: false };
    assert.equal(standing(gross, 10e6).proForma, 142.32e6);
    assert.equal(standing(gross, 10e6).tone, 'ok');
  });

  it('shows a sleeve reading on its portfolio when the portfolio has none for that rule, tightest first', () => {
    const issuer: CapacityReading = { ...sector, fundId: 'hsi', ruleCode: 'FUND_ISSUER_NAV_PCT', ruleName: 'Single-issuer share of NAV', groupValue: 'Harbor Labs', numerator: 0, denominator: 2000e6, hardLimit: 3, softLimit: 2.4, room: 60e6, denominatorGrows: false };
    const rows = [
      { fundId: 'hsi', cells: [{ trancheId: 'tl', amount: 20e6 }, { trancheId: 'ddtl', amount: 6e6 }] },
      { fundId: 'inst', parentFundId: 'hsi', cells: [{ trancheId: 'tl', amount: 16e6 }, { trancheId: 'ddtl', amount: 0.6e6 }] },
    ];
    const list = standingsForFund('hsi', [issuer, sector], rows);
    assert.deepEqual(list.map((item) => item.reading.ruleCode), ['FUND_SECTOR_BOOK_PCT', 'FUND_ISSUER_NAV_PCT']);
    assert.equal(list[0].ownerId, 'inst');
    assert.equal(list[0].used, 16.6e6);
    assert.equal(list[1].used, 26e6);
  });

  it('reads a 0 limit as not permitted, and as held when an amount is placed anyway', () => {
    const banned: CapacityReading = { ...sector, ruleCode: 'FUND_INSTRUMENT_EXPOSURE', ruleName: 'Permitted instrument types', groupValue: 'REVOLVING_CREDIT', resultUnit: 'CURRENCY', numerator: 0, denominator: null, hardLimit: 0, softLimit: null, room: 0, denominatorGrows: false };
    assert.equal(standing(banned, 0).label, 'Not permitted');
    assert.equal(standing(banned, 0).tone, 'blocked');
    assert.equal(standing(banned, 5e6).label, 'Not permitted, held');
  });
  it('passes what the evaluator passes: a room-only rule used exactly, and a floor met exactly', () => {
    const composite: CapacityReading = { ...sector, ruleName: 'Composite ratio', numerator: null, denominator: null, room: 10e6 };
    assert.equal(standing(composite, 10e6).tone, 'near');
    assert.equal(standing(composite, 10e6).label, 'At limit');
    assert.equal(standing(composite, 10e6 + 1).tone, 'breach');
    const floor: CapacityReading = { ...sector, ruleName: 'Minimum liquidity', limitDirection: 'MIN', resultUnit: 'CURRENCY', numerator: 50e6, denominator: null, hardLimit: 50e6, softLimit: null, room: 0 };
    assert.notEqual(standing(floor, 0).currentTone, 'breach');
    assert.equal(standing({ ...floor, numerator: 49e6 }, 0).currentTone, 'breach');
  });
});
