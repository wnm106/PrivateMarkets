import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
const geminiModel = 'gemini-2.0-flash';

const supabase = createClient(supabaseUrl, supabaseKey);

// Tool definitions matching the MCP server
const tools = [
  {
    name: 'list_entities',
    description: 'List entities of any domain type with optional filtering. Returns entity data with attributes and relationships.',
    parameters: {
      type: 'OBJECT',
      properties: {
        domainCode: { type: 'STRING', description: 'Domain type (FUND, ISSUER, SECURITY, DEAL, INVESTOR, POSITION)' },
        filter: { type: 'OBJECT', description: 'Filter criteria as key-value pairs' },
        first: { type: 'NUMBER', description: 'Number of results to return (default 20)' },
      },
    },
  },
  {
    name: 'get_entity',
    description: 'Get a specific entity by ID or entity code with all attributes and relationships.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entityId: { type: 'STRING', description: 'Entity ID' },
        entityCode: { type: 'STRING', description: 'Entity code' },
      },
      required: [],
    },
  },
  {
    name: 'create_entity',
    description: 'Create a new entity with attributes. Returns the created entity.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entityCode: { type: 'STRING', description: 'Unique entity code' },
        entityName: { type: 'STRING', description: 'Entity name' },
        domainCode: { type: 'STRING', description: 'Domain code (FUND, ISSUER, SECURITY, DEAL, INVESTOR, POSITION)' },
        templateCode: { type: 'STRING', description: 'Optional template code' },
        description: { type: 'STRING', description: 'Optional description' },
        attributes: { type: 'OBJECT', description: 'Attribute values as key-value pairs' },
      },
      required: ['entityCode', 'entityName', 'domainCode'],
    },
  },
  {
    name: 'create_relationship',
    description: 'Create a relationship between two entities.',
    parameters: {
      type: 'OBJECT',
      properties: {
        parentEntityId: { type: 'STRING', description: 'Parent entity ID' },
        childEntityId: { type: 'STRING', description: 'Child entity ID' },
        relationshipType: { type: 'STRING', description: 'Relationship type (e.g., ISSUER_OF, HELD_BY)' },
        relationshipCode: { type: 'STRING', description: 'Relationship code' },
        isPrimary: { type: 'BOOLEAN', description: 'Is this the primary relationship?' },
        validFrom: { type: 'STRING', description: 'Valid from date (YYYY-MM-DD)' },
      },
      required: ['parentEntityId', 'childEntityId', 'relationshipType', 'relationshipCode'],
    },
  },
  {
    name: 'get_relationship_types',
    description: 'Get all available relationship types and their allowed domain combinations.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'list_dq_exceptions',
    description: 'List data quality exceptions with filtering by status, severity, and domain.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: { type: 'STRING', description: 'Filter by status (OPEN, IN_REVIEW, RESOLVED, WAIVED)' },
        severity: { type: 'STRING', description: 'Filter by severity (CRITICAL, HIGH, MEDIUM, LOW)' },
        domainCode: { type: 'STRING', description: 'Filter by domain code' },
        first: { type: 'NUMBER', description: 'Number of results (default 20)' },
      },
    },
  },
  {
    name: 'get_dq_summary',
    description: 'Get a summary of data quality metrics including exception counts by severity and domain.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'list_domain_types',
    description: 'List all configured entity domain types (e.g., FUND, SECURITY, ISSUER).',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];

