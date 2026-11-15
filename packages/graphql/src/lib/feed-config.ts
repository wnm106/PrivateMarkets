/**
 * What a feed connection's settings may contain. Settings are stored as plain
 * JSON and shown to users, so only known keys are kept: a credential typed
 * into the wrong box is dropped, not saved where everyone can read it.
 */

export type ConnectionKind = 'STORAGE' | 'HTTP';
export const CONNECTION_KINDS: readonly ConnectionKind[] = ['STORAGE', 'HTTP'];
export const HTTP_AUTH_TYPES = ['NONE', 'BEARER', 'BASIC', 'HEADER'] as const;

const FOLDER_PART = /^[A-Za-z0-9._ -]+$/;

/** A folder path made of plain names. Returns the cleaned path, or throws with a readable reason. */
export function cleanFolder(value: unknown, label = 'The folder'): string {
  const parts = String(value ?? '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..' || !FOLDER_PART.test(part)) {
      throw new Error(`${label} may only use letters, numbers, spaces, dots, dashes and underscores.`);
    }
  }
  return parts.join('/');
}

export function cleanConnectionConfig(kind: string, config: unknown): Record<string, unknown> {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  if (kind === 'STORAGE') {
    return { folder: cleanFolder(input.folder) };
  }
  if (kind === 'HTTP') {
    const baseUrl = String(input.baseUrl ?? '').trim();
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('Enter the address the files are downloaded from, starting with https://.');
    }
    if (url.protocol !== 'https:') throw new Error('The address must start with https://.');
    if (url.username || url.password) throw new Error('Do not put a user name or password in the address. Use the credential box.');
    const authType = String(input.authType ?? 'NONE').toUpperCase();
    if (!(HTTP_AUTH_TYPES as readonly string[]).includes(authType)) throw new Error('Choose how the connection signs in.');
    const cleaned: Record<string, unknown> = { baseUrl: url.toString(), authType };
    if (authType === 'BASIC') {
      const username = String(input.username ?? '').trim();
      if (!username) throw new Error('Enter the user name.');
      cleaned.username = username;
    }
    if (authType === 'HEADER') {
      const headerName = String(input.headerName ?? '').trim();
      if (!/^[A-Za-z0-9-]+$/.test(headerName)) throw new Error('Enter the name of the header that carries the credential, for example X-Api-Key.');
      cleaned.headerName = headerName;
    }
    return cleaned;
  }
  throw new Error('The connection kind must be STORAGE or HTTP.');
}

/** Whether a connection of this kind and settings needs a stored credential. */
export function needsSecret(kind: string, config: Record<string, unknown>): boolean {
  return kind === 'HTTP' && String(config.authType || 'NONE') !== 'NONE';
}

/** A feed's path: a subfolder for STORAGE, the address after the base for HTTP. */
export function cleanFeedPath(kind: string, value: unknown): string {
  const path = String(value ?? '').trim();
  if (kind === 'STORAGE') return cleanFolder(path, 'The subfolder');
  // A backslash is read as a slash in an address, so \\host would leave the connection's host too.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[\\/]{2}/.test(path) || path.includes('\\')) {
    throw new Error('Enter only the part of the address after the connection address.');
  }
  return path;
}

export function codeFrom(name: string, fallback: string): string {
  const code = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return code || fallback;
}
