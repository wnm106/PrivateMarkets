import { SupabaseClient } from '@supabase/supabase-js';
import { ToolDefinition, ToolExecutionResult } from './types';
import { ToolContext, getContextProfile, isCategoryAllowed } from './context-profiles';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  listTools(context?: ToolContext | string): any[] {
    const tools = Array.from(this.tools.values());
    const filtered = context 
      ? tools.filter(tool => isCategoryAllowed(tool.category, context))
      : tools;
    
    return filtered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Get tool definitions in Gemini function calling format
   */
  listToolsForGemini(context?: ToolContext | string): any[] {
    const tools = Array.from(this.tools.values());
    const filtered = context 
      ? tools.filter(tool => isCategoryAllowed(tool.category, context))
      : tools;
    
    return filtered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'OBJECT',
        properties: this.convertSchemaToGemini(tool.inputSchema),
      },
    }));
  }

  /**
   * Convert JSON Schema to Gemini function parameter format
   */
  private convertSchemaToGemini(schema: any): any {
    if (!schema || !schema.properties) return {};
    
    const properties: any = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const prop = value as any;
      properties[key] = {
        type: this.mapJsonSchemaTypeToGemini(prop.type),
        description: prop.description || '',
      };
      
      if (prop.enum) {
        properties[key].enum = prop.enum;
      }
      
      if (prop.items) {
        properties[key].items = prop.items;
      }
    }
    
    return properties;
  }

  private mapJsonSchemaTypeToGemini(type: string): string {
    switch (type?.toLowerCase()) {
      case 'string': return 'STRING';
      case 'number': return 'NUMBER';
      case 'integer': return 'INTEGER';
      case 'boolean': return 'BOOLEAN';
      case 'array': return 'ARRAY';
      case 'object': return 'OBJECT';
      default: return 'STRING';
    }
  }

  /**
   * @param supabaseOverride Optional per-call client (e.g. scoped to the caller's JWT so RLS applies).
   */
  async executeTool(name: string, args: Record<string, any>, supabaseOverride?: SupabaseClient): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.execute(args, supabaseOverride || this.supabase);
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }

  /**
   * Dynamically compile JSON schema from database template registry
   */
  async compileSchemaFromTemplate(templateCode: string): Promise<any> {
    const { data: template } = await this.supabase
      .from('domain_templates')
      .select(`
        *,
        template_attribute_assignments(
          *,
          attribute_register(*)
        )
      `)
      .eq('template_code', templateCode)
      .single();

    if (!template) {
      throw new Error(`Template not found: ${templateCode}`);
    }

    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const assignment of template.template_attribute_assignments || []) {
      const attr = assignment.attribute_register;
      properties[attr.attribute_code] = {
        type: this.mapDataTypeToJsonSchema(attr.data_type),
        description: attr.description || attr.attribute_name,
        ...(attr.unit_of_measure ? { unit: attr.unit_of_measure } : {}),
        ...(attr.validation_regex ? { pattern: attr.validation_regex } : {}),
      };

      if (assignment.is_required || attr.is_required) {
        required.push(attr.attribute_code);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  private mapDataTypeToJsonSchema(dataType: string): string {
    switch (dataType) {
      case 'STRING': return 'string';
      case 'NUMBER': return 'number';
      case 'BOOLEAN': return 'boolean';
      case 'DATE': return 'string';
      case 'TIMESTAMP': return 'string';
      case 'JSON': return 'object';
      case 'REFERENCE': return 'string';
      default: return 'string';
    }
  }
}
