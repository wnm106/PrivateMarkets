/**
 * What a feed connection's settings may contain. Settings are stored as plain
 * JSON and shown to users, so only known keys are kept: a credential typed
 * into the wrong box is dropped, not saved where everyone can read it.
 */

export type ConnectionKind = 'STORAGE' | 'HTTP' | 'SFTP' | 'EMAIL';
export const CONNECTION_KINDS: readonly ConnectionKind[] = ['STORAGE', 'HTTP', 'SFTP', 'EMAIL'];
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
    const folder = cleanFolder(input.folder);
    // Email attachments are kept there, and only screening may put files in it.
    if (folder.split('/')[0].toLowerCase() === EMAIL_FOLDER) throw new Error(`The folder cannot start with ${EMAIL_FOLDER}.`);
    return { folder };
  }
  if (kind === 'EMAIL') return cleanEmailConfig(input);
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
  throw new Error('The connection kind must be STORAGE, HTTP, SFTP, or EMAIL.');
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
  // Every feed on an email connection reads the same attachments. File names tell them apart.
  if (kind === 'EMAIL') return '';
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

// ---------------------------------------------------------------------------
// EMAIL connections
// ---------------------------------------------------------------------------

/** The folder under a client's feed-inbox folder that holds email attachments. */
export const EMAIL_FOLDER = '_email';

/** File types an email connection may take. Anything else is never taken, whatever the settings say. */
export const EMAIL_FILE_TYPES = ['csv', 'txt', 'json', 'xlsx', 'xls', 'pdf'] as const;
export const DEFAULT_EMAIL_FILE_TYPES = ['csv', 'xlsx', 'xls', 'pdf'];
export const EMAIL_LIMITS = {
  maxSenders: 50,
  maxPerHour: { min: 1, max: 500, fallback: 30 },
  maxMessageMb: { min: 1, max: 35, fallback: 25 },
};

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// No * or ?: they would read as wildcards, which are not supported.
const LOCAL_PART = /^[a-z0-9!#$%&'+/=^_`{|}~.-]{1,64}$/;

/**
 * One allowed sender: a whole address (ops@adminco.com) or a domain
 * (adminco.com, also written @adminco.com). A domain allows that domain only,
 * not its subdomains. Returns the cleaned value, or null when it is neither.
 */
export function cleanSender(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/^@/, '');
  if (!text) return null;
  const at = text.lastIndexOf('@');
  if (at === -1) return DOMAIN.test(text) ? text : null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  return LOCAL_PART.test(local) && DOMAIN.test(domain) ? `${local}@${domain}` : null;
}

function wholeNumberIn(value: unknown, range: { min: number; max: number; fallback: number }, label: string): number {
  if (value === undefined || value === null || value === '') return range.fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new Error(`${label} must be a whole number between ${range.min} and ${range.max}.`);
  }
  return parsed;
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? ''));
  return String(value ?? '').split(/[\s,;]+/);
}

export function cleanEmailConfig(input: Record<string, unknown>): Record<string, unknown> {
  const senders: string[] = [];
  for (const raw of listOf(input.allowedSenders)) {
    if (!raw.trim()) continue;
    const sender = cleanSender(raw);
    if (!sender) throw new Error(`"${raw.trim()}" is not an email address or a domain.`);
    if (!senders.includes(sender)) senders.push(sender);
  }
  if (senders.length === 0) {
    throw new Error('Enter at least one sender: the address the files come from, or its domain.');
  }
  if (senders.length > EMAIL_LIMITS.maxSenders) throw new Error(`Enter no more than ${EMAIL_LIMITS.maxSenders} senders.`);

  const requested = listOf(input.fileTypes ?? DEFAULT_EMAIL_FILE_TYPES)
    .map((type) => type.trim().toLowerCase().replace(/^\*?\./, ''))
    .filter(Boolean);
  const fileTypes: string[] = [];
  for (const type of requested) {
    if (!(EMAIL_FILE_TYPES as readonly string[]).includes(type)) {
      throw new Error(`.${type} files cannot be taken from email. Choose from ${EMAIL_FILE_TYPES.map((t) => `.${t}`).join(', ')}.`);
    }
    if (!fileTypes.includes(type)) fileTypes.push(type);
  }
  if (fileTypes.length === 0) throw new Error('Choose at least one file type to take.');

  return {
    allowedSenders: senders,
    // Off only for a sender whose mail server does not sign. The sender's address alone is easy to fake.
    requireDkim: input.requireDkim !== false && String(input.requireDkim).toLowerCase() !== 'false',
    fileTypes,
    maxPerHour: wholeNumberIn(input.maxPerHour, EMAIL_LIMITS.maxPerHour, 'Messages an hour'),
    maxMessageMb: wholeNumberIn(input.maxMessageMb, EMAIL_LIMITS.maxMessageMb, 'The largest message'),
  };
}
