import { describe, expect, it } from 'vitest';
import { dealSurfaceResults, dealSurfaceRules, rulesToScore } from './deal-compliance';

describe('dealSurfaceRules', () => {
  it('keeps the pro forma rules and leaves the rest of the fund book out', () => {
    const selected = dealSurfaceRules([
      { rule_code: 'FUND_ISSUER_NAV_PCT' },
      { rule_code: 'PF_ISSUER_CONCENTRATION' },
      { rule_code: 'CLO_OC_AB' },
      { rule_code: 'PF_SPONSOR_CONCENTRATION' },
      { rule_code: 'PF_UNFUNDED_COMMITMENTS' },
    ]);
    expect(selected.map((rule) => rule.rule_code)).toEqual([
      'PF_ISSUER_CONCENTRATION',
      'PF_SPONSOR_CONCENTRATION',
      'PF_UNFUNDED_COMMITMENTS',
    ]);
  });
});

describe('dealSurfaceResults', () => {
  const meridian = 'meridian';
  const sleeve = 'sleeve';
  const other = 'other-fund';
  const proposal = 'proposal';

  it('drops funds that are not on the deal and keeps a group the proposal sits in', () => {
    const selected = dealSurfaceResults([
      { ruleId: 'issuer', anchorEntityId: meridian, contributingEntityIds: ['booked'] },
      { ruleId: 'issuer', anchorEntityId: meridian, contributingEntityIds: [proposal, 'booked'] },
      { ruleId: 'issuer', anchorEntityId: sleeve, contributingEntityIds: [proposal] },
      { ruleId: 'issuer', anchorEntityId: other, contributingEntityIds: [proposal] },
    ], new Set([meridian, sleeve]), new Set([proposal]));
    expect(selected.map((row) => row.anchorEntityId)).toEqual([meridian, sleeve]);
    expect(selected[0].contributingEntityIds).toEqual([proposal, 'booked']);
  });

  it('keeps an assigned rule the deal does not land in', () => {
    const selected = dealSurfaceResults([
      { ruleId: 'issuer', anchorEntityId: meridian, contributingEntityIds: [proposal] },
      { ruleId: 'sector', anchorEntityId: meridian, contributingEntityIds: ['booked'] },
    ], new Set([meridian]), new Set([proposal]));
    expect(selected.map((row) => row.ruleId)).toEqual(['issuer', 'sector']);
  });

  it('keeps the fund scores when no result lists a proposal', () => {
    const selected = dealSurfaceResults([
      { ruleId: 'issuer', anchorEntityId: meridian, contributingEntityIds: ['booked'] },
      { ruleId: 'issuer', anchorEntityId: other, contributingEntityIds: ['booked'] },
    ], new Set([meridian]), new Set([proposal]));
    expect(selected).toHaveLength(1);
    expect(selected[0].anchorEntityId).toBe(meridian);
  });

  it('returns every deal fund when nothing has been proposed yet', () => {
    const selected = dealSurfaceResults([
      { ruleId: 'issuer', anchorEntityId: meridian, contributingEntityIds: ['booked'] },
    ], new Set([meridian]), new Set());
    expect(selected).toHaveLength(1);
  });
});

describe('rulesToScore', () => {
  const meridian = 'meridian';
  const sleeve = 'sleeve';
  const asOf = '2026-11-16';

  it('scores pro forma rules for every fund and enrolled rules only where a limit applies', () => {
    const plans = rulesToScore([
      { id: 'pf', rule_code: 'PF_ISSUER_CONCENTRATION', is_active: false },
      { id: 'sector', rule_code: 'FUND_SECTOR_BOOK_PCT', is_active: true },
      { id: 'issuer', rule_code: 'FUND_ISSUER_NAV_PCT', is_active: true },
      { id: 'closed', rule_code: 'FUND_GROSS_EXPOSURE', is_active: true },
      { id: 'retired', rule_code: 'FUND_POSITION_COUNT', is_active: false },
    ], [
      { rule_id: 'sector', entity_id: sleeve, applies: true, valid_to: '9999-12-31' },
      { rule_id: 'sector', entity_id: sleeve, group_value: 'Industrial distribution', applies: true },
      { rule_id: 'issuer', entity_id: sleeve, applies: true, rank_from: 1, valid_to: '9999-12-31' },
      { rule_id: 'closed', entity_id: meridian, applies: false },
      { rule_id: 'closed', entity_id: meridian, applies: true, rank_from: 1 },
      { rule_id: 'retired', entity_id: meridian, applies: true },
    ], new Set([meridian, sleeve]), asOf);

    expect(plans.map((plan) => [plan.rule.rule_code, plan.ignoreEnrollment, plan.anchorIds])).toEqual([
      ['PF_ISSUER_CONCENTRATION', true, [meridian, sleeve]],
      ['FUND_SECTOR_BOOK_PCT', true, [sleeve]],
      ['FUND_ISSUER_NAV_PCT', true, [sleeve]],
    ]);
  });
});
