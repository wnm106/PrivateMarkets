/**
 * The Surface Builder's output: a blueprint for building one surface.
 *
 * A baseline blueprint is built without a model from the prototype outline,
 * the catalog matches and the standards. The model then refines it. The model's
 * reply is coerced here, and any attribute code it names that is not in the
 * catalog is moved to "new attributes" so an invented code never reads as an
 * existing one.
 */
import { matchLabels, relatedTools, suggestCode, type CatalogTool, type LabelMatch, type PlatformCatalog } from './catalog';
import { prototypeLabels, readPrototype, type PrototypeOutline } from './prototype';
import { checkStandards, type StandardFinding } from './standards';

export interface SurfaceRequest {
  name: string;
  description: string;
  /** Entity type the surface is anchored on, when it shows one record. */
  domainCode?: string | null;
  /** Who uses it and what they decide. */
  audience?: string;
  /** Where it lives: a tab on a record, a client SDK surface, or an admin page. */
  placement?: 'record-tab' | 'sdk-surface' | 'app-page';
  html: string;
}

export interface FieldMapping {
  label: string;
  where?: string;
  /** reuse: an existing attribute. new: add an attribute. derived: computed from others. ui: a label with no data. */
  decision: 'reuse' | 'new' | 'derived' | 'ui';
  attributeCode?: string;
  domainCode?: string | null;
  dataType?: string;
  editable?: boolean;
  /** How a derived value is computed, or why the choice was made. */
  note?: string;
}

export interface NewAttribute {
  code: string;
  name: string;
  domainCode: string | null;
  dataType: string;
  isTimeVarying?: boolean;
  listValues?: string[];
  reason: string;
}

export interface TabPlan {
  label: string;
  purpose: string;
  howToRead?: string;
  /** The figures, tables and charts the tab shows. */
  contents: string[];
  /** What the tab publishes to the assistant. */
  publishes: string;
  /** Queries or tools the tab loads from. */
  dataFrom: string[];
}

export interface Capability {
  title: string;
  /** exists: a tool or query already does it. extend: an existing one needs a change. new: it must be built. */
  status: 'exists' | 'extend' | 'new';
  detail: string;
  tools: string[];
  /** Kind of work: graphql, tool, db-function, skill, ui. */
  kind: string;
}

export interface WorkflowPlan {
  name: string;
  trigger: string;
  steps: Array<{ kind: 'fixed' | 'agent' | 'human'; title: string; detail: string; tools?: string[] }>;
  outcome: string;
}

export interface ArtifactPlan {
  title: string;
  purpose: string;
  /** Refined or additional HTML for the surface, when the model wrote one. */
  html?: string;
}

export interface BuildStep {
  title: string;
  detail: string;
  files: string[];
}

export interface SurfaceBlueprint {
  request: Omit<SurfaceRequest, 'html'>;
  summary: string;
  outline: PrototypeOutline;
  matches: LabelMatch[];
  fields: FieldMapping[];
  newAttributes: NewAttribute[];
  relationships: string[];
  tabs: TabPlan[];
  capabilities: Capability[];
  workflows: WorkflowPlan[];
  standards: StandardFinding[];
  uxNotes: string[];
  artifacts: ArtifactPlan[];
  buildSteps: BuildStep[];
  openQuestions: string[];
  /** model: refined by the model. baseline: the deterministic draft only. */
  source: 'model' | 'baseline';
  generatedAt: string;
  warnings: string[];
}

const DERIVED_HINT = /\b(total|sum|avg|average|count|%\s?of|share|weight|change|delta|variance|growth|ratio|vs\.?|ytd|qtd|ttm|ltm)\b/i;

