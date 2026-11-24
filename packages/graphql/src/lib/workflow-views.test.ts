import { describe, expect, it } from 'vitest';
import { asProposal } from './workflow-proposal';
import { WORKFLOW_TEMPLATES } from './workflow-templates';
import { MAX_VIEWS, REVIEW_VIEWS, normalizeViews } from './workflow-views';

describe('views an agent shows its reviewer', () => {
  it('keeps a view the step allows, with only the settings it takes', () => {
    const { views, refused } = normalizeViews(
      [{ view: 'rec.cash', args: { fundId: 'HARBOR', periodEnd: '2026-09-30', other: 'dropped' }, focus: ['txn-1', '', 'flow-2'], why: 'The two flows settle one wire.' }],
      ['rec.cash', 'rec.nav'],
    );
    expect(refused).toEqual([]);
    expect(views).toEqual([{ id: 'view-1', view: 'rec.cash', args: { fundId: 'HARBOR', periodEnd: '2026-09-30' }, focus: ['txn-1', 'flow-2'], why: 'The two flows settle one wire.' }]);
  });

  it('refuses a view that does not exist, one the step does not allow, and one missing its fund', () => {
    const { views, refused } = normalizeViews(
      [
        { view: 'perf.attribution', args: { fundId: 'F' } },
        { view: 'rec.nav', args: { fundId: 'F' } },
        { view: 'rec.cash', args: {} },
      ],
      ['rec.cash'],
    );
    expect(views).toEqual([]);
    expect(refused[0]).toMatch(/"perf.attribution" is not a view/);
    expect(refused[1]).toMatch(/rec.nav is not a view this step can show. It can show rec.cash/);
    expect(refused[2]).toMatch(/rec.cash needs fundId/);
  });

  it(`shows at most ${MAX_VIEWS} views, with unique ids`, () => {
    const ask = Array.from({ length: MAX_VIEWS + 2 }, () => ({ id: 'cash', view: 'rec.cash', args: { fundId: 'F' } }));
    const { views, refused } = normalizeViews(ask, null);
    expect(views).toHaveLength(MAX_VIEWS);
    expect(new Set(views.map((view) => view.id)).size).toBe(MAX_VIEWS);
    expect(refused).toHaveLength(1);
  });

  it('are kept on a stored proposal, and a proposal without them stays as it was', () => {
    const stored = asProposal({ items: [], views: [{ id: 'v', view: 'rec.nav', args: { fundId: 'F' }, focus: ['fee'], why: 'w' }, { view: 'nonsense' }] });
    expect(stored.views).toEqual([{ id: 'v', view: 'rec.nav', args: { fundId: 'F' }, focus: ['fee'], why: 'w' }]);
    expect(asProposal({ items: [] })).toEqual({ items: [] });
  });

  it('are offered to the reconciliation agent of Fund reconciliation', () => {
    const graph = WORKFLOW_TEMPLATES.find((template) => template.code === 'FUND_RECONCILIATION')!.graph;
    const reconcile = graph.nodes.find((node) => node.id === 'reconcile')!;
    // Every reconciliation view, and no view of another kind of work.
    expect(reconcile.config.showable).toEqual(REVIEW_VIEWS.map((view) => view.code).filter((code) => code.startsWith('rec.')));
  });
});
