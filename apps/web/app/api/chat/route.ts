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
import {
  authenticate,
  CONVERSATION_COLUMNS,
  deriveTitle,
  supabaseAnonKey,
  supabaseUrl,
} from '@/lib/chat-server';
import {
  ATTACHMENT_COLUMNS,
  CHAT_ATTACHMENT_BUCKET,
  MAX_INLINE_TEXT_CHARS,
  isImage,
} from '@/lib/chat-attachments';

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;
const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
const geminiModel = 'gemini-3.8-flash';
const MAX_TOOL_ROUNDS = 6;
/** Cap the stored turn so a huge tool payload can't bloat the transcript. */
const MAX_STORED_CONTENT = 20000;

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

/**
 * Resolves staged (or already-sent) attachments into model input parts.
 *
 * Images become `inlineData` so the model can actually see a screenshot. Text-like
 * files are inlined as a fenced block; binary formats we cannot render are named so
 * the model at least knows they were supplied. When `attachToMessageId` is given,
 * the rows are stamped with it so they travel with the turn they were sent with.
 */
async function loadAttachments(
  supabase: any,
  conversationId: string,
  attachmentIds: string[],
  attachToMessageId?: string
): Promise<Array<{ file_name: string; mime_type: string; parts: any[] }>> {
  if (!attachmentIds.length) return [];

  let query = supabase
    .from('chat_message_attachments')
    .select(`${ATTACHMENT_COLUMNS}`)
    .eq('conversation_id', conversationId)
    .in('id', attachmentIds);
  if (!attachToMessageId) query = query.is('message_id', null);

  const { data: rows, error } = await query;
  if (error || !rows?.length) return [];

  if (attachToMessageId) {
    await supabase
      .from('chat_message_attachments')
      .update({ message_id: attachToMessageId })
      .in('id', rows.map((r: any) => r.id));
  }

  const resolved: Array<{ file_name: string; mime_type: string; parts: any[] }> = [];
  for (const row of rows) {
    const { data: blob } = await supabase.storage.from(CHAT_ATTACHMENT_BUCKET).download(row.storage_path);
    if (!blob) continue;

    if (isImage(row.mime_type)) {
      const buffer = Buffer.from(await blob.arrayBuffer());
      resolved.push({
        file_name: row.file_name,
        mime_type: row.mime_type,
        parts: [{ inlineData: { mimeType: row.mime_type, data: buffer.toString('base64') } }],
      });
      continue;
    }

    const isTextish =
      row.mime_type.startsWith('text/') ||
      row.mime_type === 'application/json';
    if (isTextish) {
      const text = (await blob.text()).slice(0, MAX_INLINE_TEXT_CHARS);
      resolved.push({
        file_name: row.file_name,
        mime_type: row.mime_type,
        parts: [{ text: `\n\nAttached file "${row.file_name}":\n\`\`\`\n${text}\n\`\`\`` }],
      });
      continue;
    }

    resolved.push({
      file_name: row.file_name,
      mime_type: row.mime_type,
      parts: [
        {
          text: `\n\n[Attached file "${row.file_name}" (${row.mime_type}) could not be inlined; ask the user to paste its contents if you need them.]`,
        },
      ],
    });
  }
  return resolved;
}

