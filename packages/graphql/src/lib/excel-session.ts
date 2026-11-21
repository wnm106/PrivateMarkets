/**
 * The message the Excel sign-in page (/excel/connect) sends to the add-in once a
 * person has signed in (docs/EXCEL_ADDIN.md). The page builds it; the add-in parses it.
 *
 * The session is the person's own Supabase session, created for Excel alone. It is
 * never the browser's app session: Supabase rotates refresh tokens, so two holders of
 * one session would sign each other out.
 */

export const EXCEL_SESSION_MESSAGE = 'tapestry.excel.session';
export const EXCEL_SESSION_VERSION = 1;

export interface ExcelSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds since the epoch. */
  expiresAt: number;
  userId: string;
  email: string;
  /** Public project values, so the add-in can refresh its own token. */
  supabaseUrl: string;
  anonKey: string;
}

export function excelSessionMessage(session: ExcelSession): string {
  return JSON.stringify({ type: EXCEL_SESSION_MESSAGE, version: EXCEL_SESSION_VERSION, session });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The session in a message, or null for anything else. */
export function parseExcelSessionMessage(message: unknown): ExcelSession | null {
  let body: unknown = message;
  if (typeof message === 'string') {
    try {
      body = JSON.parse(message);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== 'object') return null;
  const envelope = body as { type?: unknown; version?: unknown; session?: Record<string, unknown> };
  if (envelope.type !== EXCEL_SESSION_MESSAGE || envelope.version !== EXCEL_SESSION_VERSION) return null;
  const raw = envelope.session || {};
  const accessToken = text(raw.accessToken);
  const refreshToken = text(raw.refreshToken);
  const userId = text(raw.userId);
  const supabaseUrl = text(raw.supabaseUrl);
  const anonKey = text(raw.anonKey);
  const expiresAt = Number(raw.expiresAt);
  if (!accessToken || !refreshToken || !userId || !supabaseUrl || !anonKey || !Number.isFinite(expiresAt)) return null;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
  } catch {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    userId,
    email: text(raw.email) || '',
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    anonKey,
  };
}
