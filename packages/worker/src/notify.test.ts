import { describe, expect, it } from 'vitest';
import { deliver, emailText, noticeLink, notifyDeliverHandler, slackText, type Fetch } from './notify';
import { LeaseLostError, type JobRun } from './worker';

function fakeFetch(fail: (url: string) => boolean = () => false) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return fail(url) ? { ok: false, status: 500, text: async () => 'down' } : { ok: true, status: 200, text: async () => '' };
  };
  return { calls, fetcher };
}

const event = {
  eventId: 'e1',
  kind: 'REVIEW_ASSIGNED',
  summary: 'Review waiting for you: "Fixes" in Data cleanup, 2 proposed changes',
  href: '/workflows/runs/r1',
  emailEnabled: true,
  slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x',
  slackSent: false,
  recipients: [
    { userId: 'u1', email: 'ada@example.com', name: 'Ada' },
    { userId: 'u2', email: 'ben@example.com', name: null },
  ],
};

describe('notify.deliver', () => {
  it('links only app paths, in full when APP_URL is set', () => {
    expect(noticeLink('/workflows/runs/r1', 'https://app.example.com/')).toBe('https://app.example.com/workflows/runs/r1');
    expect(noticeLink('/workflows/runs/r1')).toBe('/workflows/runs/r1');
    expect(noticeLink('https://elsewhere.example')).toBeNull();
    expect(noticeLink('//elsewhere.example')).toBeNull();
    expect(emailText('Review waiting', 'https://app.example.com/x', 'Ada')).toContain('Open it: https://app.example.com/x');
    expect(slackText('Review waiting', 'https://app.example.com/x')).toBe('Review waiting. <https://app.example.com/x|Open the review>');
  });

  it('emails each recipient through Resend and posts once to Slack', async () => {
    const { calls, fetcher } = fakeFetch();
    const result = await deliver(event, { resendApiKey: 're_test', emailFrom: 'Workflows <w@example.com>', appUrl: 'https://app.example.com' }, fetcher);
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', recipient: 'ada@example.com', status: 'SENT' },
      { channel: 'EMAIL', recipient: 'ben@example.com', status: 'SENT' },
      { channel: 'SLACK', recipient: 'webhook', status: 'SENT' },
    ]);
    expect(calls[0]).toMatchObject({ url: 'https://api.resend.com/emails', headers: { Authorization: 'Bearer re_test' }, body: { to: ['ada@example.com'], subject: 'A workflow review is waiting for you' } });
    expect(calls[2].url).toBe('https://hooks.slack.com/services/T/B/x');
  });

  it('skips email without a provider, Slack once sent, and a webhook that is not Slack', async () => {
    const { calls, fetcher } = fakeFetch();
    const result = await deliver({ ...event, slackSent: true }, {}, fetcher);
    expect(result.deliveries).toEqual([]);
    expect(result.skipped[0]).toMatch(/RESEND_API_KEY/);
    const elsewhere = await deliver({ ...event, emailEnabled: false, slackWebhookUrl: 'https://evil.example/hook' }, {}, fetcher);
    expect(elsewhere.deliveries).toEqual([]);
    expect(elsewhere.skipped[0]).toMatch(/hooks\.slack\.com/);
    expect(calls).toHaveLength(0);
  });

  const RUN_ID = '11111111-2222-4333-8444-555555555555';
  const notice = { ...event, href: `/workflows/runs/${RUN_ID}` };
  const job = (clientId: string | null = 'client-a'): JobRun => ({
    id: 'j', clientId, scheduleId: null, requestedBy: null, jobType: 'notify.deliver', payload: { eventId: 'e1' }, attempts: 1, maxAttempts: 3,
  });

  /** The service client: the notice as collected now, the client its run belongs to, and every send recorded. */
  function database(options: { runClient?: string | null; collected?: () => unknown; claimed?: (channel: string, recipient: string) => boolean } = {}) {
    const recorded: Array<Array<{ channel: string; recipient: string; status: string }>> = [];
    const asked: string[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        asked.push(fn);
        // Another run may hold a send; by default this run gets every claim.
        if (fn === 'job_run_notify_claim') {
          return { data: options.claimed ? options.claimed(String(args.p_channel), String(args.p_recipient)) : true, error: null };
        }
        if (fn === 'job_run_notify_collect') {
          if (options.collected) return { data: options.collected(), error: null };
          // What is left to send, the way the database answers: a recipient on record as sent is gone.
          const sent = recorded.flat().filter((row) => row.status === 'SENT');
          return {
            data: {
              ...notice,
              slackSent: sent.some((row) => row.channel === 'SLACK'),
              recipients: notice.recipients.filter((person) => !sent.some((row) => row.channel === 'EMAIL' && row.recipient === person.email)),
            },
            error: null,
          };
        }
        if (fn === 'workflow_run_get') return { data: options.runClient === null ? null : { id: args.p_run_id, client_id: options.runClient ?? 'client-a' }, error: null };
        recorded.push(args.p_rows as never);
        return { data: 1, error: null };
      },
    };
    return { supabase: supabase as never, recorded, asked };
  }

  it('leaves out a send that another run of the same notice has claimed', async () => {
    const { fetcher, calls } = fakeFetch(() => false);
    const { supabase, recorded } = database({ claimed: (channel) => channel !== 'SLACK' });
    const handler = notifyDeliverHandler(supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher);
    await handler(job());
    expect(calls.some((call) => call.url.includes('slack'))).toBe(false);
    expect(recorded.flat().some((row) => row.channel === 'SLACK')).toBe(false);
    expect(recorded.flat().filter((row) => row.channel === 'EMAIL').length).toBeGreaterThan(0);
  });

  it('records each send as it is made, and fails the job without naming anyone so a failed send is tried again', async () => {
    const { fetcher } = fakeFetch((url) => url.includes('slack'));
    const { supabase, recorded } = database();
    const handler = notifyDeliverHandler(supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher);
    const failure = await handler(job()).catch((error) => error);
    expect(failure.message).toBe('1 of 3 sends failed: SLACK HTTP 500');
    expect(failure.message).not.toMatch(/@|down/);
    // One record per send, each written once that send was made.
    expect(recorded.map((rows) => rows.map((row) => `${row.channel} ${row.status}`))).toEqual([['EMAIL SENT'], ['EMAIL SENT'], ['SLACK FAILED']]);

    // The retry sends only what failed.
    const again = fakeFetch();
    await expect(notifyDeliverHandler(supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, again.fetcher)(job())).resolves.toMatchObject({ sent: 1 });
    expect(again.calls.map((call) => call.url)).toEqual(['https://hooks.slack.com/services/T/B/x']);
  });

  it('sends nothing for a notice of another client, and says the same as for one it cannot place', async () => {
    const { calls, fetcher } = fakeFetch();
    const other = database({ runClient: 'client-b' });
    const foreign = await notifyDeliverHandler(other.supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher)(job()).catch((error) => error);
    const unplaced = database({ collected: () => ({ ...event, href: '/somewhere/else' }) });
    const unknown = await notifyDeliverHandler(unplaced.supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher)(job()).catch((error) => error);
    expect(foreign.message).toBe('This client has no notice with that id, so nothing was sent.');
    expect(unknown.message).toBe(foreign.message);
    expect(calls).toHaveLength(0);
    expect(other.recorded).toEqual([]);
  });

  it('does not send to anyone another run of the notice reached in the meantime', async () => {
    const { calls, fetcher } = fakeFetch();
    let asked = 0;
    // The first look sees both people waiting. By the time Ben is sent to, another run has reached him.
    const { supabase } = database({
      collected: () => {
        asked += 1;
        return asked <= 2 ? notice : { ...notice, recipients: notice.recipients.filter((person) => person.userId !== 'u2'), slackSent: true };
      },
    });
    const result = await notifyDeliverHandler(supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher)(job());
    expect(result).toMatchObject({ sent: 1 });
    expect(calls.map((call) => call.body.to ?? call.url)).toEqual([['ada@example.com']]);
  });

  it('stops sending once the job has lost its claim', async () => {
    const lost = new AbortController();
    const sent: string[] = [];
    const fetcher: Fetch = async (_url, init) => {
      sent.push(JSON.parse(init.body).to?.[0]);
      lost.abort(new LeaseLostError());
      return { ok: true, status: 200, text: async () => '' };
    };
    const { supabase, recorded } = database();
    await expect(notifyDeliverHandler(supabase, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher)(job(), { signal: lost.signal })).rejects.toBeInstanceOf(LeaseLostError);
    expect(sent).toEqual(['ada@example.com']);
    // The send that was made is on record, so whoever has the job now does not make it again.
    expect(recorded).toEqual([[{ channel: 'EMAIL', recipient: 'ada@example.com', status: 'SENT' }]]);
  });

  it('sends nothing for a review decided since', async () => {
    const { calls, fetcher } = fakeFetch();
    const supabase = { rpc: async () => ({ data: { stale: true }, error: null }) };
    const result = await notifyDeliverHandler(supabase as never, {}, fetcher)(job());
    expect(result).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(0);
  });
});
