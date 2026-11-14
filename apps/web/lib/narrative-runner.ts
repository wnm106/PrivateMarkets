/**
 * Server-side narrative section runner (Gemini).
 *
 * One call composes one section (or one batch of a batched section):
 *   1. evidence   declared queries at every comparison date, measures, screens, scenarios
 *   2. research   dated web notes, only when the narrative allows external search
 *   3. gather     a bounded loop of read-only tools to fill what the evidence lacks
 *   4. compose    typed blocks as JSON
 *   5. verify     every figure traced to evidence, tool results, prior sections, or the brief
 *
 * Splitting a report into section requests keeps each request short, makes progress
 * visible, and lets one failing section leave the rest intact.
 */
import {
  normalizeReview,
  reviewSystemPrompt,
  reviewUserPrompt,
  type ReviewSectionInput,
  type RunReview,
} from '@tapestrai/graphql/src/lib/narrative-review';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerDomainTools } from '@tapestrai/mcp-server/src/tools/domain-tools';
import { registerLineageTools } from '@tapestrai/mcp-server/src/tools/lineage-tools';
import { registerDQTools } from '@tapestrai/mcp-server/src/tools/dq-tools';
import { registerComplianceTools } from '@tapestrai/mcp-server/src/tools/compliance-tools';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { registerQueryTools } from '@tapestrai/mcp-server/src/tools/query-data';
import { NARRATIVE_AGENT_TOOLS, registerNarrativeTools } from '@tapestrai/mcp-server/src/tools/narrative-tools';
import {
  compactEvidence,
  researchQueries,
  runSectionData,
  type SectionEvidence,
} from '@tapestrai/graphql/src/lib/narrative-engine';
import {
  narrativeSystemPrompt,
  collapseGapColumns,
  normalizeBlocks,
  sectionUserPrompt,
  splitBatches,
  verifyBlocks,
  type NarrativeBlock,
  type NarrativeSection,
  type NarrativeSpec,
  type Verification,
} from '@tapestrai/graphql/src/lib/narrative-spec';

const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  '';
export const DEFAULT_NARRATIVE_MODEL = 'gemini-3.8-flash';
export const hasModelKey = () => !!geminiApiKey;

const MAX_AGENT_ROUNDS = 14;
/** One model call may not hang a section. */
const MODEL_TIMEOUT_MS = 120_000;
/** The tool loop stops asking for more once it has run this long, and the section is composed from what it has. */
const GATHER_BUDGET_MS = 150_000;

function log(label: string, since: number, extra = ''): void {
  console.log(`[narrative] ${label} ${Math.round(performance.now() - since)}ms${extra ? ` ${extra}` : ''}`);
}
const TOOL_RESULT_CHARS = 20000;
/** Evidence tools (queries, analysis, compliance) may return this much in total before the loop is told to stop. */
const EVIDENCE_BUDGET_CHARS = 120000;
/**
 * Discovery tools only tell the model where fields live. Their output is large and is not evidence,
 * so it neither counts against the evidence budget nor is carried into composition.
 */
const DISCOVERY_TOOLS = new Set([
  'get_model_map', 'get_template_metadata', 'get_attribute_metadata', 'search_attributes',
  'list_domain_types', 'get_relationship_types', 'find_sample_entities',
]);
/** Discovery calls stop being useful after this many; the model must query. */
const MAX_DISCOVERY_CALLS = 8;
/** Gathering and fact-based writing do not need long deliberation; synthesis sections keep the model's default. */
const FAST_THINKING = { thinkingConfig: { thinkingLevel: 'low' } };

let registry: ToolRegistry | null = null;
/** The read-only tool set a section may call. Built once; each call runs as the caller. */
function agentRegistry(): ToolRegistry {
  if (registry) return registry;
  // The registry's own client is unused: every call passes the caller's client.
  const r = new ToolRegistry(null as never);
  registerDomainTools(r);
  registerLineageTools(r);
  registerDQTools(r);
  registerComplianceTools(r);
  registerReportingTools(r);
  registerQueryTools(r);
  registerNarrativeTools(r);
  registry = r;
  return r;
}

async function gemini(model: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`Model error: ${(await response.text()).slice(0, 400)}`);
  return response.json();
}

const textOf = (data: any): string =>
  (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text || '').join('').trim();

