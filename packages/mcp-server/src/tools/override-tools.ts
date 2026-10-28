import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

const submitManualOverride: ToolDefinition = {
  name: 'submit_manual_override',
  description: 'Store a Manual Entry value on one record. An open manual value wins over every other source. attributeCode comes from search_attributes or get_template_metadata. Required: entityId, attributeCode, value, validFrom (YYYY-MM-DD), and overrideReason.',
  category: 'override',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'Entity ID to override' },
      attributeCode: { type: 'string', description: 'Attribute code to override' },
      value: { type: 'string', description: 'Override value' },
      validFrom: { type: 'string', description: 'Valid from date (YYYY-MM-DD)' },
      overrideReason: { type: 'string', description: 'Reason for the override' },
    },
    required: ['entityId', 'attributeCode', 'value', 'validFrom', 'overrideReason'],
  },
  execute: async (args, supabase) => {
    const { data: attrDef } = await supabase
      .from('attribute_register')
      .select('*')
      .eq('attribute_code', args.attributeCode)
      .single();

    if (!attrDef) throw new Error(`Attribute not found: ${args.attributeCode}`);

    const { data: manualSource } = await supabase
      .schema('entity_instances')
      .from('source_registry')
      .select('id')
      .eq('source_code', 'MANUAL')
      .single();

    await supabase
      .from('entity_attribute_values')
      .update({ system_to: new Date().toISOString() })
      .eq('entity_id', args.entityId)
      .eq('attribute_id', attrDef.id)
      .eq('source_id', manualSource?.id)
      .eq('valid_to', '9999-12-31')
      .eq('system_to', '9999-12-31 23:59:59');

    // Insert override
    const { data, error } = await supabase
      .from('entity_attribute_values')
      .insert({
        entity_id: args.entityId,
        attribute_id: attrDef.id,
        source_id: manualSource?.id,
        golden_value: args.value,
        valid_from: args.validFrom,
        precedence_rank: 1,
        is_manual_override: true,
        override_reason: args.overrideReason,
      })
      .select()
      .single();

    if (error) throw error;

    return {
      success: true,
      goldenValueId: data.id,
      message: `Override applied for ${args.attributeCode} on entity ${args.entityId}`,
    };
  },
};

const splitValidTime: ToolDefinition = {
  name: 'split_valid_time',
  description: 'Close one stored value at splitDate and open a new value from that date. eavId comes from get_field_lineage or get_temporal_history. This edits one source row. It does not change which source wins. To make Manual Entry the value on the record, use submit_manual_override.',
  category: 'override',
  inputSchema: {
    type: 'object',
    properties: {
      eavId: { type: 'string', description: 'Entity attribute value ID to split' },
      splitDate: { type: 'string', description: 'Date to split at (YYYY-MM-DD)' },
      newValue: { type: 'string', description: 'New value for the split record' },
      sourceId: { type: 'string', description: 'Source ID for the new value' },
      overrideReason: { type: 'string', description: 'Reason for the split' },
    },
    required: ['eavId', 'splitDate', 'newValue', 'sourceId'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase.rpc('split_valid_time', {
      p_eav_id: args.eavId,
      p_split_date: args.splitDate,
      p_new_value: args.newValue,
      p_source_id: args.sourceId,
    });

    if (error) throw error;

    return {
      success: true,
      newEavId: data,
      message: `Record split at ${args.splitDate}`,
    };
  },
};

export function registerOverrideTools(registry: ToolRegistry): void {
  registry.registerTool(submitManualOverride);
  registry.registerTool(splitValidTime);
}
