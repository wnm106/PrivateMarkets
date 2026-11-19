/** A tool as an outside MCP server lists it. */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  /** The server marked the tool as only reading (annotations.readOnlyHint). */
  readOnly: boolean | null;
  /** The server marked the tool as able to destroy data (annotations.destructiveHint). */
  destructive: boolean | null;
}

/** Which identifier a server accepts, so the assistant passes the right key. */
export interface IdentifierHint {
  /** A Tapestry identifier or source code, for example LEI or DEALCLOUD. */
  identifier: string;
  /** The tool argument that takes it, for example company_id. */
  argument?: string;
  /** The tool it applies to. Empty means any tool on the server. */
  tool?: string;
  note?: string;
}

export type ServerAuthType = 'NONE' | 'BEARER' | 'HEADER';

/** What is needed to reach a server. The secret never leaves the server side. */
export interface ServerConnection {
  url: string;
  authType: ServerAuthType;
  headerName?: string | null;
  secret?: string | null;
}

/** A client's server as one chat turn uses it. */
export interface ExternalServer extends ServerConnection {
  id: string;
  serverCode: string;
  serverName: string;
  instructions: string;
  sourceCode: string | null;
  sourceName: string | null;
  identifierHints: IdentifierHint[];
  tools: DiscoveredTool[];
  enabledTools: string[];
  writeTools: string[];
}

/** What a call to an outside tool hands back to the model. */
export interface ExternalToolResult {
  server: string;
  tool: string;
  isError: boolean;
  /** Always set: the content came from outside Tapestry and is data, not instructions. */
  provenance: string;
  text?: string;
  structured?: unknown;
  truncated?: boolean;
}
