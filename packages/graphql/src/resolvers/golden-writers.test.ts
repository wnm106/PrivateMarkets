import { describe, expect, it } from 'vitest';
import { entityResolvers, replaceLinks } from './entity';
import { lineageResolvers } from './lineage';
import { applyOverride } from './reconciliation';
import { fakeSupabase, filterValue, type FakeCall, type FakeHandler } from '../testing/fake-supabase';

function context(handler: FakeHandler) {
  const db = fakeSupabase(handler);
  return {
    db,
    ctx: {
      supabase: db.client,
      supabaseAdmin: null,
      user: { id: 'user-1', email: 'a@example.com', role: 'readonly' as const },
      requestId: 'test',
      loaders: {} as any,
    } as any,
  };
}

const writes = (calls: FakeCall[]) => calls.filter((call) => call.fn === 'write_value');
/** Any direct change to a value row: what guard_value_rows now refuses, or what erases history. */
const directValueEdits = (calls: FakeCall[]) => calls.filter((call) => call.table === 'entity_attribute_values' && call.op !== 'select');

describe('updateEntity value edits', () => {
  function database(source: { id: string; precedence_rank: number }) {
    return context((call) => {
      if (call.table === 'master_entities' && call.op === 'update') return { data: { id: 'e1' } };
      if (call.table === 'attribute_register') return { data: { id: 'attr-nav', default_precedence_rank: 50 } };
      if (call.table === 'source_registry') return { data: source };
      if (call.fn === 'write_value') return { data: 'v-new' };
      if (call.table === 'entity_master') return { data: { entity_id: 'e1', entity_code: 'E1', attributes: {} } };
      return undefined;
    });
  }

  it('writes a manual edit through write_value from the viewed date, until the next later value', async () => {
    const { db, ctx } = database({ id: 'src-manual', precedence_rank: 1 });
    const result = await entityResolvers.Mutation.updateEntity(undefined, { input: { id: 'e1', attributes: { NAV: '100.5' }, asOfDate: '2026-06-30' } }, ctx);
    expect(result.errors).toEqual([]);
    expect(writes(db.calls)).toEqual([expect.objectContaining({
      schema: 'golden_master',
      payload: {
        p_entity_id: 'e1',
        p_attribute_id: 'attr-nav',
        p_source_id: 'src-manual',
        p_valid_from: '2026-06-30',
        p_valid_to: null,
        p_value: { golden_value: '100.5', golden_value_numeric: 100.5, precedence_rank: 1, is_manual_override: true },
      },
    })]);
    expect(directValueEdits(db.calls)).toEqual([]);
  });

  it('keeps a named source and its own precedence', async () => {
    const { db, ctx } = database({ id: 'src-admin', precedence_rank: 20 });
    await entityResolvers.Mutation.updateEntity(undefined, { input: { id: 'e1', attributes: { NAV: { value: 7, sourceCode: 'fund_admin' } }, asOfDate: '2026-06-30' } }, ctx);
    const sourceRead = db.calls.find((call) => call.table === 'source_registry')!;
    expect(filterValue(sourceRead, 'eq', 'source_code')).toBe('FUND_ADMIN');
    expect((writes(db.calls)[0].payload as any).p_value).toEqual({ golden_value: '7', golden_value_numeric: 7, precedence_rank: 20, is_manual_override: false });
  });

  it('reports a refused write', async () => {
    const { ctx } = context((call) => {
      if (call.table === 'master_entities') return { data: { id: 'e1' } };
      if (call.table === 'attribute_register') return { data: { id: 'attr-nav' } };
      if (call.table === 'source_registry') return { data: { id: 'src-manual', precedence_rank: 1 } };
      if (call.fn === 'write_value') return { error: { message: 'new row violates row-level security policy' } };
      return undefined;
    });
    const result = await entityResolvers.Mutation.updateEntity(undefined, { input: { id: 'e1', attributes: { NAV: '1' } } }, ctx);
    expect(result.errors[0].message).toMatch(/row-level security/);
  });
});

