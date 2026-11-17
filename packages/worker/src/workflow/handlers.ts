import type { SupabaseClient } from '@supabase/supabase-js';
import { JobError, type JobHandler } from '../worker';
import { runAgentStep, type AgentModel } from './agent';
import { claudeModel } from './claude';
import { RunBusyError, advanceRun, type EngineDeps } from './engine';
import { geminiModel } from './gemini';
import { supabaseWorkflowStore } from './store';
import { workflowTools, type ToolEnv, type WorkflowTools } from './tools';

/**
 * The two workflow jobs.
 *
 *   workflow.advance  moves one run forward until it finishes, fails, or waits for a person.
 *                     Queued when a run starts, when a review is decided, and on retry.
 *   workflow.start    starts a run of a workflow by code. This is the one a person puts on a
 *                     schedule; the run belongs to whoever created the schedule.
 *   workflow.triggers platform job: queues a workflow.start for each trigger with something new
 *                     to act on, as the person who made the trigger.
 */

function toolEnv(): ToolEnv {
  return {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  };
}

export function engineDeps(supabase: SupabaseClient, tools: WorkflowTools = workflowTools(supabase, toolEnv())): EngineDeps {
  // A model is built the first time a step asks for it, so a worker with no
  // model key still runs workflows that have no agent step.
  const models = new Map<string, AgentModel>();
  const model = (provider: string): AgentModel => {
    const key = provider === 'gemini' ? 'gemini' : 'claude';
    let found = models.get(key);
    if (!found) {
      found = key === 'gemini' ? geminiModel() : claudeModel();
      models.set(key, found);
    }
    return found;
  };
  return {
    store: supabaseWorkflowStore(supabase),
    tools,
    agent: (request) => runAgentStep(request, { tools, model }),
    foundation: (args, actor) => tools.foundation(args, actor),
  };
}

export function workflowAdvanceHandler(deps: EngineDeps): JobHandler {
  return async (run) => {
    const workflowRunId = typeof run.payload.workflowRunId === 'string' ? run.payload.workflowRunId : '';
    if (!workflowRunId) throw new JobError('The job has no workflowRunId.');
    try {
      // The job's id is the lock owner, so the same job claimed again after a crash takes its own lock back.
      const result = await advanceRun(workflowRunId, run.id, deps);
      return { workflowRunId, ...result };
    } catch (error) {
      // Held by another job: come back later. Anything else here is the store
      // failing, which is also worth another attempt.
      if (error instanceof RunBusyError) throw new Error(error.message);
      throw error;
    }
  };
}

export function workflowStartHandler(supabase: SupabaseClient): JobHandler {
  return async (run) => {
    const code = typeof run.payload.workflowCode === 'string' ? run.payload.workflowCode.trim() : '';
    if (!code) throw new JobError('The job has no workflowCode.');
    if (!run.clientId) throw new JobError('This job needs a client.');
    if (!run.requestedBy) throw new JobError('This job has no owner to run as. Queue it from a schedule or from the Jobs page.');

    const person = await supabase.rpc('workflow_worker_person', { p_user_id: run.requestedBy, p_client_id: run.clientId, p_permissions: ['workflow.run'] });
    if (person.error) throw new Error(person.error.message);
    const problem = (person.data as { problem?: string } | null)?.problem;
    if (problem) throw new JobError(problem);

    const found = await supabase.rpc('workflow_worker_find', { p_client_id: run.clientId, p_code: code });
    if (found.error) throw new Error(found.error.message);
    if (!found.data) throw new JobError(`There is no workflow with the code "${code}" for this client.`);

    const input = run.payload.input && typeof run.payload.input === 'object' && !Array.isArray(run.payload.input) ? run.payload.input : {};
    const started = await supabase.rpc('workflow_run_start', {
      p_workflow_id: found.data,
      p_client_id: run.clientId,
      p_input: input,
      p_version: null,
      p_user_id: run.requestedBy,
    });
    if (started.error) {
      // Not published, or archived since the schedule was made: another attempt will not change that.
      if (started.error.code === '22023' || started.error.code === 'P0002' || started.error.code === '42501') throw new JobError(started.error.message);
      throw new Error(started.error.message);
    }
    return { workflowRunId: String(started.data), workflowCode: code };
  };
}

export function workflowTriggersHandler(supabase: SupabaseClient, now: () => Date = () => new Date()): JobHandler {
  return async () => {
    const { data, error } = await supabase.rpc('job_run_workflow_triggers', { p_now: now().toISOString() });
    if (error) throw new Error(error.message);
    return (data || {}) as Record<string, unknown>;
  };
}
