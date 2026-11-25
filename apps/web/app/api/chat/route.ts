import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { QUERY_DATA_GUIDE } from '@tapestrai/mcp-server/src/tools/query-data';
import { toolRegistry } from '@/lib/chat-tools';
import { loadExternalServers } from '@tapestrai/mcp-server/src/external/load';
import { serviceClient } from '@/lib/assistant-connections-server';
import { buildExternalToolset, ConfirmationRequired, externalServersPrompt, type ExternalToolset } from '@tapestrai/mcp-server/src/external/toolset';
import { holdAction, type HeldAction } from '@/lib/held-actions';
import { NARRATIVE_COMPOSE_GUIDE } from '@tapestrai/mcp-server/src/lib/narrative-guide';
import { formatLessons, lessonFromRow, matchLessons } from '@tapestrai/mcp-server/src/lib/chat-lessons';
import { getContextProfile, isCategoryAllowed } from '@tapestrai/mcp-server/src/lib/context-profiles';
import { moduleAllowsToolGroup, parseModuleScope } from '@/lib/client-modules';
import {
  coerceSkillState,
  completeAssistantTurn,
  ingestUserTurn,
  skillAllowsTool,
  skillById,
  skillFromUserText,
  skillSystemAddendum,
  type SkillDef,
  type SkillState,
  type SkillView,
} from '@tapestrai/mcp-server/src/lib/chat-skills';
import { DATA_QUERY_SPEC_DOC } from '@tapestrai/graphql/src/lib/data-query-engine';
import {
  authenticate,
  deriveTitle,
  selectConversationRows,
  supabaseAnonKey,
  supabaseUrl,
} from '@/lib/chat-server';
import {
  ATTACHMENT_COLUMNS,
  CHAT_ATTACHMENT_BUCKET,
  MAX_INLINE_TEXT_CHARS,
  isImage,
} from '@/lib/chat-attachments';
import { chatVoiceInstruction } from '@/lib/chat-voice';
import { callerClientId } from '@/lib/agent-audit';
import { bindAgentContext, invokeAgent, usageForClient, type AgentAudit } from '@tapestrai/mcp-server/src/agent/harness';
import { geminiAnswerText } from '@tapestrai/mcp-server/src/agent/usage';

const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  '';
const geminiModel = 'gemini-3.8-flash';
const MAX_TOOL_ROUNDS = 10;

/** Requests that ask for a report, briefing, or review get the composition method. */
const REPORT_REQUEST = /\b(review|report|briefing|narrative|memo|presentation|pack|prepare|prep|lp|limited partner|write[- ]?up|attribution|outlook)\b/i;
/** Cap the stored turn so a huge tool payload can't bloat the transcript. */
const MAX_STORED_CONTENT = 20000;

// The tool registry holds no database client. Every tool call below passes the
// caller's own client, so tenancy and row security decide what a tool may touch.
// This route never holds the service role key.
// The tools are registered in lib/chat-tools.ts, shared with /api/chat/confirm.

