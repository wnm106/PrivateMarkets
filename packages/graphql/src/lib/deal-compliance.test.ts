import { describe, expect, it } from 'vitest';
import { dealSurfaceResults, loadDealScorePlans } from './deal-compliance';

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

// Which rules apply to which fund is compliance.deal_score_plans. Its cases
// (deal-surface rules on every fund, enrolled rules only where a limit is
// assigned, an opt-out wins, inactive rules skipped) are database tests in
// supabase/tests/deal_capacity.sql.
describe('loadDealScorePlans', () => {
  function fakeCompliance(planRows: unknown[], ruleRows: unknown[]) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: planRows, error: null };
      },
      from: (_table: string) => ({
        select: () => ({
          in: async (_column: string, ids: string[]) => ({ data: (ruleRows as any[]).filter((row) => ids.includes(row.id)), error: null }),
        }),
      }),
    };
  }

  it('reads the plan from the database and attaches each rule and its group label', async () => {
    const compliance = fakeCompliance(
      [
        { rule_id: 'pf', rule_code: 'PF_ISSUER_CONCENTRATION', anchor_ids: ['fund', 'sleeve'], group_label: 'Issuer' },
        { rule_id: 'gone', rule_code: 'DELETED_RULE', anchor_ids: ['fund'], group_label: null },
      ],
      [{ id: 'pf', rule_code: 'PF_ISSUER_CONCENTRATION', is_active: false }],
    );
    const plans = await loadDealScorePlans(compliance, ['fund', 'sleeve', 'fund'], '2026-11-21');
    expect(compliance.calls).toEqual([{ fn: 'deal_score_plans', args: { p_fund_ids: ['fund', 'sleeve'], p_as_of_date: '2026-11-21' } }]);
    expect(plans).toEqual([
      { rule: { id: 'pf', rule_code: 'PF_ISSUER_CONCENTRATION', is_active: false }, anchorIds: ['fund', 'sleeve'], groupLabel: 'Issuer' },
    ]);
  });

  it('asks nothing when the deal has no funds', async () => {
    const compliance = fakeCompliance([], []);
    expect(await loadDealScorePlans(compliance, [], '2026-11-21')).toEqual([]);
    expect(compliance.calls).toEqual([]);
  });
});
