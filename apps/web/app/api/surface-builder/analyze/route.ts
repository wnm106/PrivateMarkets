import { NextRequest, NextResponse } from 'next/server';
import { callerClientId } from '@/lib/agent-audit';
import { requireTenantAdmin } from '@/lib/surface-builder/admin-auth';
import {
  baselineBlueprint,
  catalogForModel,
  decisionsFrom,
  mergeModelBlueprint,
  readUnderstanding,
  surfaceCode,
  type PrototypeUnderstanding,
  type SurfaceBlueprint,
  type SurfaceRequest,
} from '@/lib/surface-builder/blueprint';
import { loadPlatformCatalog } from '@/lib/surface-builder/catalog-server';
import { PLATFORM_MODEL } from '@/lib/surface-builder/platform-model';
import { SURFACE_STANDARDS, standardHowTo } from '@/lib/surface-builder/standards';
import { parseJsonReply, review, reviewerAvailable, type ReviewPart } from '@/lib/surface-builder/reviewer';
import { usageForClient } from '@tapestrai/mcp-server/src/agent/harness';

/**
 * Surface Builder: reads a prototype and a description against the platform
 * catalog and returns a blueprint for building the surface. Nothing is written.
 *
 * The review runs in two passes:
 *   1. understand: the model reads the prototype source, every captured view
 *      (rendered markup and screenshot) and the catalog, and returns what it
 *      understood plus the modelling questions it cannot settle alone.
 *   2. blueprint: with the admin's answers, it writes the blueprint: entity
 *      model, compliance mapping, calculations, tabs, capabilities, standards.
 * Both passes send the same prototype first, so the second reads it from the
 * model's cache. Without a model, the baseline draft is returned.
 */

// A thorough review of a large prototype takes minutes.
export const maxDuration = 800;

const MAX_HTML = 1_000_000;
const MAX_MODEL_HTML = 600_000;
const MAX_DESCRIPTION = 40_000;
const MAX_VIEWS = 24;
const MAX_IMAGES = 20;
const VIEW_MARKUP_BUDGET = 250_000;

const SYSTEM = `You are the platform architect for tapestr.ai, a bi-temporal master data platform for private markets.
An admin has given you a prototype of a new surface (a screen) and a description of what it is for. You receive:
- context: the request (name, description, audience, placement, anchored entity type), the prototype outline, a deterministic baseline draft with attribute matches, the house standards, the catalog (entity types, attributes, relationship types, compliance rules, reference lists, tools, skills, surfaces) and platformModel: how the platform stores things.
- the prototype source HTML, including its scripts: read them for the data model, calculations and rules the screens use, not only the markup.
- the rendered views: each state the prototype reached when its navigation was clicked, with its rendered markup and a screenshot. Look at the screenshots: they show what a person sees (bands, bars, pills, charts, editable cells) that markup alone does not.

How to reason:
- Model the domain the way platformModel describes. Records a person edits one value at a time, or a rule reads, are entities with attributes and relationships. Never put records (targets, bands, limits, schedules) in a JSON attribute.
- Reuse what the catalog has. Name an existing entity type, attribute, relationship type, compliance rule or reference list only by a code that appears in the catalog. Anything else is new.
- Compliance goes through the engine: rules (compliance.rules), fund limits and Hard/Soft severity (compliance.rule_thresholds), which funds a rule covers (compliance.rule_scope_assignments), interpretation (compliance.evaluate_rule). A rule kind the evaluator cannot express is an evaluator extension, driven by rule metadata.
- Every calculation the prototype does in the browser gets one home (a database function, a calculated attribute or one shared module) that the surface and the assistant both call.
- No code may name a client, rule or entity by its code; differences go in data.
- Be concrete and complete: cover every view and tab you saw, not only the first.`;

const UNDERSTAND_ASK = `PASS 1 of 2: UNDERSTAND.
Do not write the blueprint yet. Report what you understood and ask the admin only the questions whose answers change the entity model, the compliance mapping or the build.
Respond with JSON only:
{"summary":"what the surface is for and how it works, in a paragraph",
"views":[{"name":"","shows":"what this view or tab shows and what a person decides or changes there"}],
"concepts":[{"name":"","meaning":"","model":"entity-type|attribute|relationship|reference-list|compliance-rule|threshold|calculation|ui","detail":"how you would model it on the platform, naming catalog codes where they exist"}],
"computations":[{"name":"","detail":"inputs, formula and where it should run"}],
"assumptions":["what you assumed where the prototype was unclear"],
"questions":[{"id":"q1","question":"","why":"what in the build depends on it","options":["2 to 4 concrete choices"],"recommended":"the option you recommend"}]}
Ask at most 8 questions. Ask none if nothing is genuinely unclear.`;