async function callGemini(
  body: Record<string, any>,
  scope: { userId: string | null; clientId: string | null; agent: string | null; conversationId: string | null; metadata?: Record<string, unknown> },
  audits: AgentAudit[],
) {
  const { response, audit } = await invokeAgent({
    provider: 'gemini',
    model: geminiModel,
    feature: 'chat',
    activity: 'chat.turn',
    agent: scope.agent,
    userId: scope.userId,
    clientId: scope.clientId,
    conversationId: scope.conversationId,
    metadata: scope.metadata,
    body,
  });
  audits.push(audit);
  return response as any;
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

/** House vocabulary. It applies on every page, with or without the screen data. */
/** How the chat panel renders links and formulas, so answers use forms it can show and route. */
const LINKS_AND_FORMULAS = `\n\n## Links and formulas\n- Cite a document passage as a markdown link to the href the document tools return: [Credit Agreement, 1.1 Defined Terms, page 18](/documents/...?at=...). Never write an href yourself.\n- Link a record you name when a tool gave you its id and domain code: [Acme Fund III](entity:FUND/<id>). The app opens the record's page. Do not link a record whose id you do not have.\n- Write a formula in LaTeX between $$ and $$ on a line of its own, or between \\( and \\) inside a sentence. Never use a single $ for math: in this app it means money.\n- Headings go no deeper than ###.`;

const DOMAIN_GLOSSARY = `\n\n## House terms\n- A portfolio is a top-level fund. A sub-portfolio is a sleeve of a portfolio, linked to it by FUND_PARENT, and its sub-portfolios sum to it. A fund with no children is its own portfolio.\n- Report allocations, positions, exposure and holdings by portfolio unless the user asks for sub-portfolios or a breakdown. Positions and proposed allocations are stored at the sub-portfolio level, so roll them up to the parent through FUND_PARENT before reporting, and never list a sub-portfolio as if it were a portfolio or add it to its parent's total.\n- When you roll up, you may name the sub-portfolios under each portfolio in a short parenthetical if it helps.`;

const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * The As Of and Knowledge dates the user set in the app apply to every tool that accepts
 * them, unless the model passed its own because the user asked for a different date.
 * A Knowledge date of today means "now", and an earlier one means the end of that day.
 */
function withGlobalDates(
  toolName: string,
  args: Record<string, any> | undefined,
  context: Record<string, any> | null | undefined,
): Record<string, any> {
  const next = { ...(args || {}) };
  if (!context || typeof context !== 'object') return next;
  const accepted = toolRegistry.argumentNames(toolName);
  const asOf = typeof context.asOfDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(context.asOfDate) ? context.asOfDate.slice(0, 10) : '';
  if (asOf && accepted.has('asOfDate') && !next.asOfDate) next.asOfDate = asOf;
  const known = typeof context.knowledgeDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(context.knowledgeDate) ? context.knowledgeDate.slice(0, 10) : '';
  const instant = knowledgeInstantOf(context.knowledgeDate);
  if (instant && accepted.has('knowledgeDate') && !next.knowledgeDate) {
    // An exact instant, such as a certification's, applies as it is, even today.
    next.knowledgeDate = instant;
  } else if (known && known < TODAY() && accepted.has('knowledgeDate') && !next.knowledgeDate) {
    next.knowledgeDate = `${known}T23:59:59.999Z`;
  }
  return next;
}

/** The knowledge date when it is an exact instant (a timestamp), not a day. */
function knowledgeInstantOf(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

const MAX_SCREEN_JSON = 12000;

/** Hint about the open page. It does not change which tools are available. */
function screenContextBlock(context: Record<string, any> | null | undefined): string {
  if (!context || typeof context !== 'object') return '';
  const lines: string[] = [];
  if (context.page) lines.push(`Page: ${context.page}`);
  if (context.domainCode) lines.push(`Domain: ${context.domainCode}`);
  if (context.entityCode) lines.push(`Entity code: ${context.entityCode}`);
  if (context.entityId) lines.push(`Entity id: ${context.entityId}`);
  if (context.attributeCode) lines.push(`Attribute: ${context.attributeCode}`);
  if (context.asOfDate) lines.push(`As-of date: ${context.asOfDate} (applied to your tool calls unless you pass another)`);
  if (context.datesPinnedBy && knowledgeInstantOf(context.knowledgeDate)) {
    lines.push(`Knowledge: as known at ${knowledgeInstantOf(context.knowledgeDate)}. ${context.datesPinnedBy}: this page shows what was certified, and your tool calls read at the same As Of date and instant. Later changes are not in it; say so when it matters to the answer.`);
  } else if (context.knowledgeDate && String(context.knowledgeDate).slice(0, 10) < TODAY()) {
    lines.push(`Knowledge date: ${context.knowledgeDate}. Data is limited to what was known by the end of that day, and your tool calls apply it. Say so when it matters to the answer.`);
  }

  const view = context.view;
  if (view && typeof view === 'object') {
    const activity = view.activity || 'viewing';
    lines.push(`Focus: ${activity} ${view.kind || 'item'} "${view.label || ''}"`.trim());
    if (view.summary) lines.push(`Summary: ${view.summary}`);
    if (view.id) lines.push(`Focus id: ${view.id}`);
    if (view.snapshot && typeof view.snapshot === 'object') {
      let json = JSON.stringify(view.snapshot);
      if (json.length > MAX_SCREEN_JSON) json = `${json.slice(0, MAX_SCREEN_JSON)}…[truncated]`;
      lines.push(`Details: ${json}`);
    }
  }

  if (!lines.length) return '';
  return `\n\n## Current screen\nThe user is working in the app as described below. When their question is about this page, record, or configuration, answer from the Details below first, and quote its figures as shown. Those are the numbers on their screen, and they can differ from what is saved in the database. Call a tool only when Details does not contain what you need, or is marked truncated, and then say that the answer comes from saved data and not from the screen. Use these identifiers (entity id, domain, attribute, as-of date) when you call tools. If the question is about something else, do not assume they mean this screen.\n${lines.join('\n')}`;
}

export async function POST(request: NextRequest) {
  // The client's own MCP servers, connected on first use this turn and closed when it ends.
  let externalToolset: ExternalToolset | null = null;
  try {
    // The assistant is for signed-in users only. Nothing is read, no model is
    // called, and no tool runs for a request without a valid session.
    const auth = await authenticate(request);
    if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    const { messages, context, toolContext, conversationId, attachmentIds, designerDraft, voice, skill: requestedSkill, skillState: clientSkillState } = await request.json();
    const requestedAttachmentIds: string[] = Array.isArray(attachmentIds) ? attachmentIds : [];

    if (!geminiApiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    const clientId = await callerClientId(auth.supabase);
    bindAgentContext({ userId: auth.userId, clientId, feature: 'chat', activity: 'chat.turn' });
    const audits: AgentAudit[] = [];
    /** Outside writes the model asked for this turn. Each runs only if the person presses Confirm. */
    const heldActions: HeldAction[] = [];
    const withUsage = (payload: Record<string, unknown>, status = 200) =>
      NextResponse.json({ ...payload, usage: usageForClient(audits), ...(heldActions.length ? { heldActions } : {}) }, { status });

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

    if (lastUser) {
      if (conversationId) {
        const { data } = await selectConversationRows((columns) =>
          auth.supabase.from('chat_conversations').select(columns).eq('id', conversationId).maybeSingle()
        );
        conversation = data ?? null;
      }

      if (!conversation) {
        const { data } = await selectConversationRows((columns) =>
          auth.supabase
            .from('chat_conversations')
            .insert({
              created_by: auth.userId,
              title: deriveTitle(lastUser.content ?? lastUser.text ?? ''),
              tool_context: toolContext ?? null,
              page_context: context?.page ?? null,
              domain_code: context?.domainCode ?? null,
            })
            .select(columns)
            .single()
        );
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

    const userText = lastUser?.content ?? lastUser?.text ?? '';
    const clientLedger = skillById(clientSkillState?.skillId) ? clientSkillState : null;
    const storedRaw = clientLedger ?? conversation?.skill_state;
    const storedSkill = skillById(storedRaw?.skillId);
    const requested = skillById(requestedSkill);
    const skill: SkillDef | null = requested ?? storedSkill ?? skillFromUserText(userText);
    let skillState: SkillState | null = skill
      ? ingestUserTurn(
          skill,
          coerceSkillState(skill, skill?.id === storedSkill?.id ? storedRaw : null),
          userText
        )
      : null;

    const profile = getContextProfile(skill?.toolContext ?? toolContext);
    let systemInstruction = profile.systemInstruction + chatVoiceInstruction(voice) + DOMAIN_GLOSSARY + LINKS_AND_FORMULAS + screenContextBlock(context);

    // Report designer: give the model the current draft and the query format up front.
    if (profile.name === 'report-designer') {
      systemInstruction += `\n\n## Data query format\n${DATA_QUERY_SPEC_DOC}`;
      if (context?.kind) systemInstruction += `\n\nYou are designing a ${String(context.kind).toUpperCase()}.`;
      const draft = designerDraft ?? context?.draft;
      if (draft) {
        const serialized = JSON.stringify(draft);
        systemInstruction += `\n\n## Current draft (what the user sees in the designer)\n${serialized.length > 30000 ? serialized.slice(0, 30000) + '…[truncated]' : serialized}`;
      }
    }
    if (skill && skillState) systemInstruction += skillSystemAddendum(skill, skillState);

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
    const toolSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${auth.token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Tool groups outside the client's license are not offered. The registry
    // refuses them as well, so this only keeps the model from reaching for them.
    const { data: scopeRow } = await toolSupabase.schema('tenancy').rpc('module_scope');
    const licenseScope = parseModuleScope(scopeRow);
    const licensedTool = (name: string) => {
      const category = toolRegistry.categoryOf(name);
      return !category || moduleAllowsToolGroup(licenseScope, category);
    };

    const tools = toolRegistry
      .listToolsForGemini(skill?.toolContext ?? toolContext)
      .filter((tool) => skillAllowsTool(skill, skillState, tool.name))
      .filter((tool) => licensedTool(tool.name));

    // Outside systems the client has connected. Offered only to a signed-in
    // caller, in a context that allows them, and not while a guided skill runs.
    // The client id comes from the caller's own session. A server that cannot
    // be loaded leaves the assistant with Tapestry's own tools.
    if (auth && clientId && !skill && isCategoryAllowed('external', toolContext) && moduleAllowsToolGroup(licenseScope, 'external')) {
      try {
        // Only the connection loader holds the service role, for this one read: the
        // function that returns a server's credentials is not granted to signed-in users.
        const servers = await loadExternalServers(serviceClient(), clientId);
        if (servers.length) {
          externalToolset = buildExternalToolset(servers);
          tools.push(...externalToolset.declarations);
          systemInstruction += externalServersPrompt(servers, externalToolset);
        }
      } catch (error) {
        console.error('[Chat API] Could not load assistant connections:', error);
      }
    }
    if (tools.some((tool) => tool.name === 'query_data')) {
      systemInstruction += QUERY_DATA_GUIDE;
      const { data, error } = await auth.supabase
        .from('chat_lessons')
        .select('id, phrases, reading, query_shape, answer_shape')
        .eq('is_active', true);
      if (!error && data?.length) {
        systemInstruction += formatLessons(matchLessons(userText, data.map(lessonFromRow)));
      }
    }
    if (tools.some((tool) => tool.name === 'start_narrative_run') && (userText.length > 600 || REPORT_REQUEST.test(userText))) {
      systemInstruction += `\n\n${NARRATIVE_COMPOSE_GUIDE}\nIn this chat you have a limited number of tool steps. For a full multi-section report, prefer a saved narrative: tell the user it can be generated from the record's page (Dashboards & Narratives), and answer the parts you can with the tools.`;
    }
    const executedCalls: Array<{ name: string; args: any }> = [];
    const successfulTools = new Set<string>();
    /** Results already produced this turn, so an identical repeat is not re-run. */
    const callCache = new Map<string, { ok: boolean; value?: any; error?: string }>();

    /** Records the assistant turn and returns the thread id when persistence is on. */
    const persistAssistantTurn = async (text: string): Promise<string | null> => {
      if (!conversation) return null;
      await auth.supabase.from('chat_messages').insert({
        conversation_id: conversation.id,
        role: 'model',
        content: text.slice(0, MAX_STORED_CONTENT),
        tool_calls: executedCalls.length ? executedCalls : null,
        model: geminiModel,
      });
      const patch: Record<string, unknown> = {};
      if (skillState) patch.skill_state = skillState;
      if (skill) patch.tool_context = skill.toolContext;
      if (Object.keys(patch).length) {
        await auth.supabase.from('chat_conversations').update(patch).eq('id', conversation.id);
      }
      const { data } = await selectConversationRows((columns) =>
        auth.supabase.from('chat_conversations').select(columns).eq('id', conversation.id).maybeSingle()
      );
      if (data) conversation = data;
      return conversation.id;
    };

    const finish = (text: string) => {
      if (!skill || !skillState) return { text, skill: null as SkillView | null };
      const done = completeAssistantTurn(
        skill,
        skillState,
        text,
        executedCalls.filter((call) => successfulTools.has(call.name)).map((call) => call.name),
        userText
      );
      skillState = done.state;
      return { text: done.text, skill: done.view };
    };

    const scope = {
      userId: auth.userId,
      clientId,
      agent: skill?.id ?? 'assistant',
      conversationId: (conversation?.id ?? conversationId ?? null) as string | null,
      metadata: { page: context?.page ?? null },
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
      }, scope, audits);

      const candidate = data.candidates?.[0];
      if (!candidate) {
        return withUsage({ error: 'No response from Gemini' }, 500);
      }

      const parts: any[] = candidate.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);

      if (functionCalls.length === 0) {
        const raw = geminiAnswerText(data) || 'No response generated.';
        const finished = finish(raw);
        // Keep the answer block. The panel turns it into cards, colored changes, and a chart.
        const text = finished.text;
        const turnConversationId = await persistAssistantTurn(text);
        return withUsage({
          text,
          skill: finished.skill,
          skillState,
          toolCalls: executedCalls,
          conversationId: turnConversationId,
          conversation,
        });
      }

      // Execute requested tools and feed results back.
      const results = new Map<any, { ok: boolean; value?: any; error?: string }>();
      for (const call of functionCalls) {
        const { name } = call.functionCall;
        const args = withGlobalDates(name, call.functionCall.args, context);
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
          if (skill && !skillAllowsTool(skill, skillState, name)) {
            const outcome = {
              ok: false,
              error: 'This skill is still collecting decisions. Do not call this tool until the user confirms the spec.',
            };
            callCache.set(cacheKey, outcome);
            results.set(call, outcome);
            continue;
          }
          // A tool that changes live records, rules or settings is never run by the model:
          // it is held like an outside write, and runs only on the person's Confirm.
          if (!externalToolset?.has(name) && toolRegistry.effectOf(name) === 'write') {
            throw new ConfirmationRequired(name, 'Tapestry', 'internal');
          }
          const value = externalToolset?.has(name)
            ? await externalToolset.execute(name, args || {})
            : await toolRegistry.executeTool(name, args || {}, toolSupabase);
          const outcome = { ok: true, value };
          successfulTools.add(name);
          callCache.set(cacheKey, outcome);
          results.set(call, outcome);
        } catch (error: any) {
          // An outside write: held for the person, never run here.
          if (error instanceof ConfirmationRequired && clientId) {
            let held: HeldAction | null = null;
            try {
              held = holdAction({ name, args: args || {}, serverName: error.serverName, tool: error.tool, kind: error.kind }, { userId: auth.userId, clientId });
            } catch (holdError) {
              console.error('[Chat API] Could not hold a change for confirmation:', holdError);
            }
            if (held) heldActions.push(held);
            const outcome = held
              ? {
                  ok: true,
                  value: {
                    status: 'awaiting_user_confirmation',
                    note: `Not run. The user is shown this exact ${error.tool} call in ${error.serverName} with a Confirm button below your reply, and it runs only if they press it. Say in one or two sentences what it will change and ask them to confirm below. Do not call it again and do not say it is done.`,
                  },
                }
              : { ok: false, error: `${error.tool} could not be held for confirmation, so it was not run. Tell the user.` };
            callCache.set(cacheKey, outcome);
            results.set(call, outcome);
            continue;
          }
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
              text: 'No further tools are available. Answer from the rows already retrieved. '
                + 'If an amount the question needs was never returned, say it was not retrieved. '
                + 'Do not substitute a facility size, original principal, or record count for that amount.',
            }],
          },
        ],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
      }, scope, audits);
      finalText = geminiAnswerText(finalData);
    } catch (error) {
      console.error('[Chat API] Final summary call failed:', error);
    }

    const exhausted =
      finalText ||
      'I gathered data but did not finish within the allotted steps. Please ask a narrower question or try again.';
    const finished = finish(exhausted);
    const text = finished.text;
    const exhaustedConversationId = await persistAssistantTurn(text);
    return withUsage({
      text,
      skill: finished.skill,
      skillState,
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
  } finally {
    await externalToolset?.close();
  }
}
