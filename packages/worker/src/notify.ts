import type { SupabaseClient } from '@supabase/supabase-js';
import { JobError, type JobHandler } from './worker';

/**
 * notify.deliver: sends one addressed activity event (a review notice) by
 * email and to Slack, on the channels the event's client has turned on.
 *
 * Email goes through Resend when RESEND_API_KEY and NOTIFY_EMAIL_FROM are
 * set; without them email is skipped and says why. Slack goes to the client's
 * incoming webhook. Every send is recorded through job_run_notify_record, and
 * a recipient already sent to is never sent to again, so a retry is safe.
 * APP_URL, when set, turns the event's page into a full link.
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

/** Sends what the collected event calls for. Returns one row per send, and why anything was skipped. */
export async function deliver(collected: Collected, env: NotifyEnv, fetcher: Fetch): Promise<{ deliveries: Delivery[]; skipped: string[] }> {
  const deliveries: Delivery[] = [];
  const skipped: string[] = [];
  const summary = collected.summary || 'A workflow review needs you';
  const link = noticeLink(collected.href, env.appUrl);

  if (collected.emailEnabled) {
    if (!env.resendApiKey || !env.emailFrom) {
      skipped.push('Email is on for this client, but the worker has no RESEND_API_KEY and NOTIFY_EMAIL_FROM.');
    } else {
      for (const recipient of collected.recipients || []) {
        const error = await post(fetcher, 'https://api.resend.com/emails', { Authorization: `Bearer ${env.resendApiKey}` }, {
          from: env.emailFrom,
          to: [recipient.email],
          subject: emailSubject(collected.kind),
          text: emailText(summary, link, recipient.name, collected.kind),
        });
        deliveries.push({ channel: 'EMAIL', recipient: recipient.email, status: error ? 'FAILED' : 'SENT', ...(error ? { error } : {}) });
      }
    }
  }

  if (collected.slackWebhookUrl && !collected.slackSent) {
    if (!/^https:\/\/hooks\.slack\.com\//.test(collected.slackWebhookUrl)) {
      skipped.push('The Slack address is not a hooks.slack.com address.');
    } else {
      const error = await post(fetcher, collected.slackWebhookUrl, {}, { text: slackText(summary, link) });
      deliveries.push({ channel: 'SLACK', recipient: 'webhook', status: error ? 'FAILED' : 'SENT', ...(error ? { error } : {}) });
    }
  }
  return { deliveries, skipped };
}

export function notifyDeliverHandler(supabase: SupabaseClient, env: NotifyEnv = notifyEnv(), fetcher: Fetch = fetch as unknown as Fetch): JobHandler {
  return async (run) => {
    const eventId = typeof run.payload.eventId === 'string' ? run.payload.eventId : '';
    if (!eventId) throw new JobError('The job has no eventId.');
    const collected = await supabase.rpc('job_run_notify_collect', { p_event_id: eventId });
    if (collected.error) throw new Error(collected.error.message);
    const data = (collected.data || null) as Collected | null;
    if (!data) return { sent: 0, note: 'The event no longer exists.' };
    if (data.stale) return { sent: 0, note: 'The review was decided before the notice went out.' };

    const { deliveries, skipped } = await deliver(data, env, fetcher);
    if (deliveries.length > 0) {
      const recorded = await supabase.rpc('job_run_notify_record', { p_event_id: eventId, p_rows: deliveries });
      if (recorded.error) throw new Error(recorded.error.message);
    }
    const failed = deliveries.filter((row) => row.status === 'FAILED');
    // A failed send is worth another attempt; what was sent is not sent again.
    if (failed.length > 0) throw new Error(`${failed.length} of ${deliveries.length} sends failed: ${failed.map((row) => `${row.channel} ${row.recipient}: ${row.error}`).join('; ')}`);
    return { sent: deliveries.length, skipped };
  };
}
