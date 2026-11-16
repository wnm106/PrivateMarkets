/**
 * What a feed connection's settings may contain. Settings are stored as plain
 * JSON and shown to users, so only known keys are kept: a credential typed
 * into the wrong box is dropped, not saved where everyone can read it.
 */

export type ConnectionKind = 'STORAGE' | 'HTTP' | 'SFTP';
export const CONNECTION_KINDS: readonly ConnectionKind[] = ['STORAGE', 'HTTP', 'SFTP'];
export const SFTP_AUTH_TYPES = ['PASSWORD', 'KEY'] as const;
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
  if (kind === 'SFTP') {
    const host = String(input.host ?? '').trim().toLowerCase();
    // A host name or an IP address. No scheme, path, port or user: those have their own boxes.
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && !/^[0-9a-f:]+$/.test(host)) {
      throw new Error('Enter the server name only, for example sftp.example.com.');
    }
    const port = input.port === undefined || input.port === null || input.port === '' ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port must be a number between 1 and 65535.');
    const username = String(input.username ?? '').trim();
    if (!username) throw new Error('Enter the user name.');
    const authType = String(input.authType ?? 'PASSWORD').toUpperCase();
    if (!(SFTP_AUTH_TYPES as readonly string[]).includes(authType)) throw new Error('Choose a password or a private key.');
    const hostKey = String(input.hostKey ?? '').trim();
    if (hostKey && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey)) {
      throw new Error('The host key looks like SHA256: followed by 43 characters. Check the connection to see the server\'s.');
    }
    const cleaned: Record<string, unknown> = {
      host,
      port,
      username,
      authType,
      folder: cleanRemoteFolder(input.folder),
      afterLoad: String(input.afterLoad ?? 'MOVE').toUpperCase() === 'LEAVE' ? 'LEAVE' : 'MOVE',
    };
    if (hostKey) cleaned.hostKey = hostKey;
    return cleaned;
  }
  throw new Error('The connection kind must be STORAGE, HTTP, or SFTP.');
}

/** A folder on a server. Like cleanFolder, but a leading slash is kept: /outbound is not outbound. */
export function cleanRemoteFolder(value: unknown, label = 'The folder'): string {
  const text = String(value ?? '').trim();
  const cleaned = cleanFolder(text, label);
  return /^[\\/]/.test(text) ? `/${cleaned}` : cleaned;
}

/** Whether a connection of this kind and settings needs a stored credential. */
export function needsSecret(kind: string, config: Record<string, unknown>): boolean {
  return kind === 'SFTP' || (kind === 'HTTP' && String(config.authType || 'NONE') !== 'NONE');
}

/** A feed's path: a subfolder for STORAGE, the address after the base for HTTP. */
export function cleanFeedPath(kind: string, value: unknown): string {
  const path = String(value ?? '').trim();
  if (kind === 'STORAGE' || kind === 'SFTP') return cleanFolder(path, 'The subfolder');
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
