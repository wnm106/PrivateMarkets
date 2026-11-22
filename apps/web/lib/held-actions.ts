/**
 * Calls the assistant asked for that change data in an outside system, held
 * until the person confirms them.
 *
 * The model never runs such a call (see mcp-server/src/external/toolset.ts).
 * The chat route signs the exact call it was asked for and hands it to the
 * panel, which shows it with a Confirm button. Only the confirm route runs it,
 * and only for the same person and client, within HOLD_MINUTES, and with the
 * tool and arguments exactly as signed. Nothing the model or a document says
 * can produce a valid signature, so nothing but the person's click runs it.
 *
 * Server only: the signing key is derived from the service role key.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const HOLD_MINUTES = 15;

export interface HeldCall {
  /** Declared tool name, e.g. ext__CRM__update_stage. */
  name: string;
  args: Record<string, unknown>;
  /** What the person is shown. */
  serverName: string;
  tool: string;
}

export interface HeldAction extends HeldCall {
  id: string;
  expiresAt: string;
  token: string;
}

interface Claims {
  i: string;
  u: string;
  c: string;
  n: string;
  a: Record<string, unknown>;
  s: string;
  t: string;
  e: number;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function signingKey(secret: string): Buffer {
  if (!secret) throw new Error('The service role key is not configured, so a change cannot be held for confirmation.');
  // A key of its own, so a signature here can never be mistaken for anything else made from the same secret.
  return createHash('sha256').update(`tapestrai:held-action:v1:${secret}`).digest();
}

function mac(body: string, secret: string): string {
  return createHmac('sha256', signingKey(secret)).update(body).digest('base64url');
}

function defaultSecret(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

/** Signs one call for one person and client. */
export function holdAction(
  call: HeldCall,
  who: { userId: string; clientId: string },
  options: { secret?: string; now?: number } = {},
): HeldAction {
  const now = options.now ?? Date.now();
  const claims: Claims = {
    i: randomUUID(),
    u: who.userId,
    c: who.clientId,
    n: call.name,
    a: call.args || {},
    s: call.serverName,
    t: call.tool,
    e: now + HOLD_MINUTES * 60_000,
  };
  const body = b64url(JSON.stringify(claims));
  return {
    ...call,
    id: claims.i,
    expiresAt: new Date(claims.e).toISOString(),
    token: `${body}.${mac(body, options.secret ?? defaultSecret())}`,
  };
}

/**
 * The call a token holds, when it is genuine, unexpired, and for this person
 * and client. Throws with a reason the person can read otherwise.
 */
export function releaseAction(
  token: string,
  who: { userId: string; clientId: string },
  options: { secret?: string; now?: number } = {},
): HeldCall & { id: string } {
  const [body, signature, extra] = String(token || '').split('.');
  if (!body || !signature || extra !== undefined) throw new Error('This confirmation is not valid.');
  const expected = Buffer.from(mac(body, options.secret ?? defaultSecret()));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('This confirmation is not valid.');
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
  } catch {
    throw new Error('This confirmation is not valid.');
  }
  if (claims.u !== who.userId || claims.c !== who.clientId) throw new Error('This change was held for someone else.');
  if ((options.now ?? Date.now()) > claims.e) {
    throw new Error(`This change was held for ${HOLD_MINUTES} minutes and has expired. Ask the assistant again.`);
  }
  return { id: claims.i, name: claims.n, args: claims.a, serverName: claims.s, tool: claims.t };
}
