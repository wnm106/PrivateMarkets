/**
 * What screening decides about one email, without touching the network or
 * storage. email.ts gathers the facts and acts on the verdict.
 *
 *   ACCEPTED     the taken attachments go to the connection's feeds
 *   QUARANTINED  held for a person: the sender is not allowed, or its
 *                address could be forged. A person may release it.
 *   REJECTED     nothing usable, or malware. Releasing cannot help.
 *
 * The checks, in order:
 *   1. One sender address in From.                      (skipped on release)
 *   2. That address, or its domain, is allowed.         (skipped on release)
 *   3. A DKIM signature passed for the From domain.     (skipped on release, or when the connection turned it off)
 *   4. Each attachment is a type the connection takes, its content looks like
 *      that type, it carries no macros or scripts, and it is not too large.
 *   5. At least one attachment is left.
 * Malware scanning comes after, in email.ts, on what is left.
 */

import { spreadsheetProblem } from '@tapestrai/graphql/src/lib/spreadsheet-safety';

export type ScreenStatus = 'ACCEPTED' | 'QUARANTINED' | 'REJECTED';

export interface EmailSettings {
  allowedSenders: string[];
  requireDkim: boolean;
  fileTypes: string[];
}

export interface AuthSummary {
  /** Each DKIM signature: its signing domain, result, and whether it is aligned with From. */
  dkim: Array<{ domain: string; result: string; aligned: boolean }>;
  /** The signing domain of a passing DKIM signature aligned with the From domain, or null. */
  dkimAligned: string | null;
  dmarc: string;
  spf: string;
  /** True when a DNS lookup failed for a reason that may pass on its own. */
  temporary: boolean;
}

export interface AttachmentIn {
  name: string;
  size: number;
  mediaType: string;
  content: Buffer;
}

export interface AttachmentDecision {
  name: string;
  size: number;
  mediaType: string;
  taken: boolean;
  reason?: string;
}

export interface ScreenInput {
  released: boolean;
  /** Addresses in the From header. */
  from: string[];
  settings: EmailSettings;
  auth: AuthSummary;
  attachments: AttachmentIn[];
  maxFileBytes: number;
}

export interface ScreenVerdict {
  status: ScreenStatus;
  reason: string | null;
  attachments: AttachmentDecision[];
}

/** Settings from a connection's config, with the safe defaults for anything missing. */
export function emailSettings(config: Record<string, unknown>): EmailSettings {
  const list = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : []);
  const fileTypes = list(config.fileTypes);
  return {
    allowedSenders: list(config.allowedSenders).map((sender) => sender.replace(/^@/, '')),
    requireDkim: config.requireDkim !== false,
    fileTypes: fileTypes.length > 0 ? fileTypes : ['csv', 'xlsx', 'xls', 'pdf'],
  };
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/** An allowed sender is a whole address, or a domain that allows every address at exactly that domain. */
export function senderAllowed(address: string, allowed: string[]): boolean {
  const clean = address.trim().toLowerCase();
  const domain = domainOf(clean);
  if (!domain) return false;
  return allowed.some((entry) => (entry.includes('@') ? entry === clean : entry === domain));
}

/** A file name that is safe to store: no folders, plain characters, a sensible length. */
export function safeAttachmentName(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/^[. ]+/, '')
    .trim();
  if (!cleaned) return 'attachment';
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 150 - extension.length) + extension;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF = Buffer.from('%PDF-');

/**
 * Why the content is not safe to take as this type, or null when it is.
 * The checks look at the bytes, not the name, so an executable renamed to
 * .csv, or a macro workbook renamed to .xlsx, is not taken.
 */