function placementFiles(request: Pick<SurfaceRequest, 'placement' | 'name'>): string[] {
  const code = suggestCode(request.name).toLowerCase().replace(/_/g, '-');
  if (request.placement === 'sdk-surface') return [`surfaces/${code}/src/manifest.ts`, `surfaces/${code}/src/index.tsx`, 'apps/web/lib/surface-registry.ts'];
  if (request.placement === 'record-tab') return ['supabase/seed (surface_definitions / record_experiences rows)', `apps/web/components/${code}/`];
  return [`apps/web/app/${code}/page.tsx`, `apps/web/components/${code}/`];
}

/** The draft a model refines, built from the prototype and catalog alone. */
export function baselineBlueprint(request: SurfaceRequest, catalog: PlatformCatalog): SurfaceBlueprint {
  const outline = readPrototype(request.html);
  const matches = matchLabels(prototypeLabels(outline), catalog, request.domainCode);
  const fields: FieldMapping[] = matches.map((match) => {
    const best = match.candidates[0];
    if (match.verdict !== 'none' && best) {
      return { label: match.label, where: match.where, decision: 'reuse', attributeCode: best.code, domainCode: best.domainCode, dataType: best.dataType, note: match.verdict === 'close' ? `Close match (${best.score}); confirm.` : undefined };
    }
    if (DERIVED_HINT.test(match.label)) {
      return { label: match.label, where: match.where, decision: 'derived', dataType: match.inferredType, note: 'Looks computed from other values; define it as a calculated attribute or data query.' };
    }
    return { label: match.label, where: match.where, decision: 'new', attributeCode: suggestCode(match.label), domainCode: request.domainCode || null, dataType: match.inferredType };
  });
  const newAttributes: NewAttribute[] = fields
    .filter((field) => field.decision === 'new')
    .map((field) => ({ code: field.attributeCode!, name: field.label, domainCode: field.domainCode ?? null, dataType: field.dataType || 'TEXT', reason: 'No existing attribute matches this label.' }));

  const tabLabels = outline.tabs.length > 0 ? outline.tabs : ['Overview'];
  const tabs: TabPlan[] = tabLabels.map((label) => {
    const here = fields.filter((field) => (field.where || '').toLowerCase() === label.toLowerCase());
    return {
      label,
      purpose: `What ${label.toLowerCase()} shows for ${request.name}. Refine.`,
      contents: (here.length ? here : fields.slice(0, 8)).map((field) => field.label).slice(0, 20),
      publishes: 'The figures and flags the tab shows, totals first, capped at 40 rows.',
      dataFrom: [],
    };
  });

  const text = `${request.name} ${request.description} ${outline.actions.join(' ')} ${outline.headings.join(' ')}`;
  const tools = relatedTools(text, catalog.tools, 10);
  const capabilities: Capability[] = [
    ...(tools.length ? [{ title: 'Reads available today', status: 'exists' as const, detail: 'Tools whose purpose overlaps the surface. Confirm each covers what the tab needs.', tools: tools.filter((tool) => tool.readOnly).map((tool) => tool.name), kind: 'tool' }] : []),
    ...outline.actions.slice(0, 12).map((action): Capability => ({ title: action, status: 'new', detail: 'An action in the prototype. Map it to an existing mutation or tool, or specify a new one.', tools: relatedTools(action, catalog.tools, 3).map((tool) => tool.name), kind: 'graphql' })),
  ];

  return {
    request: { name: request.name, description: request.description, domainCode: request.domainCode ?? null, audience: request.audience, placement: request.placement },
    summary: `${request.name}: ${outline.tabs.length} tabs, ${matches.length} labelled values (${matches.filter((match) => match.verdict !== 'none').length} matched to existing attributes), ${outline.tables.length} tables, ${outline.charts.length} charts, ${outline.actions.length} actions.`,
    outline,
    matches,
    fields,
    newAttributes,
    relationships: [],
    tabs,
    capabilities,
    workflows: [],
    standards: checkStandards(outline),
    uxNotes: [],
    artifacts: [],
    buildSteps: defaultBuildSteps(request, newAttributes.length, tabs.length),
    openQuestions: [],
    source: 'baseline',
    generatedAt: new Date().toISOString(),
    warnings: catalog.gaps.slice(),
  };
}

