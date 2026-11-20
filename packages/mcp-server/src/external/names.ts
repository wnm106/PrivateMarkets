/**
 * Names for tools that come from a client's own MCP servers.
 *
 * The assistant sees one flat list of tools, so an outside tool is offered as
 * `ext__<server code>__<tool name>`. The prefix keeps it from colliding with a
 * Tapestry tool, and tells the route which server to send the call to.
 * Gemini accepts names of letters, digits, underscores, dots and dashes, at
 * most 64 characters, so anything else is replaced and a long name is cut and
 * given a short hash to stay unique.
 */

export const EXTERNAL_PREFIX = 'ext__';
const MAX_NAME = 64;

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function clean(part: string): string {
  return part.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function externalToolName(serverCode: string, toolName: string): string {
  const full = `${EXTERNAL_PREFIX}${clean(serverCode)}__${clean(toolName)}`;
  if (full.length <= MAX_NAME) return full;
  const suffix = `_${hash(`${serverCode}/${toolName}`)}`;
  return full.slice(0, MAX_NAME - suffix.length) + suffix;
}

export function isExternalToolName(name: string): boolean {
  return name.startsWith(EXTERNAL_PREFIX);
}

/** Server codes are short identifiers: a letter, then letters, digits or underscores. */
export function isValidServerCode(code: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(code);
}

/** A server code from a display name, for a new server that has none yet. */
export function serverCodeFrom(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const code = /^[A-Z]/.test(base) ? base : `MCP_${base}`;
  return code.slice(0, 40).replace(/_+$/, '') || 'MCP';
}
