import { ToolRegistry } from '../lib/tool-registry.js';
import { ToolDefinition } from '../lib/types.js';

const getFieldLineage: ToolDefinition = {
  name: 'get_field_lineage',
  description: 'Get field-level lineage for an entity, showing all competing source values and the resolved golden record.',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'Entity ID to query lineage for' },
      attributeCode: { type: 'string', description: 'Specific attribute code (optional, returns all if omitted)' },
      asOfDate: { type: 'string', description: 'Point-in-time date (YYYY-MM-DD)' },
    },
    required: ['entityId'],
  },
  execute: async (args, supabase) => {
    const asOf = args.asOfDate || new Date().toISOString().split('T')[0];

    let query = supabase
      .from('entity_attribute_values')
      .select(`
        *,
        attribute_register!inner(attribute_code, attribute_name, data_type),
        source_registry!inner(source_code, source_name, precedence_rank)
      `)
      .eq('entity_id', args.entityId)
      .lte('valid_from', asOf)
      .gte('valid_to', asOf)
      .eq('system_to', '9999-12-31 23:59:59')
      .order('precedence_rank', { ascending: true });

    const { data, error } = await query;
    if (error) throw error;

    // Group by attribute
    const byAttribute = new Map<string, any[]>();
    (data || []).forEach((row: any) => {
      const code = row.attribute_register.attribute_code;
      if (args.attributeCode && code !== args.attributeCode) return;
      if (!byAttribute.has(code)) byAttribute.set(code, []);
      byAttribute.get(code)!.push(row);
    });

    return Array.from(byAttribute.entries()).map(([code, values]) => ({
      attributeCode: code,
      attributeName: values[0].attribute_register.attribute_name,
      dataType: values[0].attribute_register.data_type,
      goldenValue: values[0].golden_value,
      resolutionRule: values[0].resolution_rule_applied,
      competingValues: values.map((v: any) => ({
        source: v.source_registry.source_code,
        sourceName: v.source_registry.source_name,
        value: v.golden_value,
        precedenceRank: v.precedence_rank,
        validFrom: v.valid_from,
        validTo: v.valid_to,
        confidenceScore: v.confidence_score,
        isOverride: v.is_manual_override,
      })),
    }));
  },
};

const getTemporalHistory: ToolDefinition = {
  name: 'get_temporal_history',
  description: 'Get the bi-temporal history of a specific attribute for an entity, showing all changes over time.',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'Entity ID' },
      attributeCode: { type: 'string', description: 'Attribute code to query' },
      fromDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      toDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    },
    required: ['entityId', 'attributeCode', 'fromDate', 'toDate'],
  },
  execute: async (args, supabase) => {
    const { data: attrDef } = await supabase
      .from('attribute_register')
      .select('*')
      .eq('attribute_code', args.attributeCode)
      .single();

    if (!attrDef) throw new Error(`Attribute not found: ${args.attributeCode}`);

    const { data, error } = await supabase
      .from('entity_attribute_values')
      .select(`*, source_registry!inner(source_code, source_name)`)
      .eq('entity_id', args.entityId)
      .eq('attribute_id', attrDef.id)
      .lte('valid_from', args.toDate)
      .gte('valid_to', args.fromDate)
      .order('valid_from', { ascending: true });

    if (error) throw error;

    return (data || []).map((row: any) => ({
      value: row.golden_value,
      numericValue: row.golden_value_numeric,
      dateValue: row.golden_value_date,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      systemFrom: row.system_from,
      systemTo: row.system_to,
      source: row.source_registry.source_code,
      sourceName: row.source_registry.source_name,
      isOverride: row.is_manual_override,
      overrideReason: row.override_reason,
    }));
  },
};

export function registerLineageTools(registry: ToolRegistry): void {
  registry.registerTool(getFieldLineage);
  registry.registerTool(getTemporalHistory);
}