describe('links end rather than being deleted or rewritten', () => {
  const OPEN = '9999-12-31 23:59:59';
  const current = [
    { id: 'l-keep', parent_entity_id: 'p1', child_entity_id: 'e1', relationship_code: 'FUND_PARENT', relationship_type: 'Parent', is_primary: true, valid_from: '2026-01-01' },
    { id: 'l-drop', parent_entity_id: 'p2', child_entity_id: 'e1', relationship_code: 'FUND_PARENT', relationship_type: 'Parent', is_primary: false, valid_from: '2026-01-01' },
    { id: 'l-flag', parent_entity_id: 'p4', child_entity_id: 'e1', relationship_code: 'FUND_PARENT', relationship_type: 'Parent', is_primary: false, valid_from: '2026-03-01' },
  ];
  const linkDb = (insertError?: unknown) => context((call) => {
    if (call.table === 'entity_relationships' && call.op === 'select') return { data: current };
    if (call.table === 'entity_relationships' && call.op === 'update') return { data: [{ id: filterValue(call, 'eq', 'id') }] };
    if (call.fn === 'revise_relationship') return { data: { id: 'l-revised' } };
    if (call.table === 'entity_relationships' && call.op === 'insert') return insertError ? { error: insertError } : {};
    return undefined;
  });

  it('keeps an unchanged link, ends a dropped one in system time only, and adds a new one', async () => {
    const { db, ctx } = linkDb();
    await replaceLinks(ctx, 'e1', 'parent', [
      { parentEntityId: 'p1', relationshipCode: 'FUND_PARENT', relationshipType: 'Parent', isPrimary: true, validFrom: '2026-01-01' },
      { parentEntityId: 'p4', relationshipCode: 'FUND_PARENT', relationshipType: 'Parent', isPrimary: true, validFrom: '2026-03-01' },
      { parentEntityId: 'p3', relationshipCode: 'FUND_PARENT', relationshipType: 'Parent', isPrimary: false, validFrom: '2026-11-20' },
    ]);
    const read = db.calls[0];
    expect(filterValue(read, 'eq', 'child_entity_id')).toBe('e1');
    expect(filterValue(read, 'eq', 'system_to')).toBe(OPEN);

    const updates = db.calls.filter((call) => call.op === 'update');
    const ended = updates.find((call) => filterValue(call, 'eq', 'id') === 'l-drop')!;
    expect(Object.keys(ended.payload as object)).toEqual(['system_to']);
    expect(filterValue(ended, 'eq', 'system_to')).toBe(OPEN);
    // A flag change ends the link and writes it again, so its earlier version stays in history.
    expect(updates.some((call) => filterValue(call, 'eq', 'id') === 'l-flag')).toBe(false);
    const revised = db.calls.filter((call) => call.fn === 'revise_relationship');
    expect(revised).toEqual([expect.objectContaining({
      schema: 'entity_instances',
      payload: { p_id: 'l-flag', p_is_primary: true, p_relationship_type: 'Parent' },
    })]);
    expect(updates.some((call) => filterValue(call, 'eq', 'id') === 'l-keep')).toBe(false);
    expect(updates.every((call) => !('valid_to' in (call.payload as object)))).toBe(true);

    const inserts = db.calls.filter((call) => call.op === 'insert');
    expect(inserts.map((call) => call.payload)).toEqual([
      { parent_entity_id: 'p3', child_entity_id: 'e1', relationship_type: 'Parent', relationship_code: 'FUND_PARENT', is_primary: false, valid_from: '2026-11-20' },
    ]);
    expect(db.calls.some((call) => call.op === 'delete')).toBe(false);
  });

  it('explains a new link that collides with an ended one on the same start date', async () => {
    const { ctx } = linkDb({ code: '23505', message: 'duplicate key value' });
    await expect(replaceLinks(ctx, 'e1', 'child', [
      { childEntityId: 'c9', relationshipCode: 'TRANCHE_DEAL', relationshipType: 'Tranche', validFrom: '2026-01-01' },
    ])).rejects.toThrow(/was ended before\. Give the new link a different start date/);
  });

  it('updateEntity hands its relationship lists to replaceLinks for each side', async () => {
    const { db, ctx } = context((call) => {
      if (call.table === 'master_entities') return { data: { id: 'e1' } };
      if (call.table === 'entity_relationships' && call.op === 'select') return { data: [] };
      if (call.table === 'entity_master') return { data: { entity_id: 'e1' } };
      return undefined;
    });
    await entityResolvers.Mutation.updateEntity(undefined, {
      input: {
        id: 'e1',
        parentRelationships: [{ parentEntityId: 'p1', childEntityId: 'e1', relationshipCode: 'FUND_PARENT', relationshipType: 'Parent', validFrom: '2026-01-01' }],
        childRelationships: [{ parentEntityId: 'e1', childEntityId: 'c1', relationshipCode: 'POSITION_FUND', relationshipType: 'Holds', validFrom: '2026-01-01' }],
      },
    }, ctx);
    const reads = db.calls.filter((call) => call.table === 'entity_relationships' && call.op === 'select');
    expect(reads.map((call) => [filterValue(call, 'eq', 'child_entity_id'), filterValue(call, 'eq', 'parent_entity_id')])).toEqual([['e1', undefined], [undefined, 'e1']]);
    expect(db.calls.filter((call) => call.op === 'insert').map((call) => (call.payload as any).relationship_code)).toEqual(['FUND_PARENT', 'POSITION_FUND']);
  });

  it('deleteRelationship ends the link in system time and keeps its valid dates', async () => {
    const { db, ctx } = context((call) => (call.op === 'update' ? { data: [{ id: 'l1' }] } : undefined));
    expect(await entityResolvers.Mutation.deleteRelationship(undefined, { id: 'l1' }, ctx)).toEqual({ success: true, errors: [] });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).toMatchObject({ table: 'entity_relationships', op: 'update', returning: true });
    expect(Object.keys(db.calls[0].payload as object)).toEqual(['system_to']);
    expect(filterValue(db.calls[0], 'eq', 'id')).toBe('l1');
    expect(filterValue(db.calls[0], 'eq', 'system_to')).toBe(OPEN);

    const none = context(() => ({ data: [] }));
    expect((await entityResolvers.Mutation.deleteRelationship(undefined, { id: 'gone' }, none.ctx)).success).toBe(false);
  });
});

