/** Maps the database's assistant_mcp_* rows into the shapes the toolset uses. */

import type { DiscoveredTool, ExternalServer, IdentifierHint, ServerAuthType } from './types';

type Row = Record<string, any>;

const AUTH_TYPES: ServerAuthType[] = ['NONE', 'BEARER', 'HEADER'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function cleanIdentifierHints(value: unknown): IdentifierHint[] {
  if (!Array.isArray(value)) return [];
  const hints: IdentifierHint[] = [];
  for (const item of value.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const identifier = text((item as Row).identifier).slice(0, 100);
    if (!identifier) continue;
    const hint: IdentifierHint = { identifier };
    const argument = text((item as Row).argument).slice(0, 100);
    const tool = text((item as Row).tool).slice(0, 200);
    const note = text((item as Row).note).slice(0, 300);
    if (argument) hint.argument = argument;
    if (tool) hint.tool = tool;
    if (note) hint.note = note;
    hints.push(hint);
  }
  return hints;
}

export function rowTools(value: unknown): DiscoveredTool[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t) => t && typeof t === 'object' && typeof (t as Row).name === 'string')
    .map((t: Row) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
      readOnly: typeof t.readOnly === 'boolean' ? t.readOnly : null,
      destructive: typeof t.destructive === 'boolean' ? t.destructive : null,
    }));
}

/** A row from assistant_mcp_servers_runtime, which carries the secret. */
export function serverFromRuntimeRow(row: Row): ExternalServer {
  const authType = AUTH_TYPES.includes(row.auth_type) ? row.auth_type : 'NONE';
  return {
    id: row.id,
    serverCode: row.server_code,
    serverName: row.server_name,
    url: row.url,
    authType,
    headerName: row.header_name || null,
    secret: typeof row.secret === 'string' ? row.secret : null,
    instructions: text(row.instructions),
    sourceCode: row.source_code || null,
    sourceName: row.source_name || null,
    identifierHints: cleanIdentifierHints(row.identifier_hints),
    tools: rowTools(row.discovered_tools),
    enabledTools: Array.isArray(row.enabled_tools) ? row.enabled_tools : [],
    writeTools: Array.isArray(row.write_tools) ? row.write_tools : [],
  };
}

/** A row from assistant_mcp_servers_list, as an administrator sees it: no secret. */
export function serverView(row: Row) {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    serverCode: row.server_code as string,
    serverName: row.server_name as string,
    url: row.url as string,
    authType: (AUTH_TYPES.includes(row.auth_type) ? row.auth_type : 'NONE') as ServerAuthType,
    headerName: (row.header_name || null) as string | null,
    hasSecret: row.has_secret === true,
    sourceCode: (row.source_code || null) as string | null,
    sourceName: (row.source_name || null) as string | null,
    instructions: text(row.instructions),
    identifierHints: cleanIdentifierHints(row.identifier_hints),
    tools: rowTools(row.discovered_tools),
    enabledTools: (Array.isArray(row.enabled_tools) ? row.enabled_tools : []) as string[],
    writeTools: (Array.isArray(row.write_tools) ? row.write_tools : []) as string[],
    isActive: row.is_active !== false,
    canManage: row.can_manage === true,
    lastCheckedAt: (row.last_checked_at || null) as string | null,
    lastCheckOk: (row.last_check_ok ?? null) as boolean | null,
    lastCheckMessage: (row.last_check_message || null) as string | null,
  };
}

export type ServerView = ReturnType<typeof serverView>;