function defaultBuildSteps(request: SurfaceRequest, newCount: number, tabCount: number): BuildStep[] {
  const files = placementFiles(request);
  return [
    ...(newCount > 0 ? [{ title: 'Add the new attributes', detail: `Add ${newCount} attribute(s) as seed records (or with the Field skill). No migration unless a new table is needed.`, files: ['supabase/seed'] }] : []),
    { title: 'Load the data', detail: 'One query per tab group, with As Of and Knowledge dates. Reuse existing GraphQL and tools before adding any.', files: ['packages/graphql/src/schema/typeDefs.ts', 'packages/graphql/src/resolvers'] },
    { title: 'Build the surface', detail: `Build ${tabCount} tab(s) with host classes. Bind every attribute value with InspectValue; make editable values inline-editable through the golden write path.`, files },
    { title: 'Publish every tab', detail: 'usePublishTabs (or host.usePublishTabs) with label, purpose, howToRead and data built from the same variables the tab draws.', files: ['apps/web/lib/view-context.ts', 'docs/SURFACE_TABS.md'] },
    { title: 'Check', detail: 'npm run guard, npm run lint:surfaces, npm run test in apps/web (view-context.test.ts), then open the surface with real dates.', files: [] },
  ];
}

// ---------------------------------------------------------------------------
// The model's reply
// ---------------------------------------------------------------------------

function str(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : value == null ? '' : String(value).slice(0, max);
}

