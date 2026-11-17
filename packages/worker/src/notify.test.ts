import { describe, expect, it } from 'vitest';
import { deliver, emailText, noticeLink, notifyDeliverHandler, slackText, type Fetch } from './notify';

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

  it('records each send, and fails the job so a failed send is tried again', async () => {
    const { fetcher } = fakeFetch((url) => url.includes('slack'));
    const recorded: unknown[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'job_run_notify_collect') return { data: event, error: null };
        recorded.push(args.p_rows);
        return { data: 3, error: null };
      },
    };
    const handler = notifyDeliverHandler(supabase as never, { resendApiKey: 'k', emailFrom: 'f@example.com' }, fetcher);
    await expect(handler({ id: 'j', payload: { eventId: 'e1' } } as never)).rejects.toThrow(/1 of 3 sends failed: SLACK webhook: HTTP 500: down/);
    expect((recorded[0] as Array<{ status: string }>).map((row) => row.status)).toEqual(['SENT', 'SENT', 'FAILED']);
  });

  it('sends nothing for a review decided since', async () => {
    const { calls, fetcher } = fakeFetch();
    const supabase = { rpc: async () => ({ data: { stale: true }, error: null }) };
    const result = await notifyDeliverHandler(supabase as never, {}, fetcher)({ id: 'j', payload: { eventId: 'e1' } } as never);
    expect(result).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(0);
  });
});
