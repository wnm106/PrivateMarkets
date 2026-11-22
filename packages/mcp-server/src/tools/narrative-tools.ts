import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';
import { NARRATIVE_COMPOSE_GUIDE } from '../lib/narrative-guide';
import {
  getAttributeCatalog,
  resolveEntityId,
  validateDataQueries,
  type DataQuerySpec,
} from '@tapestrai/graphql/src/lib/data-query-engine';
import {
  assembleRun,
  compactEvidence,
  fetchQueryRows,
  narrativePlan,
  narrativeSpecFromRow,
  researchQueries,
  runSectionData,
  todayIso,
  validateNarrative,
} from '@tapestrai/graphql/src/lib/narrative-engine';
import {
  normalizeReview,
  reviewSummary,
  reviewSystemPrompt,
  reviewUserPrompt,
  type ReviewSectionInput,
  type RunReview,
} from '@tapestrai/graphql/src/lib/narrative-review';
import {
  BLOCK_FORMAT_DOC,
  DESIGN_RULES,
  DEFAULT_RULES,
  applyMeasures,
  blocksToMarkdown,
  computeCoverage,
  evaluateScenarios,
  evaluateScreens,
  mergeBatchBlocks,
  narrativeSystemPrompt,
  normalizeBlocks,
  splitBatches,
  verifyBlocks,
  type NarrativeBlock,
  type NarrativeSection,
  type NarrativeSpec,
} from '@tapestrai/graphql/src/lib/narrative-spec';

/**
 * Read-only tools a narrative section may call while composing. The app's runner offers a
 * section's agent exactly these, so it can fill gaps in its evidence but cannot change
 * data, templates, or other runs.
 */
export const NARRATIVE_AGENT_TOOLS = new Set([
  'query_data', 'get_model_map', 'analyze_rows', 'compare_asof', 'get_data_coverage',
  'list_domain_types', 'get_template_metadata', 'get_attribute_metadata', 'search_attributes',
  'get_relationship_types', 'get_entity', 'list_entities', 'find_sample_entities',
  'get_field_lineage', 'get_temporal_history',
  'list_compliance_rules', 'get_compliance_rule', 'get_compliance_rule_version',
  'evaluate_compliance_rule', 'list_compliance_breaches',
  'get_dq_summary', 'list_dq_exceptions',
]);

const MAX_EVIDENCE_JSON = 900_000;

function parseJson(value: unknown, what: string): any {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (e: any) { throw new Error(`${what} is not valid JSON: ${e.message}`); }
}

const asList = (value: unknown): any[] => (Array.isArray(value) ? value : value ? [value] : []);

