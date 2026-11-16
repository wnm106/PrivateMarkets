import { describe, expect, it } from 'vitest';
import { describeFilters, hasFilters, parseFilters, selectedIds } from './workflow-filters';
import { nextNode, resolveTemplates } from './workflow-graph';
import { FILTERS_EXAMPLE, WORKFLOW_TEMPLATES } from './workflow-templates';

describe('parseFilters', () => {
  it('reads codes as a list or as text, and drops blanks and repeats', () => {
    const filters = parseFilters({ domainCode: ' fund ', entityCodes: 'HSCF2, HOCF1,,HSCF2', entityIds: ['a', '', 'a'], nameContains: '  ', limit: '5' });
    expect(filters).toEqual({ domainCode: 'FUND', entityCodes: ['HSCF2', 'HOCF1'], entityIds: ['a'], nameContains: null, limit: 5 });
    expect(describeFilters(filters)).toBe('type FUND; code HSCF2, HOCF1; 1 record id');
  });

  it('treats nothing, blanks, and a limit alone as no restriction', () => {
    for (const raw of [undefined, null, 'FUND', {}, FILTERS_EXAMPLE, { limit: 10 }, { entityCodes: [] }]) {
      expect(hasFilters(parseFilters(raw))).toBe(false);
    }
    expect(describeFilters(parseFilters({}))).toBe('every record');
    expect(parseFilters({ limit: 100000 }).limit).toBe(500);
    expect(parseFilters({ limit: -1 }).limit).toBe(100);
  });
});

describe('selectedIds', () => {
  it('keeps "no selection" apart from "a selection that is empty"', () => {
    expect(selectedIds(undefined)).toBeNull();
    expect(selectedIds(null)).toBeNull();
    expect(selectedIds([])).toEqual([]);
    expect(selectedIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });
});

describe('templates and the records they run on', () => {
  const real = WORKFLOW_TEMPLATES.filter((template) => template.code !== 'BLANK');

  it('start every template by selecting records from the run\'s filters', () => {
    for (const template of real) {
      const first = nextNode(template.graph, 'start', null);
      expect(first).toMatchObject({ id: 'select', type: 'tool', config: { tool: 'find_records' } });
      expect(template.inputExample.filters).toEqual(FILTERS_EXAMPLE);
    }
  });

  it('name no record, type of record, or record filter of their own', () => {
    for (const template of real) {
      for (const node of template.graph.nodes) {
        if (node.id === 'select') continue;
        const settings = JSON.stringify(node.config);
        // The only way a step learns which records to work on is the selection step.
        expect(settings).not.toMatch(/\{\{\s*input\.(filters|fund|domainCode|entity\w*)/);
        if (node.type === 'tool') {
          const args = (node.config.args || {}) as Record<string, unknown>;
          expect(Object.keys(args).filter((key) => /^(domainCode|fundId|entityId|entityCode|entityCodes)$/.test(key))).toEqual([]);
          if ('entityIds' in args) expect(args.entityIds).toBe('{{steps.select.entityIds}}');
        }
      }
    }
  });

  it('pass a selection on as a list, and no selection as nothing', () => {
    const args = { status: 'OPEN', entityIds: '{{steps.select.entityIds}}', first: '{{input.limit}}' };
    expect(resolveTemplates(args, { input: { limit: 20 }, steps: { select: { filtered: false } } })).toEqual({ status: 'OPEN', first: 20 });
    expect(resolveTemplates(args, { input: {}, steps: { select: { filtered: true, entityIds: [] } } })).toEqual({ status: 'OPEN', entityIds: [] });
    expect(resolveTemplates(args, { input: {}, steps: { select: { filtered: true, entityIds: ['a'] } } })).toEqual({ status: 'OPEN', entityIds: ['a'] });
  });
});
