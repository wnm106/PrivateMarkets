import type { ChatConversation } from './chat-history';
import type { ChatVoice } from './chat-voice';
import type { SkillState, SkillView } from '@tapestrai/mcp-server/src/lib/chat-skills';
import { authHeaders } from './reporting';

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface ChatContext {
  page?: string;
  entityCode?: string;
  domainCode?: string;
  entityId?: string;
  attributeCode?: string;
  /** As-of date the user is browsing with. */
  asOfDate?: string;
  /**
   * Record or configuration on screen. A hint for the current turn; it does
   * not narrow which tools the assistant may call.
   */
  view?: {
    activity?: 'viewing' | 'editing' | 'creating';
    kind: string;
    label: string;
    summary?: string;
    id?: string;
    snapshot?: Record<string, unknown>;
  };
  toolContext?: 'entity-explorer' | 'entity-admin' | 'compliance' | 'data-quality' | 'import' | 'lineage' | 'report-designer' | 'general';
  /** Existing thread to append to; omit to let the server start a new one. */
  conversationId?: string;
  /** Stored attachment ids to send with this turn. */
  attachmentIds?: string[];
  /** Current report-designer draft, so the assistant can iterate on it. */
  designerDraft?: Record<string, any>;
  /** How this reply should be phrased. */
  voice?: ChatVoice;
  /** Guided skill to run. A designer sets this; otherwise the server infers it. */
  skill?: 'design-dashboard' | 'design-narrative' | 'create-entity';
  /** Ledger from the previous turn, so the interview continues if it is not stored yet. */
  skillState?: SkillState | null;
}

export interface ChatResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
  /** Thread the turn was recorded in (absent for anonymous callers). */
  conversationId?: string | null;
  conversation?: ChatConversation | null;
  /** Guided skill ledger after this turn, when a skill is active. */
  skill?: SkillView | null;
  skillState?: SkillState | null;
}

export async function sendGeminiMessage(
  messages: ChatMessage[],
  context?: ChatContext
): Promise<ChatResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      messages,
      context,
      toolContext: context?.toolContext,
      conversationId: context?.conversationId,
      attachmentIds: context?.attachmentIds,
      designerDraft: context?.designerDraft,
      voice: context?.voice,
      skill: context?.skill,
      skillState: context?.skillState,
    }),
  });

  const text = await response.text();

  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    console.error('[Chat] Failed to parse response:', text);
    throw new Error(`Invalid response from server: ${response.status} ${response.statusText}`);
  }

  if (!response.ok) {
    throw new Error(data.error || `API error: ${response.status}`);
  }

  return {
    text: data.text || 'No response received.',
    toolCalls: data.toolCalls,
    conversationId: data.conversationId ?? null,
    conversation: data.conversation ?? null,
    skill: data.skill ?? null,
    skillState: data.skillState ?? null,
  };
}
