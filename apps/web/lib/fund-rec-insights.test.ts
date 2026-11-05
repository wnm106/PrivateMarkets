import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRecInsights, recInsightPayload, withoutRuleEchoes } from './fund-rec-insights';

describe('parseRecInsights', () => {
  it('keeps four complete points and drops a severity it does not know', () => {
    const points = parseRecInsights({
      points: [
        { title: 'Cash yield stepped up', detail: 'Cash interest rose faster than investments.', severity: 'watch' },
        { title: ' ', detail: 'missing title' },
        { title: 'Odd one', detail: 'A note.', severity: 'urgent' },
        { title: 'Third', detail: 'Still useful.', severity: 'info' },
        { title: 'Fourth', detail: 'Also useful.', severity: 'break' },
        { title: 'Fifth', detail: 'This one is past the cap.', severity: 'info' },
      ],
    });
    assert.equal(points.length, 4);
    assert.equal(points[0].severity, 'watch');
    assert.equal(points[1].severity, 'info');
    assert.equal(points[3].title, 'Fourth');
  });

  it('drops a point that restates a rule', () => {
    const kept = withoutRuleEchoes(
      [
        { title: 'Management fee accrual', detail: 'Same item.', severity: 'watch' },
        { title: 'Cash built without a call', detail: 'Cash rose while contributions were flat.', severity: 'info' },
      ],
      ['Management fee accrual'],
    );
    assert.deepEqual(kept.map((point) => point.title), ['Cash built without a call']);
  });
});

describe('recInsightPayload', () => {
  it('sends fund totals and only position rows that miss the tie', () => {
    const payload = recInsightPayload({
      fundName: 'Halyard',
      periodEnd: '2026-09-30',
      periodLabel: 'Q3 2026',
      navReported: 343_800_000,
      navProposed: 343_800_000,
      navPrior: 313_600_000,
      navChangePct: 9.6,
      netIrr: 8.7,
      health: 'IN_REVIEW',
      healthNote: '6 items to decide',
      items: [{ title: 'Management fee accrual', why: 'Fee base', admin: 1, ours: 2, effect: -1 }],
      checks: [],
      statements: [],
      drift: [],
      marks: [],
      accruals: [],
      mgmtFee: { rate: 1.5 },
      perfFee: { ready: false },
      roll: {
        present: true,
        tied: false,
        total: [10],
        ties: [],
        rows: [
          { name: 'Sleeve', group: 'Senior', values: [0, 1000], header: true },
          { name: 'Small', group: 'Senior', values: [0, 1000], header: false },
          { name: 'Large', group: 'Senior', values: [0, 20_000], header: false },
        ],
      },
    });
    assert.deepEqual(payload.positionBreaks, [{ name: 'Large', group: 'Senior', difference: 20_000 }]);
    assert.equal(payload.rules[0].title, 'Management fee accrual');
    assert.equal('rows' in payload.roll, false);
  });
});