export async function POST(request: NextRequest) {
  try {
    const { messages, context, toolContext, conversationId, attachmentIds, designerDraft } = await request.json();
    const requestedAttachmentIds: string[] = Array.isArray(attachmentIds) ? attachmentIds : [];

    if (!geminiApiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    // History is a signed-in feature; anonymous callers still get a reply but
    // nothing is persisted for them.
    const auth = await authenticate(request);

    const profile = getContextProfile(toolContext);
    let systemInstruction = profile.systemInstruction;

    if (context?.page) systemInstruction += `\n\nCurrent page: ${context.page}`;
    if (context?.domainCode) systemInstruction += `\nCurrent domain: ${context.domainCode}`;
    if (context?.entityCode) systemInstruction += `\nCurrent entity: ${context.entityCode}`;

    // Report designer: give the model the current draft and the query format up front.
    if (profile.name === 'report-designer') {
      systemInstruction += `\n\n## Data query format\n${DATA_QUERY_SPEC_DOC}`;
      if (context?.kind) systemInstruction += `\n\nYou are designing a ${String(context.kind).toUpperCase()}.`;
      // The open draft lives in the page, not the request context, so accept it
      // from either place.
      const draft = designerDraft ?? context?.draft;
      if (draft) {
        const serialized = JSON.stringify(draft);
        systemInstruction += `\n\n## Current draft (what the user sees in the designer)\n${serialized.length > 30000 ? serialized.slice(0, 30000) + '…[truncated]' : serialized}`;
      }
    }

    // Convert messages to Gemini format (accept both `content` and `text`)
    const incoming: Array<{ role: 'user' | 'model'; content?: string; text?: string }> = messages || [];
    const lastUser = [...incoming].reverse().find((m) => m.role === 'user');

    // Resolve the thread we are appending to. When the conversation already has
    // turns, its stored history wins over the client's copy: a response that
    // arrives late can't clobber a newer thread state. The server creates the
    // thread itself so every entry point (including the report designer) keeps
    // history without the caller having to pre-create anything.
    let conversation: any = null;
    let history: Array<{ role: string; content: string }> = [];
    let turnAttachments: Array<{ file_name: string; mime_type: string; parts: any[] }> = [];

    if (auth && lastUser) {
      if (conversationId) {
        const { data } = await auth.supabase
          .from('chat_conversations')
          .select(CONVERSATION_COLUMNS)
          .eq('id', conversationId)
          .maybeSingle();
        conversation = data ?? null;
      }

      if (!conversation) {
        const { data } = await auth.supabase
          .from('chat_conversations')
          .insert({
            created_by: auth.userId,
            title: deriveTitle(lastUser.content ?? lastUser.text ?? ''),
            tool_context: toolContext ?? null,
            page_context: context?.page ?? null,
            domain_code: context?.domainCode ?? null,
          })
          .select(CONVERSATION_COLUMNS)
          .single();
        conversation = data ?? null;
      }

      if (conversation) {
        const { data: stored } = await auth.supabase
          .from('chat_messages')
          .select('role, content')
          .eq('conversation_id', conversation.id)
          .order('created_at', { ascending: true });

        history = (stored ?? []).map((m) => ({ role: m.role, content: m.content }));

        // Persist this turn before generating so a failed call still records the ask.
        const { data: userMessageRow } = await auth.supabase
          .from('chat_messages')
          .insert({
            conversation_id: conversation.id,
            role: 'user',
            content: (lastUser.content ?? lastUser.text ?? '').slice(0, MAX_STORED_CONTENT),
          })
          .select('id')
          .single();
        history.push({ role: 'user', content: lastUser.content ?? lastUser.text ?? '' });

        // Bind any staged files to the message they were sent with.
        turnAttachments = await loadAttachments(auth.supabase, conversation.id, requestedAttachmentIds, userMessageRow?.id);
        for (const attachment of turnAttachments) {
          history.push({ role: 'user', content: `[Attached: ${attachment.file_name}]` });
        }

        // Keep the thread's context fresh for history hints.
        await auth.supabase
          .from('chat_conversations')
          .update({
            tool_context: toolContext ?? conversation.tool_context,
            page_context: context?.page ?? conversation.page_context,
            domain_code: context?.domainCode ?? conversation.domain_code,
          })
          .eq('id', conversation.id);
      }
    }

    const contents: any[] = (history.length ? history : incoming).map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content ?? (msg as any).text ?? '' }],
    }));

    // Attach this turn's files to the final user turn, so the model sees a
    // screenshot alongside the instruction it belongs to.
    if (turnAttachments.length) {
      const lastUserIndex = contents.map((c) => c.role).lastIndexOf('user');
      const target = lastUserIndex >= 0 ? contents[lastUserIndex] : null;
      if (target) {
        for (const attachment of turnAttachments) {
          target.parts.push(...attachment.parts);
        }
      }
    }

    // Every tool runs as the CALLER. That is both the security model (tenancy /
    // RLS governs what the assistant may read) and an operational necessity: the
    // data schemas grant USAGE to `authenticated` but not to `service_role`, so a
    // service-role client is refused by the security_invoker views before RLS is
    // even consulted.
    const toolSupabase = auth
      ? createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${auth.token}` } },
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : undefined;

    const tools = toolRegistry.listToolsForGemini(toolContext);
    const executedCalls: Array<{ name: string; args: any }> = [];
    /** Results already produced this turn, so an identical repeat is not re-run. */
    const callCache = new Map<string, { ok: boolean; value?: any; error?: string }>();

    /** Records the assistant turn and returns the thread id when persistence is on. */
    const persistAssistantTurn = async (text: string): Promise<string | null> => {
      if (!auth || !conversation) return null;
      await auth.supabase.from('chat_messages').insert({
        conversation_id: conversation.id,
        role: 'model',
        content: text.slice(0, MAX_STORED_CONTENT),
        tool_calls: executedCalls.length ? executedCalls : null,
        model: geminiModel,
      });
      const { data } = await auth.supabase
        .from('chat_conversations')
        .select(CONVERSATION_COLUMNS)
        .eq('id', conversation.id)
        .maybeSingle();
      if (data) conversation = data;
      return conversation.id;
    };

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
        const turnConversationId = await persistAssistantTurn(text);
        return NextResponse.json({
          text,
          toolCalls: executedCalls,
          conversationId: turnConversationId,
          conversation,
        });
      }

      // Execute requested tools and feed results back.
      const results = new Map<any, { ok: boolean; value?: any; error?: string }>();
      for (const call of functionCalls) {
        const { name, args } = call.functionCall;
        executedCalls.push({ name, args: args || {} });

        // A model that re-requests an identical call gains nothing, so serve the
        // cached outcome instead of spending another round on it.
        const cacheKey = `${name}:${JSON.stringify(args || {})}`;
        const cached = callCache.get(cacheKey);
        if (cached) {
          results.set(call, {
            ok: false,
            error: `${cached.ok ? 'Already retrieved this exact result' : cached.error}. `
              + 'Do not repeat this call; use a different tool or answer with what you have.',
          });
          continue;
        }

        try {
          const value = await toolRegistry.executeTool(name, args || {}, toolSupabase);
          const outcome = { ok: true, value };
          callCache.set(cacheKey, outcome);
          results.set(call, outcome);
        } catch (error: any) {
          // Tell the model not to simply retry a failing call, which otherwise
          // burns every remaining round on the same broken tool.
          const outcome = {
            ok: false,
            error: `${error?.message || String(error)}. Do not repeat this call; use a different tool or answer with what you have.`,
          };
          callCache.set(cacheKey, outcome);
          results.set(call, outcome);
        }
      }

      // Echo the model's own functionCall parts back verbatim: each carries a
      // thoughtSignature that must be preserved or the next request is rejected.
      // Any inline attachment parts on this turn ride along for the same reason.
      const echoedParts = [...functionCalls];
      if (round === 0 && turnAttachments.length) {
        const lastUserIndex = contents.map((c) => c.role).lastIndexOf('user');
        const attached = lastUserIndex >= 0 ? contents[lastUserIndex] : null;
        if (attached) {
          for (const part of attached.parts) {
            if (part !== attached.parts[0]) echoedParts.push(part);
          }
        }
      }
      contents.push({ role: candidate.content?.role || 'model', parts: echoedParts });

      // Function results are supplied by the caller, not a 'function' role --
      // that role is not accepted here.
      const resultParts = functionCalls.map((call) => {
        const { name } = call.functionCall;
        const outcome = results.get(call);
        return {
          functionResponse: {
            name,
            response: outcome?.ok
              ? clampResult(asStruct(outcome.value))
              : { error: outcome?.error ?? 'Tool did not run' },
          },
        };
      });
      contents.push({ role: 'user', parts: resultParts });
    }

    // Out of rounds. Make one final, tool-free call so the model answers from
    // whatever it already gathered instead of returning a canned apology. The
    // trailing turn is a bare function-response, so add an explicit instruction
    // for the model to respond to.
    let finalText = '';
    try {
      const finalData = await callGemini({
        contents: [
          ...contents,
          {
            role: 'user',
            parts: [{
              text: 'That is all the data available. Using only what you have already retrieved, '
                + 'answer my original question now. Do not request any more tools.',
            }],
          },
        ],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
      });
      finalText = (finalData.candidates?.[0]?.content?.parts || [])
        .map((p: any) => p.text || '')
        .join('')
        .trim();
    } catch (error) {
      console.error('[Chat API] Final summary call failed:', error);
    }

    const exhausted =
      finalText ||
      'I gathered data but did not finish within the allotted steps. Please ask a narrower question or try again.';
    const exhaustedConversationId = await persistAssistantTurn(exhausted);
    return NextResponse.json({
      text: exhausted,
      toolCalls: executedCalls,
      conversationId: exhaustedConversationId,
      conversation,
    });
  } catch (error: any) {
    console.error('[Chat API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Unknown error occurred', details: error.toString() },
      { status: 500 }
    );
  }
}
