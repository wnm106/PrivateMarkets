import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerDomainTools } from '@tapestrai/mcp-server/src/tools/domain-tools';
import { registerLineageTools } from '@tapestrai/mcp-server/src/tools/lineage-tools';
import { registerOverrideTools } from '@tapestrai/mcp-server/src/tools/override-tools';
import { registerDQTools } from '@tapestrai/mcp-server/src/tools/dq-tools';
import { registerImportMapTools } from '@tapestrai/mcp-server/src/tools/import-map-tools';
import { registerPositionFileTools } from '@tapestrai/mcp-server/src/tools/position-file-tools';
import { registerComplianceTools } from '@tapestrai/mcp-server/src/tools/compliance-tools';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { getContextProfile } from '@tapestrai/mcp-server/src/lib/context-profiles';
import { DATA_QUERY_SPEC_DOC } from '@tapestrai/graphql/src/lib/data-query-engine';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;
const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
const geminiModel = 'gemini-2.0-flash';
const MAX_TOOL_ROUNDS = 6;

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize the MCP tool registry
const toolRegistry = new ToolRegistry(supabase);
registerDomainTools(toolRegistry);
registerLineageTools(toolRegistry);
registerOverrideTools(toolRegistry);
registerDQTools(toolRegistry);
registerImportMapTools(toolRegistry);
registerPositionFileTools(toolRegistry);
registerComplianceTools(toolRegistry);
registerReportingTools(toolRegistry);

async function callGemini(body: Record<string, any>) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${error}`);
  }
  return response.json();
}

// Gemini requires function responses to be JSON objects.
function asStruct(result: any): Record<string, any> {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  return { result };
}

// Keep tool output within a sane size for the model context.
function clampResult(result: Record<string, any>, maxChars = 24000): Record<string, any> {
  const s = JSON.stringify(result);
  if (s.length <= maxChars) return result;
  return { truncated: true, note: 'Result truncated for size', preview: s.slice(0, maxChars) };
}

export async function POST(request: NextRequest) {
  try {
    const { messages, context, toolContext } = await request.json();

    if (!geminiApiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    const profile = getContextProfile(toolContext);
    let systemInstruction = profile.systemInstruction;

    if (context?.page) systemInstruction += `\n\nCurrent page: ${context.page}`;
    if (context?.domainCode) systemInstruction += `\nCurrent domain: ${context.domainCode}`;
    if (context?.entityCode) systemInstruction += `\nCurrent entity: ${context.entityCode}`;

    // Report designer: give the model the current draft and the query format up front.
    let toolSupabase: any = undefined;
    if (profile.name === 'report-designer') {
      systemInstruction += `\n\n## Data query format\n${DATA_QUERY_SPEC_DOC}`;
      if (context?.kind) systemInstruction += `\n\nYou are designing a ${String(context.kind).toUpperCase()}.`;
      if (context?.draft) {
        const draft = JSON.stringify(context.draft);
        systemInstruction += `\n\n## Current draft (what the user sees in the designer)\n${draft.length > 30000 ? draft.slice(0, 30000) + '…[truncated]' : draft}`;
      }
      // Run the designer's data access as the CALLER so tenancy / RLS applies to previews.
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
      if (token && supabaseAnonKey) {
        toolSupabase = createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { autoRefreshToken: false, persistSession: false },
        });
      }
    }

    // Convert messages to Gemini format (accept both `content` and `text`)
    const contents: any[] = (messages || []).map((msg: any) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content ?? msg.text ?? '' }],
    }));

    const tools = toolRegistry.listToolsForGemini(toolContext);
    const executedCalls: Array<{ name: string; args: any }> = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const data = await callGemini({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // Offer no tools on the final round so the model must answer.
        ...(round < MAX_TOOL_ROUNDS
          ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
          : {}),
        generationConfig: { temperature: 0.4, topK: 40, topP: 0.95, maxOutputTokens: 8192 },
      });

      const candidate = data.candidates?.[0];
      if (!candidate) {
        return NextResponse.json({ error: 'No response from Gemini' }, { status: 500 });
      }

      const parts: any[] = candidate.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);

      if (functionCalls.length === 0) {
        const text = parts.map((p) => p.text || '').join('').trim() || 'No response generated.';
        return NextResponse.json({ text, toolCalls: executedCalls });
      }

      // Execute requested tools and feed results back.
      const functionResponses: any[] = [];
      for (const call of functionCalls) {
        const { name, args } = call.functionCall;
        executedCalls.push({ name, args: args || {} });
        try {
          const result = await toolRegistry.executeTool(name, args || {}, toolSupabase);
          functionResponses.push({ name, response: clampResult(asStruct(result)) });
        } catch (error: any) {
          functionResponses.push({ name, response: { error: error.message || String(error) } });
        }
      }

      contents.push({ role: 'model', parts: functionCalls.map((c) => ({ functionCall: c.functionCall })) });
      contents.push({ role: 'function', parts: functionResponses.map((r) => ({ functionResponse: r })) });
    }

    return NextResponse.json({ text: 'I ran out of steps before finishing. Please try again with a narrower request.', toolCalls: executedCalls });
  } catch (error: any) {
    console.error('[Chat API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Unknown error occurred', details: error.toString() },
      { status: 500 }
    );
  }
}
