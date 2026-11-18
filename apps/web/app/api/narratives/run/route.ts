import { NextRequest, NextResponse } from 'next/server';
import { withAgentCaller } from '@/lib/agent-audit';
import { authenticate } from '@/lib/chat-server';
import type { ClientUsage } from '@tapestrai/mcp-server/src/agent/harness';
import { DEFAULT_NARRATIVE_MODEL, executeSection, hasModelKey, reviewRun } from '@/lib/narrative-runner';
import type { ReviewSectionInput } from '@tapestrai/graphql/src/lib/narrative-review';
import { resolveEntityId } from '@tapestrai/graphql/src/lib/data-query-engine';
import {
  assembleRun,
  narrativePlan,
  narrativeSpecFromRow,
  todayIso,
  validateNarrative,
} from '@tapestrai/graphql/src/lib/narrative-engine';
import {
  blocksToMarkdown,
  collapseGapColumns,
  mergeBatchBlocks,
  narrativeSections,
  type NarrativeBlock,
  type NarrativeSection,
  type NarrativeSpec,
} from '@tapestrai/graphql/src/lib/narrative-spec';

/** One request composes one section (or one batch), so a long report is many short requests. */
export const maxDuration = 300;

type Row = Record<string, any>;

const sectionRecord = (r: Row) => ({
  id: r.id ?? null,
  runId: r.run_id ?? null,
  sectionKey: r.section_key,
  ord: r.ord ?? 0,
  title: r.title ?? null,
  status: r.status,
  blocks: r.blocks ?? [],
  research: r.research ?? {},
  verification: r.verification ?? {},
  notes: r.notes ?? [],
  errorMessage: r.error_message ?? null,
  model: r.model ?? null,
  updatedAt: r.updated_at ?? null,
});

const runRecord = (r: Row, sections: Row[]) => ({
  id: r.id ?? null,
  narrativeId: r.narrative_id ?? null,
  entityId: r.entity_id ?? null,
  parameters: r.parameters ?? {},
  blocks: r.blocks ?? [],
  status: r.status,
  errorMessage: r.error_message ?? null,
  model: r.model ?? null,
  createdAt: r.created_at ?? new Date().toISOString(),
  asOfDate: r.as_of_date ?? null,
  sources: r.sources ?? [],
  verification: r.verification ?? {},
  plan: r.plan ?? [],
  origin: r.origin ?? 'APP',
  createdByLabel: r.created_by_label ?? null,
  publishedAt: r.published_at ?? null,
  publishedBy: r.published_by ?? null,
  publishedByLabel: r.published_by_label ?? null,
  publishedLabel: r.published_label ?? null,
  sections: sections.map(sectionRecord),
});

/**
 * Moves the run's clock forward. A run that stops moving is closed as abandoned, so a long run
 * must keep reporting progress.
 */
async function touchRun(supabase: any, runId: string | null): Promise<void> {
  if (!runId) return;
  await supabase.from('narrative_runs').update({ updated_at: new Date().toISOString() }).eq('id', runId);
}

const sectionBrief = (s: NarrativeSection) => ({
  key: s.key,
  title: s.title,
  purpose: s.purpose,
  dependsOn: s.dependsOn ?? [],
  batched: !!s.batch,
  research: !!s.research,
  agentic: !!s.agentic?.enabled,
});

const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status });

