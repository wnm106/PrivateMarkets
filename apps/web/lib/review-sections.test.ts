import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { recKey, recKeys, reviewSections, sectioned } from './review-sections';

function change(id: string, tool: string, args: Record<string, unknown> = {}): ProposalItem {
  return { id, action: 'UPDATE', target: { kind: 'Fund', label: 'Harbor' }, summary: id, tool, args, confidence: 'HIGH', needsReview: false, rationale: '', evidence: [], missing: [] };
}

describe('a review in sections', () => {
  it('groups a reconciliation by kind of change, notes last, in the order to decide them', () => {
    const sections = reviewSections([
      change('notes', 'save_reconciliation_notes', { fundId: 'HARBOR' }),
      change('fee', 'record_rec_decision', { fundId: 'HARBOR', itemId: 'fee' }),
      change('pair1', 'approve_cash_match', { fundId: 'HARBOR' }),
      change('adj', 'post_cash_adjustment', { fundId: 'HARBOR' }),
      change('pair2', 'approve_cash_match', { fundId: 'HARBOR' }),
    ]);
    assert.deepEqual(sections.map((section) => [section.kind, section.items.map((item) => item.id)]), [
      ['cash-pairs', ['pair1', 'pair2']],
      ['cash-adjustments', ['adj']],
      ['rec-decisions', ['fee']],
      ['rec-notes', ['notes']],
    ]);
    assert.equal(sectioned(sections), true);
  });

  it('keeps any other change in the general table, and needs no sections when that is all there is', () => {
    const only = reviewSections([change('a', 'submit_manual_override'), change('b', 'load_position_file_table')]);
    assert.deepEqual(only.map((section) => section.kind), ['general']);
    assert.equal(sectioned(only), false);
    const mixed = reviewSections([change('a', 'submit_manual_override'), change('n', 'save_reconciliation_notes', { fundId: 'F' })]);
    assert.deepEqual(mixed.map((section) => section.kind), ['general', 'rec-notes']);
    assert.deepEqual(reviewSections([]), []);
  });

  it('reads each fund and period once, for the sections and the views the agent chose', () => {
    const sections = reviewSections([
      change('p', 'approve_cash_match', { fundId: 'HARBOR', periodEnd: '2026-09-30' }),
      change('d', 'record_rec_decision', { fundId: 'HARBOR', periodEnd: '2026-09-30' }),
      change('n', 'save_reconciliation_notes', { fundId: 'BRIGHT' }),
      change('o', 'submit_manual_override', { fundId: 'IGNORED' }),
    ]);
    const keys = recKeys(sections, [{ view: 'rec.cash', args: { fundId: 'HARBOR', periodEnd: '2026-09-30' } }, { view: 'rec.nav', args: { fundId: 'CLO' } }]);
    assert.deepEqual(keys.map((key) => key.key), ['HARBOR|2026-09-30', 'BRIGHT|', 'CLO|']);
    assert.equal(recKey('', '2026-09-30'), null);
    assert.deepEqual(recKey(' F1 ', ' '), { key: 'F1|', fundId: 'F1', periodEnd: null });
  });
});
