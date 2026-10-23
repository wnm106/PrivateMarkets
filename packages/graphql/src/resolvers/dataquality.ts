import { Context } from '../context';

function dq(context: Context) {
  return context.supabase.schema('data_quality');
}

export const dataQualityResolvers = {
  Query: {
    dqRules: async (_: any, args: any, context: Context) => {
      const { filter } = args;

      let query = dq(context).from('dq_rules').select('*');

      if (filter) {
        if (filter.ruleCode?.equals) query = query.eq('rule_code', filter.ruleCode.equals);
        if (filter.domainCode) query = query.eq('domain_code', filter.domainCode);
        if (filter.ruleType) query = query.eq('rule_type', filter.ruleType);
        if (filter.severity) query = query.eq('rule_severity', filter.severity);
        if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      }

      const { data, error } = await query.order('rule_code');
      if (error) throw error;

      return mapDQRuleRows(context, data || []);
    },

    dqRule: async (_: any, args: { id: string }, context: Context) => {
      const { data, error } = await dq(context).from('dq_rules').select('*').eq('id', args.id).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const [rule] = await mapDQRuleRows(context, [data]);
      return rule;
    },
    
    staleAttributes: async (
      _: any,
      args: { domainCode?: string | null; olderThanDays?: number | null; asOfDate?: string | null },
      context: Context,
    ) => {
      const olderThanDays = Math.min(Math.max(args.olderThanDays ?? 30, 1), 3650);
      const { data, error } = await context.supabase.rpc('stale_attributes', {
        p_domain_code: args.domainCode || null,
        p_older_than_days: olderThanDays,
        p_as_of_date: args.asOfDate || null,
      });
      if (error) throw error;
      const report = (data || {}) as {
        olderThanDays?: number;
        asOfDate?: string;
        count?: number;
        attributes?: unknown[];
      };
      return {
        olderThanDays: report.olderThanDays ?? olderThanDays,
        asOfDate: report.asOfDate || args.asOfDate || new Date().toISOString().slice(0, 10),
        count: report.count ?? 0,
        attributes: report.attributes || [],
      };
    },

    dataQualityDashboard: async (_: any, args: { domainCode?: string | null; fromDate?: string | null; toDate?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('data_quality_dashboard', {
        p_domain_code: args.domainCode || null,
        p_from_date: args.fromDate || null,
        p_to_date: args.toDate || null,
      });
      if (error) throw error;
      return data;
    },

    dqExceptions: async (_: any, args: any, context: Context) => {
      const { filter, pagination } = args;
      
      let query = context.supabase.from('dq_exceptions').select(`
        *,
        dq_rules!inner(rule_code, rule_name, rule_type, rule_severity),
        master_entities!inner(entity_code, entity_name, domain_code)
      `, { count: 'exact' });
      
      if (filter) {
        if (filter.ruleId?.equals) query = query.eq('rule_id', filter.ruleId.equals);
        if (filter.entityId?.equals) query = query.eq('entity_id', filter.entityId.equals);
        if (filter.domainCode) query = query.eq('master_entities.domain_code', filter.domainCode);
        if (filter.severity) query = query.eq('severity', filter.severity);
        if (filter.status) query = query.eq('status', filter.status);
      }
      
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1).order('detected_at', { ascending: false });
      
      const { data, error, count } = await query;
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapDQExceptionRow(row),
        cursor: btoa(String(offset + index)),
      }));
      
      return {
        edges,
        pageInfo: { hasNextPage: (offset + limit) < (count || 0), hasPreviousPage: offset > 0, startCursor: edges[0]?.cursor, endCursor: edges[edges.length - 1]?.cursor },
        totalCount: count || 0,
      };
    },
    
  },
  
  Mutation: {
    createDQRule: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const attributeId = await resolveAttributeId(context, input.attributeCode);
        const { data, error } = await dq(context)
          .from('dq_rules')
          .insert({
            rule_code: String(input.ruleCode || '').trim(),
            rule_name: String(input.ruleName || '').trim(),
            domain_code: input.domainCode || null,
            attribute_id: attributeId,
            rule_type: input.ruleType,
            rule_severity: input.severity,
            rule_expression: String(input.ruleExpression || '').trim(),
            rule_description: input.ruleDescription || null,
            threshold_value: input.thresholdValue ?? null,
            auto_remediate: input.autoRemediate || false,
          })
          .select()
          .single();

        if (error) throw error;
        const [rule] = await mapDQRuleRows(context, [data]);
        return { rule, errors: [] };
      } catch (error: any) {
        return { rule: null, errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },

    updateDQRule: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (input.ruleName !== undefined) patch.rule_name = String(input.ruleName || '').trim();
        if (input.domainCode !== undefined) patch.domain_code = input.domainCode || null;
        if (input.attributeCode !== undefined) patch.attribute_id = await resolveAttributeId(context, input.attributeCode);
        if (input.ruleType !== undefined) patch.rule_type = input.ruleType;
        if (input.severity !== undefined) patch.rule_severity = input.severity;
        if (input.ruleExpression !== undefined) patch.rule_expression = String(input.ruleExpression || '').trim();
        if (input.ruleDescription !== undefined) patch.rule_description = input.ruleDescription || null;
        if (input.thresholdValue !== undefined) patch.threshold_value = input.thresholdValue;
        if (input.isActive !== undefined) patch.is_active = input.isActive;
        if (input.autoRemediate !== undefined) patch.auto_remediate = input.autoRemediate;

        const { data, error } = await dq(context)
          .from('dq_rules')
          .update(patch)
          .eq('id', input.id)
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          return { rule: null, errors: [{ field: 'id', message: 'Rule not found, or you do not have permission to change it.', code: 'NOT_FOUND' }] };
        }
        const [rule] = await mapDQRuleRows(context, [data]);
        return { rule, errors: [] };
      } catch (error: any) {
        return { rule: null, errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
    
    recordDQDisposition: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const status = String(input.status || '');
      const allowed = ['WAIVED', 'FALSE_POSITIVE', 'OPEN', 'IN_REVIEW'];
      if (!allowed.includes(status)) {
        return { success: false, exceptionId: null, errors: [{ field: 'status', message: 'Choose waive, not an issue, or reopen.', code: 'INVALID_STATUS' }] };
      }
      if ((status === 'WAIVED' || status === 'FALSE_POSITIVE') && !String(input.resolutionNotes || '').trim()) {
        return { success: false, exceptionId: null, errors: [{ field: 'resolutionNotes', message: 'Add a short note so the next person knows why this was accepted.', code: 'NOTE_REQUIRED' }] };
      }
      try {
        const { data: rule, error: ruleError } = await dq(context)
          .from('dq_rules')
          .select('id, rule_name, rule_severity, attribute_id')
          .eq('id', input.ruleId)
          .single();
        if (ruleError || !rule) throw ruleError || new Error('Rule not found');

        const asOf = input.asOf || new Date().toISOString().slice(0, 10);
        const notes = String(input.resolutionNotes || '').trim() || null;
        const { data: existing, error: existingError } = await dq(context)
          .from('dq_exceptions')
          .select('id')
          .eq('rule_id', input.ruleId)
          .eq('entity_id', input.entityId)
          .order('detected_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingError) throw existingError;

        const patch = {
          status,
          resolution_notes: notes,
          resolved_at: status === 'OPEN' ? null : new Date().toISOString(),
          resolved_by: status === 'OPEN' ? null : context.user?.id || null,
          valid_from: asOf,
          valid_to: '9999-12-31',
          updated_at: new Date().toISOString(),
        };

        if (existing?.id) {
          const { error } = await dq(context).from('dq_exceptions').update(patch).eq('id', existing.id);
          if (error) throw error;
          return { success: true, exceptionId: existing.id, errors: [] };
        }

        const { data, error } = await dq(context)
          .from('dq_exceptions')
          .insert({
            rule_id: rule.id,
            entity_id: input.entityId,
            attribute_id: rule.attribute_id,
            exception_type: status,
            exception_message: notes || rule.rule_name,
            severity: rule.rule_severity,
            ...patch,
          })
          .select('id')
          .single();
        if (error) throw error;
        return { success: true, exceptionId: data.id, errors: [] };
      } catch (error: any) {
        return { success: false, exceptionId: null, errors: [{ field: '', message: error.message, code: 'DISPOSITION_FAILED' }] };
      }
    },

    resolveDQException: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { error } = await dq(context)
          .from('dq_exceptions')
          .update({
            status: input.status, resolution_notes: input.resolutionNotes,
            resolved_at: new Date().toISOString(), resolved_by: context.user?.id,
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.exceptionId);
        
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: '', message: error.message, code: 'RESOLVE_FAILED' }] };
      }
    },
  },
};

