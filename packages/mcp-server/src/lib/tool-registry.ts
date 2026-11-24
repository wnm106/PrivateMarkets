import { SupabaseClient } from '@supabase/supabase-js';
import { ToolDefinition, ToolEffect, ToolExecutionResult } from './types';
import { ToolContext, getContextProfile, isCategoryAllowed } from './context-profiles';

/**
 * The tools an assistant or a workflow may call.
 *
 * The registry holds definitions only. It keeps no database client: every call
 * names the client it runs as, which is the caller's own (their JWT, so tenancy
 * and row security apply). A call without one is refused. It never falls back
 * to a client of the registry's own, because that client would be the same for
 * every caller and, built from a service key, would see every tenant.
 */
/** Tools named like this only read, unless they say otherwise. The same prefixes workflows use. */
const READ_NAME = /^(get_|list_|search_|find_|preview_|analyze_|compare_|validate_|parse_|query_data$)/;

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * @param _unused Older callers passed a default client here. It is accepted so
   * they still compile, and it is not kept or used.
   */
  constructor(_unused?: unknown) {
    void _unused;
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
   * @param supabase The client this call runs as: the caller's own, carrying their JWT.
   * Required. A call without one is refused instead of running as anyone else.
   */
  async executeTool(name: string, args: Record<string, any>, supabase: SupabaseClient): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    if (!supabase) {
      throw new Error(`Tool ${name} was called without a database client. Pass the client of the user the call runs as.`);
    }
    return tool.execute(args, supabase);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** What calling the tool does (see ToolEffect). An unknown tool is a write. */
  effectOf(name: string): ToolEffect {
    const tool = this.tools.get(name);
    if (!tool) return 'write';
    return tool.effect ?? (READ_NAME.test(name) ? 'read' : 'write');
  }

  /** Names of the arguments a tool declares, or an empty set for an unknown tool. */
  argumentNames(name: string): Set<string> {
    const properties = this.tools.get(name)?.inputSchema?.properties;
    return new Set(properties && typeof properties === 'object' ? Object.keys(properties) : []);
  }

  /**
   * Dynamically compile JSON schema from database template registry
   */
  async compileSchemaFromTemplate(templateCode: string, supabase: SupabaseClient): Promise<any> {
    if (!supabase) {
      throw new Error('compileSchemaFromTemplate was called without a database client.');
    }
    const { data: template } = await supabase
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
