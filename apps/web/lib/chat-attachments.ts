export const CHAT_ATTACHMENT_BUCKET = 'chat-attachments';

/** Images the model can actually see. */
export const IMAGE_MIME_PREFIX = 'image/';

/** Ceiling per file; mirrors the storage bucket's file_size_limit. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Cap on inlined text so a large document can't flood the prompt. */
export const MAX_INLINE_TEXT_CHARS = 60000;

/** Total attachments accepted on a single turn. */
export const MAX_ATTACHMENTS_PER_TURN = 6;

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

export const ATTACHMENT_COLUMNS =
  'id, conversation_id, message_id, file_name, mime_type, byte_size, storage_path, created_at';

/** Storage object path for a new upload: `{userId}/{uuid}.{ext}` (matches the bucket policy). */
export function attachmentObjectPath(userId: string, fileName: string, uuid: string): string {
  const ext = (fileName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || 'bin').toLowerCase();
  return `${userId}/${uuid}.${ext}`;
}

/** True for attachments the model can view directly rather than read as text. */
export function isImage(mimeType: string): boolean {
  return mimeType.startsWith(IMAGE_MIME_PREFIX);
}

/** Formats a byte count for the UI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const CHAT_ATTACHMENT_ACCEPT =
  'image/*,text/plain,text/html,text/markdown,text/csv,application/json,application/pdf,.docx,.xlsx';
