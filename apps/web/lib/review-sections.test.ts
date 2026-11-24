import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { byRecord, finKeys, groupsByRecord, isRecSection, recKey, recKeys, reviewSections, sectioned, shareText } from './review-sections';

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

  it('puts the changes of a table under the record each is aimed at', () => {
    const on = (id: string, entityId: string, label: string) => ({ ...change(id, 'submit_manual_override'), target: { kind: 'Borrower', label, entityId } });
    const groups = byRecord([on('a', 'e1', 'Northwind'), on('b', 'e2', 'Harbor'), on('c', 'e1', 'Northwind')]);
    assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [['Northwind', ['a', 'c']], ['Harbor', ['b']]]);
    assert.equal(groupsByRecord(groups), true);
    assert.equal(groupsByRecord(byRecord([on('a', 'e1', 'Northwind'), on('b', 'e2', 'Harbor')])), false);
  });

  it('gives a borrower review its own sections, and reads each borrower and covenant once', () => {
    const sections = reviewSections([
      change('n', 'save_borrower_review', { entityId: 'B1', periodEnd: '2026-09-30' }),
      change('c', 'record_borrower_covenant_value', { entityId: 'C1', testDate: '2026-09-30', value: 2.76 }),
      change('l', 'load_position_file_table', { instanceId: 'F1' }),
    ]);
    // What is loaded comes first, then what the certificate says, and the notes last.
    assert.deepEqual(sections.map((section) => section.kind), ['general', 'fin-certificates', 'fin-review']);
    assert.equal(sectioned(sections), true);
    assert.deepEqual(sections.map((section) => isRecSection(section.kind)), [false, false, false]);
    const keys = finKeys(sections, [{ view: 'fin.borrower', args: { entityId: 'B1', periodEnd: '2026-09-30' } }, { view: 'fin.borrower', args: { entityId: 'B2' } }, { view: 'rec.nav', args: { fundId: 'F' } }]);
    assert.deepEqual(keys.borrowers.map((key) => key.key), ['B1|2026-09-30', 'B2|']);
    assert.deepEqual(keys.covenants.map((key) => key.key), ['C1|2026-09-30']);
    // A borrower section reads no fund's close.
    assert.deepEqual(recKeys(sections), []);
  });

  it('says how big a difference is beside its figure', () => {
    assert.equal(shareText(-57_000, 10_682_000), '0.53%');
    assert.equal(shareText(-57_000, 1_641_847_000), 'under 0.01%');
    assert.equal(shareText(250_000, 10_000_000), '2.5%');
    assert.equal(shareText(0, 10_000_000), '0%');
    assert.equal(shareText(5, 0), null);
  });
});
