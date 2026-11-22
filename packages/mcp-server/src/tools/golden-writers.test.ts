import { describe, expect, it } from 'vitest';
import { fakeSupabase, filterValue, type FakeCall } from '@tapestrai/graphql/src/testing/fake-supabase';
import { registerComplianceTools } from './compliance-tools';
import { updateEntityAttributes } from '../lib/import-map/import-orchestrator';
import type { ToolDefinition } from '../lib/types';

const writes = (calls: FakeCall[]) => calls.filter((call) => call.fn === 'write_value');

function tool(name: string): ToolDefinition {
  const tools: ToolDefinition[] = [];
  registerComplianceTools({ registerTool: (definition: ToolDefinition) => tools.push(definition) } as never);
  const found = tools.find((definition) => definition.name === name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

describe('create_compliance_rule_version', () => {
  const database = (saveError?: unknown) => fakeSupabase((call) => {
    if (call.table === 'rules') return { data: { id: 'rule-1' } };
    if (call.fn === 'create_rule_version') return saveError ? { error: saveError } : { data: 'v2' };
    if (call.table === 'rule_versions') return { data: { id: 'v2', rule_id: 'rule-1', version_number: 2, valid_from: '2027-01-01', valid_to: '9999-12-31' } };
    if (call.table === 'rule_conditions') return { data: [{ id: 'c1', applies_to: 'BASE', condition_group: 1, condition_order: 1, attribute_code: 'ASSET_CLASS', operator: 'equals', value: 'LOAN', logic_operator: 'AND' }] };
    return undefined;
  });

  it('saves the version and its conditions in one create_rule_version call', async () => {
    const db = database();
    const result: any = await tool('create_compliance_rule_version').execute({
      ruleCode: 'ISSUER_LIMIT',
      validFrom: '2027-01-01',
      baseDomainCode: 'POSITION',
      baseRollupPath: [{ relationshipCode: 'POSITION_FUND', direction: 'DOWN' }, { relationshipCode: 'FUND_PARENT', maxHops: 3 }],
      numeratorAttributeCode: 'MARKET_VALUE',
      numeratorAggregation: 'SUM',
      conditions: [{ appliesTo: 'BASE', conditionGroup: 1, attributeCode: 'ASSET_CLASS', operator: 'equals', value: 'LOAN' }],
    }, db.client);

    const save = db.calls.find((call) => call.fn === 'create_rule_version')!;
    const payload = save.payload as any;
    expect(save.schema).toBe('compliance');
    expect(payload.p_rule_id).toBe('rule-1');
    // Columns that are NOT NULL get their defaults instead of an explicit null.
    expect(payload.p_version).toMatchObject({
      valid_from: '2027-01-01', valid_to: '9999-12-31',
      numerator_dimension: {}, denominator_dimension: {}, group_by_dimension: {},
      group_by_path: [],
      base_rollup_path: [
        { relationship_code: 'POSITION_FUND', direction: 'DOWN', recursive: false },
        { relationship_code: 'FUND_PARENT', direction: 'UP', recursive: true },
      ],
    });
    expect(payload.p_version).not.toHaveProperty('version_number');
    expect(payload.p_version).not.toHaveProperty('rule_id');
    expect(payload.p_conditions).toEqual([expect.objectContaining({ attribute_code: 'ASSET_CLASS', condition_order: 1, attribute_dimension: {}, compare_dimension: {} })]);
    expect(payload.p_conditions[0]).not.toHaveProperty('rule_version_id');
    expect(payload.p_measure_lines).toEqual([]);

    // No row is written directly: the old path inserted the version, then its conditions.
    expect(db.calls.filter((call) => call.op === 'insert' || call.op === 'update')).toEqual([]);
    expect(result.version).toMatchObject({ id: 'v2', versionNumber: 2, conditions: [expect.objectContaining({ id: 'c1' })] });
    const conditionsRead = db.calls.find((call) => call.table === 'rule_conditions')!;
    expect(filterValue(conditionsRead, 'eq', 'rule_version_id')).toBe('v2');
  });

  it('reports a refused save and reads nothing back', async () => {
    const db = database({ message: 'new row violates row-level security policy for table "rule_versions"' });
    await expect(tool('create_compliance_rule_version').execute({ ruleId: 'rule-1', baseDomainCode: 'POSITION', numeratorAttributeCode: 'MV', numeratorAggregation: 'SUM' }, db.client))
      .rejects.toMatchObject({ message: expect.stringMatching(/row-level security/) });
    expect(db.calls.some((call) => call.table === 'rule_versions')).toBe(false);
  });
});

describe('MCP import update', () => {
  it('writes the imported value through write_value from today and never edits rows', async () => {
    const db = fakeSupabase((call) => {
      if (call.table === 'attribute_register') return { data: [{ attribute_code: 'NAV', id: 'attr-nav', default_precedence_rank: 40 }] };
      if (call.table === 'source_registry') return { data: { id: 'src-import' } };
      if (call.fn === 'write_value') return { data: 'v' };
      return undefined;
    });
    await updateEntityAttributes('e1', { NAV: '2026-03-31' }, db.client, 'user-1');
    expect(writes(db.calls)[0].payload).toEqual({
      p_entity_id: 'e1', p_attribute_id: 'attr-nav', p_source_id: 'src-import', p_valid_from: new Date().toISOString().slice(0, 10), p_valid_to: null,
      p_value: { golden_value: '2026-03-31', golden_value_numeric: null, golden_value_date: '2026-03-31', precedence_rank: 40 },
    });
    expect(db.calls.filter((call) => call.table === 'entity_attribute_values')).toEqual([]);
  });

  it('fails the record when the source is missing or the write is refused', async () => {
    const missing = fakeSupabase((call) => (call.table === 'attribute_register' ? { data: [{ attribute_code: 'NAV', id: 'a' }] } : undefined));
    await expect(updateEntityAttributes('e1', { NAV: '1' }, missing.client)).rejects.toThrow(/IMPORT source is not registered/);
    const refused = fakeSupabase((call) => {
      if (call.table === 'attribute_register') return { data: [{ attribute_code: 'NAV', id: 'a' }] };
      if (call.table === 'source_registry') return { data: { id: 's' } };
      return { error: { message: 'permission denied for function write_value' } };
    });
    await expect(updateEntityAttributes('e1', { NAV: '1' }, refused.client)).rejects.toThrow(/permission denied/);
  });
});
