import type { SupabaseClient } from '@supabase/supabase-js';
import { publicFetch, type HttpOptions } from '../connectors';
import { notifyEnv, type Fetch, type NotifyEnv } from '../notify';
import type { HttpCall, Outbound } from './engine';

/**
 * What workflow steps send outside the platform.
 *
 *   http   calls one of the client's HTTP connections, at a path under its
 *          base address, with the connection's stored credential. https only,
 *          no private or internal hosts, no redirects, 30 seconds at most. The
 *          connection is made to the address that was checked (publicFetch).
 *   email  through Resend (RESEND_API_KEY, NOTIFY_EMAIL_FROM).
 *   slack  to the client's incoming webhook, set where review notices are.
 */

type Row = Record<string, unknown>;

const TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 100_000;

/** The full address for a connection's base address and a step's path. Refuses anything that leaves the base address. */
export function connectionUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const clean = String(path || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) throw new Error('The path must be part of the connection\'s address, not a whole address.');
  if (clean.split(/[/?#]/)[0].split('/').some((part) => part === '..') || clean.includes('/../') || clean.startsWith('../')) throw new Error('The path cannot climb out of the connection\'s address.');
  const joined = new URL(base.toString().replace(/\/+$/, '') + (clean ? (clean.startsWith('/') || clean.startsWith('?') ? clean : `/${clean}`) : ''));
  if (joined.origin !== base.origin || !joined.pathname.startsWith(base.pathname.replace(/\/+$/, ''))) throw new Error('The path leaves the connection\'s address.');
  return joined;
}

function authFor(config: Row, secret: string | null): Record<string, string> {
  const authType = String(config.authType || 'NONE').toUpperCase();
  if (authType === 'NONE') return {};
  if (!secret) throw new Error('This connection needs a stored credential.');
  if (authType === 'BEARER') return { authorization: `Bearer ${secret}` };
  if (authType === 'BASIC') return { authorization: `Basic ${Buffer.from(`${String(config.username || '')}:${secret}`).toString('base64')}` };
  if (authType === 'HEADER') {
    const name = String(config.headerName || '').trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error('The connection needs a header name for its credential.');
    return { [name.toLowerCase()]: secret };
  }
  throw new Error(`"${authType}" is not a sign-in method.`);
}

export interface OutboundDeps {
  supabase: SupabaseClient;
  env?: NotifyEnv;
  fetchImpl?: typeof fetch;
  http?: HttpOptions;
}

export function workflowOutbound(deps: OutboundDeps): Outbound {
  const env = deps.env || notifyEnv();
  const fetcher = deps.fetchImpl || fetch;
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await deps.supabase.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  };

  return {
    async http(call: HttpCall) {
      const found = await rpc<Row | null>('workflow_worker_connection', { p_client_id: call.clientId, p_code: call.connection });
      const connection = (found?.connection || null) as Row | null;
      if (!connection) throw new Error(`There is no connection "${call.connection}" for this client.`);
      if (connection.is_active === false) throw new Error(`The connection "${call.connection}" is paused.`);
      if (String(connection.kind) !== 'HTTP') throw new Error(`"${call.connection}" is not an HTTP connection.`);
      const config = (connection.config || {}) as Row;
      const url = connectionUrl(String(config.baseUrl || ''), call.path);
      const headers = { accept: 'application/json', ...(call.body === undefined ? {} : { 'content-type': 'application/json' }), ...authFor(config, typeof found?.secret === 'string' ? found.secret : null) };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await publicFetch(
          url,
          {
            method: call.method,
            headers,
            body: call.body === undefined ? undefined : JSON.stringify(call.body),
            redirect: 'manual',
            signal: controller.signal,
            // The reply is cut to MAX_BODY_CHARS below. A character is at most four bytes.
            maxBytes: MAX_BODY_CHARS * 4,
          },
          { ...deps.http, fetchImpl: deps.fetchImpl },
        );
        if (response.status >= 300 && response.status < 400) throw new Error(`${url.host} answered with a redirect, which is not followed.`);
        const raw = (await response.text()).slice(0, MAX_BODY_CHARS);
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          // Not JSON: keep the text.
        }
        if (!response.ok) throw new Error(`${url.host} answered ${response.status}${raw ? `: ${raw.slice(0, 300)}` : ''}`);
        return { status: response.status, body };
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`${url.host} did not answer within ${TIMEOUT_MS / 1000} seconds.`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async email(to, subject, text) {
      if (!env.resendApiKey || !env.emailFrom) throw new Error('The worker has no RESEND_API_KEY and NOTIFY_EMAIL_FROM, so it cannot send email.');
      const response = await (fetcher as unknown as Fetch)('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.resendApiKey}` },
        body: JSON.stringify({ from: env.emailFrom, to, subject, text }),
      });
      if (!response.ok) throw new Error(`The email was not sent: HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
    },

    async slack(clientId, text) {
      const webhook = await rpc<string | null>('workflow_worker_slack', { p_client_id: clientId });
      if (!webhook) throw new Error('This client has no Slack address. Set one under Review notices on the Workflows page.');
      if (!/^https:\/\/hooks\.slack\.com\//.test(webhook)) throw new Error('The Slack address is not a hooks.slack.com address.');
      const response = await (fetcher as unknown as Fetch)(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!response.ok) throw new Error(`Slack answered ${response.status}.`);
    },

    formLink(token) {
      const path = `/portal/${token}`;
      return env.appUrl ? `${env.appUrl.replace(/\/+$/, '')}${path}` : path;
    },
  };
}