function clampJson(value: unknown, max: number): unknown {
  const s = JSON.stringify(value);
  return s.length <= max ? value : { truncated: true, preview: s.slice(0, max) };
}

// ---------------------------------------------------------------------------
// Research (grounded web search)
// ---------------------------------------------------------------------------

export interface ResearchResult {
  queries: string[];
  notes: string;
  sources: Array<{ title: string; url?: string }>;
}

async function researchWeb(model: string, queries: string[], maxSources: number): Promise<ResearchResult> {
  const prompt = [
    'Search the web and report dated findings on the topics below.',
    'For every item give: a one-line headline, the publisher, the publication date (YYYY-MM-DD, or month and year if that is all there is), and the fact it supports.',
    'Leave out anything you cannot attribute to a dated source. Do not speculate, and do not state a number that is not in a source.',
    `Report at most ${maxSources} items, most recent and most relevant first.`,
    '',
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ].join('\n');
  const data = await gemini(model, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
  });
  const chunks: any[] = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources = chunks.flatMap((c) => {
    const url = c?.web?.uri as string | undefined;
    const title = (c?.web?.title as string | undefined) ?? url ?? '';
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ title, url }];
  }).slice(0, Math.max(maxSources, 1) * 2);
  return { queries, notes: textOf(data), sources };
}

// ---------------------------------------------------------------------------
// Gather (bounded tool loop)
// ---------------------------------------------------------------------------

interface Gathered {
  findings: string;
  toolResults: Array<{ tool: string; args: unknown; result: unknown }>;
  /** Warnings the tools raised (for example records that share a name). Kept with the section so a reviewer sees them. */
  warnings: string[];
}

async function gatherWithTools(args: {
  model: string;
  section: NarrativeSection;
  compact: Record<string, unknown>;
  params: Record<string, unknown>;
  asOfDate: string;
  entityCode?: string;
  toolSupabase: any;
  maxRounds: number;
  /** What an earlier group of this section already worked out (field codes, paths). Reuse it, do not rediscover. */
  reuse?: string;
}): Promise<Gathered> {
  const { section } = args;
  const reg = agentRegistry();
  const tools = reg.listToolsForGemini('analyst').filter((t) => NARRATIVE_AGENT_TOOLS.has(t.name));
  const system = [
    'You are gathering extra evidence for one section of a report. You do not write the report.',
    'Read the section brief and the evidence already supplied, then call tools to fill what is missing. Find fields with get_model_map and get_data_coverage; never guess a code. Do arithmetic and apply thresholds with analyze_rows, not in your head. Use compare_asof for movement over time and the compliance tools for limit status.',
    'Stop when you have what the section needs or the data is not there. Then reply with a plain list of findings: each with the exact figure, the as-of date, and the tool it came from, plus a list of what you looked for and could not find.',
    `The report as-of date is ${args.asOfDate}.${args.entityCode ? ` The record is ${args.entityCode}; use it as entityCode for CONTEXT queries.` : ''}`,
  ].join('\n');
  const brief = [
    `# Section: ${section.title}`,
    section.purpose ? `Key question: ${section.purpose}` : '',
    `# Instructions\n${section.instructions}`,
    `# Inputs\n${JSON.stringify(args.params)}`,
    args.reuse
      ? `# Already worked out for an earlier group in this section\nReuse these field codes, relationship paths and approaches. Do not rediscover them; go straight to retrieving data for the rows in the evidence below.\n${args.reuse.slice(0, 6000)}`
      : '',
    `# Evidence already gathered\n${JSON.stringify(clampJson(args.compact, 30000))}`,
  ].filter(Boolean).join('\n\n');

  const contents: any[] = [{ role: 'user', parts: [{ text: brief }] }];
  const toolResults: Gathered['toolResults'] = [];
  const cache = new Map<string, string>();
  let evidenceChars = 0;
  let discoveryCalls = 0;
  let findings = '';
  const warnings = new Set<string>();
  const started = performance.now();

  for (let round = 0; round < Math.min(args.maxRounds, MAX_AGENT_ROUNDS); round++) {
    if (performance.now() - started > GATHER_BUDGET_MS) {
      log(`gather ${section.key} budget reached, composing from what it has`, started);
      break;
    }
    const roundStart = performance.now();
    const data = await gemini(args.model, {
      contents,
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096, ...FAST_THINKING },
    });
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    log(`gather ${section.key} round ${round + 1} model`, roundStart, calls.length ? `calls=${calls.map((c) => c.functionCall.name).join(',')}` : 'final');
    if (!calls.length) { findings = textOf(data); break; }

    const responses: any[] = [];
    for (const call of calls) {
      const { name, args: callArgs } = call.functionCall as { name: string; args?: Record<string, unknown> };
      const key = `${name}:${JSON.stringify(callArgs ?? {})}`;
      let payload: Record<string, unknown>;
      if (!NARRATIVE_AGENT_TOOLS.has(name)) {
        payload = { error: `${name} is not available in a narrative section.` };
      } else if (cache.has(key)) {
        payload = { error: 'Already retrieved this exact result. Use a different call or give your findings.' };
      } else if (DISCOVERY_TOOLS.has(name) && discoveryCalls >= MAX_DISCOVERY_CALLS) {
        payload = { error: 'You have enough discovery. Run query_data or analyze_rows with the codes you found, or give your findings.' };
      } else if (!DISCOVERY_TOOLS.has(name) && evidenceChars > EVIDENCE_BUDGET_CHARS) {
        payload = { error: 'Evidence budget used. Give your findings now.' };
      } else {
        const toolStart = performance.now();
        try {
          const value = await reg.executeTool(name, callArgs ?? {}, args.toolSupabase);
          log(`gather ${section.key} tool ${name}`, toolStart);
          const clamped = clampJson(value, TOOL_RESULT_CHARS);
          cache.set(key, '1');
          const raised = (value as { warnings?: unknown })?.warnings;
          if (Array.isArray(raised)) for (const w of raised) warnings.add(String(w));
          if (DISCOVERY_TOOLS.has(name)) discoveryCalls++;
          else {
            evidenceChars += JSON.stringify(clamped).length;
            toolResults.push({ tool: name, args: callArgs ?? {}, result: clamped });
          }
          payload = (clamped && typeof clamped === 'object' && !Array.isArray(clamped) ? clamped : { result: clamped }) as Record<string, unknown>;
        } catch (e: any) {
          log(`gather ${section.key} tool ${name} FAILED`, toolStart, String(e?.message || e).slice(0, 160));
          cache.set(key, '1');
          payload = { error: `${e?.message || String(e)}. Do not repeat this call.` };
        }
      }
      responses.push({ functionResponse: { name, response: payload } });
    }
    contents.push({ role: data.candidates[0].content?.role || 'model', parts: calls });
    contents.push({ role: 'user', parts: responses });
  }
  return { findings, toolResults, warnings: [...warnings] };
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

