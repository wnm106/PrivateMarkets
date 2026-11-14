import { describe, expect, it } from 'vitest';
import { parseFundBoardResultPayload, selectLatestFundResults, type FundBoardResultRow } from './fund-board-results';

function row(overrides: Partial<FundBoardResultRow> & Pick<FundBoardResultRow, 'rule_id' | 'anchor_entity_id' | 'status'>): FundBoardResultRow {
  return {
    group_by_value: null,
    rank_position: null,
    evaluated_at: '2026-09-30T00:00:00Z',
    id: '1',
    ...overrides,
  };
}

describe('selectLatestFundResults', () => {
  it('keeps the newest score for a fund and leaves an older score for a fund the later run skipped', () => {
    const selected = selectLatestFundResults([
      row({ rule_id: 'r', anchor_entity_id: 'parent', status: 'PASS', evaluated_at: '2026-09-01T00:00:00Z', id: 'a' }),
      row({ rule_id: 'r', anchor_entity_id: 'parent', status: 'HARD_BREACH', evaluated_at: '2026-10-01T00:00:00Z', id: 'b' }),
      row({ rule_id: 'r', anchor_entity_id: 'child', status: 'PASS', evaluated_at: '2026-09-01T00:00:00Z', id: 'c' }),
    ]);
    expect(selected.map((item) => item.id).sort()).toEqual(['b', 'c']);
  });

  it('treats group and rank as separate grains and breaks timestamp ties by id', () => {
    const selected = selectLatestFundResults([
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'PASS', group_by_value: 'Banks', rank_position: 1, id: 'a' }),
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'SOFT_BREACH', group_by_value: 'Banks', rank_position: 2, id: 'b' }),
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'PASS', group_by_value: 'Energy', rank_position: 1, id: 'c' }),
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'PASS', id: 'd' }),
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'HARD_BREACH', id: 'e' }),
    ]);
    expect(selected.map((item) => item.id).sort()).toEqual(['a', 'b', 'c', 'e']);
  });

  it('hides a no-data placeholder once the same fund has a scored group', () => {
    const selected = selectLatestFundResults([
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'NO_DATA', group_by_value: 'Cash' }),
      row({ rule_id: 'r', anchor_entity_id: 'fund', status: 'PASS', group_by_value: 'Banks', id: 'scored' }),
      row({ rule_id: 'r', anchor_entity_id: 'other', status: 'NO_DATA', id: 'empty' }),
    ]);
    expect(selected.map((item) => item.id).sort()).toEqual(['empty', 'scored']);
  });
});

describe('parseFundBoardResultPayload', () => {
  it('accepts an array or a JSON string and treats anything else as no rows', () => {
    expect(parseFundBoardResultPayload('[{"rule_id":"r"}]')).toEqual([{ rule_id: 'r' }]);
    expect(parseFundBoardResultPayload([{ rule_id: 'r' }])).toEqual([{ rule_id: 'r' }]);
    expect(parseFundBoardResultPayload(null)).toEqual([]);
    expect(parseFundBoardResultPayload({})).toEqual([]);
  });
});
