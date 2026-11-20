import { checkServerUrl } from '@tapestrai/mcp-server/src/external/url-guard';
import { isValidServerCode, serverCodeFrom } from '@tapestrai/mcp-server/src/external/names';
import { cleanIdentifierHints, type ServerView } from '@tapestrai/mcp-server/src/external/rows';
import type { DiscoveredTool, IdentifierHint, ServerAuthType } from '@tapestrai/mcp-server/src/external/types';

/** What the admin page sends to save a server. */
export interface ServerInput {
  id?: string | null;
  serverCode?: string;
  serverName?: string;
  url?: string;
  authType?: string;
  headerName?: string | null;
  /** null or undefined keeps the stored secret; '' removes it. */
  secret?: string | null;
  sourceCode?: string | null;
  instructions?: string;
  identifierHints?: unknown;
  enabledTools?: unknown;
  writeTools?: unknown;
  isActive?: boolean;
}

export interface CleanServerInput {
  id: string | null;
  serverCode: string;
  serverName: string;
  url: string;
  authType: ServerAuthType;
  headerName: string | null;
  secret: string | null;
  sourceCode: string | null;
  instructions: string;
  identifierHints: IdentifierHint[];
  enabledTools: string[];
  writeTools: string[];
  isActive: boolean;
}

export type FieldError = { field: string | null; message: string };

const AUTH_TYPES: ServerAuthType[] = ['NONE', 'BEARER', 'HEADER'];
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'cookie', 'mcp-session-id', 'mcp-protocol-version']);

function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))] : [];
}

/**
 * Checks what an administrator entered. Tools can be turned on only once a
 * connection check has listed them, so `known` is the server's stored tool
 * list (empty for a new server).
 */
export function cleanServerInput(
  input: ServerInput,
  existing: Pick<ServerView, 'serverCode' | 'hasSecret'> | null,
  known: DiscoveredTool[],
): { value: CleanServerInput | null; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const serverName = String(input.serverName || '').trim();
  if (!serverName) errors.push({ field: 'serverName', message: 'Give the server a name.' });

  const serverCode = String(input.serverCode || '').trim() || existing?.serverCode || serverCodeFrom(serverName);
  if (!isValidServerCode(serverCode)) {
    errors.push({ field: 'serverCode', message: 'The code starts with a letter and uses letters, digits and underscores, up to 40.' });
  }

  const url = String(input.url || '').trim();
  const urlProblem = checkServerUrl(url);
  if (urlProblem) errors.push({ field: 'url', message: urlProblem });

  const authType = String(input.authType || 'NONE').toUpperCase() as ServerAuthType;
  if (!AUTH_TYPES.includes(authType)) errors.push({ field: 'authType', message: 'Choose how the assistant signs in.' });

  const headerName = authType === 'HEADER' ? String(input.headerName || '').trim() : '';
  if (authType === 'HEADER' && (!HEADER_NAME.test(headerName) || FORBIDDEN_HEADERS.has(headerName.toLowerCase()))) {
    errors.push({ field: 'headerName', message: 'Enter the header the key goes in, for example X-Api-Key.' });
  }

  // A server that no longer signs in does not keep a credential.
  let secret: string | null = typeof input.secret === 'string' ? input.secret : null;
  if (authType === 'NONE') secret = existing?.hasSecret ? '' : null;
  const willHaveSecret = secret === null ? existing?.hasSecret === true : secret !== '';
  if (authType !== 'NONE' && !willHaveSecret) errors.push({ field: 'secret', message: 'Enter the token or key.' });

  const listed = new Set(known.map((tool) => tool.name));
  const enabledTools = names(input.enabledTools).filter((name) => listed.has(name));
  const writeTools = names(input.writeTools).filter((name) => listed.has(name));

  if (errors.length) return { value: null, errors };
  return {
    value: {
      id: input.id || null,
      serverCode,
      serverName,
      url,
      authType,
      headerName: headerName || null,
      secret,
      sourceCode: String(input.sourceCode || '').trim() || null,
      instructions: String(input.instructions || '').trim().slice(0, 4000),
      identifierHints: cleanIdentifierHints(input.identifierHints),
      enabledTools,
      writeTools,
      isActive: input.isActive !== false,
    },
    errors: [],
  };
}

/** Tools a check found that the server says change data, or does not say only read. */
export function suggestedWriteTools(tools: DiscoveredTool[]): string[] {
  return tools.filter((tool) => tool.destructive === true || tool.readOnly === false).map((tool) => tool.name);
}

/** Turns a database error into a message for the page. */
export function friendlyError(error: unknown): FieldError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (/duplicate key/i.test(raw)) return { field: 'serverCode', message: 'That code is already used by another server.' };
  return { field: null, message: raw || 'The request failed.' };
}
