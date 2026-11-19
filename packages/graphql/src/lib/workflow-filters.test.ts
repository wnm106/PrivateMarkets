import { describe, expect, it } from 'vitest';
import { buildRunInput, describeFilters, hasFilters, parseFilters, parseRunSetup, prepareRunInput, runSetupOf, selectedIds } from './workflow-filters';
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
  // A run of these works on one stored file, not on records chosen by filters.
  const onAFile = new Set(['FILE_INTAKE']);

  it('start a template that works on a file with that file, and with no filters', () => {
    for (const template of real.filter((candidate) => onAFile.has(candidate.code))) {
      expect(template.inputExample).toEqual({ importInstanceId: '' });
      expect(JSON.stringify(nextNode(template.graph, 'start', null)?.config)).toContain('{{input.importInstanceId}}');
      expect(template.graph.nodes.some((node) => node.config.tool === 'find_records')).toBe(false);
    }
  });

  it('start every template by selecting records from the run\'s filters', () => {
    for (const template of real.filter((candidate) => !onAFile.has(candidate.code))) {
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

describe('what a workflow asks for when a run starts', () => {
  const fund = parseRunSetup({ appliesTo: 'fund', inputs: [{ key: 'periodEnd', label: 'Period end', type: 'date' }, { key: 'filters' }, { key: 'periodEnd' }, { key: 'limit', type: 'number' }] });
  const any = parseRunSetup(undefined);

  it('reads the Start step, dropping an input that would shadow the filters or repeat a key', () => {
    expect(fund).toEqual({ appliesTo: 'FUND', requiresRecords: false, inputs: [{ key: 'periodEnd', label: 'Period end', type: 'date' }, { key: 'limit', label: 'limit', type: 'number' }] });
    expect(any).toEqual({ appliesTo: null, requiresRecords: false, inputs: [] });
  });

  it('is declared by every template, and never as a filter', () => {
    const by = (code: string) => runSetupOf(WORKFLOW_TEMPLATES.find((template) => template.code === code)!.graph);
    expect(by('FUND_RECONCILIATION')).toMatchObject({ appliesTo: 'FUND', requiresRecords: false, inputs: [{ key: 'periodEnd' }] });
    expect(by('CLOSING_READINESS').appliesTo).toBe('DEAL');
    expect(by('DATA_CLEANUP').appliesTo).toBeNull();
    expect(by('REQUIRED_VALUES_CHECK').requiresRecords).toBe(true);
    for (const template of WORKFLOW_TEMPLATES) {
      const start = template.graph.nodes.find((node) => node.type === 'start')!;
      expect(Object.keys(start.config).sort()).toEqual(['appliesTo', 'inputs', 'requiresRecords']);
    }
  });

  it('builds the input from what a person chose', () => {
    expect(buildRunInput(fund, { entityIds: ['a', 'b', 'a'], all: false }, { periodEnd: '2026-09-30', limit: '5', other: 'x' })).toEqual({
      filters: { domainCode: 'FUND', entityIds: ['a', 'b'] },
      periodEnd: '2026-09-30',
      limit: 5,
    });
    // All funds needs no filter: the workflow is already about funds.
    expect(buildRunInput(fund, { entityIds: ['a'], all: true })).toEqual({});
    // A workflow for any type, run on every record of a type the person picked.
    expect(buildRunInput(any, { entityIds: [], domainCode: 'issuer', all: true })).toEqual({ filters: { domainCode: 'ISSUER' } });
    expect(buildRunInput(any, { entityIds: [], all: true })).toEqual({});
  });

  it('holds chosen records to the type the workflow is about', () => {
    expect(prepareRunInput(fund, { filters: { entityCodes: ['HSCF2'] }, periodEnd: '' })).toEqual({ input: { filters: { entityCodes: ['HSCF2'], domainCode: 'FUND' }, periodEnd: '' } });
    expect(prepareRunInput(fund, { filters: { domainCode: 'DEAL', entityCodes: ['X'] } })).toEqual({ problem: 'This workflow runs on FUND records, not DEAL.' });
    // No filters is still no restriction.
    expect(prepareRunInput(fund, { periodEnd: '2026-09-30' })).toEqual({ input: { periodEnd: '2026-09-30' } });
    expect(prepareRunInput(any, { filters: { domainCode: 'DEAL' } })).toEqual({ input: { filters: { domainCode: 'DEAL' } } });
  });

  it('refuses to start on everything when the workflow needs records chosen', () => {
    const needs = parseRunSetup({ requiresRecords: true });
    expect(prepareRunInput(needs, {})).toEqual({ problem: 'Choose the records to run this workflow on. It does not run on everything.' });
    expect(prepareRunInput(needs, { filters: { entityIds: [] } })).toHaveProperty('problem');
    expect(prepareRunInput(needs, { filters: { entityIds: ['a'] } })).toEqual({ input: { filters: { entityIds: ['a'] } } });
  });
});