async function compose(args: {
  model: string;
  spec: NarrativeSpec;
  section: NarrativeSection;
  params: Record<string, unknown>;
  asOfDate: string;
  evidence: unknown;
  prior: Array<{ key: string; title: string; markdown: string }>;
  research: ResearchResult | null;
  batchLabel?: string;
  mustCover?: string[];
  reviewNotes?: string;
}): Promise<NarrativeBlock[]> {
  const body = {
    systemInstruction: { parts: [{ text: narrativeSystemPrompt(args.spec) }] },
    contents: [{
      role: 'user',
      parts: [{
        text: sectionUserPrompt({
          section: args.section, params: args.params, asOfDate: args.asOfDate, evidence: args.evidence,
          prior: args.prior, research: args.research, batchLabel: args.batchLabel, mustCover: args.mustCover,
          reviewNotes: args.reviewNotes,
        }),
      }],
    }],
    generationConfig: {
      temperature: 0.2, maxOutputTokens: 16000, responseMimeType: 'application/json',
      // A section written from its own evidence is mostly transcription; a synthesis of other sections keeps full reasoning.
      ...(args.section.dependsOn?.length ? {} : FAST_THINKING),
    },
  };
  let lastError = 'The model returned no usable blocks.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await gemini(args.model, body);
    try {
      const blocks = normalizeBlocks(JSON.parse(textOf(data)));
      if (blocks.length) return blocks;
    } catch {
      lastError = 'The model returned output that could not be parsed.';
    }
  }
  throw new Error(lastError);
}

// ---------------------------------------------------------------------------
// Consistency review
// ---------------------------------------------------------------------------

/**
 * A second reader checks the finished report against its own evidence. It is given each section's text,
 * its data notes, and what its tool gathering found, and must quote the exact words of anything it
 * flags; issues whose quote is not in the report are discarded.
 */
