import { Context } from '../context';
import { loadAttributeSequences, pickPersistedWinner, sequenceLabel, sequencePosition, storedRuleLabel } from '../lib/attribute-sequence';
import { dirtyAttributeCodes } from './calculation';

const OPEN_SYSTEM_TO = '9999-12-31 23:59:59';

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

function dayBefore(isoDate: string): string {
  const [year, month, day] = dateOnly(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** A past knowledge date or timestamp. Today, or a time that has not arrived, means current knowledge. */
function knowledgeCutoff(knowledgeDate?: string | null): string | null {
  if (!knowledgeDate) return null;
  const trimmed = knowledgeDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const today = new Date().toISOString().slice(0, 10);
    if (trimmed >= today) return null;
    return `${trimmed}T23:59:59.999Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() >= Date.now() - 1000) return null;
  return parsed.toISOString();
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

      return Array.from(byAttribute.entries()).map(([code, values]) => {
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
            };
          }),
          resolutionRule: storedRuleLabel(winningRecord?.resolution_rule_applied) || sequenceLabel(sequence),
          lastUpdated: winningRecord?.system_from,
          calcDirty: dirty.has(code),
        };
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
      const userId = context.user?.id;
      
      try {
        const { data: attrDef } = await context.supabase
          .from('attribute_register')
          .select('*')
          .eq('attribute_code', input.attributeCode)
          .single();
        
        if (!attrDef) throw new Error(`Attribute not found: ${input.attributeCode}`);
        
        const { data: manualSource } = await context.supabase
          .schema('entity_instances')
          .from('source_registry')
          .select('id')
          .eq('source_code', 'MANUAL')
          .single();
        
        // Replace only the manual source. Precedence is resolved and stored by the database trigger.
        await context.supabase
          .from('entity_attribute_values')
          .update({ system_to: new Date().toISOString() })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .eq('source_id', manualSource?.id)
          .eq('valid_to', '9999-12-31')
          .eq('system_to', '9999-12-31 23:59:59');
        
        // Insert override
        const { data, error } = await context.supabase
          .from('entity_attribute_values')
          .insert({
            entity_id: input.entityId,
            attribute_id: attrDef.id,
            source_id: manualSource?.id,
            golden_value: input.value,
            valid_from: input.validFrom || new Date().toISOString().split('T')[0],
            valid_to: '9999-12-31',
            system_from: new Date().toISOString(),
            system_to: '9999-12-31 23:59:59',
            precedence_rank: 1,
            is_manual_override: true,
            override_reason: input.overrideReason,
            created_by: userId,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        return { success: true, goldenValueId: data.id, errors: [] };
      } catch (error: any) {
        return { success: false, goldenValueId: null, errors: [{ field: '', message: error.message, code: 'OVERRIDE_FAILED' }] };
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
        const now = new Date().toISOString();

        const { data: sourceRow, error: sourceLookupError } = await context.supabase
          .schema('entity_instances')
          .from('source_registry')
          .select('id, source_code, precedence_rank')
          .eq('id', input.sourceId)
          .single();
        if (sourceLookupError || !sourceRow) throw sourceLookupError || new Error('Source not found');

        // A new value for this source versions that source only. Other sources stay current.
        const { error: expireError } = await context.supabase
          .from('entity_attribute_values')
          .update({
            valid_to: validFrom,
            system_to: now,
          })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .eq('source_id', sourceRow.id)
          .eq('valid_to', '9999-12-31')
          .eq('system_to', '9999-12-31 23:59:59');

        if (expireError) throw expireError;

        const { data, error } = await context.supabase
          .from('entity_attribute_values')
          .insert({
            entity_id: input.entityId,
            attribute_id: attrDef.id,
            source_id: sourceRow.id,
            golden_value: input.value,
            valid_from: validFrom,
            valid_to: '9999-12-31',
            system_from: now,
            system_to: '9999-12-31 23:59:59',
            precedence_rank: sourceRow.precedence_rank ?? attrDef.default_precedence_rank,
            is_manual_override: sourceRow.source_code === 'MANUAL',
            created_by: userId,
          })
          .select()
          .single();

        if (error) throw error;

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
              created_by: context.user?.id,
            });
            if (insertError) throw insertError;
          }
        }

        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: '', message: error.message, code: 'DELETE_SOURCE_FAILED' }] };
      }
    },
  },
};
