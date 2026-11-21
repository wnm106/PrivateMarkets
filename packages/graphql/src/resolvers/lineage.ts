import { Context } from '../context';
import { loadAttributeSequences, pickPersistedWinner, sequenceLabel, sequencePosition, storedRuleLabel } from '../lib/attribute-sequence';
import { knowledgeCutoff, loadOnReadValues, mergeOnReadLineage } from '../lib/on-read-values';
import { dirtyAttributeCodes } from './calculation';
import { planVersionDelete } from '../lib/source-version';
import { ManualOverrideError, OPEN_SYSTEM_TO, refreshCalculations, versionCopy, writeManualOverride, writeSourceVersion } from '../lib/source-write';


function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

function dayBefore(isoDate: string): string {
  const [year, month, day] = dateOnly(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Refresh calculations for the record that just changed (lib/source-write.ts). */
async function refreshEntityCalculations(context: Context, entityId: string) {
  await refreshCalculations(context.supabase, entityId);
}

async function attachAttributeSources(context: Context, rows: any[]) {
  if (rows.length === 0) return [];
  const attributeIds = [...new Set(rows.map((row) => row.attribute_id).filter(Boolean))];
  const sourceIds = [...new Set(rows.map((row) => row.source_id).filter(Boolean))];
  const [{ data: attributes, error: attributeError }, { data: sources, error: sourceError }] = await Promise.all([
    context.supabase.from('attribute_register').select('id, attribute_code, attribute_name').in('id', attributeIds),
    context.supabase.schema('entity_instances').from('source_registry').select('id, source_code, source_name').in('id', sourceIds),
  ]);
  if (attributeError) throw attributeError;
  if (sourceError) throw sourceError;
  const attributeById = new Map((attributes || []).map((attribute: any) => [attribute.id, attribute]));
  const sourceById = new Map((sources || []).map((source: any) => [source.id, source]));
  return rows.map((row) => {
    const attribute = attributeById.get(row.attribute_id);
    const source = sourceById.get(row.source_id);
    return {
      ...row,
      attribute_code: attribute?.attribute_code,
      attribute_name: attribute?.attribute_name,
      source_code: source?.source_code,
      source_name: source?.source_name,
    };
  }).filter((row) => row.attribute_code && row.source_code);
}

/** A stored version written again over new valid dates, as a fresh system-time row. */
/**
 * Removes one current version. The same source's version that ends the day before it runs on
 * over the removed days, so the prior value resumes. Both changes are new system-time rows, so a
 * knowledge date before now still sees what was there.
 */
async function removeVersion(context: Context, current: any, now: string) {
  const { data: siblings, error: siblingError } = await context.supabase
    .from('entity_attribute_values')
    .select('*')
    .eq('entity_id', current.entity_id)
    .eq('attribute_id', current.attribute_id)
    .eq('source_id', current.source_id)
    .eq('system_to', OPEN_SYSTEM_TO);
  if (siblingError) throw siblingError;

  const plan = planVersionDelete(siblings || [], current);
  const closing = [current.id, ...(plan.extend ? [plan.extend.id] : [])];
  const { error: closeError } = await context.supabase
    .from('entity_attribute_values')
    .update({ system_to: now })
    .in('id', closing);
  if (closeError) throw closeError;

  if (plan.extend) {
    const { error: insertError } = await context.supabase
      .from('entity_attribute_values')
      .insert(versionCopy(plan.extend, dateOnly(plan.extend.valid_from), plan.extendTo, now, context.user?.id));
    if (insertError) throw insertError;
  }
  return plan;
}

export const lineageResolvers = {
  Query: {
    fieldLineage: async (_: any, args: { entityId: string; asOfDate?: string; knowledgeDate?: string }, context: Context) => {
      const asOf = args.asOfDate || new Date().toISOString().split('T')[0];
      const knownAt = knowledgeCutoff(args.knowledgeDate);
      
      let query = context.supabase
        .from('entity_attribute_values')
        .select('*')
        .eq('entity_id', args.entityId)
        .lte('valid_from', asOf)
        .gte('valid_to', asOf);
      query = knownAt
        ? query.lte('system_from', knownAt).gt('system_to', knownAt)
        : query.eq('system_to', OPEN_SYSTEM_TO);
      const { data, error } = await query.order('precedence_rank', { ascending: true });
      
      if (error) throw error;

      const rows = await attachAttributeSources(context, data || []);
      
      const byAttribute = new Map<string, any[]>();
      rows.forEach((row: any) => {
        const code = row.attribute_code;
        if (!byAttribute.has(code)) byAttribute.set(code, []);
        byAttribute.get(code)!.push(row);
      });
      
      const sequences = await loadAttributeSequences(context.supabase, args.entityId, [...byAttribute.keys()]);
      const dirty = await dirtyAttributeCodes(context, args.entityId);

      const built = Array.from(byAttribute.entries()).map(([code, values]) => {
        const sequence = sequences.get(code) ?? { chain: [], tier: 'source' as const };
        const winningRecord = pickPersistedWinner(values);
        const ordered = [
          ...(winningRecord ? [winningRecord] : []),
          ...values
            .filter((row) => row !== winningRecord)
            .sort((a, b) =>
              sequencePosition(a.source_code, sequence.chain, a.precedence_rank ?? 999) -
              sequencePosition(b.source_code, sequence.chain, b.precedence_rank ?? 999)
            ),
        ];
        
        return {
          attributeCode: code,
          attributeName: winningRecord?.attribute_name,
          currentValue: winningRecord?.golden_value ?? null,
          competingValues: ordered.map((v: any) => {
            const sequenceIndex = sequence.chain.indexOf(v.source_code);
            return {
              source: v.source_code,
              sourceName: v.source_name,
              value: v.golden_value,
              precedenceRank: sequenceIndex >= 0 ? sequenceIndex + 1 : v.precedence_rank,
              validFrom: v.valid_from,
              validTo: v.valid_to,
              confidenceScore: v.confidence_score,
              receivedAt: v.last_received_at || v.system_from,
            };
          }),
          resolutionRule: storedRuleLabel(winningRecord?.resolution_rule_applied) || sequenceLabel(sequence),
          lastUpdated: winningRecord?.system_from,
          calcDirty: dirty.has(code),
        };
      });

      const reads = await loadOnReadValues(context.supabase, args.entityId, asOf, args.knowledgeDate);
      return mergeOnReadLineage(built, reads, asOf);
    },

    entityActivity: async (
      _: any,
      args: { entityId: string; knowledgeDate?: string; attributeCode?: string | null; limit?: number },
      context: Context
    ) => {
      const knownAt = knowledgeCutoff(args.knowledgeDate);
      const limit = Math.min(Math.max(args.limit ?? 40, 1), 100);
      let query = context.supabase
        .from('entity_attribute_values')
        .select('id, attribute_id, source_id, golden_value, system_from, system_to, created_by, valid_from, valid_to')
        .eq('entity_id', args.entityId);
      if (args.attributeCode) {
        const { data: attributes, error: attributeError } = await context.supabase
          .from('attribute_register')
          .select('id')
          .eq('attribute_code', args.attributeCode)
          .limit(1);
        if (attributeError) throw attributeError;
        const attribute = attributes?.[0];
        if (!attribute) return [];
        query = query.eq('attribute_id', attribute.id);
      }
      query = query.order('system_from', { ascending: false }).limit(limit);
      if (knownAt) query = query.lte('system_from', knownAt);
      const { data, error } = await query;
      if (error) throw error;

      const rows = await attachAttributeSources(context, data || []);
      const userIds = [...new Set(rows.map((row) => row.created_by).filter(Boolean))];
      const names = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profiles } = await context.supabase
          .schema('tenancy')
          .from('profiles')
          .select('id, display_name')
          .in('id', userIds);
        for (const profile of profiles || []) {
          if (profile.display_name) names.set(profile.id, profile.display_name);
        }
      }

      return rows
        .map((row) => ({
          id: row.id,
          attributeCode: row.attribute_code,
          attributeName: row.attribute_name || row.attribute_code,
          value: row.golden_value,
          updatedAt: row.system_from,
          updatedBy: (row.created_by && names.get(row.created_by)) || (row.created_by ? 'Unknown user' : 'System'),
          sourceName: row.source_name || null,
          sourceCode: row.source_code || null,
          validFrom: dateOnly(row.valid_from),
          validTo: dateOnly(row.valid_to),
          current: knownAt
            ? new Date(row.system_to).getTime() > new Date(knownAt).getTime()
            : String(row.system_to).startsWith('9999'),
        }))
        .sort((a, b) => {
          const byTime = String(b.updatedAt).localeCompare(String(a.updatedAt));
          if (byTime !== 0) return byTime;
          return String(b.validFrom).localeCompare(String(a.validFrom));
        });
    },
    
    temporalHistory: async (
      _: any,
      args: { entityId: string; attributeCode: string; fromDate: string; toDate: string },
      context: Context
    ) => {
      const { data: attrDef } = await context.supabase
        .from('attribute_register')
        .select('*')
        .eq('attribute_code', args.attributeCode)
        .single();
      
      if (!attrDef) return [];
      
      const { data, error } = await context.supabase
        .from('entity_attribute_values')
        .select(`*, source_registry!inner(source_code)`)
        .eq('entity_id', args.entityId)
        .eq('attribute_id', attrDef.id)
        .or(`valid_from.lte.${args.toDate},valid_to.gte.${args.fromDate}`)
        .order('valid_from', { ascending: true });
      
      if (error) throw error;
      
      return (data || []).map((row: any) => ({
        value: row.golden_value,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        systemFrom: row.system_from,
        systemTo: row.system_to,
        source: row.source_registry.source_code,
        isOverride: row.is_manual_override,
      }));
    },
  },
  
  Mutation: {
    updateAttribute: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        const { data: attrDef } = await context.supabase
          .from('attribute_register')
          .select('*')
          .eq('attribute_code', input.attributeCode)
          .single();
        
        if (!attrDef) throw new Error(`Attribute not found: ${input.attributeCode}`);
        
        // Replace only this source. The preference trigger keeps the other sources and stamps the winner.
        await context.supabase
          .from('entity_attribute_values')
          .update({ system_to: new Date().toISOString() })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .eq('source_id', input.sourceId)
          .eq('valid_to', '9999-12-31')
          .eq('system_to', '9999-12-31 23:59:59');
        
        // Insert new golden record
        const { data, error } = await context.supabase
          .from('entity_attribute_values')
          .insert({
            entity_id: input.entityId,
            attribute_id: attrDef.id,
            source_id: input.sourceId,
            golden_value: input.value,
            valid_from: input.validFrom,
            precedence_rank: input.isOverride ? 1 : attrDef.default_precedence_rank,
            is_manual_override: input.isOverride || false,
            override_reason: input.overrideReason,
            created_by: userId,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        return { success: true, goldenValueId: data.id, errors: [] };
      } catch (error: any) {
        return { success: false, goldenValueId: null, errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
    
    splitValidTime: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        const { data, error } = await context.supabase.rpc('split_valid_time', {
          p_eav_id: input.eavId,
          p_split_date: input.splitDate,
          p_new_value: input.newValue,
          p_source_id: input.sourceId,
          p_user_id: userId,
        });
        
        if (error) throw error;
        
        return { success: true, newEavId: data, errors: [] };
      } catch (error: any) {
        return { success: false, newEavId: null, errors: [{ field: '', message: error.message, code: 'SPLIT_FAILED' }] };
      }
    },
    
    submitManualOverride: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: attrDef, error: attrError } = await context.supabase
          .from('attribute_register')
          .select('id, data_type')
          .eq('attribute_code', input.attributeCode)
          .maybeSingle();
        if (attrError) throw attrError;
        if (!attrDef) throw new Error(`Attribute not found: ${input.attributeCode}`);

        // The same writer chat, workflows and Excel use (lib/source-write.ts).
        const written = await writeManualOverride(context.supabase, {
          entityId: input.entityId,
          attribute: attrDef,
          value: input.value,
          validFrom: input.validFrom,
          reason: input.overrideReason,
          userId: context.user?.id,
        });
        await refreshEntityCalculations(context, input.entityId);
        return { success: true, goldenValueId: written.id, errors: [] };
      } catch (error: any) {
        const code = error instanceof ManualOverrideError ? error.code : 'OVERRIDE_FAILED';
        return { success: false, goldenValueId: null, errors: [{ field: '', message: error.message, code }] };
      }
    },
    
    addCompetingSource: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        const { data: attrDef } = await context.supabase
          .from('attribute_register')
          .select('*')
          .eq('attribute_code', input.attributeCode)
          .single();
        
        if (!attrDef) throw new Error(`Attribute not found: ${input.attributeCode}`);

        const validFrom = input.validFrom || new Date().toISOString().split('T')[0];

        const { data: sourceRow, error: sourceLookupError } = await context.supabase
          .schema('entity_instances')
          .from('source_registry')
          .select('id, source_code, precedence_rank')
          .eq('id', input.sourceId)
          .single();
        if (sourceLookupError || !sourceRow) throw sourceLookupError || new Error('Source not found');

        // A new value for this source versions that source only. Other sources stay current.
        const data = await writeSourceVersion(context.supabase, {
          entityId: input.entityId,
          attributeId: attrDef.id,
          sourceId: sourceRow.id,
          validFrom,
          stored: { golden_value: input.value, golden_value_numeric: null, golden_value_date: null },
          precedenceRank: sourceRow.precedence_rank ?? attrDef.default_precedence_rank,
          isManualOverride: sourceRow.source_code === 'MANUAL',
          userId,
        });

        await refreshEntityCalculations(context, input.entityId);

        return { success: true, attributeValueId: data.id, errors: [] };
      } catch (error: any) {
        return { success: false, attributeValueId: null, errors: [{ field: '', message: error.message, code: 'ADD_SOURCE_FAILED' }] };
      }
    },

    deleteCompetingSource: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const asOf = input.asOfDate || new Date().toISOString().split('T')[0];
      const now = new Date().toISOString();

      try {
        const { data: attrDef } = await context.supabase
          .from('attribute_register')
          .select('id')
          .eq('attribute_code', input.attributeCode)
          .single();
        if (!attrDef) throw new Error(`Attribute not found: ${input.attributeCode}`);

        const { data: current, error: currentError } = await context.supabase
          .from('entity_attribute_values')
          .select('*')
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .eq('source_id', input.sourceId)
          .lte('valid_from', asOf)
          .gte('valid_to', asOf)
          .eq('system_to', OPEN_SYSTEM_TO)
          .maybeSingle();
        if (currentError) throw currentError;
        if (!current) throw new Error('No current source value covers that as-of date');

        // A value that starts on this date is removed outright, and the source's prior value resumes.
        if (dateOnly(current.valid_from) >= asOf) {
          await removeVersion(context, current, now);
          await refreshEntityCalculations(context, input.entityId);
          return { success: true, errors: [] };
        }

        // Close what we believe right now. A knowledge date before this moment still sees the value.
        const { error: closeError } = await context.supabase
          .from('entity_attribute_values')
          .update({ system_to: now })
          .eq('id', current.id);
        if (closeError) throw closeError;

        // Keep the value visible for as-of dates before the deletion date.
        const started = dateOnly(current.valid_from);
        if (started < asOf) {
          const ended = dayBefore(asOf);
          if (ended >= started) {
            const { error: insertError } = await context.supabase
              .from('entity_attribute_values')
              .insert(versionCopy(current, started, ended, now, context.user?.id));
            if (insertError) throw insertError;
          }
        }

        await refreshEntityCalculations(context, input.entityId);

        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: '', message: error.message, code: 'DELETE_SOURCE_FAILED' }] };
      }
    },

    deleteAttributeVersion: async (_: any, args: { input: { entityId: string; versionId: string } }, context: Context) => {
      const now = new Date().toISOString();
      try {
        const { data: current, error: currentError } = await context.supabase
          .from('entity_attribute_values')
          .select('*')
          .eq('id', args.input.versionId)
          .eq('entity_id', args.input.entityId)
          .eq('system_to', OPEN_SYSTEM_TO)
          .maybeSingle();
        if (currentError) throw currentError;
        if (!current) throw new Error('That version was already replaced or deleted. Reload the timeline.');

        await removeVersion(context, current, now);
        await refreshEntityCalculations(context, args.input.entityId);
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: '', message: error.message, code: 'DELETE_VERSION_FAILED' }] };
      }
    },

    clearManualOverride: async (_: any, args: { input: { entityId: string; attributeCode: string; asOf?: string | null } }, context: Context) => {
      const { input } = args;
      const asOf = input.asOf || new Date().toISOString().split('T')[0];
      const now = new Date().toISOString();

      try {
        const { data: attrDef, error: attrError } = await context.supabase
          .from('attribute_register')
          .select('id')
          .eq('attribute_code', input.attributeCode)
          .single();
        if (attrError || !attrDef) throw attrError || new Error(`Attribute not found: ${input.attributeCode}`);

        const { data: manualSource, error: sourceError } = await context.supabase
          .schema('entity_instances')
          .from('source_registry')
          .select('id')
          .eq('source_code', 'MANUAL')
          .maybeSingle();
        if (sourceError) throw sourceError;

        const { data: currentRows, error: currentError } = await context.supabase
          .from('entity_attribute_values')
          .select('*')
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .lte('valid_from', asOf)
          .gte('valid_to', asOf)
          .eq('system_to', OPEN_SYSTEM_TO);
        if (currentError) throw currentError;

        const rows = currentRows || [];
        const manuals = rows.filter((row) => row.is_manual_override === true || (manualSource?.id && row.source_id === manualSource.id));
        if (manuals.length === 0) throw new Error('No manual override is current on that date.');

        const systemRows = rows.filter((row) => !manuals.some((manual) => manual.id === row.id) && String(row.golden_value ?? '').trim() !== '');
        if (systemRows.length === 0) {
          throw new Error('No system source has a value to take ownership. The override was left in place.');
        }

        for (const current of manuals) {
          const { error: closeError } = await context.supabase
            .from('entity_attribute_values')
            .update({ system_to: now })
            .eq('id', current.id);
          if (closeError) throw closeError;

          const started = dateOnly(current.valid_from);
          if (started < asOf) {
            const ended = dayBefore(asOf);
            if (ended >= started) {
              const { error: insertError } = await context.supabase.from('entity_attribute_values').insert({
                entity_id: current.entity_id,
                attribute_id: current.attribute_id,
                source_id: current.source_id,
                golden_value: current.golden_value,
                golden_value_jsonb: current.golden_value_jsonb,
                golden_value_numeric: current.golden_value_numeric,
                golden_value_date: current.golden_value_date,
                golden_value_timestamp: current.golden_value_timestamp,
                golden_value_boolean: current.golden_value_boolean,
                valid_from: started,
                valid_to: ended,
                system_from: now,
                system_to: OPEN_SYSTEM_TO,
                precedence_rank: current.precedence_rank,
                confidence_score: current.confidence_score,
                is_manual_override: current.is_manual_override,
                override_reason: current.override_reason,
                metadata: current.metadata,
                last_received_at: current.last_received_at,
                created_by: context.user?.id,
              });
              if (insertError) throw insertError;
            }
          }
        }

        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: '', message: error.message, code: 'CLEAR_OVERRIDE_FAILED' }] };
      }
    },
  },
};