export async function reviewRun(args: {
  model?: string | null;
  sections: ReviewSectionInput[];
}): Promise<RunReview> {
  if (!geminiApiKey) throw new Error('Gemini API key not configured');
  const model = args.model || DEFAULT_NARRATIVE_MODEL;
  const t0 = performance.now();
  const data = await gemini(model, {
    systemInstruction: { parts: [{ text: reviewSystemPrompt() }] },
    contents: [{ role: 'user', parts: [{ text: reviewUserPrompt(args.sections) }] }],
    // Full reasoning: this is the step that has to notice what the writers did not.
    generationConfig: { temperature: 0.1, maxOutputTokens: 8000, responseMimeType: 'application/json' },
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(textOf(data));
  } catch {
    throw new Error('The reviewer returned output that could not be read. Try again.');
  }
  const { issues, discarded } = normalizeReview(parsed, args.sections);
  log('review', t0, `issues=${issues.length} discarded=${discarded}`);
  return { issues, discarded, reviewedAt: new Date().toISOString(), model, sectionsReviewed: args.sections.length, source: 'APP' };
}

// ---------------------------------------------------------------------------
// One section (or one batch of it)
// ---------------------------------------------------------------------------

const SUBJECT_COLUMNS = ['iss.entity_name', 'issuer', 'borrower', 'company', 'entity_name'];

/** The names of the rows in a batch, in order. */
function subjectNames(rows: Array<Record<string, any>>): string[] {
  return rows
    .map((r) => SUBJECT_COLUMNS.map((c) => r[c]).find((v) => typeof v === 'string' && v.trim()))
    .filter((v): v is string => !!v);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

/** Names that appear in no table or scorecard first column and nowhere in the prose. */
function missingSubjects(blocks: NarrativeBlock[], names: string[]): string[] {
  const firstCells = new Set<string>();
  let prose = '';
  for (const b of blocks) {
    if (b.type === 'table' || b.type === 'scorecard') b.rows.forEach((r) => firstCells.add(String(r[0] ?? '').trim().toLowerCase()));
    else if (b.type === 'markdown') prose += ` ${b.text.toLowerCase()}`;
  }
  const hasTable = blocks.some((b) => b.type === 'table' || b.type === 'scorecard');
  return names.filter((n) => {
    const key = n.trim().toLowerCase();
    // A trailing digit run must match whole: "Issuer 1" is not "Issuer 10".
    const inProse = new RegExp(`${escapeRegExp(key)}(?!\\d)`).test(prose);
    return hasTable ? !firstCells.has(key) : !inProse;
  });
}

export interface SectionOutcome {
  blocks: NarrativeBlock[];
  /** Compact evidence kept with the section so a reader can see what the figures came from. */
  evidence: Record<string, unknown>;
  research: { queries: string[]; sources: Array<{ title: string; url?: string }>; notes?: string };
  notes: string[];
  verification: Verification;
  batch?: { index: number; count: number };
  toolCalls: number;
}

export async function executeSection(args: {
  supabase: any;
  spec: NarrativeSpec & { model?: string | null };
  section: NarrativeSection;
  entityId?: string | null;
  entityCode?: string | null;
  asOfDate: string;
  params: Record<string, unknown>;
  prior: Array<{ key: string; title: string; markdown: string }>;
  batchIndex?: number;
  /** Findings from the first group of a batched section, so later groups skip rediscovery. */
  reuseFindings?: string;
  /** Problems a reviewer found in an earlier version of this section, to be fixed in this one. */
  reviewNotes?: string;
}): Promise<SectionOutcome> {
  if (!geminiApiKey) throw new Error('Gemini API key not configured');
  const { spec, section, supabase } = args;
  const model = spec.model || DEFAULT_NARRATIVE_MODEL;
  const t0 = performance.now();

  const evidence: SectionEvidence = await runSectionData(supabase, spec, section, {
    entityId: args.entityId, entityCode: args.entityCode, asOfDate: args.asOfDate, params: args.params,
  });

  let batchRows: Record<string, any>[] | undefined;
  let batch: SectionOutcome['batch'];
  if (section.batch) {
    const all = evidence.datasets[section.batch.query]?.rows ?? [];
    const groups = splitBatches(all, section.batch.size);
    if (!groups.length) throw new Error(`The data set "${section.batch.query}" has no rows, so there is nothing to review.`);
    const index = Math.max(0, args.batchIndex ?? 0);
    if (index >= groups.length) throw new Error(`Batch ${index} is past the last batch (${groups.length - 1}).`);
    batchRows = groups[index];
    batch = { index, count: groups.length };
  }

  log(`section ${section.key} evidence`, t0, `datasets=${Object.keys(evidence.datasets).length} notes=${evidence.notes.length}`);
  const compact = compactEvidence(evidence, 120, batchRows && section.batch ? { query: section.batch.query, rows: batchRows } : undefined);
  const notes = [...evidence.notes];

  let research: ResearchResult | null = null;
  const queries = spec.allowExternalSearch ? researchQueries(section, evidence, batchRows) : [];
  if (queries.length) {
    try {
      research = await researchWeb(model, queries, section.research?.maxSources ?? 8);
    } catch (e: any) {
      notes.push(`Web research failed (${e?.message || e}). Sentiment and news were not researched for this section.`);
    }
  } else if (section.research && !spec.allowExternalSearch) {
    notes.push('External search is not enabled for this narrative, so news and sentiment were not researched.');
  }

  let gathered: Gathered = { findings: '', toolResults: [], warnings: [] };
  if (section.agentic?.enabled) {
    try {
      gathered = await gatherWithTools({
        model, section, compact, params: args.params, asOfDate: args.asOfDate,
        entityCode: evidence.entity?.entityCode ?? args.entityCode ?? undefined,
        toolSupabase: supabase, maxRounds: args.reuseFindings ? Math.min(section.agentic.maxRounds ?? 8, 6) : section.agentic.maxRounds ?? 8,
        reuse: args.reuseFindings,
      });
    } catch (e: any) {
      notes.push(`Tool gathering stopped early (${e?.message || e}). The section was written from the evidence above only.`);
    }
  }

  log(`section ${section.key} gathered`, t0, `toolResults=${gathered.toolResults.length}`);
  notes.push(...gathered.warnings.map((w) => `Tool warning: ${w}`));
  const evidenceForModel = {
    ...compact,
    ...(gathered.toolResults.length ? { toolResults: gathered.toolResults } : {}),
    ...(gathered.findings ? { toolFindings: gathered.findings } : {}),
  };
  const composeArgs = {
    model, spec, section, params: args.params, asOfDate: args.asOfDate, evidence: evidenceForModel,
    prior: args.prior, research, batchLabel: batch ? `group ${batch.index + 1} of ${batch.count}` : undefined,
    reviewNotes: args.reviewNotes,
  };
  let blocks = await compose(composeArgs);

  // A review of a list must cover the whole list. If rows were skipped, ask once more with the names.
  const subjects = batchRows ? subjectNames(batchRows) : [];
  if (subjects.length) {
    const missing = missingSubjects(blocks, subjects);
    if (missing.length) {
      log(`section ${section.key} missing ${missing.length} of ${subjects.length}, retrying`, t0);
      try {
        const retry = await compose({ ...composeArgs, mustCover: subjects });
        if (missingSubjects(retry, subjects).length < missing.length) blocks = retry;
      } catch (e: any) {
        notes.push(`A retry to cover every row failed (${e?.message || e}).`);
      }
      const still = missingSubjects(blocks, subjects);
      if (still.length) notes.push(`Not covered in this group: ${still.join('; ')}.`);
    }
  }
  // Batches are merged later, so only a section that is not batched can drop empty columns here.
  if (!batch) blocks = collapseGapColumns(blocks);

  log(`section ${section.key} composed`, t0, `blocks=${blocks.length}`);
  const allowed = [
    section.instructions, section.purpose ?? '', ...section.blocks.map((b) => b.guidance ?? ''),
    ...(spec.rules ?? []), JSON.stringify(args.params), args.asOfDate,
  ];
  const verification = verifyBlocks(
    blocks,
    [evidenceForModel, ...args.prior.map((p) => p.markdown), research?.notes ?? ''],
    allowed,
  );

  return {
    blocks,
    evidence: clampJson(evidenceForModel, 900_000) as Record<string, unknown>,
    research: { queries, sources: research?.sources ?? [], notes: research?.notes },
    notes: Array.from(new Set(notes)),
    verification,
    batch,
    toolCalls: gathered.toolResults.length,
  };
}