const BLUEPRINT_ASK = (understanding: PrototypeUnderstanding | null, decisions: Array<{ question: string; answer: string; source: string }>) => `PASS 2 of 2: BLUEPRINT.
${understanding ? `Your first read of the prototype:\n${JSON.stringify(understanding)}\n` : ''}${decisions.length ? `The admin's decisions (source "assumed" means the admin skipped the question and your recommendation stands; say so where it matters):\n${JSON.stringify(decisions)}\n` : ''}
Write the blueprint a developer or coding agent follows. Rules:
- fields: every value the views show, on every tab: ribbon figures, each column of each grid and the cells inside editable grids, rail and side-panel figures, cards, totals and footers. A grid of min, target and max cells is one field per kind of cell, not one field for the grid. decision reuse (a catalog attribute code), new (also in newAttributes), derived (say how, from which codes) or ui. Editable only when a person changes it on this screen. The redesign and the build bind what you list here and nothing else, so a value you leave out has no right-click.
- entityTypes: every kind of record involved, existing (status reuse, catalog code) and new. identity says what makes one record (e.g. "one per fund, hierarchy and node"). attributes lists its attribute codes.
- relationshipTypes: every link between entity types, existing or new, with from and to entity types.
- taxonomies: every classification tree, its levels and how it is stored.
- compliance: every rule, limit or check in the prototype and what it maps to (rule, threshold, scope, evaluator, other), naming the tables.
- computations: every calculation, its inputs, output, where it runs (runsIn) and whether that exists, needs extending or is new. Every field with decision derived has a computation here. Never leave this empty when any field is derived: an unnamed home means the builder works it out inside the surface.
- tabs: one per view and tab you saw. purpose (the question it answers), howToRead (terms, levels, colors and signs a reader could get wrong), contents, publishes (what the tab tells the assistant, totals first), dataFrom (existing tool names, queries or "new: <name>").
- capabilities: functional requirements. status exists only when a registered tool or query already does it (name it); extend when one needs a change; new otherwise. kind: graphql, tool, db-function, skill, workflow or ui.
- workflows: agentic steps only where needed: agent (reads, proposes), human (reviews, answers), fixed (applies). An agent never writes directly.
- standards: for each standard id, what this surface in particular must do on top of the house rule: name the tabs, grids, cells and controls it applies to. Do not restate or soften the rule. Name only the APIs the standard's own howTo names (context.standards[].howTo is already written for this placement); a client surface (placement sdk-surface) may not import app components such as InspectValue, so never name them for one.
- uxNotes: where the prototype departs from the house design system and how to standardise it.
- artifacts: leave empty. Each view is redesigned in the house design in a separate step, from its own markup and screenshot.
- buildSteps: ordered, with files, for the placement requested. Records go in supabase/seed, never a migration. A client surface lives in surfaces/<surfaceCode>/, where surfaceCode is given in context: use exactly that folder, never a name of your own. It uses only @tapestrai/surface-sdk.
- openQuestions: decisions still open after the admin's answers, each one a question a person can answer in a sentence. The builder is told to stop and ask these before it builds, so include every choice you would otherwise make silently (for example whether an edit saves at once or is staged for a commit).
Respond with JSON only:
{"summary":"",
"entityTypes":[{"code":"","name":"","status":"reuse|new","parentCode":"","purpose":"","identity":"","attributes":[""],"reason":""}],
"relationshipTypes":[{"code":"","name":"","status":"reuse|new","fromDomain":"","toDomain":"","cardinality":"","reason":""}],
"taxonomies":[{"name":"","levels":[""],"storage":"","source":"","reason":""}],
"compliance":[{"prototypeRule":"","mapsTo":"rule|threshold|scope|evaluator|other","detail":"","tables":[""]}],
"computations":[{"name":"","inputs":[""],"output":"","runsIn":"","status":"exists|extend|new","detail":""}],
"fields":[{"label":"","where":"","decision":"reuse|new|derived|ui","attributeCode":"","domainCode":"","dataType":"","editable":false,"note":""}],
"newAttributes":[{"code":"","name":"","domainCode":"","dataType":"","isTimeVarying":false,"listValues":[],"reason":""}],
"relationships":[""],
"tabs":[{"label":"","purpose":"","howToRead":"","contents":[""],"publishes":"","dataFrom":[""]}],
"capabilities":[{"title":"","status":"exists|extend|new","detail":"","tools":[""],"kind":""}],
"workflows":[{"name":"","trigger":"","outcome":"","steps":[{"kind":"agent|human|fixed","title":"","detail":"","tools":[""]}]}],
"standards":[{"id":"","note":""}],
"uxNotes":[""],
"artifacts":[],
"buildSteps":[{"title":"","detail":"","files":[""]}],
"openQuestions":[""]}`;

interface ViewInput {
  label: string;
  html: string;
  text: string;
  image?: string;
}

function readRequest(body: any): SurfaceRequest | string {
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const html = typeof body?.html === 'string' ? body.html : '';
  if (!name) return 'Give the surface a name.';
  if (!description) return 'Describe what the surface is for.';
  if (description.length > MAX_DESCRIPTION) return `The description is ${Math.round(description.length / 1000)}K characters; the limit is ${MAX_DESCRIPTION / 1000}K.`;
  if (!html.trim()) return 'Add the prototype HTML.';
  if (html.length > MAX_HTML) return `The prototype is ${Math.round(html.length / 1000)}KB; the limit is ${MAX_HTML / 1000}KB. Remove embedded images or data.`;
  const placement = ['record-tab', 'sdk-surface', 'app-page'].includes(body?.placement) ? body.placement : undefined;
  return {
    name,
    description,
    html,
    domainCode: typeof body?.domainCode === 'string' && body.domainCode.trim() ? body.domainCode.trim().slice(0, 60) : null,
    audience: typeof body?.audience === 'string' ? body.audience.trim().slice(0, 1000) : undefined,
    placement,
  };
}

function readViews(value: unknown): ViewInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_VIEWS).map((item) => {
    const row = (item || {}) as Record<string, unknown>;
    const image = typeof row.image === 'string' && row.image.length < 2_000_000 && /^[A-Za-z0-9+/=]+$/.test(row.image.slice(0, 400)) ? row.image : undefined;
    return {
      label: typeof row.label === 'string' ? row.label.slice(0, 120) : 'View',
      html: typeof row.html === 'string' ? row.html.slice(0, 60_000) : '',
      text: typeof row.text === 'string' ? row.text.slice(0, 8_000) : '',
      image,
    };
  }).filter((view) => view.html || view.text);
}

function readAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, answer] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (typeof answer === 'string') out[key.slice(0, 20)] = answer.slice(0, 1000);
  }
  return out;
}

/** The prototype as the model sees it: context, source, then each view's markup and screenshot. Identical for both passes. */
function sharedParts(surfaceRequest: SurfaceRequest, baseline: SurfaceBlueprint, catalog: Awaited<ReturnType<typeof loadPlatformCatalog>>, views: ViewInput[], warnings: string[]): ReviewPart[] {
  const context = JSON.stringify({
    request: { ...surfaceRequest, html: undefined },
    outline: baseline.outline,
    baseline: {
      fields: baseline.fields,
      matches: baseline.matches.map((match) => ({ label: match.label, verdict: match.verdict, candidates: match.candidates })),
      capabilities: baseline.capabilities,
    },
    surfaceCode: surfaceCode(surfaceRequest.name),
    standards: SURFACE_STANDARDS.map((standard) => ({ id: standard.id, title: standard.title, rule: standard.rule, howTo: standardHowTo(standard, surfaceRequest.placement), accept: standard.accept })),
    catalog: catalogForModel(catalog, baseline, 1500),
    platformModel: PLATFORM_MODEL,
  });
  const source = surfaceRequest.html.length > MAX_MODEL_HTML
    ? `${surfaceRequest.html.slice(0, MAX_MODEL_HTML)}\n<!-- prototype source cut at ${MAX_MODEL_HTML / 1000}KB -->`
    : surfaceRequest.html;
  if (surfaceRequest.html.length > MAX_MODEL_HTML) warnings.push(`The prototype source is ${Math.round(surfaceRequest.html.length / 1000)}KB; the model read the first ${MAX_MODEL_HTML / 1000}KB. The rendered views cover what it draws.`);

  const parts: ReviewPart[] = [
    { type: 'text', text: `CONTEXT:\n${context}` },
    { type: 'text', text: `PROTOTYPE SOURCE HTML:\n${source}` },
  ];
  if (views.length === 0) {
    warnings.push('No rendered views were captured, so the model read the source only and saw no screenshots.');
    return parts;
  }
  const perView = Math.min(60_000, Math.floor(VIEW_MARKUP_BUDGET / views.length));
  let images = 0;
  views.forEach((view, index) => {
    parts.push({ type: 'text', text: `RENDERED VIEW ${index + 1} of ${views.length}: ${view.label}\nMARKUP:\n${view.html.slice(0, perView)}` });
    if (view.image && images < MAX_IMAGES) {
      parts.push({ type: 'text', text: `SCREENSHOT of "${view.label}":` });
      parts.push({ type: 'image', data: view.image, mediaType: 'image/jpeg' });
      images += 1;
    }
  });
  if (images === 0) warnings.push('The views were captured without screenshots, so the model read rendered markup only.');
  return parts;
}

export async function POST(request: NextRequest) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 });
  }
  const surfaceRequest = readRequest(body);
  if (typeof surfaceRequest === 'string') return NextResponse.json({ error: surfaceRequest }, { status: 400 });
  const views = readViews(body?.views);
  const stage: 'understand' | 'blueprint' = body?.stage === 'understand' ? 'understand' : 'blueprint';

  const catalog = await loadPlatformCatalog(auth.supabase);
  const baseline = baselineBlueprint(surfaceRequest, catalog, views);
  const reviewer = body?.useModel === false ? null : reviewerAvailable();
  if (!reviewer) {
    if (body?.useModel !== false) baseline.warnings.push('No model key is configured, so this is the baseline draft without model review.');
    return NextResponse.json({ stage: 'blueprint', blueprint: baseline, usage: null });
  }
  if (reviewer.provider === 'gemini') baseline.warnings.push(`No Anthropic key is set, so the review ran on ${reviewer.model}, a fast model. Set ANTHROPIC_API_KEY for the full review.`);

  const warnings: string[] = [];
  const shared = sharedParts(surfaceRequest, baseline, catalog, views, warnings);
  const clientId = await callerClientId(auth.supabase);
  const common = {
    system: SYSTEM,
    shared,
    userId: auth.userId,
    clientId,
    subject: { type: 'surface', id: surfaceRequest.name, label: surfaceRequest.name },
    metadata: { domainCode: surfaceRequest.domainCode, placement: surfaceRequest.placement, htmlBytes: surfaceRequest.html.length, views: views.length, stage },
  };

  try {
    if (stage === 'understand') {
      const result = await review({ ...common, ask: UNDERSTAND_ASK, maxTokens: 24_000, activity: 'surface-builder.understand' });
      const parsed = parseJsonReply(result.text);
      if (!parsed) {
        return NextResponse.json({
          error: result.stopped === 'refusal'
            ? 'The model declined to review this prototype.'
            : result.stopped === 'max_tokens' ? 'The model ran out of room while reading the prototype. Try again with fewer views.' : 'The model reply could not be read. Try again.',
          usage: usageForClient([result.audit]),
        }, { status: 502 });
      }
      baseline.warnings.push(...warnings);
      return NextResponse.json({
        stage: 'understand',
        understanding: readUnderstanding(parsed),
        blueprint: baseline,
        reviewer: { provider: result.provider, model: result.model },
        usage: usageForClient([result.audit]),
      });
    }

    const understanding = body?.understanding ? readUnderstanding(body.understanding) : null;
    const decisions = decisionsFrom(understanding || undefined, readAnswers(body?.answers));
    const result = await review({ ...common, ask: BLUEPRINT_ASK(understanding, decisions), maxTokens: 64_000, activity: 'surface-builder.blueprint' });
    const parsed = parseJsonReply(result.text);
    if (!parsed) {
      baseline.warnings.push(...warnings, result.stopped === 'max_tokens'
        ? 'The model ran out of room before it finished the blueprint; this is the baseline draft.'
        : result.stopped === 'refusal' ? 'The model declined to write the blueprint; this is the baseline draft.' : 'The model reply could not be read; this is the baseline draft.');
      return NextResponse.json({ stage: 'blueprint', blueprint: { ...baseline, decisions, understanding: understanding || undefined }, usage: usageForClient([result.audit]) });
    }
    const merged = mergeModelBlueprint(baseline, parsed, catalog);
    merged.warnings.push(...warnings);
    return NextResponse.json({
      stage: 'blueprint',
      blueprint: { ...merged, decisions, understanding: understanding || undefined, model: result.model },
      usage: usageForClient([result.audit]),
    });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : 'unknown error').slice(0, 300);
    if (stage === 'understand') return NextResponse.json({ error: `The model could not review the prototype: ${detail}` }, { status: 502 });
    baseline.warnings.push(...warnings, `The model could not be reached (${detail}); this is the baseline draft.`);
    return NextResponse.json({ stage: 'blueprint', blueprint: baseline, usage: null });
  }
}