describe('lineage value writers', () => {
  const lineageDb = (source = { id: 'src-a', source_code: 'FUND_ADMIN', precedence_rank: 20 }) => context((call) => {
    if (call.table === 'attribute_register') return { data: { id: 'attr-1', default_precedence_rank: 60 } };
    if (call.table === 'source_registry') return { data: source.source_code === 'MANUAL' ? { id: source.id } : source };
    if (call.fn === 'write_value') return { data: 'v-new' };
    return { data: [] };
  });

  it('updateAttribute writes one source from validFrom', async () => {
    const { db, ctx } = lineageDb();
    const result = await lineageResolvers.Mutation.updateAttribute(undefined, { input: { entityId: 'e1', attributeCode: 'NAV', value: '5', validFrom: '2026-02-01', sourceId: 'src-a', isOverride: true, overrideReason: 'Fix' } }, ctx);
    expect(result).toEqual({ success: true, goldenValueId: 'v-new', errors: [] });
    expect(writes(db.calls)[0].payload).toEqual({
      p_entity_id: 'e1', p_attribute_id: 'attr-1', p_source_id: 'src-a', p_valid_from: '2026-02-01', p_valid_to: null,
      p_value: { golden_value: '5', precedence_rank: 1, is_manual_override: true, override_reason: 'Fix' },
    });
    expect(directValueEdits(db.calls)).toEqual([]);
  });

  it('submitManualOverride writes the manual source at precedence 1', async () => {
    const { db, ctx } = lineageDb({ id: 'src-manual', source_code: 'MANUAL', precedence_rank: 1 });
    const result = await lineageResolvers.Mutation.submitManualOverride(undefined, { input: { entityId: 'e1', attributeCode: 'NAV', value: '9', validFrom: '2026-03-01', overrideReason: 'Admin statement' } }, ctx);
    expect(result.goldenValueId).toBe('v-new');
    expect(writes(db.calls)[0].payload).toMatchObject({
      p_source_id: 'src-manual', p_valid_from: '2026-03-01', p_valid_to: null,
      p_value: { golden_value: '9', precedence_rank: 1, is_manual_override: true, override_reason: 'Admin statement' },
    });
    expect(directValueEdits(db.calls)).toEqual([]);
  });

  it('addCompetingSource writes the chosen source at its precedence', async () => {
    const { db, ctx } = lineageDb();
    const result = await lineageResolvers.Mutation.addCompetingSource(undefined, { input: { entityId: 'e1', attributeCode: 'NAV', sourceId: 'src-a', value: '11', validFrom: '2026-04-01' } }, ctx);
    expect(result).toMatchObject({ success: true, attributeValueId: 'v-new' });
    expect(writes(db.calls)[0].payload).toMatchObject({
      p_source_id: 'src-a', p_valid_from: '2026-04-01', p_valid_to: null,
      p_value: { golden_value: '11', precedence_rank: 20, is_manual_override: false },
    });
    expect(directValueEdits(db.calls)).toEqual([]);
  });
});

describe('reconciliation override', () => {
  it('writes the manual value from the as-of date through write_value', async () => {
    const { db, ctx } = context((call) => {
      if (call.table === 'attribute_register') return { data: { id: 'attr-cash', default_precedence_rank: 50 } };
      if (call.table === 'source_registry') return { data: { id: 'src-manual' } };
      if (call.fn === 'write_value') return { data: 'v-new' };
      return undefined;
    });
    await applyOverride(ctx, 'e1', 'CASH', '1,250.00', '2026-09-30', 'Matched to bank');
    expect(writes(db.calls)[0].payload).toEqual({
      p_entity_id: 'e1', p_attribute_id: 'attr-cash', p_source_id: 'src-manual', p_valid_from: '2026-09-30', p_valid_to: null,
      p_value: { golden_value: '1,250.00', golden_value_numeric: 1250, precedence_rank: 1, is_manual_override: true, override_reason: 'Matched to bank' },
    });
    expect(directValueEdits(db.calls)).toEqual([]);
  });
});
