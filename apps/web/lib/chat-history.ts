import { authHeaders } from '@/lib/reporting';
import type { SkillState } from '@tapestrai/mcp-server/src/lib/chat-skills';

export interface ChatConversation {
  id: string;
  title: string;
  tool_context: string | null;
  page_context: string | null;
  domain_code: string | null;
  entity_id: string | null;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  /** Guided skill ledger. Absent on threads started before skills existed. */
  skill_state?: SkillState | null;
}

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  tool_calls: Array<{ name: string; args: Record<string, any> }> | null;
  model: string | null;
  created_at: string;
  attachments?: ChatAttachment[];
}

export interface ChatAttachment {
  id: string;
  conversation_id: string;
  message_id: string | null;
  file_name: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
  created_at: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid response (${response.status})`);
  }

  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

/** The signed-in user's threads, most recently used first. */
export async function listConversations(): Promise<ChatConversation[]> {
  const data = await request<{ conversations: ChatConversation[] }>('/api/chat/conversations');
  return data.conversations ?? [];
}

export async function createConversation(input?: {
  title?: string;
  toolContext?: string;
  context?: { page?: string; domainCode?: string; entityId?: string };
}): Promise<ChatConversation> {
  const data = await request<{ conversation: ChatConversation }>('/api/chat/conversations', {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  });
  return data.conversation;
}

export async function fetchConversation(
  id: string
): Promise<{ conversation: ChatConversation; messages: StoredChatMessage[] }> {
  return request(`/api/chat/conversations/${id}`);
}

export async function renameConversation(id: string, title: string): Promise<ChatConversation> {
  const data = await request<{ conversation: ChatConversation }>(`/api/chat/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return data.conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  await request(`/api/chat/conversations/${id}`, { method: 'DELETE' });
}

/**
 * Uploads one file to the private attachment bucket and stages it against a
 * conversation. Sends the raw File so the browser sets the multipart boundary.
 * Returns the attachment plus the thread it belongs to (created on demand).
 */
export async function uploadAttachment(
  file: File,
  conversationId?: string | null
): Promise<{ attachment: ChatAttachment; conversationId: string }> {
  const form = new FormData();
  form.append('file', file);
  if (conversationId) form.append('conversationId', conversationId);

  const response = await fetch('/api/chat/attachments', {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });

  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid response (${response.status})`);
  }
  if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`);
  return data;
}

/** URL for fetching a stored attachment (owner-only; the route enforces it). */
export function attachmentUrl(id: string): string {
  return `/api/chat/attachments/${id}`;
}