export function contentProblem(extension: string, content: Buffer): string | null {
  if (content.length === 0) return 'The file is empty.';
  if (extension === 'xlsx') {
    if (!content.subarray(0, 4).equals(ZIP)) return 'The file is not an Excel workbook.';
    // File names in a zip are stored as plain text, so a macro project is visible without unpacking.
    // Every macro workbook has one. (Content types are inside compressed parts, so they are not read.)
    if (content.includes('vbaProject.bin')) return 'The workbook contains macros.';
    // A zip whose parts would inflate far past the attachment itself is refused before anything unpacks it.
    return spreadsheetProblem(content);
  }
  if (extension === 'xls') {
    if (!content.subarray(0, 8).equals(OLE)) return 'The file is not an Excel workbook.';
    if (content.includes(Buffer.from('_VBA_PROJECT', 'utf16le')) || content.includes('_VBA_PROJECT')) return 'The workbook contains macros.';
    return null;
  }
  if (extension === 'pdf') {
    if (!content.subarray(0, 1024).includes(PDF)) return 'The file is not a PDF.';
    if (/\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(content.toString('latin1'))) {
      return 'The PDF contains scripts, launch actions or embedded files.';
    }
    return null;
  }
  // csv, txt, json: text. A NUL byte, or a known binary header, means it is not.
  if (content.includes(0)) return 'The file is not text.';
  if (content.subarray(0, 2).toString('latin1') === 'MZ' || content.subarray(0, 4).equals(ZIP)) return 'The file is not text.';
  return null;
}

export function screenMessage(input: ScreenInput): ScreenVerdict {
  const decisions = input.attachments.map((attachment) => decideAttachment(attachment, input.settings.fileTypes, input.maxFileBytes));

  if (!input.released) {
    const quarantine = (reason: string): ScreenVerdict => ({ status: 'QUARANTINED', reason, attachments: decisions });
    const from = input.from.map((address) => address.trim().toLowerCase()).filter(Boolean);
    if (from.length !== 1) return quarantine(from.length === 0 ? 'The message has no sender address.' : 'The message names more than one sender.');
    const sender = from[0];
    if (!senderAllowed(sender, input.settings.allowedSenders)) {
      return quarantine(`${sender} is not an allowed sender for this connection.`);
    }
    if (input.settings.requireDkim && !input.auth.dkimAligned) {
      const domain = domainOf(sender);
      const signed = input.auth.dkim.filter((signature) => signature.result === 'pass').map((signature) => signature.domain);
      return quarantine(
        signed.length > 0
          ? `The message is signed by ${signed.join(', ')}, not by ${domain}, so the sender could be forged.`
          : `No DKIM signature from ${domain} passed, so the sender could be forged.`,
      );
    }
  }

  const taken = decisions.filter((decision) => decision.taken);
  if (taken.length === 0) {
    const reason =
      decisions.length === 0
        ? 'The message has no attachments.'
        : `No attachment could be taken: ${decisions.map((decision) => `${decision.name} (${decision.reason})`).join('; ')}`;
    return { status: 'REJECTED', reason, attachments: decisions };
  }
  const setAside = decisions.filter((decision) => !decision.taken);
  return {
    status: 'ACCEPTED',
    reason: setAside.length > 0 ? `Set aside: ${setAside.map((decision) => `${decision.name} (${decision.reason})`).join('; ')}` : null,
    attachments: decisions,
  };
}

function decideAttachment(attachment: AttachmentIn, fileTypes: string[], maxFileBytes: number): AttachmentDecision {
  const base = { name: attachment.name, size: attachment.size, mediaType: attachment.mediaType };
  const extension = extensionOf(attachment.name);
  if (!extension || !fileTypes.includes(extension)) {
    return { ...base, taken: false, reason: extension ? `.${extension} files are not taken` : 'the file has no type' };
  }
  if (attachment.size > maxFileBytes) {
    return { ...base, taken: false, reason: `larger than ${Math.round(maxFileBytes / 1024 / 1024)} MB` };
  }
  const problem = contentProblem(extension, attachment.content);
  if (problem) return { ...base, taken: false, reason: problem.replace(/\.$/, '').replace(/^./, (char) => char.toLowerCase()) };
  return { ...base, taken: true };
}
