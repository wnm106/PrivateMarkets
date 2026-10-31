import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

const getFieldLineage: ToolDefinition = {
  name: 'get_field_lineage',
  description: 'Competing source values and the winning value for one record. entityId is required. attributeCode, when used, comes from search_attributes; omit it for every field on that record. For a source or a field across many records, use query_data with grain "value". An open Manual Entry value wins when one is present.',
  category: 'lineage',
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

    return Array.from(byAttribute.entries()).map(([code, values]) => {
      const winningRecord = values.find(v => v.golden_value !== null && v.golden_value !== undefined && v.golden_value !== '') || values[0];
      return {
        attributeCode: code,
        attributeName: winningRecord.attribute_register.attribute_name,
        dataType: winningRecord.attribute_register.data_type,
        goldenValue: winningRecord.golden_value,
        resolutionRule: winningRecord.resolution_rule_applied,
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
      };
    });
  },
};

const getTemporalHistory: ToolDefinition = {
  name: 'get_temporal_history',
  description: 'History of one field on one record between fromDate and toDate (YYYY-MM-DD). attributeCode comes from search_attributes. For the current value across records, use query_data.',
  category: 'lineage',
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