function list(value: unknown, max = 60): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function strings(value: unknown, max = 40): string[] {
  return list(value, max).map((item) => str(item, 400)).filter(Boolean);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Merge the model's refinement into the baseline. Arrays the model returns
 * replace the baseline's; ones it leaves out keep the baseline.
 */
export function mergeModelBlueprint(baseline: SurfaceBlueprint, raw: unknown, catalog: PlatformCatalog): SurfaceBlueprint {
  if (!raw || typeof raw !== 'object') return { ...baseline, warnings: [...baseline.warnings, 'The model returned no blueprint; this is the baseline draft.'] };
  const reply = raw as Record<string, unknown>;
  const known = new Map(catalog.attributes.map((attribute) => [attribute.code, attribute]));
  const knownTools = new Set(catalog.tools.map((tool) => tool.name));
  const warnings = [...baseline.warnings];

  let fields = baseline.fields;
  const movedToNew: NewAttribute[] = [];
  if (Array.isArray(reply.fields)) {
    fields = list(reply.fields, 200).map((item): FieldMapping => {
      const row = (item || {}) as Record<string, unknown>;
      const decision = pick(row.decision, ['reuse', 'new', 'derived', 'ui'] as const, 'new');
      const code = str(row.attributeCode, 80).toUpperCase() || undefined;
      const field: FieldMapping = {
        label: str(row.label, 120),
        where: str(row.where, 80) || undefined,
        decision,
        attributeCode: code,
        domainCode: str(row.domainCode, 60) || null,
        dataType: str(row.dataType, 30) || undefined,
        editable: row.editable === true,
        note: str(row.note, 400) || undefined,
      };
      if (decision === 'reuse') {
        const attribute = code ? known.get(code) : undefined;
        if (!attribute) {
          warnings.push(`"${field.label}": the model named ${code || 'no code'} as existing, but it is not in the catalog. Treated as a new attribute.`);
          field.decision = 'new';
          field.attributeCode = code || suggestCode(field.label);
          movedToNew.push({ code: field.attributeCode, name: field.label, domainCode: field.domainCode ?? null, dataType: field.dataType || 'TEXT', reason: 'Named as existing by the model but not found in the catalog.' });
        } else {
          field.domainCode = attribute.domainCode;
          field.dataType = attribute.dataType;
        }
      }
      return field;
    }).filter((field) => field.label);
  }

  const newAttributes = Array.isArray(reply.newAttributes)
    ? list(reply.newAttributes, 120).map((item): NewAttribute => {
      const row = (item || {}) as Record<string, unknown>;
      return {
        code: (str(row.code, 80) || suggestCode(str(row.name))).toUpperCase(),
        name: str(row.name, 120),
        domainCode: str(row.domainCode, 60) || baseline.request.domainCode || null,
        dataType: str(row.dataType, 30) || 'TEXT',
        isTimeVarying: row.isTimeVarying === true,
        listValues: strings(row.listValues, 30),
        reason: str(row.reason, 400),
      };
    }).filter((attribute) => attribute.name && !known.has(attribute.code))
    : baseline.newAttributes;
  for (const moved of movedToNew) if (!newAttributes.some((attribute) => attribute.code === moved.code)) newAttributes.push(moved);

  const toolsOf = (value: unknown) => {
    const names = strings(value, 20);
    for (const name of names) if (!knownTools.has(name)) warnings.push(`Tool ${name} is not registered; it is listed as work to build.`);
    return names;
  };

  const tabs = Array.isArray(reply.tabs)
    ? list(reply.tabs, 24).map((item): TabPlan => {
      const row = (item || {}) as Record<string, unknown>;
      return {
        label: str(row.label, 60),
        purpose: str(row.purpose, 400),
        howToRead: str(row.howToRead, 600) || undefined,
        contents: strings(row.contents, 40),
        publishes: str(row.publishes, 600),
        dataFrom: strings(row.dataFrom, 20),
      };
    }).filter((tab) => tab.label)
    : baseline.tabs;

  const capabilities = Array.isArray(reply.capabilities)
    ? list(reply.capabilities, 40).map((item): Capability => {
      const row = (item || {}) as Record<string, unknown>;
      const tools = toolsOf(row.tools);
      let status = pick(row.status, ['exists', 'extend', 'new'] as const, 'new');
      if (status === 'exists' && tools.length > 0 && tools.every((name) => !knownTools.has(name))) status = 'new';
      return { title: str(row.title, 160), status, detail: str(row.detail, 1200), tools, kind: str(row.kind, 30) || 'graphql' };
    }).filter((capability) => capability.title)
    : baseline.capabilities;

  const workflows = Array.isArray(reply.workflows)
    ? list(reply.workflows, 12).map((item): WorkflowPlan => {
      const row = (item || {}) as Record<string, unknown>;
      return {
        name: str(row.name, 120),
        trigger: str(row.trigger, 400),
        outcome: str(row.outcome, 600),
        steps: list(row.steps, 20).map((step) => {
          const s = (step || {}) as Record<string, unknown>;
          return { kind: pick(s.kind, ['fixed', 'agent', 'human'] as const, 'fixed'), title: str(s.title, 120), detail: str(s.detail, 600), tools: toolsOf(s.tools) };
        }).filter((step) => step.title),
      };
    }).filter((workflow) => workflow.name)
    : baseline.workflows;

  const artifacts = Array.isArray(reply.artifacts)
    ? list(reply.artifacts, 8).map((item): ArtifactPlan => {
      const row = (item || {}) as Record<string, unknown>;
      return { title: str(row.title, 120), purpose: str(row.purpose, 600), html: str(row.html, 120_000) || undefined };
    }).filter((artifact) => artifact.title)
    : baseline.artifacts;

  const buildSteps = Array.isArray(reply.buildSteps)
    ? list(reply.buildSteps, 30).map((item): BuildStep => {
      const row = (item || {}) as Record<string, unknown>;
      return { title: str(row.title, 160), detail: str(row.detail, 2000), files: strings(row.files, 20) };
    }).filter((step) => step.title)
    : baseline.buildSteps;

  // Standards: the model may add notes, but cannot drop one.
  const modelNotes = new Map<string, string>();
  for (const item of list(reply.standards, 40)) {
    const row = (item || {}) as Record<string, unknown>;
    const id = str(row.id, 60);
    if (id) modelNotes.set(id, str(row.note, 600));
  }
  const standards = baseline.standards.map((finding) => (modelNotes.get(finding.id) ? { ...finding, note: modelNotes.get(finding.id)! } : finding));

  return {
    ...baseline,
    summary: str(reply.summary, 2000) || baseline.summary,
    fields,
    newAttributes,
    relationships: Array.isArray(reply.relationships) ? strings(reply.relationships, 30) : baseline.relationships,
    tabs,
    capabilities,
    workflows,
    standards,
    uxNotes: Array.isArray(reply.uxNotes) ? strings(reply.uxNotes, 40) : baseline.uxNotes,
    artifacts,
    buildSteps,
    openQuestions: Array.isArray(reply.openQuestions) ? strings(reply.openQuestions, 30) : baseline.openQuestions,
    source: 'model',
    generatedAt: new Date().toISOString(),
    warnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function mdEscape(text: string | undefined | null): string {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

/** The blueprint as build instructions a developer or coding agent can follow. */
export function blueprintMarkdown(blueprint: SurfaceBlueprint): string {
  const lines: string[] = [];
  const { request } = blueprint;
  lines.push(`# Build instructions: ${request.name}`, '');
  lines.push(`> ${blueprint.summary}`, '');
  lines.push(`- **Purpose:** ${request.description}`);
  if (request.audience) lines.push(`- **Audience:** ${request.audience}`);
  if (request.domainCode) lines.push(`- **Anchored on entity type:** \`${request.domainCode}\``);
  if (request.placement) lines.push(`- **Placement:** ${request.placement}`);
  lines.push(`- **Generated:** ${blueprint.generatedAt} (${blueprint.source === 'model' ? 'model-refined' : 'baseline, no model'})`, '');
  lines.push('Read `AGENTS.md`, `docs/SURFACE_TABS.md` and `docs/GUARDRAILS.md` before starting. Do not finish until every standard below is met and `npm run guard` passes.', '');

  lines.push('## Tabs', '');
  for (const tab of blueprint.tabs) {
    lines.push(`### ${tab.label}`, '', `- **Purpose:** ${tab.purpose}`);
    if (tab.howToRead) lines.push(`- **How to read:** ${tab.howToRead}`);
    if (tab.contents.length) lines.push(`- **Shows:** ${tab.contents.join('; ')}`);
    if (tab.dataFrom.length) lines.push(`- **Loads from:** ${tab.dataFrom.map((item) => `\`${item}\``).join(', ')}`);
    lines.push(`- **Publishes to the assistant:** ${tab.publishes}`, '');
  }

  lines.push('## Entities and attributes', '', '| Label | Decision | Attribute | Entity type | Type | Editable | Note |', '|---|---|---|---|---|---|---|');
  for (const field of blueprint.fields) {
    lines.push(`| ${mdEscape(field.label)} | ${field.decision} | ${field.attributeCode ? `\`${field.attributeCode}\`` : ''} | ${field.domainCode || ''} | ${field.dataType || ''} | ${field.editable ? 'yes' : ''} | ${mdEscape(field.note)} |`);
  }
  lines.push('');
  if (blueprint.newAttributes.length) {
    lines.push('### New attributes to add (seed records, not migrations)', '', '| Code | Name | Entity type | Type | Time-varying | Why |', '|---|---|---|---|---|---|');
    for (const attribute of blueprint.newAttributes) {
      lines.push(`| \`${attribute.code}\` | ${mdEscape(attribute.name)} | ${attribute.domainCode || ''} | ${attribute.dataType}${attribute.listValues?.length ? ` (${attribute.listValues.join(', ')})` : ''} | ${attribute.isTimeVarying ? 'yes' : ''} | ${mdEscape(attribute.reason)} |`);
    }
    lines.push('');
  }
  if (blueprint.relationships.length) {
    lines.push('### Relationships', '', ...blueprint.relationships.map((item) => `- ${item}`), '');
  }

  lines.push('## Functional requirements and capabilities', '');
  for (const capability of blueprint.capabilities) {
    lines.push(`- **${capability.title}** \u2014 _${capability.status}_ (${capability.kind}). ${capability.detail}${capability.tools.length ? ` Tools: ${capability.tools.map((tool) => `\`${tool}\``).join(', ')}.` : ''}`);
  }
  lines.push('');

  if (blueprint.workflows.length) {
    lines.push('## Agentic workflows', '', 'Rule: an agent proposes, a person approves, a fixed step applies (`docs/WORKFLOWS.md`).', '');
    for (const workflow of blueprint.workflows) {
      lines.push(`### ${workflow.name}`, '', `- **Trigger:** ${workflow.trigger}`, `- **Outcome:** ${workflow.outcome}`, '');
      workflow.steps.forEach((step, index) => {
        lines.push(`${index + 1}. **[${step.kind}] ${step.title}** \u2014 ${step.detail}${step.tools?.length ? ` (${step.tools.map((tool) => `\`${tool}\``).join(', ')})` : ''}`);
      });
      lines.push('');
    }
  }

  lines.push('## Standards and guardrails', '');
  for (const finding of blueprint.standards) {
    lines.push(`- [${finding.level === 'meets' ? 'x' : ' '}] **${finding.title}**${finding.level === 'gap' ? ' \u26a0 gap' : ''} \u2014 ${finding.note}`);
  }
  lines.push('');
  if (blueprint.uxNotes.length) lines.push('## UX notes', '', ...blueprint.uxNotes.map((note) => `- ${note}`), '');

  lines.push('## Build steps', '');
  blueprint.buildSteps.forEach((step, index) => {
    lines.push(`${index + 1}. **${step.title}** \u2014 ${step.detail}${step.files.length ? `\n   Files: ${step.files.map((file) => `\`${file}\``).join(', ')}` : ''}`);
  });
  lines.push('');

  if (blueprint.artifacts.length) {
    lines.push('## HTML artifacts', '');
    for (const artifact of blueprint.artifacts) {
      lines.push(`### ${artifact.title}`, '', artifact.purpose, '');
      if (artifact.html) lines.push('```html', artifact.html, '```', '');
    }
  }
  if (blueprint.openQuestions.length) lines.push('## Open questions', '', ...blueprint.openQuestions.map((question) => `- ${question}`), '');
  if (blueprint.warnings.length) lines.push('## Warnings', '', ...blueprint.warnings.map((warning) => `- ${warning}`), '');
  return lines.join('\n');
}

/** The catalog trimmed to what the model needs: codes and names, attributes near the surface first. */
export function catalogForModel(catalog: PlatformCatalog, blueprint: SurfaceBlueprint, maxAttributes = 400): Record<string, unknown> {
  const domain = blueprint.request.domainCode;
  const matched = new Set(blueprint.matches.flatMap((match) => match.candidates.map((candidate) => candidate.code)));
  const ranked = [...catalog.attributes].sort((a, b) => {
    const rank = (attribute: typeof a) => (matched.has(attribute.code) ? 0 : attribute.domainCode === domain ? 1 : 2);
    return rank(a) - rank(b) || a.code.localeCompare(b.code);
  }).slice(0, maxAttributes);
  const compactTool = (tool: CatalogTool) => ({ name: tool.name, readOnly: tool.readOnly, description: tool.description.slice(0, 220) });
  return {
    domains: catalog.domains.map((item) => ({ code: item.code, name: item.name, parent: item.parentCode || undefined })),
    attributes: ranked.map((item) => ({ code: item.code, name: item.name, type: item.dataType, domain: item.domainCode, derived: item.isDerived || undefined, timeVarying: item.isTimeVarying || undefined })),
    attributesOmitted: Math.max(0, catalog.attributes.length - ranked.length),
    relationships: catalog.relationships.slice(0, 120),
    tools: catalog.tools.map(compactTool),
    skills: catalog.skills,
    surfaces: catalog.surfaces,
  };
}
