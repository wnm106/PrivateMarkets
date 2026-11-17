import type { SupabaseClient } from '@supabase/supabase-js';
import { JobError, type JobHandler, type JobRun } from './worker';

/** A database refusal that another attempt cannot change: no owner, or the owner lost access. */
function ownerProblem(error: { code?: string; message: string }): boolean {
  return error.code === '42501' || error.code === '22023';
}

/**
 * Assistant jobs. The sweep queues one brief per person whose delivery time
 * has passed. The brief and the watch run as that person, through the
 * job_run_assistant_* functions, and write a templated note into their chat.
 * The model is not called. Silence is a successful run that sends nothing.
 */

export type BriefMode = 'DIGEST' | 'IMMEDIATE';

export interface BriefEvent {
  id: string;
  summary: string;
  occurredAt: string;
  kind?: string;
  /** A page in the app the note links to. */
  href?: string;
}

/** Notes addressed to a person about a workflow review, rather than something they follow. */
const REVIEW_KINDS = new Set(['REVIEW_ASSIGNED', 'REVIEW_OVERDUE']);

interface Collected {
  events?: unknown;
  truncated?: boolean;
}

interface Committed {
  delivered?: boolean;
  events?: number;
  conversationId?: string | null;
}

/** The note placed in the person's briefing chat. Empty when there is nothing to say. */
export function briefText(events: BriefEvent[], mode: BriefMode, truncated = false): string {
  if (events.length === 0) return '';
  const reviews = events.every((event) => REVIEW_KINDS.has(event.kind || ''));
  const lead = reviews
    ? events.length === 1
      ? 'A workflow review needs you.'
      : `${events.length} workflow review notes for you.`
    : mode === 'IMMEDIATE'
      ? events.length === 1
        ? 'Something you asked to hear about right away.'
        : `${events.length} things you asked to hear about right away.`
      : events.length === 1
        ? 'One thing you follow changed.'
        : `${events.length} things you follow changed.`;
  const lines = events.map((event) => {
    const when = event.occurredAt.slice(0, 16).replace('T', ' ');
    // Only a path inside the app is linked.
    const link = event.href && event.href.startsWith('/') && !event.href.startsWith('//') ? ` [Open](${event.href})` : '';
    return `- ${event.summary} (${when} UTC)${link}`;
  });
  const more = truncated ? '\n\nMore changes are waiting for the next summary.' : '';
  return `${lead}\n\n${lines.join('\n')}${more}`;
}

function asEvents(data: Collected | null): BriefEvent[] {
  if (!data || !Array.isArray(data.events)) return [];
  const events: BriefEvent[] = [];
  for (const item of data.events) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.summary !== 'string') continue;
    const occurredAt = typeof row.occurredAt === 'string' ? row.occurredAt : '';
    events.push({
      id: row.id,
      summary: row.summary,
      occurredAt,
      ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
      ...(typeof row.href === 'string' && row.href ? { href: row.href } : {}),
    });
  }
  return events;
}

async function advance(supabase: SupabaseClient, run: JobRun): Promise<void> {
  const { error } = await supabase.rpc('job_run_assistant_advance', {
    p_user_id: run.requestedBy,
    p_client_id: run.clientId,
  });
  if (error) throw new Error(error.message);
}

async function deliver(supabase: SupabaseClient, run: JobRun, mode: BriefMode): Promise<Record<string, unknown>> {
  if (!run.clientId || !run.requestedBy) throw new JobError('This job needs a client and a person.');

  const collected = await supabase.rpc('job_run_assistant_collect', {
    p_user_id: run.requestedBy,
    p_client_id: run.clientId,
    p_delivery: mode,
  });
  if (collected.error) {
    if (ownerProblem(collected.error)) {
      if (mode === 'DIGEST') await advance(supabase, run);
      throw new JobError(collected.error.message);
    }
    throw new Error(collected.error.message);
  }

  const events = asEvents(collected.data as Collected | null);
  if (events.length === 0) {
    if (mode === 'DIGEST') await advance(supabase, run);
    return { delivered: false, events: 0 };
  }

  const content = briefText(events, mode, (collected.data as Collected).truncated === true);
  const committed = await supabase.rpc('job_run_assistant_commit', {
    p_user_id: run.requestedBy,
    p_client_id: run.clientId,
    p_event_ids: events.map((event) => event.id),
    p_content: content,
    p_advance: mode === 'DIGEST',
  });
  if (committed.error) {
    if (ownerProblem(committed.error)) throw new JobError(committed.error.message);
    throw new Error(committed.error.message);
  }
  const result = (committed.data || {}) as Committed;
  return {
    delivered: result.delivered === true,
    events: Number(result.events) || events.length,
    conversationId: result.conversationId || null,
  };
}

export function assistantSweepHandler(supabase: SupabaseClient, now: () => Date = () => new Date()): JobHandler {
  return async (run) => {
    if (!run.clientId) throw new JobError('This job needs a client.');
    const { data, error } = await supabase.rpc('job_run_assistant_sweep', {
      p_client_id: run.clientId,
      p_now: now().toISOString(),
    });
    if (error) throw new Error(error.message);
    return (data || {}) as Record<string, unknown>;
  };
}

export function assistantBriefHandler(supabase: SupabaseClient): JobHandler {
  return (run) => deliver(supabase, run, 'DIGEST');
}

export function assistantWatchHandler(supabase: SupabaseClient): JobHandler {
  return (run) => deliver(supabase, run, 'IMMEDIATE');
}

/** Platform job: overdue review notices, and addressed notes that were not delivered. */
export function workflowReviewsDueHandler(supabase: SupabaseClient, now: () => Date = () => new Date()): JobHandler {
  return async () => {
    const { data, error } = await supabase.rpc('job_run_workflow_reviews_due', { p_now: now().toISOString() });
    if (error) throw new Error(error.message);
    return (data || {}) as Record<string, unknown>;
  };
}
