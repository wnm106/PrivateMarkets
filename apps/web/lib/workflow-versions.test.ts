import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffGraphs, diffIsEmpty, duration, exportWorkflow, freeCode, readExport } from './workflow-versions';

const node = (id: string, label: string, config: Record<string, unknown> = {}, type = 'tool') => ({ id, type: type as never, label, position: { x: 0, y: 0 }, config });

const before = {
  nodes: [node('start', 'Start', {}, 'start'), node('scan', 'Scan', { tool: 'list_dq_exceptions', args: { first: 5 } }), node('old', 'Old step'), node('end', 'End', {}, 'end')],
  edges: [{ id: 'a', from: 'start', to: 'scan' }, { id: 'b', from: 'scan', to: 'old' }, { id: 'c', from: 'old', to: 'end' }],
};
const after = {
  nodes: [
    { ...node('start', 'Start', {}, 'start'), position: { x: 50, y: 90 } },
    node('scan', 'Scan exceptions', { tool: 'list_dq_exceptions', args: { first: 10 } }),
    node('review', 'Review', { source: 'x' }, 'review'),
    node('end', 'End', {}, 'end'),
  ],
  edges: [{ id: 'a', from: 'start', to: 'scan' }, { id: 'd', from: 'scan', to: 'review' }, { id: 'e', from: 'review', to: 'end' }],
};

describe('workflow versions', () => {
  it('names what was added, removed, changed, and reconnected, but not what moved', () => {
    const diff = diffGraphs(before, after);
    assert.deepEqual(diff.added.map((step) => step.id), ['review']);
    assert.deepEqual(diff.removed.map((step) => step.id), ['old']);
    assert.deepEqual(diff.changed, [{ id: 'scan', label: 'Scan exceptions', settings: ['args'], renamed: true }]);
    assert.deepEqual(diff.connectionsAdded, ['Scan exceptions → Review', 'Review → End']);
    assert.deepEqual(diff.connectionsRemoved, ['Scan → Old step', 'Old step → End']);
    assert.equal(diffIsEmpty(diffGraphs(before, before)), true);
  });

  it('exports without named people, and reads the file back', () => {
    const graph = { nodes: [node('r', 'Review', { people: ['u1'], roles: ['OPS_LEAD'] }, 'review')], edges: [] };
    const file = exportWorkflow({ code: 'DATA_CLEANUP', name: 'Data cleanup', description: null, version: 3, graph }, new Date('2026-11-17T00:00:00Z'));
    assert.deepEqual(file.graph.nodes[0].config, { people: [], roles: ['OPS_LEAD'] });
    const back = readExport(JSON.stringify(file));
    assert.equal(back.ok, true);
    if (back.ok) assert.equal(back.value.exportedFromVersion, 3);
    assert.deepEqual(readExport('nope'), { ok: false, message: 'The file is not JSON.' });
    assert.deepEqual(readExport('{"format":"other"}'), { ok: false, message: 'The file is not an exported workflow.' });
  });

  it('picks a code that is not taken', () => {
    assert.equal(freeCode('data cleanup', new Set()), 'DATA_CLEANUP');
    assert.equal(freeCode('DATA_CLEANUP', new Set(['DATA_CLEANUP', 'DATA_CLEANUP_2'])), 'DATA_CLEANUP_3');
    assert.equal(freeCode('', new Set()), 'IMPORTED_WORKFLOW');
  });

  it('says how long, briefly', () => {
    assert.equal(duration(42), '42s');
    assert.equal(duration(95), '1m 35s');
    assert.equal(duration(7200), '2h');
    assert.equal(duration(200000), '2d 8h');
    assert.equal(duration(null), '—');
  });
});