async function loadTemplate(supabase: any, narrativeCode: string) {
  const { data, error } = await supabase.from('narrative_templates').select('*').eq('narrative_code', narrativeCode).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No narrative with code "${narrativeCode}". Call list_narratives to see what exists.`);
  return data;
}

async function loadRun(supabase: any, runId: string) {
  const { data: run, error } = await supabase.from('narrative_runs').select('*').eq('id', runId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) throw new Error(`No run "${runId}", or you cannot read it.`);
  const { data: template, error: te } = await supabase.from('narrative_templates').select('*').eq('id', run.narrative_id).maybeSingle();
  if (te) throw new Error(te.message);
  if (!template) throw new Error('The narrative for this run no longer exists.');
  const spec = narrativeSpecFromRow(template);
  return { run, template, spec, ...narrativePlan(spec) };
}

function sectionOf(sections: NarrativeSection[], key: string): NarrativeSection {
  const section = sections.find((s) => s.key === key);
  if (!section) throw new Error(`No section "${key}". Sections: ${sections.map((s) => s.key).join(', ')}.`);
  return section;
}

function brief(s: NarrativeSection) {
  return {
    key: s.key,
    title: s.title,
    purpose: s.purpose,
    dependsOn: s.dependsOn ?? [],
    agentic: !!s.agentic?.enabled,
    batch: s.batch,
    research: s.research ? { queries: s.research.queries } : undefined,
    blocks: s.blocks.map((b) => ({ type: b.type, key: b.key, title: b.title })),
  };
}

/** Moves a run's clock forward so a long run is not closed as abandoned. */
async function touchRun(supabase: any, runId: string): Promise<void> {
  await supabase.from('narrative_runs').update({ updated_at: new Date().toISOString() }).eq('id', runId);
}

function trimForStorage(compact: Record<string, any>): Record<string, any> {
  if (JSON.stringify(compact).length <= MAX_EVIDENCE_JSON) return compact;
  const datasets: Record<string, any> = {};
  for (const [k, d] of Object.entries<any>(compact.datasets ?? {})) datasets[k] = { ...d, rows: (d.rows ?? []).slice(0, 40), truncated: true };
  return { ...compact, datasets };
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

const listNarratives: ToolDefinition = {
  name: 'list_narratives',
  description:
    'Saved narratives (sectioned reports) offered on an entity type. Pass entityCode to use that record\'s type, or domainCode. Call this first for any request that is a report, review, or briefing: if one fits, run it with get_narrative then start_narrative_run instead of planning your own outline. Returns each narrative\'s sections so you can judge the fit.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Entity type, such as FUND. From list_domain_types.' },
      entityCode: { type: 'string', description: 'A record; its entity type is used.' },
    },
  },
  execute: async (args, supabase) => {
    let domainCode: string | undefined = args.domainCode ? String(args.domainCode).toUpperCase() : undefined;
    if (!domainCode && args.entityCode) {
      const { data, error } = await supabase.from('entity_master').select('domain_code').eq('entity_code', args.entityCode).limit(1);
      if (error) throw new Error(error.message);
      domainCode = data?.[0]?.domain_code;
      if (!domainCode) return { error: `No record with code "${args.entityCode}".` };
    }
    let q = supabase.from('narrative_templates').select('*').eq('is_active', true).order('narrative_name');
    if (domainCode) {
      const code = domainCode.replace(/[^A-Z0-9_]/g, '');
      q = q.or(`domain_code.eq.${code},exposed_domains.cs.{${code}}`);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return {
      domainCode: domainCode ?? null,
      narratives: (data || []).map((row: any) => {
        const spec = narrativeSpecFromRow(row);
        const { sections } = narrativePlan(spec);
        return {
          narrativeCode: row.narrative_code,
          name: row.narrative_name,
          description: row.description,
          domainCode: row.domain_code,
          exposedDomains: row.exposed_domains ?? [],
          audience: row.audience,
          allowExternalSearch: !!row.allow_external_search,
          parameters: row.parameters ?? [],
          sections: sections.map((s) => ({ key: s.key, title: s.title, purpose: s.purpose })),
        };
      }),
    };
  },
};

const getNarrative: ToolDefinition = {
  name: 'get_narrative',
  description:
    'The full blueprint of one narrative: persona, rules, run order, and every section with its instructions, data queries, comparison dates, measures, screens, scenarios, research queries, and expected output blocks. Read it before start_narrative_run so you know the whole report you are about to compose.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: { narrativeCode: { type: 'string', description: 'From list_narratives.' } },
    required: ['narrativeCode'],
  },
  execute: async (args, supabase) => {
    const row = await loadTemplate(supabase, String(args.narrativeCode));
    const spec = narrativeSpecFromRow(row);
    const { sections, order } = narrativePlan(spec);
    return {
      narrativeCode: row.narrative_code,
      name: row.narrative_name,
      description: row.description,
      domainCode: row.domain_code,
      exposedDomains: row.exposed_domains ?? [],
      persona: spec.persona ?? null,
      audience: spec.audience ?? null,
      allowExternalSearch: !!spec.allowExternalSearch,
      parameters: spec.parameters ?? [],
      rules: [...DEFAULT_RULES, ...(spec.rules ?? [])],
      runOrder: order,
      sections,
      systemPrompt: narrativeSystemPrompt(spec),
      blockFormat: BLOCK_FORMAT_DOC,
      method: 'Read tapestrai://model/narrative-guide, then start_narrative_run and work the sections in runOrder.',
    };
  },
};

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

const startNarrativeRun: ToolDefinition = {
  name: 'start_narrative_run',
  effect: 'stage',
  description:
    'Begin a stored run of a narrative for one record. Needs narrativeCode, the record (entityCode or entityId, of a type the narrative is offered on), and asOfDate (YYYY-MM-DD; ask the user, do not assume today). params carries the narrative\'s inputs such as inceptionDate, as a JSON object string. Returns runId and the order to work the sections in. The run appears on the record\'s page in the app.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: {
      narrativeCode: { type: 'string' },
      entityCode: { type: 'string' },
      entityId: { type: 'string' },
      asOfDate: { type: 'string', description: 'YYYY-MM-DD' },
      params: { type: 'string', description: 'JSON object of the narrative\'s inputs, e.g. {"inceptionDate":"2021-04-01"}' },
    },
    required: ['narrativeCode', 'asOfDate'],
  },
  execute: async (args, supabase) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.asOfDate))) return { error: 'asOfDate must be YYYY-MM-DD.' };
    const template = await loadTemplate(supabase, String(args.narrativeCode));
    if (!template.is_active) return { error: 'This narrative is not active.' };
    const spec = narrativeSpecFromRow(template);
    const problems = validateNarrative(spec);
    if (problems.length) return { error: 'This narrative has problems an administrator must fix.', problems };

    const entityId = await resolveEntityId(supabase, args.entityId, args.entityCode);
    if (!entityId) return { error: 'Give entityCode or entityId for a record you can read.' };
    const { data: entity, error: ee } = await supabase
      .from('entity_master').select('entity_id, entity_code, entity_name, domain_code').eq('entity_id', entityId).maybeSingle();
    if (ee) throw new Error(ee.message);
    if (!entity) return { error: 'That record was not found or you cannot read it.' };
    const offered = [template.domain_code, ...(template.exposed_domains ?? [])];
    if (!offered.includes(entity.domain_code)) {
      return { error: `This narrative is offered on ${offered.join(', ')}; ${entity.entity_code} is a ${entity.domain_code}.` };
    }

    const params = parseJson(args.params, 'params') ?? {};
    const { sections, order } = narrativePlan(spec);
    // Runs that stopped reporting progress are closed first so they are never offered as the latest report.
    await Promise.resolve(supabase.rpc('close_stale_narrative_runs', { p_minutes: 30 })).catch(() => undefined);
    const { data: run, error } = await supabase
      .from('narrative_runs')
      .insert({
        narrative_id: template.id,
        entity_id: entityId,
        parameters: params,
        blocks: [],
        status: 'RUNNING',
        as_of_date: args.asOfDate,
        plan: order,
        origin: 'MCP',
        model: 'external',
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    const { error: se } = await supabase.from('narrative_run_sections').insert(
      sections.map((s, i) => ({ run_id: run.id, section_key: s.key, ord: i, title: s.title, status: 'PENDING' })),
    );
    if (se) throw new Error(se.message);

    return {
      runId: run.id,
      entity: { entityCode: entity.entity_code, entityName: entity.entity_name, domainCode: entity.domain_code },
      asOfDate: args.asOfDate,
      persona: spec.persona ?? null,
      rules: [...DEFAULT_RULES, ...(spec.rules ?? [])],
      allowExternalSearch: !!spec.allowExternalSearch,
      runOrder: order,
      sections: order.map((k) => brief(sectionOf(sections, k))),
      next: `run_narrative_section_data(runId, "${order[0]}")`,
    };
  },
};

const runNarrativeSectionData: ToolDefinition = {
  name: 'run_narrative_section_data',
  effect: 'read',
  description:
    'Gather one section\'s evidence for a run: every data query at every comparison date, derived measures, computed screens and scenarios, and mustDisclose (what is missing or truncated). Also returns the section\'s instructions, expected blocks, the text of the sections it depends on, and any research queries. Compose the section from this, then call save_narrative_section. For a section with a batch, pass batchIndex 0, 1, 2 ... until batchCount is reached.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      sectionKey: { type: 'string' },
      batchIndex: { type: 'number', description: 'For a batched section: which group of rows (starts at 0).' },
    },
    required: ['runId', 'sectionKey'],
  },
  execute: async (args, supabase) => {
    const { run, spec, sections } = await loadRun(supabase, String(args.runId));
    const section = sectionOf(sections, String(args.sectionKey));
    const params = (run.parameters ?? {}) as Record<string, unknown>;
    const asOfDate = run.as_of_date ?? todayIso();

    const { data: rows, error } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id);
    if (error) throw new Error(error.message);
    const byKey = new Map<string, any>((rows || []).map((r: any) => [r.section_key, r]));
    const pending = (section.dependsOn ?? []).filter((d) => byKey.get(d)?.status !== 'COMPLETED');
    if (pending.length) {
      return { error: `Compose and save these sections first: ${pending.join(', ')}.`, dependsOn: section.dependsOn };
    }

    const evidence = await runSectionData(supabase, spec, section, { entityId: run.entity_id, asOfDate, params });

    let batchRows: Record<string, any>[] | undefined;
    let batchInfo: { index: number; count: number } | undefined;
    if (section.batch) {
      const all = evidence.datasets[section.batch.query]?.rows ?? [];
      const batches = splitBatches(all, section.batch.size);
      const index = Math.max(0, Number(args.batchIndex) || 0);
      if (!batches.length) return { error: `The batch data set "${section.batch.query}" has no rows, so there is nothing to compose.`, notes: evidence.notes };
      if (index >= batches.length) return { error: `batchIndex ${index} is past the last batch (${batches.length - 1}).` };
      batchRows = batches[index];
      batchInfo = { index, count: batches.length };
    }

    const compact = compactEvidence(evidence, 120, batchRows && section.batch ? { query: section.batch.query, rows: batchRows } : undefined);
    const prior = (section.dependsOn ?? []).map((k) => {
      const row = byKey.get(k);
      return { key: k, title: row?.title ?? k, text: blocksToMarkdown((row?.blocks ?? []) as NarrativeBlock[]).slice(0, 8000) };
    });
    const research = spec.allowExternalSearch ? researchQueries(section, evidence, batchRows) : [];

    const existing = byKey.get(section.key);
    const stored = trimForStorage(compact);
    const nextEvidence = batchInfo
      ? { batchCount: batchInfo.count, batches: { ...((existing?.evidence ?? {}).batches ?? {}), [batchInfo.index]: stored } }
      : stored;
    const { error: ue } = await supabase
      .from('narrative_run_sections')
      .update({ status: 'RUNNING', evidence: nextEvidence, notes: evidence.notes, updated_at: new Date().toISOString() })
      .eq('run_id', run.id).eq('section_key', section.key);
    if (ue) throw new Error(ue.message);
    await touchRun(supabase, run.id);

    return {
      runId: run.id,
      section: { key: section.key, title: section.title, purpose: section.purpose, instructions: section.instructions, blocks: section.blocks },
      batch: batchInfo,
      evidence: compact,
      sectionsAlreadyWritten: prior,
      research: spec.allowExternalSearch
        ? { allowed: true, queries: research, note: 'Search the web for these, keep each source\'s title, publisher, URL, and publication date, and cite only those.' }
        : { allowed: false, note: 'External search is not enabled for this narrative. Do not search. Say sentiment and news were not researched.' },
      agentic: section.agentic?.enabled
        ? { enabled: true, note: 'Fill gaps with get_model_map, query_data, analyze_rows, compare_asof, get_data_coverage, and the compliance tools before composing.' }
        : { enabled: false },
      blockFormat: BLOCK_FORMAT_DOC,
      layout: section.layout === 'free'
        ? { mode: 'free', note: 'The blocks listed for this section are a palette. Design the section: choose the blocks, order and width that tell its story best, following designRules.', designRules: DESIGN_RULES }
        : { mode: 'fixed', note: 'Produce exactly the listed blocks, in order, with their keys.' },
      next: 'Compose the blocks, then save_narrative_section(runId, sectionKey, blocks, sources).',
    };
  },
};

function figuresPool(section: NarrativeSection, spec: NarrativeSpec, run: any, evidenceRow: any, priorBlocks: unknown[]): { evidence: unknown[]; allowed: string[] } {
  const e = evidenceRow ?? {};
  const own = e.batches ? Object.values(e.batches) : [e];
  return {
    evidence: [...own, ...priorBlocks],
    allowed: [
      section.instructions,
      section.purpose ?? '',
      ...section.blocks.map((b) => b.guidance ?? ''),
      ...(spec.rules ?? []),
      JSON.stringify(run.parameters ?? {}),
      String(run.as_of_date ?? ''),
    ],
  };
}

const saveNarrativeSection: ToolDefinition = {
  name: 'save_narrative_section',
  effect: 'stage',
  description:
    'Store the section you composed. blocks is a JSON array (or {"blocks":[...]}) of the block types in the section\'s expected blocks; see blockFormat. sources is an optional JSON array of external sources used, each { title, publisher, url, date }. Every figure is checked against the evidence you were given: the result lists any figure it could not trace. Fix those (use the evidence value, or write data not available) and save again; saving replaces the section.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      sectionKey: { type: 'string' },
      blocks: { type: 'string', description: 'JSON array of blocks.' },
      sources: { type: 'string', description: 'JSON array of external sources.' },
      batchIndex: { type: 'number', description: 'For a batched section: which batch these blocks are for.' },
    },
    required: ['runId', 'sectionKey', 'blocks'],
  },
  execute: async (args, supabase) => {
    const { run, spec, sections } = await loadRun(supabase, String(args.runId));
    const section = sectionOf(sections, String(args.sectionKey));
    let blocks = normalizeBlocks(parseJson(args.blocks, 'blocks'));
    if (!blocks.length) return { error: 'No usable blocks. Send a JSON array of blocks in the format given by blockFormat.' };
    const sources = asList(parseJson(args.sources, 'sources'));
    if (sources.length && !blocks.some((b) => b.type === 'sources')) {
      blocks = [...blocks, ...normalizeBlocks([{ type: 'sources', key: `${section.key}_sources`, title: 'Sources', items: sources }])];
    }

    const { data: rows, error } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id);
    if (error) throw new Error(error.message);
    const row = (rows || []).find((r: any) => r.section_key === section.key);
    if (!row) return { error: 'This run has no such section.' };
    if (!row.evidence || !Object.keys(row.evidence).length) {
      return { error: 'Call run_narrative_section_data for this section first, so there is evidence to verify against.' };
    }
    const priorBlocks = (section.dependsOn ?? []).map((k) => (rows || []).find((r: any) => r.section_key === k)?.blocks ?? []);
    const pool = figuresPool(section, spec, run, row.evidence, priorBlocks);
    const verification = verifyBlocks(blocks, pool.evidence, pool.allowed);

    let storedBlocks = blocks;
    let batchBlocks: Record<string, NarrativeBlock[]> | undefined;
    let complete = true;
    let remaining: number[] = [];
    if (section.batch) {
      const index = Math.max(0, Number(args.batchIndex) || 0);
      const count = Number(row.evidence.batchCount ?? 1);
      const perBatch: Record<string, NarrativeBlock[]> = { ...((row.research ?? {}).batchBlocks ?? {}) };
      perBatch[String(index)] = blocks;
      batchBlocks = perBatch;
      const ordered = Object.keys(perBatch).map(Number).sort((a, b) => a - b).map((i) => perBatch[String(i)]);
      storedBlocks = mergeBatchBlocks(ordered);
      remaining = Array.from({ length: count }, (_, i) => i).filter((i) => !(String(i) in perBatch));
      complete = remaining.length === 0;
    }

    const { error: ue } = await supabase
      .from('narrative_run_sections')
      .update({
        status: complete ? 'COMPLETED' : 'RUNNING',
        blocks: storedBlocks,
        verification,
        research: { ...(row.research ?? {}), sources, ...(batchBlocks ? { batchBlocks } : {}) },
        error_message: null,
        model: 'external',
        updated_at: new Date().toISOString(),
      })
      .eq('run_id', run.id).eq('section_key', section.key);
    if (ue) throw new Error(ue.message);
    await touchRun(supabase, run.id);

    return {
      saved: true,
      sectionStatus: complete ? 'COMPLETED' : 'RUNNING',
      ...(section.batch ? { batchesRemaining: remaining } : {}),
      verification: {
        figuresChecked: verification.checked,
        figuresTraced: verification.matched,
        notTraced: verification.unmatched,
      },
      next: verification.unmatched.length
        ? 'Some figures could not be traced to the evidence. Correct them (use the evidence value, or write data not available) and save this section again.'
        : section.batch && !complete
          ? `Compose the remaining batches: ${remaining.join(', ')}.`
          : 'Move to the next section in runOrder, or finish_narrative_run if all are saved.',
    };
  },
};

const finishNarrativeRun: ToolDefinition = {
  name: 'finish_narrative_run',
  effect: 'stage',
  description:
    'Close a run: assemble the saved sections into one report, aggregate sources and verification, and report any section still missing. Returns the report as markdown to present to the user. Safe to call again after saving a missing section.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
  },
  execute: async (args, supabase) => {
    const { run, sections } = await loadRun(supabase, String(args.runId));
    const { data: rows, error } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id).order('ord', { ascending: true });
    if (error) throw new Error(error.message);
    const assembled = assembleRun((rows || []) as any[]);
    const { missing, status, sources } = assembled;
    const { checked, matched, notTraced } = assembled.verification;
    const done = { length: assembled.completed };
    const { error: ue } = await supabase
      .from('narrative_runs')
      .update({
        status,
        blocks: assembled.blocks,
        sources,
        verification: { checked, matched, notTraced: notTraced.slice(0, 80) },
        error_message: missing.length ? `Sections not completed: ${missing.join(', ')}` : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', run.id);
    if (ue) throw new Error(ue.message);

    return {
      runId: run.id,
      status,
      sectionsCompleted: done.length,
      sectionsMissing: missing,
      verification: { figuresChecked: checked, figuresTraced: matched, notTraced: notTraced.slice(0, 40) },
      sourcesCount: sources.length,
      reportMarkdown: blocksToMarkdown(assembled.blocks).slice(0, 120_000),
      next: missing.length
        ? `Compose the missing sections (${missing.join(', ')}) and call finish_narrative_run again.`
        : 'Present the report to the user. List data gaps (each section\'s mustDisclose) and sources at the end.',
      planned: sections.length,
    };
  },
};

// ---------------------------------------------------------------------------
// Consistency review
// ---------------------------------------------------------------------------

async function reviewInputs(supabase: any, runId: string): Promise<{ run: any; inputs: ReviewSectionInput[] }> {
  const { run } = await loadRun(supabase, runId);
  const { data: rows, error } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id).order('ord', { ascending: true });
  if (error) throw new Error(error.message);
  const inputs: ReviewSectionInput[] = (rows || [])
    .filter((r: any) => r.status === 'COMPLETED')
    .map((r: any) => ({
      key: r.section_key,
      title: r.title ?? r.section_key,
      markdown: blocksToMarkdown((r.blocks ?? []) as NarrativeBlock[]),
      notes: (r.notes ?? []) as string[],
      findings: String(r.evidence?.toolFindings ?? ''),
      untraced: ((r.verification?.unmatched ?? []) as Array<{ figure: string }>).map((u) => u.figure),
    }));
  return { run, inputs };
}

const getReviewBrief: ToolDefinition = {
  name: 'get_review_brief',
  description:
    'Everything needed to check a finished run for contradictions and unsupported claims: the reviewer instructions and each section\'s text, data notes, and findings. Read it as an independent reviewer who did not write the report, follow the instructions, and save what you find with save_run_review. Do this before presenting a report to the user. It catches what the figure check cannot: a status nobody recorded, an action described as underway, one section saying data is unavailable while another quotes it, or a value read from a different record that shares a name.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
  },
  execute: async (args, supabase) => {
    const { inputs } = await reviewInputs(supabase, String(args.runId));
    if (!inputs.length) return { error: 'No section of this run has finished, so there is nothing to review.' };
    return {
      instructions: reviewSystemPrompt(),
      sections: inputs.map((s) => ({ key: s.key, title: s.title })),
      brief: reviewUserPrompt(inputs),
      next: 'Write the JSON the instructions ask for, then call save_run_review(runId, issues). Quote the exact words for every issue.',
    };
  },
};

const saveRunReview: ToolDefinition = {
  name: 'save_run_review',
  effect: 'stage',
  description:
    'Store your consistency review of a finished run. issues is a JSON array of { severity, kind, sections, quote, problem, suggestion }. Every issue must quote the exact words from the report; an issue whose quote is not found in the report is discarded. The result shows on the record page next to the report.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      issues: { type: 'string', description: 'JSON array of issues, or { "issues": [...] }.' },
    },
    required: ['runId', 'issues'],
  },
  execute: async (args, supabase) => {
    const { run, inputs } = await reviewInputs(supabase, String(args.runId));
    const { issues, discarded } = normalizeReview(parseJson(args.issues, 'issues') ?? [], inputs);
    const review: RunReview = { issues, discarded, reviewedAt: new Date().toISOString(), model: 'external', sectionsReviewed: inputs.length, source: 'MCP' };
    const { data, error } = await supabase
      .from('narrative_runs')
      .update({ verification: { ...(run.verification ?? {}), review }, updated_at: new Date().toISOString() })
      .eq('id', run.id)
      .select('id');
    if (error) throw new Error(error.message);
    return {
      saved: (data ?? []).length > 0,
      summary: reviewSummary(review),
      issues: issues.length,
      discarded,
      next: issues.length
        ? 'Fix the sections the issues name (save_narrative_section again), call finish_narrative_run, and review again, or tell the user what you found.'
        : 'Nothing to fix. Present the report.',
    };
  },
};

// ---------------------------------------------------------------------------
// Reuse: existing runs
// ---------------------------------------------------------------------------

const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

const listNarrativeRuns: ToolDefinition = {
  name: 'list_narrative_runs',
  description:
    'Finished runs of a narrative for a record, newest first, with who made each, its as-of date, its age in days, and whether it is the published one. CALL THIS BEFORE start_narrative_run: a run takes minutes and costs model spend, and a published or recent run for the same record and as-of date should be shown to the user instead of recomputed. Pass narrativeCode and entityCode (or entityId); asOfDate (YYYY-MM-DD) marks which runs match the date the user wants. Read a run with get_narrative_run.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: {
      narrativeCode: { type: 'string' },
      entityCode: { type: 'string' },
      entityId: { type: 'string' },
      asOfDate: { type: 'string', description: 'The date the user wants, YYYY-MM-DD.' },
      limit: { type: 'number', description: 'Default 10.' },
    },
    required: ['narrativeCode'],
  },
  execute: async (args, supabase) => {
    const template = await loadTemplate(supabase, String(args.narrativeCode));
    const entityId = await resolveEntityId(supabase, args.entityId, args.entityCode);
    let q = supabase.from('narrative_runs').select('*').eq('narrative_id', template.id).order('created_at', { ascending: false });
    if (entityId) q = q.eq('entity_id', entityId);
    const { data, error } = await q.limit(Math.min(Math.max(Number(args.limit) || 10, 1), 50) + 20);
    if (error) throw new Error(error.message);
    const want = args.asOfDate ? String(args.asOfDate).slice(0, 10) : null;
    const runs = (data || [])
      .filter((r: any) => r.status === 'COMPLETED' || r.status === 'PARTIAL')
      .slice(0, Math.min(Math.max(Number(args.limit) || 10, 1), 50))
      .map((r: any) => ({
        runId: r.id,
        status: r.status,
        asOfDate: r.as_of_date,
        matchesAsOfDate: want ? String(r.as_of_date ?? '').slice(0, 10) === want : undefined,
        createdAt: r.created_at,
        ageDays: daysSince(r.created_at),
        createdBy: r.created_by_label ?? null,
        origin: r.origin,
        published: !!r.published_at,
        publishedLabel: r.published_label ?? null,
        publishedBy: r.published_by_label ?? null,
        publishedAt: r.published_at ?? null,
      }));
    const best = runs.find((r: any) => r.published && r.matchesAsOfDate !== false) ?? runs.find((r: any) => r.matchesAsOfDate !== false) ?? null;
    return {
      narrativeCode: template.narrative_code,
      runs,
      suggestion: best
        ? `Show run ${best.runId} (${best.published ? 'published' : 'latest'}, ${best.ageDays} day(s) old${best.matchesAsOfDate === false ? ', different as-of date' : ''}) with get_narrative_run. Start a new run only if the user asks to refresh, the as-of date differs, or the run is stale.`
        : 'No finished run exists for this record and date. Use start_narrative_run.',
    };
  },
};

const getNarrativeRun: ToolDefinition = {
  name: 'get_narrative_run',
  description:
    'Read a finished run: the assembled report as markdown, each section\'s status and verification, and the data gaps it reported. Use it to present an existing report instead of composing a new one. Say who made it, when, and its as-of date.',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
  },
  execute: async (args, supabase) => {
    const { run } = await loadRun(supabase, String(args.runId));
    const { data: rows, error } = await supabase.from('narrative_run_sections').select('*').eq('run_id', run.id).order('ord', { ascending: true });
    if (error) throw new Error(error.message);
    const assembled = assembleRun((rows || []) as any[]);
    const blocks = assembled.blocks.length ? assembled.blocks : ((run.blocks ?? []) as NarrativeBlock[]);
    return {
      runId: run.id,
      status: run.status,
      asOfDate: run.as_of_date,
      createdAt: run.created_at,
      ageDays: daysSince(run.created_at),
      createdBy: run.created_by_label ?? null,
      published: !!run.published_at,
      publishedLabel: run.published_label ?? null,
      sections: (rows || []).map((r: any) => ({
        key: r.section_key, title: r.title, status: r.status,
        figuresChecked: r.verification?.checked ?? 0, figuresTraced: r.verification?.matched ?? 0,
        dataGaps: r.notes ?? [],
      })),
      reportMarkdown: blocksToMarkdown(blocks).slice(0, 120_000),
    };
  },
};

const publishNarrativeRun: ToolDefinition = {
  name: 'publish_narrative_run',
  description:
    'Mark a finished run as the one everyone who can see the record is shown by default (replacing any earlier published run for that record). Do this only when the user asks to publish or share the report. label is an optional name for the version, such as "Q3 LP review".',
  category: 'narrative',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string' }, label: { type: 'string' } },
    required: ['runId'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase.rpc('publish_narrative_run', { p_run_id: args.runId, p_label: args.label ?? null });
    if (error) return { published: false, error: error.message };
    return { published: true, runId: data.id, label: data.published_label ?? null, publishedBy: data.published_by_label ?? null };
  },
};

// ---------------------------------------------------------------------------
// Evidence helpers usable outside a run
// ---------------------------------------------------------------------------

const analyzeRows: ToolDefinition = {
  name: 'analyze_rows',
  description:
    'Run one entity-grain query over the WHOLE book (up to 5000 rows) and apply computed analysis to every row, so you never do arithmetic or apply thresholds by hand. query is a data query (same shape as query_data grain "entity"; set limit for the full set). measures: [{alias, expr, unit?}] add a derived column per row, e.g. {"alias":"cushion","expr":"(COVENANT_LEVEL - COVENANT_CURRENT) / COVENANT_LEVEL"}. screens: [{key, label, when, severity}] flag every row where the test is true, e.g. {"key":"thin","label":"Cushion under 15%","when":"cushion < 0.15","severity":"high"}. scenarios: [{key, label, expr, agg, params, rankBy, top}] aggregate an expression across rows, e.g. a +100bps shock {"key":"up","label":"+100bps","expr":"FLOATING * BALANCE * shock","agg":"SUM","params":{"shock":0.01}} or the two largest names stop paying {"key":"stress","label":"Top 2 stop","expr":"INTEREST","agg":"SUM","rankBy":"MARKET_VALUE","top":2}. Expressions use field names as variables (lookups as "iss.INDUSTRY"), + - * / % ( ), comparisons, && || !, and abs min max round coalesce if isnull. A missing input makes a measure null and a test not evaluable; the result counts those, so report them as data not available. Returns coverage, screens, scenarios, and the first rows.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'One data query as JSON. grain is entity: start DOMAIN or CONTEXT, lookups, select, filters, limit.' },
      entityCode: { type: 'string', description: 'The context record when the query starts at CONTEXT.' },
      asOfDate: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      measures: { type: 'string', description: 'JSON array of derived measures.' },
      screens: { type: 'string', description: 'JSON array of screens.' },
      scenarios: { type: 'string', description: 'JSON array of scenarios.' },
      maxRows: { type: 'number', description: 'Rows to echo back (default 40, max 100).' },
    },
    required: ['query'],
  },
  execute: async (args, supabase) => {
    const spec = parseJson(args.query, 'query') as DataQuerySpec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'query must be one JSON object.' };
    const key = spec.key || 'rows';
    const full: DataQuerySpec = { ...spec, key, start: spec.start ?? ((spec as any).entityCode || args.entityCode ? 'CONTEXT' : 'DOMAIN') };
    const problems = validateDataQueries([full]);
    if (problems.length) return { error: problems.join('; ') };
    const asOfDate = String(args.asOfDate || todayIso()).slice(0, 10);

    const anchorId = await resolveEntityId(supabase, undefined, args.entityCode);
    if (full.start === 'CONTEXT' && !anchorId) return { error: 'start CONTEXT needs entityCode for a record you can read.' };
    let fetched;
    try {
      fetched = await fetchQueryRows(supabase, full, anchorId, { asOfDate }, asOfDate, new Map());
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }

    const measures = asList(parseJson(args.measures, 'measures')).map((m: any) => ({ ...m, query: key }));
    const applied = applyMeasures(fetched.rows, measures);
    const rows = applied.rows;
    const columns = [...fetched.columns, ...measures.map((m: any) => m.alias)];
    const screens = asList(parseJson(args.screens, 'screens')).map((s: any, i: number) => ({
      key: s.key ?? `screen_${i + 1}`, label: s.label ?? s.key ?? `Screen ${i + 1}`, severity: s.severity ?? 'medium', ...s, query: key,
    }));
    const scenarios = asList(parseJson(args.scenarios, 'scenarios')).map((s: any, i: number) => ({
      key: s.key ?? `scenario_${i + 1}`, label: s.label ?? s.key ?? `Scenario ${i + 1}`, agg: s.agg ?? 'SUM', ...s, query: key,
    }));
    const screenOut = evaluateScreens({ [key]: rows }, screens);
    const scenarioOut = evaluateScenarios({ [key]: rows }, scenarios);
    const notes = [...applied.errors, ...screenOut.errors, ...scenarioOut.errors];
    if (fetched.truncated) notes.push(`Only ${rows.length} of ${fetched.total} rows were retrieved. Raise limit (max 5000) before relying on totals.`);
    const coverage = computeCoverage(rows, columns);
    if (coverage.empty.length) notes.push(`No value on any row for ${coverage.empty.join(', ')}: data not available.`);

    return {
      asOfDate,
      matched: fetched.matched,
      total: fetched.total,
      rowsRetrieved: rows.length,
      truncated: fetched.truncated,
      summaryOverAllMatched: fetched.summary ?? undefined,
      coverage,
      derivedMeasures: measures.map((m: any) => ({ alias: m.alias, expr: m.expr, unit: m.unit })),
      screens: screenOut.results,
      scenarios: scenarioOut.results,
      notes,
      rows: rows.slice(0, Math.min(Math.max(Number(args.maxRows) || 40, 1), 100)),
    };
  },
};

const compareAsOf: ToolDefinition = {
  name: 'compare_asof',
  description:
    'Run one data query at several as-of dates and return the results side by side, with the change from the first date for aggregate queries. Use it for "now versus last quarter, one year ago, and inception" instead of running the query repeatedly. query is one data query as JSON (set metrics and groupBy for totals). asOfDates is a JSON array like [{"label":"Current","date":"2026-09-30"},{"label":"1 year ago","date":"2025-09-30"}] (max 6). A date the data does not reach returns empty rows; report that as data not available.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'One data query as JSON.' },
      asOfDates: { type: 'string', description: 'JSON array of {label, date}.' },
      entityCode: { type: 'string', description: 'The context record when the query starts at CONTEXT.' },
      maxRows: { type: 'number', description: 'Rows per date (default 40).' },
    },
    required: ['query', 'asOfDates'],
  },
  execute: async (args, supabase) => {
    const spec = parseJson(args.query, 'query') as DataQuerySpec;
    const dates = asList(parseJson(args.asOfDates, 'asOfDates')).slice(0, 6)
      .map((d: any, i: number) => (typeof d === 'string' ? { label: d, date: d } : { label: d?.label ?? `Date ${i + 1}`, date: d?.date }))
      .filter((d: any) => /^\d{4}-\d{2}-\d{2}/.test(String(d.date)));
    if (!spec || !dates.length) return { error: 'Send one query and at least one {label, date} with a YYYY-MM-DD date.' };
    const key = spec.key || 'rows';
    const full: DataQuerySpec = { ...spec, key, start: spec.start ?? (args.entityCode ? 'CONTEXT' : 'DOMAIN') };
    const problems = validateDataQueries([full]);
    if (problems.length) return { error: problems.join('; ') };
    const anchorId = await resolveEntityId(supabase, undefined, args.entityCode);
    if (full.start === 'CONTEXT' && !anchorId) return { error: 'start CONTEXT needs entityCode for a record you can read.' };

    const cap = Math.min(Math.max(Number(args.maxRows) || 40, 1), 100);
    const catalog = new Map<string, any[]>();
    const results: Array<{ label: string; date: string; error?: string; matched?: number; total?: number; summary?: unknown; rows?: any[] }> = [];
    const full_rows: Record<string, any[]> = {};
    for (const d of dates) {
      try {
        const f = await fetchQueryRows(supabase, full, anchorId, { asOfDate: d.date }, String(d.date).slice(0, 10), catalog);
        full_rows[d.label] = f.rows;
        results.push({ label: d.label, date: d.date, matched: f.matched, total: f.total, summary: f.summary ?? undefined, rows: f.rows.slice(0, cap) });
      } catch (e: any) {
        results.push({ label: d.label, date: d.date, error: e?.message || String(e) });
      }
    }

    // Change from the first date, per group and metric.
    const deltas: Array<Record<string, unknown>> = [];
    const groupBy = full.groupBy ?? [];
    const aliases = (full.metrics ?? []).map((m) => m.alias);
    if (aliases.length && results.length > 1 && full_rows[results[0].label]) {
      const keyOf = (row: any) => groupBy.map((g) => String(row[g] ?? '')).join(' | ') || 'all';
      const groups = new Set<string>();
      for (const rows of Object.values(full_rows)) rows.forEach((r) => groups.add(keyOf(r)));
      for (const g of groups) {
        for (const alias of aliases) {
          const values: Record<string, number | null> = {};
          for (const d of dates) {
            const hit = (full_rows[d.label] ?? []).find((r) => keyOf(r) === g);
            const v = hit ? Number(hit[alias]) : NaN;
            values[d.label] = Number.isFinite(v) ? v : null;
          }
          const first = values[dates[0].label];
          const change: Record<string, number | null> = {};
          for (const d of dates.slice(1)) {
            const v = values[d.label];
            change[d.label] = first !== null && v !== null ? first - v : null;
          }
          deltas.push({ group: g, metric: alias, values, changeFromEarlier: change });
        }
      }
    }
    return {
      note: 'changeFromEarlier = first date minus that date (positive means the first date is higher). null means the value was not available at one of the dates.',
      dates: results,
      deltas: deltas.slice(0, 200),
    };
  },
};

const getDataCoverage: ToolDefinition = {
  name: 'get_data_coverage',
  description:
    'For one entity type: which attributes are defined and how many records actually have a value. Use it before promising a metric. An attribute with zero values is "defined but not loaded"; one that is absent from the list is "not defined" - both are data not available, but they have different fixes. domainCode from list_domain_types. attributeCodes (optional JSON array) narrows the list.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string' },
      attributeCodes: { type: 'string', description: 'Optional JSON array of attribute codes.' },
      asOfDate: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
    },
    required: ['domainCode'],
  },
  execute: async (args, supabase) => {
    const domainCode = String(args.domainCode).toUpperCase();
    const wanted = new Set<string>(asList(parseJson(args.attributeCodes, 'attributeCodes')).map(String));
    const catalog = await getAttributeCatalog(supabase, domainCode);
    const asOf = String(args.asOfDate || todayIso()).slice(0, 10);

    const { data: counted, error } = await supabase.rpc('query_values', {
      p_request: {
        domainCode, attributeCodes: wanted.size ? [...wanted] : null, asOfDate: asOf, filters: [],
        groupBy: ['attribute_code'],
        metrics: [{ alias: 'values', agg: 'COUNT' }, { alias: 'records', agg: 'COUNT_DISTINCT', field: 'entity_id' }],
        select: [], orderBy: [], limit: 1000,
      },
    });
    if (error) throw new Error(error.message);
    const byCode = new Map<string, { values: number; records: number }>();
    for (const r of (counted?.rows ?? counted ?? []) as any[]) {
      if (r?.attribute_code) byCode.set(r.attribute_code, { values: Number(r.values) || 0, records: Number(r.records) || 0 });
    }

    const { data: total } = await supabase.rpc('query_values', {
      p_request: {
        domainCode, asOfDate: asOf, filters: [], groupBy: [], select: [], orderBy: [],
        metrics: [{ alias: 'records', agg: 'COUNT_DISTINCT', field: 'entity_id' }],
      },
    });
    const recordCount = Number((total?.rows ?? [])[0]?.records ?? 0) || undefined;

    const defined = catalog.filter((a) => !wanted.size || wanted.has(a.attribute_code));
    const attributes = defined.map((a) => {
      const c = byCode.get(a.attribute_code);
      return {
        attributeCode: a.attribute_code,
        attributeName: a.attribute_name,
        recordsWithValue: c?.records ?? 0,
        pctOfRecords: recordCount && c ? Math.round((c.records / recordCount) * 1000) / 10 : c ? undefined : 0,
        state: c && c.records > 0 ? 'loaded' : 'defined-not-loaded',
      };
    });
    const notDefined = [...wanted].filter((code) => !catalog.some((a) => a.attribute_code === code));
    return {
      domainCode,
      asOfDate: asOf,
      recordsInDomain: recordCount,
      attributes,
      notDefined,
      note: 'notDefined codes are not registered for this entity type; check search_attributes - the field may live on a related type (use get_model_map).',
    };
  },
};

// ---------------------------------------------------------------------------
// Design (writes templates; tenant admins)
// ---------------------------------------------------------------------------

const validateNarrativeTool: ToolDefinition = {
  name: 'validate_narrative',
  description:
    'Check a narrative design without saving it: structure, block types, data queries, measure / screen / scenario expressions, run order. spec is a JSON object with narrativeName, domainCode, sections (and optionally persona, audience, rules, parameters, exposedDomains, allowExternalSearch). Returns problems, or the run order when it is valid.',
  category: 'reporting',
  inputSchema: {
    type: 'object',
    properties: { spec: { type: 'string', description: 'The narrative as a JSON object.' } },
    required: ['spec'],
  },
  execute: async (args) => {
    const spec = parseJson(args.spec, 'spec') as NarrativeSpec;
    if (!spec || typeof spec !== 'object') return { valid: false, problems: ['spec must be a JSON object'] };
    const problems = validateNarrative(spec);
    return problems.length ? { valid: false, problems } : { valid: true, runOrder: narrativePlan(spec).order };
  },
};

const NARRATIVE_COLUMNS: Array<[keyof NarrativeSpec | 'narrativeName', string]> = [
  ['narrativeName', 'narrative_name'], ['description', 'description'], ['domainCode', 'domain_code'],
  ['exposedDomains', 'exposed_domains'], ['persona', 'persona'], ['audience', 'audience'], ['rules', 'rules'],
  ['allowExternalSearch', 'allow_external_search'], ['parameters', 'parameters'], ['sections', 'sections'],
];

const saveNarrative: ToolDefinition = {
  name: 'save_narrative',
  description:
    'Create or update a reusable narrative so everyone gets it on the record page of the entity types it is offered on. narrativeCode is UPPER_SNAKE. spec has the same fields as validate_narrative; for an update send only what changes. It is validated first. Needs the tenant-admin role; if refused, hand the sections to the user as text. Do not save a narrative the user did not ask to keep.',
  category: 'reporting',
  inputSchema: {
    type: 'object',
    properties: {
      narrativeCode: { type: 'string' },
      spec: { type: 'string', description: 'The narrative (or the changed fields) as a JSON object.' },
    },
    required: ['narrativeCode', 'spec'],
  },
  execute: async (args, supabase) => {
    const code = String(args.narrativeCode).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const patch = parseJson(args.spec, 'spec') as NarrativeSpec;
    const { data: existing, error: fe } = await supabase.from('narrative_templates').select('*').eq('narrative_code', code).maybeSingle();
    if (fe) throw new Error(fe.message);
    const merged: NarrativeSpec = { ...(existing ? narrativeSpecFromRow(existing) : {}), ...patch };
    const problems = validateNarrative(merged);
    if (!merged.domainCode) problems.push('domainCode is required');
    if (!merged.narrativeName) problems.push('narrativeName is required');
    if (problems.length) return { saved: false, problems };

    const row: Record<string, unknown> = {};
    for (const [field, column] of NARRATIVE_COLUMNS) {
      if ((patch as any)[field] !== undefined) row[column] = (patch as any)[field];
    }
    const { data, error } = existing
      ? await supabase.from('narrative_templates').update({ ...row, updated_at: new Date().toISOString() }).eq('id', existing.id).select('narrative_code').single()
      : await supabase.from('narrative_templates').insert({ narrative_code: code, ...row }).select('narrative_code').single();
    if (error) return { saved: false, error: error.message };
    return { saved: true, created: !existing, narrativeCode: data.narrative_code, runOrder: narrativePlan(merged).order };
  },
};

const assignNarrative: ToolDefinition = {
  name: 'assign_narrative_entity_types',
  description:
    'Choose the entity types whose record pages offer a narrative, in addition to its own type. exposedDomains is a JSON array of entity type codes from list_domain_types, for example ["FUND","ISSUER"]; send [] to offer it on its own type only. The queries in the narrative start at the record being viewed, so make sure they make sense for each type. Needs the tenant-admin role.',
  category: 'reporting',
  inputSchema: {
    type: 'object',
    properties: {
      narrativeCode: { type: 'string' },
      exposedDomains: { type: 'string', description: 'JSON array of entity type codes.' },
    },
    required: ['narrativeCode', 'exposedDomains'],
  },
  execute: async (args, supabase) => {
    const codes = asList(parseJson(args.exposedDomains, 'exposedDomains')).map((c) => String(c).toUpperCase());
    const { data: known, error: de } = await supabase.from('domain_types').select('domain_code').in('domain_code', codes.length ? codes : ['_']);
    if (de) throw new Error(de.message);
    const unknown = codes.filter((c) => !(known || []).some((k: any) => k.domain_code === c));
    if (unknown.length) return { saved: false, error: `Unknown entity types: ${unknown.join(', ')}. Use list_domain_types.` };
    const { data, error } = await supabase
      .from('narrative_templates').update({ exposed_domains: codes, updated_at: new Date().toISOString() })
      .eq('narrative_code', String(args.narrativeCode)).select('narrative_code, domain_code, exposed_domains').maybeSingle();
    if (error) return { saved: false, error: error.message };
    if (!data) return { saved: false, error: 'No such narrative, or you may not change it.' };
    return { saved: true, narrativeCode: data.narrative_code, offeredOn: [data.domain_code, ...data.exposed_domains] };
  },
};

const getNarrativeGuide: ToolDefinition = {
  name: 'get_narrative_guide',
  description: 'The method for composing a narrative or a large analytical report from this server: workflow, data rules, output standard, block format. The same text is the resource tapestrai://model/narrative-guide. Read it before answering a multi-part request if you cannot read resources.',
  category: 'narrative',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ guide: NARRATIVE_COMPOSE_GUIDE }),
};

export function registerNarrativeTools(registry: ToolRegistry): void {
  for (const tool of [
    listNarratives, getNarrative, getNarrativeGuide,
    listNarrativeRuns, getNarrativeRun, publishNarrativeRun, getReviewBrief, saveRunReview,
    startNarrativeRun, runNarrativeSectionData, saveNarrativeSection, finishNarrativeRun,
    analyzeRows, compareAsOf, getDataCoverage,
    validateNarrativeTool, saveNarrative, assignNarrative,
  ]) registry.registerTool(tool);
}
