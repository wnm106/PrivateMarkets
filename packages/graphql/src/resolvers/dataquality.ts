import { Context } from '../context';

export const dataQualityResolvers = {
  Query: {
    dqRules: async (_: any, args: any, context: Context) => {
      const { filter, pagination } = args;
      
      let query = context.supabase.from('dq_rules').select('*');
      
      if (filter) {
        if (filter.ruleCode?.equals) query = query.eq('rule_code', filter.ruleCode.equals);
        if (filter.domainCode) query = query.eq('domain_code', filter.domainCode);
        if (filter.ruleType) query = query.eq('rule_type', filter.ruleType);
        if (filter.severity) query = query.eq('rule_severity', filter.severity);
        if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      }
      
      const { data, error } = await query.order('rule_code');
      if (error) throw error;
      
      return (data || []).map(mapDQRuleRow);
    },
    
    dqRule: async (_: any, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.from('dq_rules').select('*').eq('id', args.id).single();
      if (error) { if (error.code === 'PGRST116') return null; throw error; }
      return mapDQRuleRow(data);
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
        const { data, error } = await context.supabase
          .from('dq_rules')
          .insert({
            rule_code: input.ruleCode, rule_name: input.ruleName, domain_code: input.domainCode,
            attribute_id: input.attributeCode, rule_type: input.ruleType, rule_severity: input.severity,
            rule_expression: input.ruleExpression, rule_description: input.ruleDescription,
            threshold_value: input.thresholdValue, auto_remediate: input.autoRemediate || false,
          })
          .select().single();
        
        if (error) throw error;
        return { rule: mapDQRuleRow(data), errors: [] };
      } catch (error: any) {
        return { rule: null, errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },
    
    resolveDQException: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { error } = await context.supabase
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

function mapDQRuleRow(row: any): any {
  return {
    id: row.id, ruleCode: row.rule_code, ruleName: row.rule_name,
    domainCode: row.domain_code, attributeCode: row.attribute_id,
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
