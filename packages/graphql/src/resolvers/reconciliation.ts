import { Context } from '../context';
import {
  buildComparisons,
  parseIdentityChecks,
  parseMeasures,
  parseStages,
  pickLatest,
  stageIndexFor,
  withGolden,
  type ComparisonCell,
  type IdentityCheck,
  type IdentityResult,
  type LineRef,
  type StoredValue,
} from '../lib/reconciliation';

const err = (message: string, code = 'RECONCILIATION_FAILED', field = '') => ({ field, message, code });

function asDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapCells(raw: unknown): ComparisonCell[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const cell = item as ComparisonCell;
    if (typeof cell.key !== 'string') return [];
    return [{
      key: cell.key,
      label: cell.label || cell.key,
      value: cell.value ?? null,
      numeric: typeof cell.numeric === 'number' ? cell.numeric : null,
    }];
  });
}

function mapIdentities(raw: unknown): IdentityResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const identities = (raw as { identities?: unknown }).identities;
  if (!Array.isArray(identities)) return [];
  return identities.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const identity = item as IdentityResult;
    if (typeof identity.code !== 'string') return [];
    return [{
      code: identity.code,
      name: identity.name,
      calculated: identity.calculated ?? null,
      compareValue: identity.compareValue ?? null,
      variance: identity.variance ?? null,
      passed: Boolean(identity.passed),
      message: identity.message ?? null,
    }];
  });
}

function mapDefinition(row: any) {
  return {
    id: row.id,
    definitionCode: row.definition_code,
    definitionName: row.definition_name,
    description: row.description,
    domainCode: row.domain_code,
    compareMode: row.compare_mode,
    grain: row.grain,
    relationshipCode: row.relationship_code,
    relationshipDirection: row.relationship_direction,
    measures: row.measures || [],
    identityChecks: row.identity_checks || [],
    stages: parseStages(row.stages),
    isActive: row.is_active,
  };
}

function mapLine(row: any) {
  return {
    id: row.id,
    lineEntityId: row.line_entity_id,
    lineCode: row.line_code,
    lineName: row.line_name,
    attributeCode: row.attribute_code,
    attributeName: row.attribute_name,
    breakKind: row.break_kind,
    cells: mapCells(row.cells),
    goldenValue: row.golden_value,
    variance: row.variance == null ? null : Number(row.variance),
    isBreak: row.is_break,
    status: row.status,
    resolutionSourceCode: row.resolution_source_code,
    resolutionValue: row.resolution_value,
    resolutionNotes: row.resolution_notes,
  };
}

function mapRun(row: any, definition: any, lines: any[]) {
  return {
    id: row.id,
    definition,
    anchorEntityId: row.anchor_entity_id,
    anchorEntityCode: row.anchor_entity_code || row.entity_code,
    anchorEntityName: row.anchor_entity_name || row.entity_name,
    domainCode: row.domain_code,
    asOfDate: row.as_of_date,
    compareAsOfDate: row.compare_as_of_date,
    status: row.status,
    stageIndex: row.stage_index,
    assignedTo: row.assigned_to,
    identities: mapIdentities(row.summary),
    lines,
    openBreakCount: row.open_break_count ?? 0,
    decidedAt: row.decided_at,
    decisionNotes: row.decision_notes,
    createdAt: row.created_at,
  };
}

