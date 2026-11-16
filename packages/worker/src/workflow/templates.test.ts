import { describe, expect, it } from 'vitest';
import { asGraph, isReadTool, validateGraph } from '@tapestrai/graphql/src/lib/workflow-graph';
import { REPORT_ONLY, WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import { buildRegistry, signReason, toolSpecs } from './tools';

/**
 * A template names tools by hand. This holds every template to the tools the
 * worker really has, so a renamed or misspelt tool fails here and not halfway
 * through somebody's run.
 */

const specs = toolSpecs(buildRegistry());
const names = new Set(specs.map((tool) => tool.name));
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

describe('workflow templates against the worker\'s tools', () => {
  it.each(WORKFLOW_TEMPLATES.map((template) => [template.code, template] as const))('%s uses only tools that exist', (_code, template) => {
    expect(validateGraph(asGraph(template.graph), names)).toEqual([]);
    for (const node of template.graph.nodes.filter((candidate) => candidate.type === 'agent')) {
      // A step that only reports lists one name that is no tool's, so nothing can be proposed.
      if (strings(node.config.proposable).join() === REPORT_ONLY.join()) {
        expect(names.has(REPORT_ONLY[0])).toBe(false);
        continue;
      }
      const proposable = strings(node.config.proposable);
      expect(proposable.length).toBeGreaterThan(0);
      expect(proposable.filter((tool) => !names.has(tool))).toEqual([]);
      // A reading tool under "changes it can propose" would never be offered to the agent.
      expect(proposable.filter(isReadTool)).toEqual([]);
    }
  });

  it('gives the fund reconciliation what each agent needs', () => {
    const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.code === 'FUND_RECONCILIATION')!;
    const node = (id: string) => template.graph.nodes.find((candidate) => candidate.id === id)!;
    expect(strings(node('map').config.tools)).toEqual(expect.arrayContaining(['get_position_file_tables', 'preview_position_file_load', 'list_position_file_mapping_targets']));
    expect(strings(node('map').config.proposable)).toEqual(['load_position_file_table']);
    expect(strings(node('reconcile').config.tools)).toEqual(expect.arrayContaining(['get_nav_reconciliation', 'get_position_reconciliation', 'get_cash_reconciliation']));
    // The funds come from the run's selection, at every point the closes are read.
    for (const id of ['closes', 'loaded', 'after']) {
      expect(node(id).config).toMatchObject({ tool: 'list_fund_closes', args: { entityIds: '{{steps.select.entityIds}}' } });
    }
    // Certifying is not something a workflow can propose: no tool does it.
    expect([...names].filter((name) => /certif|signoff|sign_off/i.test(name))).toEqual([]);
  });

  it('signs an approved decision and an approved adjustment with who approved it', () => {
    const spec = (name: string) => specs.find((tool) => tool.name === name);
    expect(signReason(spec('record_rec_decision'), { itemId: 'fee', decision: 'ACCEPT' }, 'Approved by Ada.')).toMatchObject({ note: 'Approved by Ada.' });
    expect(signReason(spec('post_cash_adjustment'), { reason: 'Bank charge.' }, 'Approved by Ada.')).toMatchObject({ reason: 'Bank charge. Approved by Ada.' });
    expect(signReason(spec('save_reconciliation_notes'), { notes: '## Outcome' }, 'Approved by Ada.')).toEqual({ notes: '## Outcome' });
  });
});
