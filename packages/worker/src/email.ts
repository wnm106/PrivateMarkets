import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticate } from 'mailauth';
import { simpleParser } from 'mailparser';
import { emailInbox, FEED_BUCKET, MAX_FILE_BYTES, mediaTypeFor } from './connectors';
import {
  emailSettings,
  safeAttachmentName,
  screenMessage,
  type AttachmentIn,
  type AuthSummary,
  type ScreenVerdict,
} from './email-screen';
import { JobError, type JobHandler } from './worker';

/**
 * email.screen: decides whether one email sent to an EMAIL connection may be
 * loaded. See email-screen.ts for the checks, and docs/FEEDS.md for the whole path.
 *
 * The Email Worker in apps/inbound-email has already refused mail to an
 * unknown or paused address, mail that is too large, and mail over the
 * connection's hourly limit. This job reads the stored message, checks the
 * sender and DKIM, keeps the attachments the connection takes, scans them when
 * a scanner is set up, and records the verdict. Accepted attachments are put
 * where the connection's feeds poll, and the database queues those polls.
 *
 * Nothing here replies to the sender. A reply to a forged sender would be
 * spam of our own, and would tell a spammer the address is live.
 */

type Row = Record<string, any>;

export type DnsResolver = (name: string, type: string) => Promise<unknown>;

/** Scans one file. Returns the signature found, or null when the file is clean. */
export type Scanner = (bytes: Buffer) => Promise<string | null>;

export interface EmailDeps {
  supabase: SupabaseClient;
  /** Checks DKIM, SPF and DMARC. Tests replace it. */
  verify?: (raw: Buffer, envelopeFrom: string | null) => Promise<AuthSummary>;
  /** Set when a scanner is configured. */
  scan?: Scanner | null;
  /** Refuse to accept anything when no scanner is configured. */
  requireScan?: boolean;
}

async function call<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** DKIM, SPF and DMARC, through mailauth, with no IP address: DKIM is what the decision rests on. */
export function mailauthVerifier(resolver?: DnsResolver) {
  return async (raw: Buffer, envelopeFrom: string | null): Promise<AuthSummary> => {
    const result = await authenticate(raw, {
      sender: envelopeFrom || undefined,
      mta: 'tapestrai-inbound',
      disableArc: true,
      disableBimi: true,
      ...(resolver ? { resolver: resolver as never } : {}),
    } as never);
    return summarizeAuth(result as unknown as Row);
  };
}

export function summarizeAuth(result: Row): AuthSummary {
  const dkim = (Array.isArray(result?.dkim?.results) ? result.dkim.results : []).map((signature: Row) => ({
    domain: String(signature.signingDomain || ''),
    result: String(signature.status?.result || 'none'),
    aligned: Boolean(signature.status?.aligned),
  }));
  const aligned = dkim.find((signature: { result: string; aligned: boolean }) => signature.result === 'pass' && signature.aligned);
  return {
    dkim,
    dkimAligned: aligned ? aligned.domain : null,
    dmarc: String(result?.dmarc?.status?.result || 'none'),
    spf: String(result?.spf?.status?.result || 'none'),
    temporary: dkim.some((signature: { result: string }) => signature.result === 'temperror'),
  };
}

/**
 * A scanner that talks to clamd over TCP (INSTREAM). Set CLAMAV_HOST, and
 * CLAMAV_PORT when it is not 3310.
 */
export function clamdScanner(host: string, port = 3310, timeoutMs = 60_000): Scanner {
  return (bytes) =>
    new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => socket.destroy(new Error('The virus scanner did not answer in time.')), timeoutMs);
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const part = bytes.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/: OK$/.test(reply)) resolve(null);
        else if (/ FOUND$/.test(reply)) resolve(reply.replace(/^stream: /, '').replace(/ FOUND$/, ''));
        else reject(new Error(`The virus scanner answered: ${reply || 'nothing'}`));
      });
    });
}

export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): Scanner | null {
  const host = String(env.CLAMAV_HOST || '').trim();
  if (!host) return null;
  const port = Number(env.CLAMAV_PORT) || 3310;
  return clamdScanner(host, port);
}

/** Stored names for the taken attachments: a prefix from the message id, and no two the same. */
export function storedNames(messageId: string, names: string[]): string[] {
  const prefix = messageId.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase().padEnd(8, '0');
  const used = new Set<string>();
  return names.map((name) => {
    const safe = safeAttachmentName(name);
    let candidate = safe;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      const dot = safe.lastIndexOf('.');
      candidate = dot > 0 ? `${safe.slice(0, dot)}_${n}${safe.slice(dot)}` : `${safe}_${n}`;
    }
    used.add(candidate.toLowerCase());
    return `${prefix}_${candidate}`;
  });
}

