import { NextRequest, NextResponse } from 'next/server';
import { callerClientId } from '@/lib/agent-audit';
import { requireTenantAdmin } from '@/lib/surface-builder/admin-auth';
import { baselineBlueprint, catalogForModel, mergeModelBlueprint, type SurfaceRequest } from '@/lib/surface-builder/blueprint';
import { loadPlatformCatalog } from '@/lib/surface-builder/catalog-server';
import { SURFACE_STANDARDS } from '@/lib/surface-builder/standards';
import { invokeAgent, usageForClient } from '@tapestrai/mcp-server/src/agent/harness';
import { geminiAnswerText } from '@tapestrai/mcp-server/src/agent/usage';

/**
 * Surface Builder: reads a prototype and a description against the platform
 * catalog and returns a blueprint for building the surface.
 *
 * The baseline (prototype outline, attribute matches, standards) is built
 * without a model. The model then refines it into tabs, field decisions,
 * capabilities, workflows and refined HTML. Nothing is written.
 */

const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  '';
const MODEL = 'gemini-3.8-flash';
const MAX_HTML = 400_000;

const INSTRUCTION = `You are the platform architect for tapestr.ai, a bi-temporal master data platform for private markets.
An admin has given you a prototype HTML page and a description of a new surface (a screen). You receive:
- request: the surface name, description, audience, placement and the entity type it is anchored on.
- outline: what the prototype shows (tabs, labelled values, tables, charts, actions, inputs).
- baseline: a deterministic first draft, including attribute matches with scores.
- catalog: the entity types, attributes, relationship types, registered tools (readOnly says whether a tool only reads), guided skills and existing surfaces.
- standards: the house rules every surface meets.

Produce the blueprint a developer or coding agent follows to build the surface. Be concrete and use the catalog.

Rules:
- Reuse an attribute only by a code that appears in catalog.attributes. Never invent an existing code. If nothing fits, the field is "new" (add it to newAttributes with an UPPER_SNAKE code, entity type, data type and reason) or "derived" (say exactly how it is computed from which attribute codes) or "ui" (a label with no data).
- Prefer an existing attribute on the anchored entity type or its parents. Note when a value belongs on a related entity and which relationship type reaches it.
- Mark a field editable only when a person would correct it on this screen. Derived values are never editable.
- Tabs: one per prototype tab (or a sensible split if it has none). Each tab has purpose (one sentence, the question it answers), howToRead (terms, levels, sign conventions a reader could get wrong), contents, publishes (what the tab tells the assistant, totals first) and dataFrom (existing tool names, GraphQL queries or "new: <name>").
- Capabilities: every functional requirement the surface needs. status "exists" only when a registered tool or known query already does it (name it in tools); "extend" when one needs a change (say which); "new" when it must be built. kind is graphql, tool, db-function, skill, workflow or ui. Compliance, scoring plans and capacity must call compliance.evaluate_rule, compliance.deal_score_plans and compliance-capacity.ts, never copy them.
- Workflows: any agentic capability (research, drafting, matching, extraction, monitoring). Each is steps of kind agent (reads with read-only tools and proposes), human (review, ask for information) and fixed (apply approved changes, run a tool, send a message). An agent never writes directly.
- standards: for each standard id, a note saying exactly what this surface must do to meet it (which values get right-click inspect, which are inline-editable, how each tab publishes).
- uxNotes: where the prototype departs from the house design system (dense, tabular numerals, right-aligned figures, one accent, 1px borders, 8px radius, no shadows or gradients, direct chart labels, loading/empty/error states) and how to standardise it.
- artifacts: refined or additional HTML the build needs: at least a refined version of the prototype using host classes and data-attr="<ATTRIBUTE_CODE>" on every bound value; add others (an empty state, an edit dialog, a workflow review screen) only when needed. Keep each under 40KB, inline styles only, no external scripts.
- buildSteps: ordered steps with the files to create or change, for the placement the request names: record-tab is a tab on a record's surface or experience (catalog rows in supabase/seed, components in apps/web/components); sdk-surface is surfaces/<code>/ registered in apps/web/lib/surface-registry.ts; app-page is a page under apps/web/app. If placement is missing, pick one and say why in openQuestions. Records (attributes, surface catalog rows) go in supabase/seed, never a migration. A client surface lives in surfaces/<code>/ and uses only @tapestrai/surface-sdk.
- openQuestions: decisions only the admin can make.
- No code may name a client, rule or entity by its code; put differences in data.

Respond with JSON only:
{"summary":"","fields":[{"label":"","where":"","decision":"reuse|new|derived|ui","attributeCode":"","domainCode":"","dataType":"","editable":false,"note":""}],
"newAttributes":[{"code":"","name":"","domainCode":"","dataType":"","isTimeVarying":false,"listValues":[],"reason":""}],
"relationships":[""],
"tabs":[{"label":"","purpose":"","howToRead":"","contents":[""],"publishes":"","dataFrom":[""]}],
"capabilities":[{"title":"","status":"exists|extend|new","detail":"","tools":[""],"kind":""}],
"workflows":[{"name":"","trigger":"","outcome":"","steps":[{"kind":"agent|human|fixed","title":"","detail":"","tools":[""]}]}],
"standards":[{"id":"","note":""}],
"uxNotes":[""],
"artifacts":[{"title":"","purpose":"","html":""}],
"buildSteps":[{"title":"","detail":"","files":[""]}],
"openQuestions":[""]}`;