async function loadTemplate(supabase: any, narrativeId: string) {
  const { data, error } = await supabase.from('narrative_templates').select('*').eq('id', narrativeId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Row | null;
}

async function priorFor(section: NarrativeSection, rows: Row[]) {
  return (section.dependsOn ?? []).map((key) => {
    const row = rows.find((r) => r.section_key === key);
    return { key, title: row?.title ?? key, markdown: blocksToMarkdown((row?.blocks ?? []) as NarrativeBlock[]).slice(0, 8000), done: row?.status === 'COMPLETED' };
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return fail('Authentication required', 401);
  if (!hasModelKey()) return fail('Gemini API key not configured', 500);
  const { supabase } = auth;

  try {
    const body = await request.json();
    const action: string | undefined = body.action;
    const params: Record<string, unknown> = body.params ?? {};
    const asOfDate = String(body.asOfDate || params.asOfDate || todayIso()).slice(0, 10);

    // ------------------------------------------------------------------
    // start: create the run and its pending sections
    // ------------------------------------------------------------------
    if (action === 'start') {
      if (!body.narrativeId) return fail('narrativeId required');
      const template = await loadTemplate(supabase, body.narrativeId);
      if (!template) return fail('Narrative not found', 404);
      const spec = narrativeSpecFromRow(template);
      const problems = validateNarrative(spec);
      if (problems.length) return fail(`This narrative has problems: ${problems.slice(0, 5).join('; ')}`, 400);
      const { sections, order } = narrativePlan(spec);

      // Runs that stopped reporting progress are closed first, so they are never shown as the latest report.
      await Promise.resolve(supabase.rpc('close_stale_narrative_runs', { p_minutes: 30 })).catch(() => undefined);

      const { data: run, error } = await supabase
        .from('narrative_runs')
        .insert({
          narrative_id: template.id,
          entity_id: body.entityId || null,
          parameters: params,
          blocks: [],
          status: 'RUNNING',
          as_of_date: asOfDate,
          plan: order,
          origin: 'APP',
          model: spec.model || DEFAULT_NARRATIVE_MODEL,
        })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      const { data: rows, error: se } = await supabase
        .from('narrative_run_sections')
        .insert(sections.map((s, i) => ({ run_id: run.id, section_key: s.key, ord: i, title: s.title, status: 'PENDING' })))
        .select('*');
      if (se) throw new Error(se.message);
      return NextResponse.json({
        run: runRecord(run, rows ?? []),
        order,
        sections: sections.map(sectionBrief),
        allowExternalSearch: !!spec.allowExternalSearch,
      });
    }

    // ------------------------------------------------------------------
    // section: compose one section (or one batch of it)
    // ------------------------------------------------------------------
    if (action === 'section') {
      const sectionKey: string = body.sectionKey;
      const batchIndex = Number.isInteger(body.batchIndex) ? body.batchIndex : 0;
      /** Problems a reviewer found in this section's earlier version; the new version must fix them. */
      const reviewNotes = typeof body.reviewNotes === 'string' && body.reviewNotes.trim() ? body.reviewNotes.slice(0, 4000) : undefined;
      let spec: NarrativeSpec & { model?: string | null };
      let runId: string | null = body.runId ?? null;
      let runRow: Row | null = null;
      let rows: Row[] = [];
      let entityId: string | null = body.entityId ?? null;
      let useParams = params;
      let useAsOf = asOfDate;

      if (runId) {
        const { data: r, error } = await supabase.from('narrative_runs').select('*').eq('id', runId).maybeSingle();
        if (error) throw new Error(error.message);
        if (!r) return fail('Run not found', 404);
        runRow = r;
        const template = await loadTemplate(supabase, r.narrative_id);
        if (!template) return fail('The narrative for this run no longer exists', 404);
        spec = narrativeSpecFromRow(template);
        const { data: sectionRows, error: se } = await supabase.from('narrative_run_sections').select('*').eq('run_id', r.id);
        if (se) throw new Error(se.message);
        rows = sectionRows ?? [];
        entityId = r.entity_id;
        useParams = r.parameters ?? {};
        useAsOf = (r.as_of_date ?? asOfDate).slice(0, 10);
      } else if (body.draft) {
        spec = { ...(body.draft as NarrativeSpec) };
        const problems = validateNarrative(spec);
        if (problems.length) return fail(`Invalid narrative: ${problems.slice(0, 5).join('; ')}`);
      } else {
        return fail('runId or draft required');
      }

      const section = narrativeSections(spec).find((s) => s.key === sectionKey);
      if (!section) return fail(`No section "${sectionKey}"`, 404);

      const prior = runId
        ? await priorFor(section, rows)
        : ((body.prior ?? []) as Array<{ key: string; title: string; markdown: string }>).map((p) => ({ ...p, done: true }));
      const notReady = prior.filter((p) => !p.done).map((p) => p.key);
      if (notReady.length) return fail(`Compose these sections first: ${notReady.join(', ')}`, 409);

      if (runId) {
        await supabase.from('narrative_run_sections')
          .update({ status: 'RUNNING', error_message: null, updated_at: new Date().toISOString() })
          .eq('run_id', runId).eq('section_key', sectionKey);
        await touchRun(supabase, runId);
      }

      let outcome;
      let usage: ClientUsage | undefined;
      try {
        const ran = await withAgentCaller(supabase, auth.userId, {
          feature: 'narrative',
          activity: 'narrative.section',
          agent: sectionKey,
          metadata: { runId, sectionKey },
        }, () => executeSection({
          supabase, spec, section, entityId, asOfDate: useAsOf, params: useParams,
          prior: prior.map(({ key, title, markdown }) => ({ key, title, markdown })), batchIndex, reviewNotes,
          reuseFindings: batchIndex > 0
            ? (rows.find((r) => r.section_key === sectionKey)?.evidence?.batches?.['0']?.toolFindings as string | undefined)
            : undefined,
        }));
        outcome = ran.result;
        usage = ran.usage;
      } catch (e: any) {
        const message = e?.message || String(e);
        if (runId) {
          await supabase.from('narrative_run_sections')
            .update({ status: 'FAILED', error_message: message.slice(0, 1000), updated_at: new Date().toISOString() })
            .eq('run_id', runId).eq('section_key', sectionKey);
        }
        return NextResponse.json({ section: sectionRecord({ section_key: sectionKey, status: 'FAILED', error_message: message, title: section.title }), batch: null, usage: e?.usage });
      }

      // Stitch batches: keep each batch's blocks, merge in order, complete when all are in.
      const existing = rows.find((r) => r.section_key === sectionKey);
      let blocks = outcome.blocks;
      let complete = true;
      let batchBlocks: Record<string, NarrativeBlock[]> | undefined;
      if (outcome.batch) {
        const perBatch: Record<string, NarrativeBlock[]> = { ...((existing?.research ?? {}).batchBlocks ?? {}) };
        // A re-run of the first batch starts the section over.
        if (outcome.batch.index === 0) for (const k of Object.keys(perBatch)) delete perBatch[k];
        perBatch[String(outcome.batch.index)] = outcome.blocks;
        batchBlocks = perBatch;
        const ordered = Object.keys(perBatch).map(Number).sort((a, b) => a - b).map((i) => perBatch[String(i)]);
        // Only the finished set can say a column is empty for every row.
        blocks = collapseGapColumns(mergeBatchBlocks(ordered));
        complete = Object.keys(perBatch).length >= outcome.batch.count;
      }

      // Verification covers every batch, not just the last one saved.
      let verification: Row = outcome.verification;
      if (outcome.batch && outcome.batch.index > 0 && existing?.verification && typeof existing.verification.checked === 'number') {
        verification = {
          checked: (existing.verification.checked ?? 0) + outcome.verification.checked,
          matched: (existing.verification.matched ?? 0) + outcome.verification.matched,
          unmatched: [...(existing.verification.unmatched ?? []), ...outcome.verification.unmatched].slice(0, 80),
        };
      }

      const saved: Row = {
        run_id: runId,
        section_key: sectionKey,
        ord: existing?.ord ?? 0,
        title: section.title,
        status: complete ? 'COMPLETED' : 'RUNNING',
        blocks,
        research: { ...outcome.research, ...(batchBlocks ? { batchBlocks } : {}) },
        verification,
        notes: outcome.notes,
        evidence: outcome.batch ? { batchCount: outcome.batch.count, batches: { ...((existing?.evidence ?? {}).batches ?? {}), [outcome.batch.index]: outcome.evidence } } : outcome.evidence,
        error_message: null,
        model: spec.model || DEFAULT_NARRATIVE_MODEL,
        updated_at: new Date().toISOString(),
      };
      if (runId) {
        const { error } = await supabase.from('narrative_run_sections').update({
          status: saved.status, blocks: saved.blocks, research: saved.research, verification: saved.verification,
          notes: saved.notes, evidence: saved.evidence, error_message: null, model: saved.model, updated_at: saved.updated_at,
        }).eq('run_id', runId).eq('section_key', sectionKey);
        if (error) throw new Error(error.message);
        await touchRun(supabase, runId);
      }
      void runRow;
      return NextResponse.json({
        section: sectionRecord(saved),
        batch: outcome.batch ? { ...outcome.batch, done: complete } : null,
        // For an unsaved draft the caller keeps the batch blocks and sends them back merged.
        batchBlocks: runId ? undefined : outcome.blocks,
        usage,
      });
    }

    // ------------------------------------------------------------------
    // review: a second reader checks the finished report against its evidence
    // ------------------------------------------------------------------
    if (action === 'review') {
      if (!body.runId) return fail('runId required');
      const { data: run, error } = await supabase.from('narrative_runs').select('*').eq('id', body.runId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!run) return fail('Run not found', 404);
      const { data: rows, error: se } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id).order('ord', { ascending: true });
      if (se) throw new Error(se.message);
      const done = (rows ?? []).filter((r: Row) => r.status === 'COMPLETED');
      if (!done.length) return fail('There is nothing to review yet: no section has finished.', 409);
      const template = await loadTemplate(supabase, run.narrative_id);

      const inputs: ReviewSectionInput[] = done.map((r: Row) => {
        const evidence = r.evidence ?? {};
        return {
          key: r.section_key,
          title: r.title ?? r.section_key,
          markdown: blocksToMarkdown((r.blocks ?? []) as NarrativeBlock[]),
          notes: (r.notes ?? []) as string[],
          findings: String(evidence.toolFindings ?? evidence.batches?.['0']?.toolFindings ?? ''),
          untraced: ((r.verification?.unmatched ?? []) as Array<{ figure: string }>).map((u) => u.figure),
        };
      });
      const reviewed = await withAgentCaller(supabase, auth.userId, {
        feature: 'narrative',
        activity: 'narrative.review',
        agent: 'reviewer',
        metadata: { runId: run.id },
      }, () => reviewRun({ model: template?.model, sections: inputs }));
      const review = reviewed.result;

      // Stored with the run so every reader sees it. Only the run's creator may change the run, so a
      // review by someone else is returned but not kept.
      const { data: saved } = await supabase
        .from('narrative_runs')
        .update({ verification: { ...(run.verification ?? {}), review }, updated_at: new Date().toISOString() })
        .eq('id', run.id)
        .select('id');
      return NextResponse.json({ review, saved: (saved ?? []).length > 0, usage: reviewed.usage });
    }

    // ------------------------------------------------------------------
    // finish: assemble the saved sections into the run
    // ------------------------------------------------------------------
    if (action === 'finish') {
      if (!body.runId) return fail('runId required');
      const { data: run, error } = await supabase.from('narrative_runs').select('*').eq('id', body.runId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!run) return fail('Run not found', 404);
      const { data: rows, error: se } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id).order('ord', { ascending: true });
      if (se) throw new Error(se.message);
      const assembled = assembleRun((rows ?? []) as any[]);
      const patch = {
        status: assembled.status,
        blocks: assembled.blocks,
        sources: assembled.sources,
        verification: assembled.verification,
        error_message: assembled.missing.length ? `Sections not completed: ${assembled.missing.join(', ')}` : null,
        updated_at: new Date().toISOString(),
      };
      const { data: updated, error: ue } = await supabase.from('narrative_runs').update(patch).eq('id', run.id).select('*').single();
      if (ue) throw new Error(ue.message);
      return NextResponse.json({ run: runRecord(updated, rows ?? []) });
    }

    // ------------------------------------------------------------------
    // Legacy single call: a saved or draft narrative with one section
    // ------------------------------------------------------------------
    let spec: NarrativeSpec & { model?: string | null };
    let narrativeId: string | null = body.narrativeId ?? null;
    if (body.draft) {
      spec = { ...(body.draft as NarrativeSpec) };
      narrativeId = null;
    } else {
      if (!narrativeId) return fail('narrativeId required');
      const template = await loadTemplate(supabase, narrativeId);
      if (!template) return fail('Narrative not found', 404);
      spec = narrativeSpecFromRow(template);
    }
    const sections = narrativeSections(spec);
    if (sections.length > 1 || sections[0].batch) {
      return fail('This narrative has several sections. Start a run and compose each section (action: "start", then "section", then "finish").');
    }
    const problems = validateNarrative(spec);
    if (problems.length) return fail(`Invalid data queries: ${problems.slice(0, 5).join('; ')}`);
    const entityId = body.entityId ? await resolveEntityId(supabase, body.entityId, null) : null;

    let status: 'COMPLETED' | 'FAILED' = 'COMPLETED';
    let errorMessage: string | null = null;
    let blocks: NarrativeBlock[] = [];
    let dataSummary: Row = {};
    let usage: ClientUsage | undefined;
    try {
      const ran = await withAgentCaller(supabase, auth.userId, {
        feature: 'narrative',
        activity: 'narrative.section',
        agent: sections[0].key,
      }, () => executeSection({
        supabase, spec, section: sections[0], entityId, asOfDate, params, prior: [],
      }));
      const outcome = ran.result;
      usage = ran.usage;
      blocks = outcome.blocks;
      dataSummary = { notes: outcome.notes, verification: outcome.verification };
    } catch (e: any) {
      status = 'FAILED';
      errorMessage = e?.message || String(e);
      usage = e?.usage;
    }
    const run: Row = {
      id: null, narrative_id: narrativeId, entity_id: entityId, parameters: params, blocks, status,
      error_message: errorMessage, model: spec.model || DEFAULT_NARRATIVE_MODEL, as_of_date: asOfDate,
    };
    if (!body.draft && narrativeId) {
      const { data: saved, error } = await supabase
        .from('narrative_runs')
        .insert({
          narrative_id: narrativeId, entity_id: entityId, parameters: params, blocks, status,
          error_message: errorMessage, model: run.model, data_summary: dataSummary, as_of_date: asOfDate, origin: 'APP',
        })
        .select('*')
        .single();
      if (error) console.error('[narratives/run] failed to store run:', error.message);
      else Object.assign(run, saved);
    }
    return NextResponse.json({ run: runRecord(run, []), usage });
  } catch (error: any) {
    console.error('[narratives/run] Error:', error);
    return fail(error.message || 'Unknown error', 500);
  }
}
