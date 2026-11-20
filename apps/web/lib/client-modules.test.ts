import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterByTools, moduleAllowsSurface, parseModuleScope } from './client-modules';

const tools = [
  { href: '/fund-surface', label: 'Fund surface' },
  { href: '/s/deal-pipeline', label: 'Deal Pipeline' },
  { href: '/imports', label: 'Load data' },
];

describe('module scope', () => {
  it('keeps every surface and tool when the session is unrestricted', () => {
    const scope = parseModuleScope({ restricted: false, surfaces: [], tools: [] });
    assert.equal(moduleAllowsSurface(scope, 'deal-pipeline'), true);
    assert.deepEqual(filterByTools(tools, scope).map((tool) => tool.href), tools.map((tool) => tool.href));
  });

  it('keeps an unexpected payload unrestricted', () => {
    assert.equal(parseModuleScope(null).restricted, false);
    assert.equal(parseModuleScope('nope').restricted, false);
  });

  it('limits a curated session to the saved surfaces and tools', () => {
    const scope = parseModuleScope({
      restricted: true,
      surfaces: ['fund-index', 12, ''],
      tools: ['/fund-surface'],
    });
    assert.equal(moduleAllowsSurface(scope, 'fund-index'), true);
    assert.equal(moduleAllowsSurface(scope, 'deal-pipeline'), false);
    assert.deepEqual(filterByTools(tools, scope).map((tool) => tool.href), ['/fund-surface']);
  });

  it('hides every tool when a curated client has none saved', () => {
    const scope = parseModuleScope({ restricted: true, surfaces: [], tools: [] });
    assert.deepEqual(filterByTools(tools, scope), []);
    assert.equal(moduleAllowsSurface(scope, 'fund-index'), false);
  });
});
