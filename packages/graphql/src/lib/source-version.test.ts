import { describe, expect, it } from 'vitest';
import { dayBefore, planSourceVersion, planVersionDelete } from './source-version';

const row = (id: string, valid_from: string, valid_to = '9999-12-31') => ({ id, valid_from, valid_to });

describe('planSourceVersion', () => {
  it('keeps the current value up to the day before a future-dated change', () => {
    const plan = planSourceVersion([row('a', '2026-11-07')], '2026-11-22');
    expect(plan.close.map((r) => r.id)).toEqual(['a']);
    expect(plan.keepBefore).toEqual([{ row: row('a', '2026-11-07'), validTo: '2026-11-21' }]);
    expect(plan.newValidTo).toBe('9999-12-31');
  });

  it('replaces a value that starts on the same day without keeping a slice', () => {
    const plan = planSourceVersion([row('a', '2026-11-22')], '2026-11-22');
    expect(plan.close.map((r) => r.id)).toEqual(['a']);
    expect(plan.keepBefore).toEqual([]);
  });

  it('stops a back-dated change before a value already scheduled for later', () => {
    const plan = planSourceVersion([row('a', '2026-01-01', '2026-11-30'), row('b', '2026-12-01')], '2026-11-22');
    expect(plan.close.map((r) => r.id)).toEqual(['a']);
    expect(plan.keepBefore[0].validTo).toBe('2026-11-21');
    expect(plan.newValidTo).toBe('2026-11-30');
  });

  it('ignores rows that ended before the change', () => {
    const plan = planSourceVersion([row('a', '2020-01-01', '2026-01-01')], '2026-11-22');
    expect(plan.close).toEqual([]);
    expect(plan.newValidTo).toBe('9999-12-31');
  });

  it('steps back across a month and a year', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });
});

describe('planVersionDelete', () => {
  it('lets the prior value resume when a future value is removed', () => {
    const prior = row('a', '2026-11-07', '2026-11-25');
    const future = row('b', '2026-11-26');
    const plan = planVersionDelete([prior, future], future);
    expect(plan.extend?.id).toBe('a');
    expect(plan.extendTo).toBe('9999-12-31');
  });

  it('closes a gap in the middle of the timeline', () => {
    const plan = planVersionDelete(
      [row('a', '2026-01-01', '2026-05-31'), row('b', '2026-06-01', '2026-08-31'), row('c', '2026-09-01')],
      row('b', '2026-06-01', '2026-08-31'),
    );
    expect(plan.extend?.id).toBe('a');
    expect(plan.extendTo).toBe('2026-08-31');
  });

  it('leaves the days to other sources when nothing comes right before', () => {
    const plan = planVersionDelete([row('a', '2020-01-01', '2026-01-01'), row('b', '2026-11-26')], row('b', '2026-11-26'));
    expect(plan.extend).toBeNull();
  });
});