async function resolveAttributeId(context: Context, attributeCode: string | null | undefined) {
  const code = String(attributeCode || '').trim();
  if (!code) return null;
  const { data, error } = await context.supabase
    .schema('metadata_register')
    .from('attribute_register')
    .select('id')
    .eq('attribute_code', code)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Unknown attribute ${code}`);
  return data.id;
}

async function mapDQRuleRows(context: Context, rows: any[]) {
  const ids = [...new Set(rows.map((row) => row.attribute_id).filter(Boolean))];
  const codes = new Map<string, string>();
  if (ids.length) {
    const { data, error } = await context.supabase
      .schema('metadata_register')
      .from('attribute_register')
      .select('id, attribute_code')
      .in('id', ids);
    if (error) throw error;
    for (const attribute of data || []) codes.set(attribute.id, attribute.attribute_code);
  }
  return rows.map((row) => mapDQRuleRow(row, codes.get(row.attribute_id) || null));
}

function mapDQRuleRow(row: any, attributeCode: string | null = null): any {
  return {
    id: row.id, ruleCode: row.rule_code, ruleName: row.rule_name,
    domainCode: row.domain_code, attributeCode,
    ruleType: row.rule_type, severity: row.rule_severity,
    ruleExpression: row.rule_expression, ruleDescription: row.rule_description,
    thresholdValue: row.threshold_value, isActive: row.is_active,
    autoRemediate: row.auto_remediate, metadata: row.metadata,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapDQExceptionRow(row: any): any {
  return {
    id: row.id, ruleId: row.rule_id,
    rule: { id: row.dq_rules?.id, ruleCode: row.dq_rules?.rule_code, ruleName: row.dq_rules?.rule_name, ruleType: row.dq_rules?.rule_type, severity: row.dq_rules?.rule_severity },
    entityId: row.entity_id, entityCode: row.master_entities?.entity_code,
    entityName: row.master_entities?.entity_name, domainCode: row.master_entities?.domain_code,
    attributeId: row.attribute_id, exceptionType: row.exception_type,
    exceptionMessage: row.exception_message, expectedValue: row.expected_value,
    actualValue: row.actual_value, severity: row.severity, status: row.status,
    assignedTo: row.assigned_to, resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by, resolutionNotes: row.resolution_notes,
    detectedAt: row.detected_at, validFrom: row.valid_from, validTo: row.valid_to,
    metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
