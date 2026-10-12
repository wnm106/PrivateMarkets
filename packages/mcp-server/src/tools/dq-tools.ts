import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

const listDQExceptions: ToolDefinition = {
  name: 'list_dq_exceptions',
  description: 'List data quality exceptions with optional filtering by status, severity, and domain.',
  category: 'dq',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['OPEN', 'IN_REVIEW', 'RESOLVED', 'WAIVED', 'FALSE_POSITIVE'], description: 'Filter by status' },
      severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], description: 'Filter by severity' },
      domainCode: { type: 'string', description: 'Filter by domain code' },
      first: { type: 'number', description: 'Number of results to return', default: 20 },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase
      .from('dq_exceptions')
      .select(`
        *,
        dq_rules!inner(rule_code, rule_name, rule_type, rule_severity),
        master_entities!inner(entity_code, entity_name, domain_code)
      `, { count: 'exact' });

    if (args.status) query = query.eq('status', args.status);
    if (args.severity) query = query.eq('severity', args.severity);
    if (args.domainCode) query = query.eq('master_entities.domain_code', args.domainCode);

    query = query.order('detected_at', { ascending: false }).limit(args.first || 20);

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      exceptions: (data || []).map((row: any) => ({
        id: row.id,
        ruleCode: row.dq_rules.rule_code,
        ruleName: row.dq_rules.rule_name,
        entityCode: row.master_entities.entity_code,
        entityName: row.master_entities.entity_name,
        domainCode: row.master_entities.domain_code,
        exceptionMessage: row.exception_message,
        severity: row.severity,
        status: row.status,
        detectedAt: row.detected_at,
        expectedValue: row.expected_value,
        actualValue: row.actual_value,
      })),
      totalCount: count,
    };
  },
};

const resolveDQException: ToolDefinition = {
  name: 'resolve_dq_exception',
  description: 'Resolve a data quality exception by updating its status and adding resolution notes.',
  category: 'dq',
  inputSchema: {
    type: 'object',
    properties: {
      exceptionId: { type: 'string', description: 'Exception ID to resolve' },
      status: { type: 'string', enum: ['RESOLVED', 'WAIVED', 'FALSE_POSITIVE'], description: 'New status' },
      resolutionNotes: { type: 'string', description: 'Notes about the resolution' },
    },
    required: ['exceptionId', 'status'],
  },
  execute: async (args, supabase) => {
    const { error } = await supabase
      .from('dq_exceptions')
      .update({
        status: args.status,
        resolution_notes: args.resolutionNotes,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', args.exceptionId);

    if (error) throw error;

    return {
      success: true,
      message: `Exception ${args.exceptionId} resolved with status ${args.status}`,
    };
  },
};

const getDQSummary: ToolDefinition = {
  name: 'get_dq_summary',
  description: 'Get a summary of data quality metrics including exception counts by severity and domain.',
  category: 'dq',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (_, supabase) => {
    const { data: byStatus } = await supabase
      .from('dq_exceptions')
      .select('status')
      .neq('status', 'RESOLVED');

    const { data: bySeverity } = await supabase
      .from('dq_exceptions')
      .select('severity')
      .neq('status', 'RESOLVED');

    const statusCounts: Record<string, number> = {};
    (byStatus || []).forEach((row: any) => {
      statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    });

    const severityCounts: Record<string, number> = {};
    (bySeverity || []).forEach((row: any) => {
      severityCounts[row.severity] = (severityCounts[row.severity] || 0) + 1;
    });

    return {
      totalOpen: (byStatus || []).length,
      byStatus: statusCounts,
      bySeverity: severityCounts,
    };
  },
};

export function registerDQTools(registry: ToolRegistry): void {
  registry.registerTool(listDQExceptions);
  registry.registerTool(resolveDQException);
  registry.registerTool(getDQSummary);
}