// Execute tool calls against Supabase
async function executeTool(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case 'list_entities': {
      let query = supabase.from('entity_master').select('*', { count: 'exact' });
      if (args.domainCode) query = query.eq('domain_code', args.domainCode);
      if (args.filter) {
        for (const [key, value] of Object.entries(args.filter)) {
          if (typeof value === 'string') query = query.eq(key, value);
        }
      }
      query = query.limit(args.first || 20);
      const { data, error, count } = await query;
      if (error) throw error;
      return { entities: data, totalCount: count };
    }

    case 'get_entity': {
      let query = supabase.from('entity_master').select('*');
      if (args.entityId) query = query.eq('entity_id', args.entityId);
      else if (args.entityCode) query = query.eq('entity_code', args.entityCode);
      else throw new Error('Must provide entityId or entityCode');
      const { data, error } = await query.single();
      if (error) throw error;
      return data;
    }

    case 'create_entity': {
      let templateId = null;
      if (args.templateCode) {
        const { data: template } = await supabase
          .from('domain_templates')
          .select('id')
          .eq('template_code', args.templateCode)
          .single();
        templateId = template?.id;
      }

      const { data: entity, error: entityError } = await supabase
        .from('master_entities')
        .insert({
          entity_code: args.entityCode,
          entity_name: args.entityName,
          domain_code: args.domainCode,
          template_id: templateId,
          description: args.description,
        })
        .select()
        .single();

      if (entityError) throw entityError;

      if (args.attributes) {
        for (const [attrCode, value] of Object.entries(args.attributes)) {
          const { data: attr } = await supabase
            .from('attribute_register')
            .select('id, default_precedence_rank')
            .eq('attribute_code', attrCode)
            .single();

          if (attr) {
            const { data: source } = await supabase
              .from('source_registry')
              .select('id')
              .eq('source_code', 'MANUAL')
              .single();

            await supabase.from('entity_attribute_values').insert({
              entity_id: entity.id,
              attribute_id: attr.id,
              source_id: source?.id,
              golden_value: typeof value === 'string' ? value : null,
              golden_value_numeric: typeof value === 'number' ? value : null,
              valid_from: new Date().toISOString().split('T')[0],
              precedence_rank: attr.default_precedence_rank,
            });
          }
        }
      }
      return entity;
    }

    case 'create_relationship': {
      const { data, error } = await supabase
        .from('entity_relationships')
        .insert({
          parent_entity_id: args.parentEntityId,
          child_entity_id: args.childEntityId,
          relationship_type: args.relationshipType,
          relationship_code: args.relationshipCode,
          is_primary: args.isPrimary ?? false,
          valid_from: args.validFrom || new Date().toISOString().split('T')[0],
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    case 'get_relationship_types': {
      const { data, error } = await supabase
        .from('relationship_types')
        .select('*')
        .eq('is_active', true)
        .order('relationship_code');
      if (error) throw error;
      return data;
    }

    case 'list_dq_exceptions': {
      let query = supabase.from('dq_exceptions').select(`
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
      return { exceptions: data, totalCount: count };
    }

    case 'get_dq_summary': {
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
    }

    case 'list_domain_types': {
      const { data, error } = await supabase
        .from('domain_types')
        .select('*')
        .order('domain_code');
      if (error) throw error;
      return data;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    console.log('[Chat API] Request received');
    const body = await request.text();
    console.log('[Chat API] Request body:', body);
    
    const { messages, context } = JSON.parse(body);

    if (!geminiApiKey) {
      console.error('[Chat API] No Gemini API key configured');
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    console.log('[Chat API] Using model:', geminiModel);

    // Build system instruction with context
    let systemInstruction = `You are a helpful assistant for the Meridian MDM (Master Data Management) system. You help users manage financial entities like funds, securities, issuers, deals, and investors. You have access to tools that can query and modify the database. Use them when the user asks about entities, data quality, or wants to create/modify records. Always use tools to get real data rather than making up answers.`;

    if (context?.page) systemInstruction += `\n\nCurrent page: ${context.page}`;
    if (context?.domainCode) systemInstruction += `\nCurrent domain: ${context.domainCode}`;
    if (context?.entityCode) systemInstruction += `\nCurrent entity: ${context.entityCode}`;

    // Convert messages to Gemini format
    const contents = messages.map((msg: any) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }],
    }));

    // Call Gemini with tools
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;
    console.log('[Chat API] Calling Gemini:', geminiUrl);
    
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: [{ functionDeclarations: tools }],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 2048,
        },
      }),
    });

    console.log('[Chat API] Gemini response status:', response.status);

    if (!response.ok) {
      const error = await response.text();
      console.error('[Chat API] Gemini API error:', error);
      return NextResponse.json({ error: `Gemini API error: ${error}` }, { status: 500 });
    }

    const data = await response.json();
    console.log('[Chat API] Gemini response:', JSON.stringify(data, null, 2));
    const candidate = data.candidates?.[0];

    if (!candidate) {
      return NextResponse.json({ error: 'No response from Gemini' }, { status: 500 });
    }

    // Check if Gemini wants to call a function
    const functionCalls = candidate.content?.parts?.filter((p: any) => p.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      // Execute all function calls
      const functionResponses: any[] = [];

      for (const call of functionCalls) {
        try {
          const result = await executeTool(call.functionCall.name, call.functionCall.args || {});
          functionResponses.push({
            name: call.functionCall.name,
            response: result,
          });
        } catch (error: any) {
          functionResponses.push({
            name: call.functionCall.name,
            response: { error: error.message },
          });
        }
      }

      // Send function results back to Gemini for final response
      const followUpContents = [
        ...contents,
        {
          role: 'model',
          parts: functionCalls.map((c: any) => ({
            functionCall: c.functionCall,
          })),
        },
        {
          role: 'function',
          parts: functionResponses.map((r) => ({
            functionResponse: r,
          })),
        },
      ];

      const followUpResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: followUpContents,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: [{ functionDeclarations: tools }],
            generationConfig: {
              temperature: 0.7,
              topK: 40,
              topP: 0.95,
              maxOutputTokens: 2048,
            },
          }),
        }
      );

      const followUpData = await followUpResponse.json();
      const finalText = followUpData.candidates?.[0]?.content?.parts?.[0]?.text || 'I executed the query but could not generate a response.';

      return NextResponse.json({
        text: finalText,
        toolCalls: functionCalls.map((c: any) => ({
          name: c.functionCall.name,
          args: c.functionCall.args,
        })),
      });
    }

    // No function calls - just return the text response
    const text = candidate.content?.parts?.[0]?.text || 'No response generated.';
    return NextResponse.json({ text });

  } catch (error: any) {
    console.error('[Chat API] Error:', error);
    console.error('[Chat API] Error stack:', error.stack);
    return NextResponse.json(
      { error: error.message || 'Unknown error occurred', details: error.toString() },
      { status: 500 }
    );
  }
}