async function definitionById(context: Context, id: string) {
  const { data, error } = await context.supabase.from('reconciliation_definitions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapDefinition(data) : null;
}

async function linesFor(context: Context, runId: string) {
  const { data, error } = await context.supabase
    .from('reconciliation_lines')
    .select('*')
    .eq('run_id', runId)
    .order('line_code')
    .order('attribute_code');
  if (error) throw error;
  return (data || []).map(mapLine);
}

async function hydrateRuns(context: Context, rows: any[], includeLines: boolean) {
  const definitionIds = Array.from(new Set(rows.map((row) => row.definition_id)));
  const entityIds = Array.from(new Set(rows.map((row) => row.anchor_entity_id)));
  const [{ data: definitions }, { data: entities }] = await Promise.all([
    definitionIds.length
      ? context.supabase.from('reconciliation_definitions').select('*').in('id', definitionIds)
      : Promise.resolve({ data: [] }),
    entityIds.length
      ? context.supabase.from('master_entities').select('id, entity_code, entity_name, domain_code').in('id', entityIds)
      : Promise.resolve({ data: [] }),
  ]);
  const definitionBy = new Map((definitions || []).map((row: any) => [row.id, mapDefinition(row)]));
  const entityBy = new Map((entities || []).map((row: any) => [row.id, row]));
  const hydrated = [];
  for (const row of rows) {
    const entity = entityBy.get(row.anchor_entity_id);
    hydrated.push(mapRun({
      ...row,
      anchor_entity_code: entity?.entity_code,
      anchor_entity_name: entity?.entity_name,
      domain_code: entity?.domain_code,
    }, definitionBy.get(row.definition_id), includeLines ? await linesFor(context, row.id) : []));
  }
  return hydrated;
}

function referencedCodes(measures: ReturnType<typeof parseMeasures>, checks: IdentityCheck[]): string[] {
  const codes = new Set(measures.map((measure) => measure.attributeCode));
  const walk = (expr: IdentityCheck['expression']) => {
    if (!expr) return;
    if ('ref' in expr) codes.add(expr.ref);
    else if ('op' in expr) expr.args.forEach(walk);
  };
  for (const check of checks) {
    if (check.compareAttributeCode) codes.add(check.compareAttributeCode);
    if (check.anchorAttributeCode) codes.add(check.anchorAttributeCode);
    if (check.childAttributeCode) codes.add(check.childAttributeCode);
    walk(check.expression);
  }
  return Array.from(codes);
}

async function loadValues(
  context: Context,
  entityIds: string[],
  attributeIds: string[],
  codeByAttribute: Map<string, string>,
  sourceById: Map<string, { source_code: string; source_name: string; precedence_rank: number }>,
  asOf: string,
  role: 'CURRENT' | 'PRIOR',
): Promise<StoredValue[]> {
  if (entityIds.length === 0 || attributeIds.length === 0) return [];
  const data: any[] = [];
  const pageSize = 1000;
  for (let index = 0; index < entityIds.length; index += 150) {
    const entityPage = entityIds.slice(index, index + 150);
    for (let from = 0; ; from += pageSize) {
      const { data: page, error } = await context.supabase
        .from('entity_attribute_values')
        .select('entity_id, attribute_id, source_id, golden_value, golden_value_numeric, golden_source_id, precedence_rank, valid_from, system_from')
        .in('entity_id', entityPage)
        .in('attribute_id', attributeIds)
        .lte('valid_from', asOf)
        .gte('valid_to', asOf)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      data.push(...(page || []));
      if (!page || page.length < pageSize) break;
    }
  }

  const grouped = new Map<string, StoredValue[]>();
  for (const row of data || []) {
    const attributeCode = codeByAttribute.get(row.attribute_id);
    if (!attributeCode) continue;
    const source = row.source_id ? sourceById.get(row.source_id) : null;
    const stored: StoredValue = {
      entityId: row.entity_id,
      attributeCode,
      sourceCode: source?.source_code || 'UNSPECIFIED',
      sourceName: source?.source_name || 'Unspecified',
      value: row.golden_value,
      numeric: row.golden_value_numeric == null ? null : Number(row.golden_value_numeric),
      precedenceRank: row.precedence_rank ?? source?.precedence_rank ?? 9999,
      isGolden: row.source_id != null && row.source_id === row.golden_source_id,
      validFrom: String(row.valid_from).slice(0, 10),
      systemFrom: String(row.system_from || ''),
      asOfRole: role,
    };
    const key = `${stored.entityId}|${stored.attributeCode}|${stored.sourceCode}`;
    grouped.set(key, [...(grouped.get(key) || []), stored]);
  }

  const picked = Array.from(grouped.values()).flatMap((rows) => {
    const latest = pickLatest(rows);
    return latest ? [latest] : [];
  });
  const byAttribute = new Map<string, StoredValue[]>();
  for (const row of picked) {
    const key = `${row.entityId}|${row.attributeCode}`;
    byAttribute.set(key, [...(byAttribute.get(key) || []), row]);
  }
  return Array.from(byAttribute.values()).flatMap((rows) => withGolden(rows));
}

async function relatedLines(context: Context, anchorId: string, relationshipCode: string, direction: string, asOf: string): Promise<LineRef[]> {
  const data: any[] = [];
  for (let from = 0; ; from += 1000) {
    let query = context.supabase
      .from('entity_relationships')
      .select('parent_entity_id, child_entity_id, valid_from, system_to')
      .eq('relationship_code', relationshipCode)
      .lte('valid_from', asOf)
      .gte('valid_to', asOf)
      .range(from, from + 999);
    query = direction === 'PARENT'
      ? query.eq('parent_entity_id', anchorId)
      : query.eq('child_entity_id', anchorId);
    const { data: page, error } = await query;
    if (error) throw error;
    data.push(...(page || []));
    if (!page || page.length < 1000) break;
  }
  const ids = Array.from(new Set(data.flatMap((row: any) => {
    if (row.system_to && String(row.system_to).slice(0, 10) < asOf) return [];
    const id = direction === 'PARENT' ? row.child_entity_id : row.parent_entity_id;
    return id ? [id] : [];
  })));
  if (ids.length === 0) return [];
  const entities: any[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const { data: page, error: entityError } = await context.supabase
      .from('master_entities')
      .select('id, entity_code, entity_name')
      .in('id', ids.slice(index, index + 200));
    if (entityError) throw entityError;
    entities.push(...(page || []));
  }
  return entities.map((entity: any) => ({
    entityId: entity.id,
    entityCode: entity.entity_code,
    entityName: entity.entity_name,
  }));
}

async function applyOverride(context: Context, entityId: string, attributeCode: string, value: string, asOf: string, reason: string) {
  const { data: attribute, error: attributeError } = await context.supabase
    .from('attribute_register')
    .select('id, default_precedence_rank')
    .eq('attribute_code', attributeCode)
    .maybeSingle();
  if (attributeError || !attribute) throw attributeError || new Error(`Attribute not found: ${attributeCode}`);

  const { data: manual, error: sourceError } = await context.supabase
    .schema('entity_instances')
    .from('source_registry')
    .select('id')
    .eq('source_code', 'MANUAL')
    .maybeSingle();
  if (sourceError || !manual) throw sourceError || new Error('Manual source is not registered');

  const now = new Date().toISOString();
  const { error: expireError } = await context.supabase
    .from('entity_attribute_values')
    .update({ system_to: now })
    .eq('entity_id', entityId)
    .eq('attribute_id', attribute.id)
    .eq('source_id', manual.id)
    .gte('valid_to', asOf)
    .gt('system_to', now);
  if (expireError) throw expireError;

  const numeric = Number(value.replace(/,/g, ''));
  const { error } = await context.supabase.from('entity_attribute_values').insert({
    entity_id: entityId,
    attribute_id: attribute.id,
    source_id: manual.id,
    golden_value: value,
    golden_value_numeric: Number.isFinite(numeric) ? numeric : null,
    valid_from: asOf,
    valid_to: '9999-12-31',
    system_from: now,
    system_to: '9999-12-31 23:59:59',
    precedence_rank: 1,
    is_manual_override: true,
    override_reason: reason,
    created_by: context.user?.id || null,
  });
  if (error) throw error;
}

export const reconciliationResolvers = {
  Query: {
    reconciliationDefinitions: async (_: unknown, args: { domainCode?: string | null }, context: Context) => {
      let query = context.supabase.from('reconciliation_definitions').select('*').eq('is_active', true).order('definition_name');
      if (args.domainCode) query = query.eq('domain_code', args.domainCode);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(mapDefinition);
    },

    reconciliationRuns: async (_: unknown, args: { status?: string | null; first?: number | null }, context: Context) => {
      let query = context.supabase.from('reconciliation_runs').select('*').order('created_at', { ascending: false }).limit(args.first || 40);
      if (args.status) query = query.eq('status', args.status);
      const { data, error } = await query;
      if (error) throw error;
      return hydrateRuns(context, data || [], false);
    },

    reconciliationRun: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.from('reconciliation_runs').select('*').eq('id', args.id).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const [run] = await hydrateRuns(context, [data], true);
      return run;
    },
  },

  Mutation: {
    openReconciliationRun: async (_: unknown, args: { input: { definitionCode: string; entityId: string; asOfDate: unknown; compareAsOfDate?: unknown } }, context: Context) => {
      try {
        const asOf = asDate(args.input.asOfDate);
        const compareAsOf = args.input.compareAsOfDate ? asDate(args.input.compareAsOfDate) : null;
        const { data: definitionRow, error: definitionError } = await context.supabase
          .from('reconciliation_definitions')
          .select('*')
          .eq('definition_code', args.input.definitionCode)
          .eq('is_active', true)
          .maybeSingle();
        if (definitionError || !definitionRow) return { run: null, errors: [err('Reconciliation definition not found', 'NOT_FOUND', 'definitionCode')] };

        const { data: anchor, error: anchorError } = await context.supabase
          .from('master_entities')
          .select('id, entity_code, entity_name, domain_code, client_id')
          .eq('id', args.input.entityId)
          .maybeSingle();
        if (anchorError || !anchor) return { run: null, errors: [err('Entity not found', 'NOT_FOUND', 'entityId')] };
        if (anchor.domain_code !== definitionRow.domain_code) {
          return { run: null, errors: [err(`This review is for ${definitionRow.domain_code} entities`, 'DOMAIN_MISMATCH', 'entityId')] };
        }

        const definition = mapDefinition(definitionRow);
        const measures = parseMeasures(definition.measures);
        const checks = parseIdentityChecks(definition.identityChecks);
        const anchorRef: LineRef = { entityId: anchor.id, entityCode: anchor.entity_code, entityName: anchor.entity_name };
        const lines = definition.grain === 'RELATED' && definition.relationshipCode
          ? await relatedLines(context, anchor.id, definition.relationshipCode, definition.relationshipDirection, asOf)
          : [anchorRef];
        const subjectIds = Array.from(new Set([anchor.id, ...lines.map((line) => line.entityId)]));
        const codes = referencedCodes(measures, checks);
        const { data: attributes, error: attributeError } = codes.length
          ? await context.supabase.from('attribute_register').select('id, attribute_code, attribute_name').in('attribute_code', codes)
          : { data: [], error: null };
        if (attributeError) throw attributeError;
        const codeByAttribute = new Map((attributes || []).map((row: any) => [row.id, row.attribute_code]));
        const attributeNames = Object.fromEntries((attributes || []).map((row: any) => [row.attribute_code, row.attribute_name]));
        const { data: sources, error: sourceError } = await context.supabase
          .schema('entity_instances')
          .from('source_registry')
          .select('id, source_code, source_name, precedence_rank');
        if (sourceError) throw sourceError;
        const sourceById = new Map((sources || []).map((row: any) => [row.id, row]));
        const attributeIds = (attributes || []).map((row: any) => row.id);
        const current = await loadValues(context, subjectIds, attributeIds, codeByAttribute, sourceById, asOf, 'CURRENT');
        const prior = compareAsOf && (definition.compareMode === 'PERIOD' || definition.compareMode === 'BOTH')
          ? await loadValues(context, subjectIds, attributeIds, codeByAttribute, sourceById, compareAsOf, 'PRIOR')
          : [];
        const built = buildComparisons({
          anchor: anchorRef,
          lines: lines.filter((line) => line.entityId !== anchor.id || definition.grain === 'ENTITY'),
          measures,
          identityChecks: checks,
          compareMode: definition.compareMode,
          facts: [...current, ...prior],
          attributeNames,
        });
        const openBreakCount = built.lines.filter((line) => line.isBreak).length;
        const status = openBreakCount === 0 ? 'REVIEW' : 'EXCEPTIONS';
        const { data: run, error: runError } = await context.supabase.from('reconciliation_runs').insert({
          definition_id: definition.id,
          anchor_entity_id: anchor.id,
          as_of_date: asOf,
          compare_as_of_date: compareAsOf,
          status,
          stage_index: stageIndexFor(status, definition.stages.length),
          assigned_to: context.user?.email || null,
          open_break_count: openBreakCount,
          summary: { identities: built.identities },
          client_id: anchor.client_id || null,
        }).select('*').single();
        if (runError || !run) throw runError || new Error('Review could not be opened');

        if (built.lines.length > 0) {
          const { error: lineError } = await context.supabase.from('reconciliation_lines').insert(built.lines.map((line) => ({
            run_id: run.id,
            line_entity_id: line.lineEntityId,
            line_code: line.lineCode,
            line_name: line.lineName,
            attribute_code: line.attributeCode,
            attribute_name: line.attributeName,
            break_kind: line.breakKind,
            cells: line.cells,
            golden_value: line.goldenValue,
            variance: line.variance,
            is_break: line.isBreak,
            status: line.isBreak ? 'OPEN' : 'MATCHED',
          })));
          if (lineError) {
            await context.supabase.from('reconciliation_runs').delete().eq('id', run.id);
            throw lineError;
          }
        }

        const [hydrated] = await hydrateRuns(context, [run], true);
        return { run: hydrated, errors: [] };
      } catch (error: any) {
        return { run: null, errors: [err(error.message || 'Review could not be opened')] };
      }
    },

    resolveReconciliationLine: async (_: unknown, args: { input: { lineId: string; status: string; sourceCode?: string | null; notes?: string | null } }, context: Context) => {
      try {
        const status = args.input.status;
        if (!['ACCEPTED', 'OVERRIDDEN', 'WAIVED'].includes(status)) {
          return { run: null, errors: [err('Choose accept, override, or waive', 'VALIDATION', 'status')] };
        }
        const { data: line, error: lineError } = await context.supabase
          .from('reconciliation_lines')
          .select('*')
          .eq('id', args.input.lineId)
          .maybeSingle();
        if (lineError || !line) return { run: null, errors: [err('Comparison line not found', 'NOT_FOUND', 'lineId')] };
        if (!line.is_break) return { run: null, errors: [err('Agreed rows do not need a resolution', 'VALIDATION', 'lineId')] };

        const { data: run, error: runError } = await context.supabase
          .from('reconciliation_runs')
          .select('*')
          .eq('id', line.run_id)
          .maybeSingle();
        if (runError || !run) return { run: null, errors: [err('Review not found', 'NOT_FOUND')] };
        if (run.status === 'APPROVED') return { run: null, errors: [err('This review is already approved', 'LOCKED')] };

        const cells = mapCells(line.cells);
        let resolutionValue: string | null = null;
        let resolutionSource: string | null = null;
        if (status === 'OVERRIDDEN') {
          const cell = cells.find((item) => item.key === args.input.sourceCode && item.value);
          if (!cell) return { run: null, errors: [err('Pick a source value to keep', 'VALIDATION', 'sourceCode')] };
          resolutionSource = cell.key;
          resolutionValue = cell.value;
        }

        const { error: updateError } = await context.supabase.from('reconciliation_lines').update({
          status,
          resolution_source_code: resolutionSource,
          resolution_value: resolutionValue,
          resolution_notes: args.input.notes || null,
          updated_at: new Date().toISOString(),
        }).eq('id', line.id);
        if (updateError) throw updateError;

        const { data: siblings, error: siblingError } = await context.supabase
          .from('reconciliation_lines')
          .select('id, status, is_break')
          .eq('run_id', run.id);
        if (siblingError) throw siblingError;
        const openBreakCount = (siblings || []).filter((sibling: any) => sibling.is_break && (sibling.id === line.id ? status === 'OPEN' : sibling.status === 'OPEN')).length;
        const nextStatus = openBreakCount === 0 ? 'REVIEW' : (run.status === 'SENT_BACK' ? 'SENT_BACK' : 'EXCEPTIONS');
        const definition = await definitionById(context, run.definition_id);
        const { error: runUpdateError } = await context.supabase.from('reconciliation_runs').update({
          open_break_count: openBreakCount,
          status: nextStatus,
          stage_index: stageIndexFor(nextStatus, definition?.stages.length || 5),
          updated_at: new Date().toISOString(),
        }).eq('id', run.id);
        if (runUpdateError) throw runUpdateError;

        const { data: refreshed, error: refreshError } = await context.supabase.from('reconciliation_runs').select('*').eq('id', run.id).single();
        if (refreshError) throw refreshError;
        const [hydrated] = await hydrateRuns(context, [refreshed], true);
        return { run: hydrated, errors: [] };
      } catch (error: any) {
        return { run: null, errors: [err(error.message || 'Line could not be resolved')] };
      }
    },

    decideReconciliationRun: async (_: unknown, args: { input: { runId: string; decision: string; notes?: string | null } }, context: Context) => {
      try {
        const decision = args.input.decision;
        if (!['APPROVE', 'SEND_BACK'].includes(decision)) {
          return { run: null, errors: [err('Decision must approve or send back', 'VALIDATION', 'decision')] };
        }
        const { data: run, error: runError } = await context.supabase
          .from('reconciliation_runs')
          .select('*')
          .eq('id', args.input.runId)
          .maybeSingle();
        if (runError || !run) return { run: null, errors: [err('Review not found', 'NOT_FOUND', 'runId')] };
        if (run.status === 'APPROVED') return { run: null, errors: [err('This review is already approved', 'LOCKED')] };

        const definition = await definitionById(context, run.definition_id);
        if (decision === 'SEND_BACK') {
          const { error } = await context.supabase.from('reconciliation_runs').update({
            status: 'SENT_BACK',
            stage_index: stageIndexFor('SENT_BACK', definition?.stages.length || 5),
            decision_notes: args.input.notes || null,
            updated_at: new Date().toISOString(),
          }).eq('id', run.id);
          if (error) throw error;
        } else {
          if (run.open_break_count > 0) return { run: null, errors: [err('Resolve every break before approving', 'OPEN_BREAKS')] };
          const { data: overrides, error: overrideQueryError } = await context.supabase
            .from('reconciliation_lines')
            .select('*')
            .eq('run_id', run.id)
            .eq('status', 'OVERRIDDEN');
          if (overrideQueryError) throw overrideQueryError;
          for (const line of overrides || []) {
            if (line.break_kind === 'IDENTITY' || !line.resolution_value) continue;
            await applyOverride(
              context,
              line.line_entity_id,
              line.attribute_code,
              line.resolution_value,
              String(run.as_of_date).slice(0, 10),
              `Reconciliation ${run.id}: kept ${line.resolution_source_code}`,
            );
          }
          const { error } = await context.supabase.from('reconciliation_runs').update({
            status: 'APPROVED',
            stage_index: stageIndexFor('APPROVED', definition?.stages.length || 5),
            decided_at: new Date().toISOString(),
            decided_by: context.user?.email || null,
            decision_notes: args.input.notes || null,
            updated_at: new Date().toISOString(),
          }).eq('id', run.id);
          if (error) throw error;
        }

        const { data: refreshed, error: refreshError } = await context.supabase.from('reconciliation_runs').select('*').eq('id', run.id).single();
        if (refreshError) throw refreshError;
        const [hydrated] = await hydrateRuns(context, [refreshed], true);
        return { run: hydrated, errors: [] };
      } catch (error: any) {
        return { run: null, errors: [err(error.message || 'Decision could not be saved')] };
      }
    },
  },
};
