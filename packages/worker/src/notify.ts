import type { SupabaseClient } from '@supabase/supabase-js';
import { JobError, type JobHandler } from './worker';

/**
 * notify.deliver: sends one addressed activity event (a review notice) by
 * email and to Slack, on the channels the event's client has turned on.
 *
 * Email goes through Resend when RESEND_API_KEY and NOTIFY_EMAIL_FROM are
 * set; without them email is skipped and says why. Slack goes to the client's
 * incoming webhook. Each send is recorded through job_run_notify_record as soon
 * as it finishes, and a recipient already sent to is never sent to again, so a
 * run that stops part-way is safe to repeat.
 * APP_URL, when set, turns the event's page into a full link.
 *
 * The event id comes from the job, and a job can be queued with any id. The
 * event must belong to the job's client before anything is sent.
 */

export interface NotifyEnv {
  resendApiKey?: string;
  emailFrom?: string;
  appUrl?: string;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface Recipient {
  userId: string;
  email: string;
  name: string | null;
}

interface Collected {
  eventId?: string;
  /** The client the event belongs to, once job_run_notify_collect returns it. */
  clientId?: string;
  kind?: string;
  summary?: string;
  href?: string | null;
  emailEnabled?: boolean;
  slackWebhookUrl?: string | null;
  slackSent?: boolean;
  recipients?: Recipient[];
  stale?: boolean;
}

export interface Delivery {
  channel: 'EMAIL' | 'SLACK';
  recipient: string;
  status: 'SENT' | 'FAILED';
  error?: string;
}

export function notifyEnv(): NotifyEnv {
  return {
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    emailFrom: process.env.NOTIFY_EMAIL_FROM || undefined,
    appUrl: process.env.APP_URL || undefined,
  };
}

/** The full link to a page in the app, or the path when APP_URL is not set. Only app paths are linked. */
export function noticeLink(href: string | null | undefined, appUrl?: string): string | null {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return null;
  return appUrl ? `${appUrl.replace(/\/+$/, '')}${href}` : href;
}

const SUBJECTS: Record<string, string> = {
  REVIEW_OVERDUE: 'Overdue workflow review',
  FORM_ASSIGNED: 'A workflow form is waiting for you',
  FORM_OVERDUE: 'Overdue workflow form',
  STAGE_ASSIGNED: 'A workflow step is waiting for you',
  STAGE_RETURNED: 'A workflow step came back to you',
  STAGE_OVERDUE: 'Overdue workflow step',
};

export function emailSubject(kind: string | undefined): string {
  return SUBJECTS[kind || ''] || 'A workflow review is waiting for you';
}

/** Why the person is getting the email, by what it is about. */
function becauseLine(kind: string | undefined): string {
  if (kind?.startsWith('FORM_')) return 'You are getting this because the form is for you.';
  if (kind?.startsWith('STAGE_')) return 'You are getting this because this step of the workflow is for you.';
  return 'You are getting this because the review is assigned to you.';
}

export function emailText(summary: string, link: string | null, name: string | null, kind?: string): string {
  const hello = name ? `Hello ${name},` : 'Hello,';
  // A summary that already ends a sentence keeps its own stop.
  const body = /[.!?]$/.test(summary.trim()) ? summary.trim() : `${summary}.`;
  return [hello, '', body, ...(link ? ['', `Open it: ${link}`] : []), '', becauseLine(kind)].join('\n');
}

export function slackText(summary: string, link: string | null): string {
  return link && /^https?:\/\//.test(link) ? `${summary}. <${link}|Open the review>` : link ? `${summary}. Open ${link}` : summary;
}

async function post(fetcher: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<string | null> {
  try {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (response.ok) return null;
    const text = await response.text().catch(() => '');
    return `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Called before each send, and with each send as soon as it finishes. Either
 * may throw to stop the rest. `before` answers false to leave this one send out.
 */
export interface DeliverHooks {
  before?: (channel: Delivery['channel'], recipient: string) => Promise<boolean>;
  sent?: (delivery: Delivery) => Promise<void>;
}

/** Sends what the collected event calls for. Returns one row per send, and why anything was skipped. */
export async function deliver(collected: Collected, env: NotifyEnv, fetcher: Fetch, hooks: DeliverHooks = {}): Promise<{ deliveries: Delivery[]; skipped: string[] }> {
  const deliveries: Delivery[] = [];
  const skipped: string[] = [];
  const summary = collected.summary || 'A workflow review needs you';
  const link = noticeLink(collected.href, env.appUrl);
  const send = async (channel: Delivery['channel'], recipient: string, url: string, headers: Record<string, string>, body: unknown) => {
    if (hooks.before && !(await hooks.before(channel, recipient))) return;
    const error = await post(fetcher, url, headers, body);
    const delivery: Delivery = { channel, recipient, status: error ? 'FAILED' : 'SENT', ...(error ? { error } : {}) };
    deliveries.push(delivery);
    await hooks.sent?.(delivery);
  };

  if (collected.emailEnabled) {
    if (!env.resendApiKey || !env.emailFrom) {
      skipped.push('Email is on for this client, but the worker has no RESEND_API_KEY and NOTIFY_EMAIL_FROM.');
    } else {
      for (const recipient of collected.recipients || []) {
        await send('EMAIL', recipient.email, 'https://api.resend.com/emails', { Authorization: `Bearer ${env.resendApiKey}` }, {
          from: env.emailFrom,
          to: [recipient.email],
          subject: emailSubject(collected.kind),
          text: emailText(summary, link, recipient.name, collected.kind),
        });
      }
    }
  }

  if (collected.slackWebhookUrl && !collected.slackSent) {
    if (!/^https:\/\/hooks\.slack\.com\//.test(collected.slackWebhookUrl)) {
      skipped.push('The Slack address is not a hooks.slack.com address.');
    } else {
      await send('SLACK', 'webhook', collected.slackWebhookUrl, {}, { text: slackText(summary, link) });
    }
  }
  return { deliveries, skipped };
}

/**
 * Why sends failed, for the run's error. The run's error is shown on the Jobs
 * page, so it names the channel and the status only: never who a notice was
 * for, and not the provider's reply, which can repeat the address.
 */
export function failureSummary(deliveries: Delivery[]): string {
  const failed = deliveries.filter((row) => row.status === 'FAILED');
  const reasons = new Map<string, number>();
  for (const row of failed) {
    const reason = `${row.channel} ${/^HTTP \d+/.exec(row.error || '')?.[0] || 'could not be reached'}`;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  const listed = [...reasons].map(([reason, count]) => (count > 1 ? `${reason} (${count})` : reason));
  return `${failed.length} of ${deliveries.length} sends failed: ${listed.join('; ')}`;
}

/**
 * The client an event belongs to, or null when it cannot be told.
 * job_run_notify_collect does not return it yet. Until it does, it is read from
 * the workflow run the notice links to: only review notices are delivered, and
 * each is written with the address of its run.
 */
async function noticeClient(supabase: SupabaseClient, collected: Collected): Promise<string | null> {
  if (typeof collected.clientId === 'string' && collected.clientId) return collected.clientId;
  const runId = /^\/workflows\/runs\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(collected.href || '')?.[1];
  if (!runId) return null;
  const { data, error } = await supabase.rpc('workflow_run_get', { p_run_id: runId });
  if (error) throw new Error(error.message);
  const clientId = (data as { client_id?: unknown } | null)?.client_id;
  return typeof clientId === 'string' && clientId ? clientId : null;
}

export function notifyDeliverHandler(supabase: SupabaseClient, env: NotifyEnv = notifyEnv(), fetcher: Fetch = fetch as unknown as Fetch): JobHandler {
  return async (run, job) => {
    const eventId = typeof run.payload.eventId === 'string' ? run.payload.eventId : '';
    if (!eventId) throw new JobError('The job has no eventId.');
    const collect = async (): Promise<Collected | null> => {
      const collected = await supabase.rpc('job_run_notify_collect', { p_event_id: eventId });
      if (collected.error) throw new Error(collected.error.message);
      return (collected.data || null) as Collected | null;
    };
    const data = await collect();
    // One answer for both, because neither can be matched to a client: it must not say which it was.
    if (!data || data.stale) return { sent: 0, note: 'Nothing to send: the event no longer exists, or its review was decided before the notice went out.' };
    // One answer whether the notice is another client's or cannot be matched to one, for the same reason.
    const owner = await noticeClient(supabase, data);
    if (!owner || owner !== run.clientId) throw new JobError('This client has no notice with that id, so nothing was sent.');

    const { deliveries, skipped } = await deliver(data, env, fetcher, {
      before: async (channel, recipient) => {
        // A run another worker has taken over sends nothing more: that worker sends what is left.
        job?.signal.throwIfAborted();
        // Asked again just before each send. A send another run of this notice has made since this run
        // started is on record by now, and is not made twice; a review decided meanwhile is not announced.
        const now = await collect();
        if (!now || now.stale) return false;
        const due = channel === 'SLACK' ? !now.slackSent : (now.recipients || []).some((row) => row.email === recipient);
        if (!due) return false;
        // Claimed in the database before sending, so of two runs that both get here only one sends.
        const claimed = await supabase.rpc('job_run_notify_claim', { p_event_id: eventId, p_channel: channel, p_recipient: recipient });
        if (claimed.error) throw new Error(claimed.error.message);
        return claimed.data === true;
      },
      // Recorded one at a time, so a run that stops part-way never sends the same notice to the same person again.
      sent: async (delivery) => {
        const recorded = await supabase.rpc('job_run_notify_record', { p_event_id: eventId, p_rows: [delivery] });
        if (recorded.error) throw new Error(recorded.error.message);
      },
    });
    // A failed send is worth another attempt; what was sent is not sent again.
    if (deliveries.some((row) => row.status === 'FAILED')) throw new Error(failureSummary(deliveries));
    return { sent: deliveries.length, skipped };
  };
}