export function emailScreenHandler(deps: EmailDeps): JobHandler {
  const verify = deps.verify || mailauthVerifier();
  return async (run) => {
    const messageId = typeof run.payload.messageId === 'string' ? run.payload.messageId : '';
    if (!messageId) throw new JobError('The job has no messageId.');
    const context = await call<Row | null>(deps.supabase, 'email_message_context', { p_id: messageId });
    if (!context?.message) throw new JobError('The message no longer exists.');
    const message = context.message as Row;
    const connection = context.connection as Row;
    if (message.client_id !== run.clientId) throw new JobError('The message belongs to another client.');
    // Screened already, released and screened again, or discarded.
    if (message.status !== 'RECEIVED') return { message: messageId, skipped: message.status };
    if (!message.raw_path) throw new JobError('The message was not stored.');
    if (deps.requireScan && !deps.scan) {
      throw new JobError('EMAIL_REQUIRE_SCAN is set but no virus scanner is configured (CLAMAV_HOST). The message is waiting.');
    }

    const bucket = deps.supabase.storage.from(FEED_BUCKET);
    const { data: blob, error: downloadError } = await bucket.download(String(message.raw_path));
    if (downloadError || !blob) throw new Error(`The stored message could not be read: ${downloadError?.message || 'not found'}`);
    const raw = Buffer.from(await blob.arrayBuffer());

    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    const fromField = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
    const from = (fromField?.value || []).map((entry: { address?: string }) => String(entry.address || '')).filter(Boolean);
    const attachments: AttachmentIn[] = (parsed.attachments || [])
      // Inline images in a signature are not files someone sent.
      .filter((attachment) => !(attachment.contentDisposition === 'inline' && /^image\//i.test(attachment.contentType || '')))
      .map((attachment) => {
        const name = attachment.filename || 'attachment';
        return { name, size: attachment.size ?? attachment.content.length, mediaType: mediaTypeFor(name, attachment.contentType), content: attachment.content };
      });

    const released = Boolean(message.released_at);
    const settings = emailSettings(connection?.config && typeof connection.config === 'object' ? connection.config : {});
    const auth = await verify(raw, message.envelope_from || null);
    // A DNS lookup that failed may pass later. Try again rather than quarantine a real sender.
    if (!released && settings.requireDkim && !auth.dkimAligned && auth.temporary) {
      throw new Error('A DKIM key could not be looked up. The message will be screened again.');
    }

    let verdict: ScreenVerdict = screenMessage({ released, from, settings, auth, attachments, maxFileBytes: MAX_FILE_BYTES });

    const takenIndexes = verdict.attachments.map((decision, index) => (decision.taken ? index : -1)).filter((index) => index >= 0);
    if (verdict.status === 'ACCEPTED' && deps.scan) {
      for (const index of takenIndexes) {
        const signature = await deps.scan(attachments[index].content);
        if (signature) {
          verdict = {
            status: 'REJECTED',
            reason: `Malware was found in ${attachments[index].name} (${signature}). Nothing from this message was taken.`,
            attachments: verdict.attachments.map((decision) => ({ ...decision, taken: false })),
          };
          break;
        }
      }
    }

    const record = verdict.attachments.map((decision, index) => ({
      ...decision,
      sha256: createHash('sha256').update(attachments[index].content).digest('hex'),
    })) as Array<Row>;

    if (verdict.status === 'ACCEPTED') {
      const inbox = emailInbox(String(message.client_id), String(message.connection_id));
      const names = storedNames(messageId, takenIndexes.map((index) => attachments[index].name));
      for (let i = 0; i < takenIndexes.length; i += 1) {
        const index = takenIndexes[i];
        const { error } = await bucket.upload(`${inbox}/${names[i]}`, attachments[index].content, {
          contentType: attachments[index].mediaType,
          // A retry after a partial upload writes the same file again.
          upsert: true,
        });
        if (error) throw new Error(`${attachments[index].name} could not be stored: ${error.message}`);
        record[index].storedAs = names[i];
      }
    }

    const polls = await call<number>(deps.supabase, 'email_inbound_screened', {
      p_id: messageId,
      p_status: verdict.status,
      p_reason: verdict.reason,
      p_header_from: from.join(', ') || null,
      p_auth: { dkim: auth.dkim, dkimAligned: auth.dkimAligned, dmarc: auth.dmarc, spf: auth.spf },
      p_attachments: record,
    });

    const result = {
      message: messageId,
      status: verdict.status,
      from: from.join(', '),
      taken: verdict.status === 'ACCEPTED' ? takenIndexes.length : 0,
      setAside: verdict.attachments.filter((decision) => !decision.taken).length,
      pollsQueued: polls || 0,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
    // Held mail fails the run, so it is seen in Jobs as well as under Inbound email.
    if (verdict.status === 'QUARANTINED') throw new JobError(`Email from ${result.from || 'an unknown sender'} was quarantined: ${verdict.reason}`);
    return result;
  };
}
