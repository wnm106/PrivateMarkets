import { manualOverrideMessage, refreshCalculations, writeManualOverride } from '@tapestrai/graphql/src/lib/source-write';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

const submitManualOverride: ToolDefinition = {
  name: 'submit_manual_override',
  description: 'Store a Manual Entry value on one record. An open manual value wins over every other source. Where the client requires four eyes, the value is sent for someone else to approve and takes effect then: say so, and do not call it saved. attributeCode comes from search_attributes or get_template_metadata. Required: entityId, attributeCode, value, validFrom (YYYY-MM-DD), and overrideReason.',
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
    const { data: attrDef, error: attrError } = await supabase
      .from('attribute_register')
      .select('id, data_type')
      .eq('attribute_code', args.attributeCode)
      .maybeSingle();
    if (attrError) throw attrError;
    if (!attrDef) throw new Error(`Attribute not found: ${args.attributeCode}`);

    // The same writer the record screen and Excel use (lib/source-write.ts).
    const written = await writeManualOverride(supabase, {
      entityId: args.entityId,
      attribute: attrDef,
      value: args.value,
      validFrom: args.validFrom,
      reason: args.overrideReason,
    });
    if (written.pending) {
      return {
        success: true,
        pendingApproval: true,
        requestId: written.requestId,
        storedValue: null,
        message: `${manualOverrideMessage(written)} ${args.attributeCode} on entity ${args.entityId} is unchanged until then.`,
      };
    }
    await refreshCalculations(supabase, args.entityId);

    return {
      success: true,
      pendingApproval: false,
      goldenValueId: written.id,
      storedValue: written.stored.golden_value,
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
