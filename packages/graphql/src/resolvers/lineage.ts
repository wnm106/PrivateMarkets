import { Context } from '../context';

export const lineageResolvers = {
  Query: {
    fieldLineage: async (_: any, args: { entityId: string; asOfDate?: string }, context: Context) => {
      const asOf = args.asOfDate || new Date().toISOString().split('T')[0];
      
      const { data, error } = await context.supabase
        .from('entity_attribute_values')
        .select(`
          *,
          attribute_register!inner(id, attribute_code, attribute_name),
          source_registry!inner(id, source_code, source_name, precedence_rank)
        `)
        .eq('entity_id', args.entityId)
        .lte('valid_from', asOf)
        .gte('valid_to', asOf)
        .eq('system_to', '9999-12-31 23:59:59')
        .order('precedence_rank', { ascending: true });
      
      if (error) throw error;
      
      const byAttribute = new Map<string, any[]>();
      (data || []).forEach((row: any) => {
        const code = row.attribute_register.attribute_code;
        if (!byAttribute.has(code)) byAttribute.set(code, []);
        byAttribute.get(code)!.push(row);
      });
      
      return Array.from(byAttribute.entries()).map(([code, values]) => {
        // Find the first record with a non-null, non-empty golden_value
        const winningRecord = values.find(v => v.golden_value !== null && v.golden_value !== undefined && v.golden_value !== '') || values[0];
        
        return {
          attributeCode: code,
          attributeName: winningRecord.attribute_register.attribute_name,
          currentValue: winningRecord.golden_value,
          competingValues: values.map((v: any) => ({
            source: v.source_registry.source_code,
            sourceName: v.source_registry.source_name,
            value: v.golden_value,
            precedenceRank: v.precedence_rank,
            validFrom: v.valid_from,
            validTo: v.valid_to,
            confidenceScore: v.confidence_score,
          })),
          resolutionRule: winningRecord.resolution_rule_applied,
          lastUpdated: winningRecord.system_from,
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
        
        // Close existing current record
        await context.supabase
          .from('entity_attribute_values')
          .update({ system_to: new Date().toISOString() })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
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
        
        // Get manual source
        const { data: manualSource } = await context.supabase
          .from('source_registry')
          .select('id')
          .eq('source_code', 'MANUAL')
          .single();
        
        // Close existing records
        await context.supabase
          .from('entity_attribute_values')
          .update({ system_to: new Date().toISOString() })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .eq('valid_to', '9999-12-31')
          .eq('system_to', '9999-12-31 23:59:59');
        
        // Insert override
        const { data, error } = await context.supabase
          .from('entity_attribute_values')
          .insert({
            entity_id: input.entityId,
            attribute_id: attrDef.id,
            source_id: manualSource?.id,
            golden_source_id: manualSource?.id,
            golden_value: input.value,
            valid_from: input.validFrom || new Date().toISOString().split('T')[0],
            valid_to: '9999-12-31',
            system_from: new Date().toISOString(),
            system_to: '9999-12-31 23:59:59',
            precedence_rank: 1,
            is_manual_override: true,
            override_reason: input.overrideReason,
            resolution_rule_applied: 'MANUAL_OVERRIDE',
            resolution_version: 0,
            resolved_at: new Date().toISOString(),
            competing_values: JSON.stringify([{ source: 'MANUAL', value: input.value, rank: 1 }]),
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

        // Expire the currently active record for this entity/attribute/source combination
        const { error: expireError } = await context.supabase
          .from('entity_attribute_values')
          .update({
            valid_to: validFrom,
            system_to: now,
          })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attrDef.id)
          .eq('source_id', input.sourceId)
          .eq('valid_to', '9999-12-31')
          .eq('system_to', '9999-12-31 23:59:59');

        if (expireError) {
          console.error('Error expiring prior record:', expireError);
        }

        // Insert the new value
        const { data, error } = await context.supabase
          .from('entity_attribute_values')
          .insert({
            entity_id: input.entityId,
            attribute_id: attrDef.id,
            source_id: input.sourceId,
            golden_value: input.value,
            valid_from: validFrom,
            valid_to: '9999-12-31',
            system_from: now,
            system_to: '9999-12-31 23:59:59',
            precedence_rank: attrDef.default_precedence_rank,
            is_manual_override: false,
            created_by: userId,
          })
          .select()
          .single();
        
        if (error) throw error;

        // ── TRIGGER: Re-resolve golden source after new source value ──
        // Look up entity's domain and template for the 4-tier waterfall
        try {
          const { data: entity } = await context.supabase
            .from('master_entities')
            .select('id, domain_code, template_id')
            .eq('id', input.entityId)
            .single();

          if (entity) {
            // Import and call the golden source resolver
            const { evaluatePrecedence } = await import('../lib/rule-engine');
            const result = await evaluatePrecedence(
              context.supabase, input.entityId, input.attributeCode,
              entity.domain_code, entity.template_id
            );

            // Look up winning source_id
            const { data: winningSource } = await context.supabase
              .from('source_registry').select('id').eq('source_code', result.winningSource).single();

            const winningCandidate = result.allCandidates.find(c => c.source === result.winningSource);

            // Close existing golden record and persist new one
            await context.supabase.from('entity_attribute_values')
              .update({ system_to: now })
              .eq('entity_id', input.entityId).eq('attribute_id', attrDef.id)
              .eq('valid_to', '9999-12-31').eq('system_to', '9999-12-31 23:59:59')
              .neq('id', data.id); // Don't close the source record we just inserted

            await context.supabase.from('entity_attribute_values').insert({
              entity_id: input.entityId, attribute_id: attrDef.id,
              source_id: winningSource?.id || null,
              golden_source_id: winningSource?.id || null,
              golden_value: winningCandidate?.value || null,
              valid_from: validFrom, valid_to: '9999-12-31',
              system_from: now, system_to: '9999-12-31 23:59:59',
              precedence_rank: winningCandidate?.rank || 999,
              is_manual_override: result.winningSource === 'MANUAL',
              resolution_rule_applied: result.appliedRule?.ruleCode || null,
              resolution_version: result.resolutionVersion,
              resolved_at: now,
              competing_values: JSON.stringify(result.allCandidates),
              created_by: userId,
            });
          }
        } catch (resolveErr) {
          // Non-fatal: golden resolution failed but source value was saved
          console.error('Golden source re-resolution failed:', resolveErr);
        }
        
        return { success: true, attributeValueId: data.id, errors: [] };
      } catch (error: any) {
        return { success: false, attributeValueId: null, errors: [{ field: '', message: error.message, code: 'ADD_SOURCE_FAILED' }] };
      }
    },
  },
};