function readRequest(body: any): SurfaceRequest | string {
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 6000) : '';
  const html = typeof body?.html === 'string' ? body.html : '';
  if (!name) return 'Give the surface a name.';
  if (!description) return 'Describe what the surface is for.';
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

  const catalog = await loadPlatformCatalog(auth.supabase);
  const baseline = baselineBlueprint(surfaceRequest, catalog);
  const useModel = body?.useModel !== false;
  if (!useModel || !geminiApiKey) {
    if (useModel) baseline.warnings.push('No model key is configured, so this is the baseline draft without model refinement.');
    return NextResponse.json({ blueprint: baseline, usage: null });
  }

  const packed = JSON.stringify({
    request: { ...surfaceRequest, html: undefined },
    outline: baseline.outline,
    baseline: {
      fields: baseline.fields,
      matches: baseline.matches.map((match) => ({ label: match.label, verdict: match.verdict, candidates: match.candidates })),
      capabilities: baseline.capabilities,
    },
    standards: SURFACE_STANDARDS.map((standard) => ({ id: standard.id, title: standard.title, rule: standard.rule, howTo: standard.howTo })),
    catalog: catalogForModel(catalog, baseline),
  });
  const prototype = surfaceRequest.html.length > 120_000 ? `${surfaceRequest.html.slice(0, 120_000)}\n<!-- prototype truncated -->` : surfaceRequest.html;

  const clientId = await callerClientId(auth.supabase);
  try {
    const called = await invokeAgent({
      provider: 'gemini',
      model: MODEL,
      feature: 'surface-builder',
      activity: 'surface-builder.analyze',
      agent: 'surface-architect',
      userId: auth.userId,
      clientId,
      subject: { type: 'surface', id: surfaceRequest.name, label: surfaceRequest.name },
      metadata: { domainCode: surfaceRequest.domainCode, placement: surfaceRequest.placement, htmlBytes: surfaceRequest.html.length },
      body: {
        systemInstruction: { parts: [{ text: INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: packed }, { text: `PROTOTYPE HTML:\n${prototype}` }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 32768,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 4096 },
        },
      },
    });
    const text = geminiAnswerText(called.response);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const finish = (called.response as { candidates?: Array<{ finishReason?: string }> } | null)?.candidates?.[0]?.finishReason;
      baseline.warnings.push(finish === 'MAX_TOKENS'
        ? 'The model ran out of room before it finished; this is the baseline draft.'
        : 'The model reply could not be read; this is the baseline draft.');
      return NextResponse.json({ blueprint: baseline, usage: usageForClient([called.audit]) });
    }
    return NextResponse.json({ blueprint: mergeModelBlueprint(baseline, parsed, catalog), usage: usageForClient([called.audit]) });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : 'unknown error').slice(0, 180);
    baseline.warnings.push(`The model could not be reached (${detail}); this is the baseline draft.`);
    return NextResponse.json({ blueprint: baseline, usage: null });
  }
}
