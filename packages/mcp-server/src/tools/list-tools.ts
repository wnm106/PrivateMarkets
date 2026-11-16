import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * An attribute's list of allowed values: reading it, and adding to it.
 *
 * These are for workflows. A workflow reads the list so a value it proposes is
 * one the attribute accepts, and can propose adding a value when nothing on
 * the list fits. Lists are shared by every client, so adding a value goes
 * through workflow_list_value_add, which only the worker may call and only
 * after a tenant admin has approved the change.
 */

const getAttributeListValues: ToolDefinition = {
  name: 'get_attribute_list_values',
  description:
    'The values an attribute accepts, when it takes its value from a list. Returns each value\'s code, its label, and other names it is known by. hasList is false when the attribute takes any value. Call this before proposing a value for an attribute, and use the code.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      attributeCode: { type: 'string', description: 'The attribute code, from get_template_metadata or search_attributes' },
    },
    required: ['attributeCode'],
  },
  execute: async (args, supabase) => {
    const { data: attribute, error } = await supabase
      .from('attribute_register')
      .select('attribute_code, attribute_name, reference_list_code, list_values')
      .eq('attribute_code', args.attributeCode)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!attribute) throw new Error(`Attribute not found: ${args.attributeCode}`);

    if (attribute.reference_list_code) {
      const { data: list, error: listError } = await supabase.from('reference_lists').select('id, list_name').eq('list_code', attribute.reference_list_code).maybeSingle();
      if (listError) throw listError;
      if (list) {
        const { data: values, error: valuesError } = await supabase
          .from('reference_list_values')
          .select('value_code, value_label, synonyms, display_order')
          .eq('list_id', list.id)
          .eq('is_active', true)
          .order('display_order');
        if (valuesError) throw valuesError;
        return {
          attributeCode: attribute.attribute_code,
          attributeName: attribute.attribute_name,
          hasList: true,
          listCode: attribute.reference_list_code,
          listName: list.list_name,
          values: (values || []).map((value: any) => ({
            code: value.value_code,
            label: value.value_label || value.value_code,
            synonyms: Array.isArray(value.synonyms) ? value.synonyms.map(String) : [],
          })),
        };
      }
    }

    const inline = (Array.isArray(attribute.list_values) ? attribute.list_values : []).map(String).filter(Boolean);
    return {
      attributeCode: attribute.attribute_code,
      attributeName: attribute.attribute_name,
      hasList: inline.length > 0,
      listCode: null,
      values: inline.map((value: string) => ({ code: value, label: value, synonyms: [] })),
    };
  },
};

const addAttributeListValue: ToolDefinition = {
  name: 'add_attribute_list_value',
  description:
    'Add a value to the list an attribute takes its values from. The list is shared by every client, so use this only when nothing on the list means the same thing. valueCode follows the list\'s own style (look at the existing codes). valueLabel is how people read it. Does nothing if the code is already on the list.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      attributeCode: { type: 'string', description: 'The attribute whose list gets the value' },
      valueCode: { type: 'string', description: 'The code stored on records, in the style of the list\'s existing codes' },
      valueLabel: { type: 'string', description: 'The name shown to people' },
    },
    required: ['attributeCode', 'valueCode', 'valueLabel'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase.rpc('workflow_list_value_add', {
      p_attribute_code: args.attributeCode,
      p_value_code: args.valueCode,
      p_value_label: args.valueLabel,
    });
    if (error) throw error;
    return data;
  },
};

export function registerListTools(registry: ToolRegistry) {
  registry.registerTool(getAttributeListValues);
  registry.registerTool(addAttributeListValue);
}
