import { describe, expect, it } from 'vitest';
import { assistantBriefHandler, assistantSweepHandler, assistantWatchHandler, briefText } from './assistant';
import { JobError, type JobRun } from './worker';

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: 'run-1',
  clientId: 'client-a',
  scheduleId: null,
  requestedBy: 'user-1',
  jobType: 'assistant.brief',
  payload: {},
  attempts: 1,
  maxAttempts: 3,
  ...overrides,
});

const event = { id: 'e1', summary: 'NAV pack: loaded nav.csv.', occurredAt: '2026-11-16T14:05:00.000Z' };

function fake(script: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const supabase = {
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const reply = script[fn];
      if (!reply) return { data: null, error: { message: `unexpected ${fn}` } };
      return { data: reply.data ?? null, error: reply.error ?? null };
    },
  };
  return { supabase: supabase as never, calls };
}

describe('briefText', () => {
  it('says nothing when nothing changed', () => {
    expect(briefText([], 'DIGEST')).toBe('');
  });

  it('names one change, several changes, and an immediate note', () => {
    expect(briefText([event], 'DIGEST')).toBe('One thing you follow changed.\n\n- NAV pack: loaded nav.csv. (2026-11-16 14:05 UTC)');
    expect(briefText([event, { ...event, id: 'e2', summary: 'NAV pack has not received the file expected 2026-11-16 09:00 UTC.' }], 'DIGEST')).toMatch(/^2 things you follow changed\./);
    expect(briefText([event], 'IMMEDIATE')).toMatch(/^Something you asked to hear about right away\./);
    expect(briefText([event], 'DIGEST', true)).toMatch(/More changes are waiting for the next summary\.$/);
  });
});

describe('assistant handlers', () => {
  it('writes a digest and moves the clock', async () => {
    const { supabase, calls } = fake({
      job_run_assistant_collect: { data: { events: [event], truncated: false } },
      job_run_assistant_commit: { data: { delivered: true, events: 1, conversationId: 'conv-1' } },
    });
    const result = await assistantBriefHandler(supabase)(run());
    expect(result).toEqual({ delivered: true, events: 1, conversationId: 'conv-1' });
    const commit = calls.find((call) => call.fn === 'job_run_assistant_commit');
    expect(commit?.args.p_advance).toBe(true);
    expect(commit?.args.p_event_ids).toEqual(['e1']);
    expect(commit?.args.p_content).toMatch(/One thing you follow changed/);
  });

  it('sends nothing and still moves the clock when the digest is empty', async () => {
    const { supabase, calls } = fake({
      job_run_assistant_collect: { data: { events: [], truncated: false } },
      job_run_assistant_advance: { data: null },
    });
    expect(await assistantBriefHandler(supabase)(run())).toEqual({ delivered: false, events: 0 });
    expect(calls.map((call) => call.fn)).toEqual(['job_run_assistant_collect', 'job_run_assistant_advance']);
  });

  it('does not move the digest clock for an empty watch', async () => {
    const { supabase, calls } = fake({
      job_run_assistant_collect: { data: { events: [] } },
    });
    expect(await assistantWatchHandler(supabase)(run({ jobType: 'assistant.watch' }))).toEqual({ delivered: false, events: 0 });
    expect(calls.map((call) => call.fn)).toEqual(['job_run_assistant_collect']);
  });

  it('moves the clock and does not retry when the person can no longer be assumed', async () => {
    const { supabase, calls } = fake({
      job_run_assistant_collect: { error: { code: '42501', message: 'The person who scheduled this job can no longer read this client\'s records' } },
      job_run_assistant_advance: { data: null },
    });
    const failure = await assistantBriefHandler(supabase)(run()).catch((error) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect(calls.map((call) => call.fn)).toEqual(['job_run_assistant_collect', 'job_run_assistant_advance']);
  });

  it('queues whoever is due', async () => {
    const { supabase } = fake({
      job_run_assistant_sweep: { data: { due: 2, queued: 2, watches: 1 } },
    });
    expect(await assistantSweepHandler(supabase, () => new Date('2026-11-16T12:00:00Z'))(run({ jobType: 'assistant.sweep', requestedBy: null }))).toEqual({
      due: 2,
      queued: 2,
      watches: 1,
    });
  });

  it('refuses a brief with no person and a sweep with no client', async () => {
    const { supabase } = fake({});
    await expect(assistantBriefHandler(supabase)(run({ requestedBy: null }))).rejects.toThrow(/person/);
    await expect(assistantSweepHandler(supabase)(run({ clientId: null }))).rejects.toThrow(/client/);
  });
});
