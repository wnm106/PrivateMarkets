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
import { prototypeLabels, readPrototype, readPrototypeWithViews, type PrototypeOutline, type RenderedView } from './prototype';
import { checkStandards, standardById, standardHowTo, type StandardFinding } from './standards';

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
  /** The captured view this redesigns, when it is a house-design redesign of one. */
  view?: string;
  /** What the designer mapped, and what the kit could not express. */
  notes?: string[];
  /** Whether the redesign was rendered and compared with the original. */
  checked?: boolean;
}

export interface BuildStep {
  title: string;
  detail: string;
  files: string[];
}

/** An entity type the surface reads or adds: a kind of record with its own identity. */
export interface EntityTypePlan {
  code: string;
  name: string;
  /** reuse: in the catalog today. new: add it as a seed record. */
  status: 'reuse' | 'new';
  parentCode?: string | null;
  purpose: string;
  /** What makes one record, e.g. "one per fund, hierarchy and node". */
  identity?: string;
  /** Attribute codes it carries (existing or in newAttributes). */
  attributes: string[];
  reason?: string;
}

/** A relationship type between two entity types. */
export interface RelationshipPlan {
  code: string;
  name: string;
  status: 'reuse' | 'new';
  fromDomain?: string | null;
  toDomain?: string | null;
  cardinality?: string;
  reason?: string;
}

/** A classification tree, such as Category > Asset Class > Strategy. */
export interface TaxonomyPlan {
  name: string;
  levels: string[];
  /** How the values and their parent links are stored: a reference list, an entity type, or one that exists. */
  storage: string;
  source?: string;
  reason?: string;
}

/** How a rule or limit in the prototype maps to the compliance engine. */
export interface CompliancePlan {
  prototypeRule: string;
  /** rule: a compliance.rules row. threshold: a fund limit in compliance.rule_thresholds. scope: compliance.rule_scope_assignments. evaluator: compliance.evaluate_rule must learn something. */
  mapsTo: 'rule' | 'threshold' | 'scope' | 'evaluator' | 'other';
  detail: string;
  tables: string[];
}

/** A calculation the surface shows, and the one place it runs. */
export interface ComputationPlan {
  name: string;
  inputs: string[];
  output: string;
  /** The function or module that computes it, e.g. compliance.evaluate_rule or a new db function. */
  runsIn: string;
  status: 'exists' | 'extend' | 'new';
  detail?: string;
}

/** A modelling question put to the admin, and the answer the blueprint follows. */
export interface DesignDecision {
  question: string;
  answer: string;
  /** admin: answered by the admin. assumed: the admin skipped it and the model's recommendation was used. */
  source: 'admin' | 'assumed';
}

export interface DesignQuestion {
  id: string;
  question: string;
  /** Why the answer changes the build. */
  why: string;
  options: string[];
  recommended?: string;
}

/** The model's first read of the prototype, before it writes the blueprint. */
export interface PrototypeUnderstanding {
  summary: string;
  views: Array<{ name: string; shows: string }>;
  concepts: Array<{ name: string; meaning: string; model: string; detail: string }>;
  computations: Array<{ name: string; detail: string }>;
  assumptions: string[];
  questions: DesignQuestion[];
}

export interface SurfaceBlueprint {
  request: Omit<SurfaceRequest, 'html'>;
  summary: string;
  outline: PrototypeOutline;
  matches: LabelMatch[];
  fields: FieldMapping[];
  newAttributes: NewAttribute[];
  /** Free-text notes on relationships; the structured list is relationshipTypes. */
  relationships: string[];
  entityTypes: EntityTypePlan[];
  relationshipTypes: RelationshipPlan[];
  taxonomies: TaxonomyPlan[];
  compliance: CompliancePlan[];
  computations: ComputationPlan[];
  decisions: DesignDecision[];
  understanding?: PrototypeUnderstanding;
  /** The model that refined the blueprint, when one did. */
  model?: string;
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

/**
 * The surface's code: its folder under surfaces/, its route and its manifest code. One
 * derivation, used by the blueprint, the build steps and the brief, so they cannot disagree.
 */
export function surfaceCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'surface';
}

function placementFiles(request: Pick<SurfaceRequest, 'placement' | 'name'>): string[] {
  const code = surfaceCode(request.name);
  if (request.placement === 'sdk-surface') return [`surfaces/${code}/src/manifest.ts`, `surfaces/${code}/src/index.tsx`, 'apps/web/lib/surface-registry.ts'];
  if (request.placement === 'record-tab') return ['supabase/seed (surface_definitions / record_experiences rows)', `apps/web/components/${code}/`];
  return [`apps/web/app/${code}/page.tsx`, `apps/web/components/${code}/`];
}

/** The draft a model refines, built from the prototype and catalog alone. */
export function baselineBlueprint(request: SurfaceRequest, catalog: PlatformCatalog, views: RenderedView[] = []): SurfaceBlueprint {
  const outline = views.length ? readPrototypeWithViews(request.html, views) : readPrototype(request.html);
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
    entityTypes: request.domainCode ? [{ code: request.domainCode, name: catalog.domains.find((domain) => domain.code === request.domainCode)?.name || request.domainCode, status: 'reuse', purpose: 'The record the surface is anchored on.', attributes: [] }] : [],
    relationshipTypes: [],
    taxonomies: [],
    compliance: [],
    computations: [],
    decisions: [],
    tabs,
    capabilities,
    workflows: [],
    standards: checkStandards(outline, request.placement),
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
    { title: 'Build the surface', detail: request.placement === 'sdk-surface'
      ? `Build ${tabCount} tab(s) with host classes and one scoped stylesheet. Bind every value through host.inspectAttribute, cell by cell in every grid; give each derived figure a "how it is worked out" panel; make editable values edit in place through host.mutate and the manual override mutation.`
      : `Build ${tabCount} tab(s) with host classes. Bind every attribute value with InspectValue, cell by cell in every grid; give each derived figure a "how it is worked out" panel; make editable values inline-editable through the golden write path.`, files },
    { title: 'Publish every tab', detail: 'usePublishTabs (or host.usePublishTabs) with label, purpose, howToRead and data built from the same variables the tab draws. Publish the open record as the view focus.', files: ['apps/web/lib/view-context.ts', 'docs/SURFACE_TABS.md'] },
    { title: 'Measure it in the browser', detail: 'npm run guard, npm run lint:surfaces and the web tests. Then open the surface with real records, run acceptance.js on every tab at 1440x900 and 1920x1080, right-click one value of each kind, and hand back the tables. A failing line means not done.', files: [] },
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

  // The model sometimes invents its own folder name. A client surface has one code.
  if (baseline.request.placement === 'sdk-surface') {
    const code = surfaceCode(baseline.request.name);
    // Only the files a step writes are corrected: its prose may name another surface to copy from.
    const fix = (path: string) => path.replace(/^surfaces\/[a-z0-9][a-z0-9-]*\//, (found) => {
      if (found === `surfaces/${code}/`) return found;
      warnings.push(`The model named the folder ${found}; the surface's code is "${code}", so the build steps say surfaces/${code}/.`);
      return `surfaces/${code}/`;
    });
    for (const step of buildSteps) step.files = step.files.map(fix);
  }

  // The entity model. A type or relationship named as existing must be in the
  // catalog; otherwise it is new, so an invented code never reads as real.
  const knownDomains = new Set(catalog.domains.map((domain) => domain.code));
  const knownRelationships = new Set(catalog.relationships.map((relationship) => relationship.code));
  const entityTypes = Array.isArray(reply.entityTypes)
    ? list(reply.entityTypes, 40).map((item): EntityTypePlan => {
      const row = (item || {}) as Record<string, unknown>;
      const code = (str(row.code, 80) || suggestCode(str(row.name))).toUpperCase();
      let status = pick(row.status, ['reuse', 'new'] as const, 'new');
      if (status === 'reuse' && !knownDomains.has(code)) {
        warnings.push(`Entity type ${code} was named as existing, but it is not in the catalog. Treated as new.`);
        status = 'new';
      }
      if (status === 'new' && knownDomains.has(code)) status = 'reuse';
      return {
        code,
        name: str(row.name, 120) || code,
        status,
        parentCode: str(row.parentCode, 80).toUpperCase() || null,
        purpose: str(row.purpose, 600),
        identity: str(row.identity, 300) || undefined,
        attributes: strings(row.attributes, 60).map((value) => value.toUpperCase()),
        reason: str(row.reason, 600) || undefined,
      };
    }).filter((plan) => plan.code)
    : baseline.entityTypes;
  const plannedDomains = new Set([...knownDomains, ...entityTypes.map((plan) => plan.code)]);

  const relationshipTypes = Array.isArray(reply.relationshipTypes)
    ? list(reply.relationshipTypes, 40).map((item): RelationshipPlan => {
      const row = (item || {}) as Record<string, unknown>;
      const code = (str(row.code, 80) || suggestCode(str(row.name))).toUpperCase();
      let status = pick(row.status, ['reuse', 'new'] as const, 'new');
      if (status === 'reuse' && !knownRelationships.has(code)) {
        warnings.push(`Relationship ${code} was named as existing, but it is not in the catalog. Treated as new.`);
        status = 'new';
      }
      if (status === 'new' && knownRelationships.has(code)) status = 'reuse';
      return {
        code,
        name: str(row.name, 120) || code,
        status,
        fromDomain: str(row.fromDomain, 80).toUpperCase() || null,
        toDomain: str(row.toDomain, 80).toUpperCase() || null,
        cardinality: str(row.cardinality, 60) || undefined,
        reason: str(row.reason, 600) || undefined,
      };
    }).filter((plan) => plan.code)
    : baseline.relationshipTypes;

  const taxonomies = Array.isArray(reply.taxonomies)
    ? list(reply.taxonomies, 20).map((item): TaxonomyPlan => {
      const row = (item || {}) as Record<string, unknown>;
      return { name: str(row.name, 120), levels: strings(row.levels, 12), storage: str(row.storage, 400), source: str(row.source, 400) || undefined, reason: str(row.reason, 600) || undefined };
    }).filter((plan) => plan.name)
    : baseline.taxonomies;

  const compliance = Array.isArray(reply.compliance)
    ? list(reply.compliance, 60).map((item): CompliancePlan => {
      const row = (item || {}) as Record<string, unknown>;
      return {
        prototypeRule: str(row.prototypeRule, 200),
        mapsTo: pick(row.mapsTo, ['rule', 'threshold', 'scope', 'evaluator', 'other'] as const, 'other'),
        detail: str(row.detail, 1200),
        tables: strings(row.tables, 10),
      };
    }).filter((plan) => plan.prototypeRule)
    : baseline.compliance;

  const computations = Array.isArray(reply.computations)
    ? list(reply.computations, 40).map((item): ComputationPlan => {
      const row = (item || {}) as Record<string, unknown>;
      return {
        name: str(row.name, 160),
        inputs: strings(row.inputs, 20),
        output: str(row.output, 300),
        runsIn: str(row.runsIn, 200),
        status: pick(row.status, ['exists', 'extend', 'new'] as const, 'new'),
        detail: str(row.detail, 1200) || undefined,
      };
    }).filter((plan) => plan.name)
    : baseline.computations;
  for (const computation of computations) {
    if (!computation.runsIn) warnings.push(`"${computation.name}" does not say where it runs. Every calculation has one home (docs/GUARDRAILS.md, rule 2).`);
  }
  const derivedFields = fields.filter((field) => field.decision === 'derived');
  if (derivedFields.length > 0 && computations.length === 0) {
    warnings.push(`${derivedFields.length} value(s) are derived (${derivedFields.slice(0, 5).map((field) => field.label).join(', ')}${derivedFields.length > 5 ? ', ...' : ''}) but the blueprint names no calculation and no home for them. Decide where each runs before the build, or the builder will work them out inside the surface.`);
  }

  // A JSON attribute that holds records hides them from lineage, history,
  // inline edit and the compliance evaluator. Say so wherever one is proposed.
  for (const attribute of newAttributes) {
    if (DOCUMENT_TYPES.test(attribute.dataType)) {
      warnings.push(`${attribute.code} is a ${attribute.dataType.toUpperCase()} attribute, so this blueprint cannot be handed to a builder. Model what it holds as an entity type: one record per intersection, one attribute per value, so each value has its own history, sources and right-click inspect.`);
    }
    if (attribute.domainCode && !plannedDomains.has(attribute.domainCode)) {
      warnings.push(`${attribute.code} is placed on entity type ${attribute.domainCode}, which is neither in the catalog nor in the planned entity types.`);
    }
  }

  // Standards: the model may add notes, but cannot drop one.
  const modelNotes = new Map<string, string>();
  for (const item of list(reply.standards, 40)) {
    const row = (item || {}) as Record<string, unknown>;
    const id = str(row.id, 60);
    if (id) modelNotes.set(id, str(row.note, 600));
  }
  const sdkSurface = baseline.request.placement === 'sdk-surface';
  const standards = baseline.standards.map((finding) => {
    const note = modelNotes.get(finding.id);
    if (!note) return finding;
    // An SDK surface cannot import the app, so a note that tells it to is wrong whatever else it says.
    if (sdkSurface && /\b(InspectValue|attrBind|useInspectBind|AttributeCellEditor|usePublishViewContext|entityViewFocus|surface-links)\b/.test(note)) {
      warnings.push(`The model's note on "${finding.title}" names app-only code a client surface may not import; the house rule is used instead.`);
      return finding;
    }
    return { ...finding, note };
  });

  return {
    ...baseline,
    summary: str(reply.summary, 2000) || baseline.summary,
    fields,
    newAttributes,
    relationships: Array.isArray(reply.relationships) ? strings(reply.relationships, 30) : baseline.relationships,
    entityTypes,
    relationshipTypes,
    taxonomies,
    compliance,
    computations,
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

const DOCUMENT_TYPES = /^(JSON|JSONB|OBJECT|MAP|ARRAY)$/i;

/**
 * Why a blueprint may not be handed to a builder. A builder follows the blueprint literally,
 * so a wrong data model in it becomes a wrong data model in the database.
 *
 *  - A JSON attribute. Targets, bands, limits, schedules and overrides are records: one entity
 *    per intersection (a fund at a level, a fund in a year) with one attribute per value, so each
 *    value has its own sources, history and right-click. A document attribute hides all of that.
 *  - A model review that predates the entity model: it never asked how records should be stored.
 */
export function exportBlockers(blueprint: SurfaceBlueprint): string[] {
  const out: string[] = [];
  const documents = new Map<string, string>();
  for (const attribute of blueprint.newAttributes) if (DOCUMENT_TYPES.test(attribute.dataType)) documents.set(attribute.code, attribute.dataType.toUpperCase());
  for (const field of blueprint.fields) if (field.decision === 'new' && field.attributeCode && DOCUMENT_TYPES.test(field.dataType || '')) documents.set(field.attributeCode, (field.dataType || '').toUpperCase());
  for (const [code, type] of documents) {
    out.push(`${code} is a ${type} attribute. Values a person edits, a rule reads or anyone right-clicks are never kept in a document: model one record per intersection (for example a fund at one level of one hierarchy) as an entity type, with one attribute per value (each minimum, target and maximum). Review the prototype again and answer the modelling questions.`);
  }
  if (blueprint.source === 'model' && !blueprint.understanding && (blueprint.entityTypes ?? []).length === 0) {
    out.push('This blueprint was reviewed by an earlier version of the builder, before it modelled records as entity types and asked modelling questions. Review the prototype again before handing it to a builder.');
  }
  return out;
}

/** A blueprint saved before a section existed, with that section empty, so screens and exports can read it. */
export function normalizeBlueprint(blueprint: SurfaceBlueprint): SurfaceBlueprint {
  return {
    ...blueprint,
    entityTypes: blueprint.entityTypes ?? [],
    relationshipTypes: blueprint.relationshipTypes ?? [],
    taxonomies: blueprint.taxonomies ?? [],
    compliance: blueprint.compliance ?? [],
    computations: blueprint.computations ?? [],
    decisions: blueprint.decisions ?? [],
  };
}

/** The model's first read, coerced. Questions keep a stable id so answers can refer to them. */
export function readUnderstanding(raw: unknown): PrototypeUnderstanding {
  const reply = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rows = (value: unknown, max: number) => list(value, max).map((item) => (item || {}) as Record<string, unknown>);
  return {
    summary: str(reply.summary, 3000),
    views: rows(reply.views, 30).map((row) => ({ name: str(row.name, 120), shows: str(row.shows, 800) })).filter((view) => view.name),
    concepts: rows(reply.concepts, 40).map((row) => ({ name: str(row.name, 120), meaning: str(row.meaning, 600), model: str(row.model, 60), detail: str(row.detail, 800) })).filter((concept) => concept.name),
    computations: rows(reply.computations, 30).map((row) => ({ name: str(row.name, 160), detail: str(row.detail, 800) })).filter((computation) => computation.name),
    assumptions: strings(reply.assumptions, 30),
    questions: rows(reply.questions, 10).map((row, index) => ({
      id: str(row.id, 20) || `q${index + 1}`,
      question: str(row.question, 400),
      why: str(row.why, 600),
      options: strings(row.options, 6),
      recommended: str(row.recommended, 400) || undefined,
    })).filter((question) => question.question),
  };
}

/**
 * The decisions the blueprint follows: the admin's answers, and for each
 * question left blank, the model's recommendation, marked as assumed.
 */
export function decisionsFrom(understanding: PrototypeUnderstanding | undefined, answers: Record<string, string>): DesignDecision[] {
  if (!understanding) return [];
  return understanding.questions.map((question) => {
    const answer = (answers[question.id] || '').trim();
    return answer
      ? { question: question.question, answer: answer.slice(0, 1000), source: 'admin' as const }
      : { question: question.question, answer: question.recommended || 'No answer; the model chooses and says why.', source: 'assumed' as const };
  });
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
  lines.push(`- **Generated:** ${blueprint.generatedAt} (${blueprint.source === 'model' ? `model-refined${blueprint.model ? ` by ${blueprint.model}` : ''}` : 'baseline, no model'})`);
  if (blueprint.outline.views?.length) lines.push(`- **Views reviewed:** ${blueprint.outline.views.join('; ')}`);
  lines.push('');
  const blockers = exportBlockers(blueprint);
  if (blockers.length) {
    lines.push('## Do not build from this blueprint', '', 'Its data model is not fit to build. Fix it in the Surface Builder first.', '', ...blockers.map((line) => `- ${line}`), '');
  }
  lines.push('Read `AGENTS.md`, `docs/SURFACE_TABS.md`, `docs/GUARDRAILS.md` and `surfaces/README.md` before starting. Do not finish until every standard below is met, measured in the browser, and `npm run guard` passes.', '');

  const assumed = blueprint.decisions.filter((decision) => decision.source === 'assumed');
  if (blueprint.openQuestions.length || assumed.length) {
    lines.push('## Before you start: ask', '', 'Put these to the person, in one message, before you build the part each affects. Do not pick an answer yourself.', '');
    for (const question of blueprint.openQuestions) lines.push(`- ${question}`);
    for (const decision of assumed) lines.push(`- Assumed, not confirmed: ${decision.question} The blueprint follows "${decision.answer}". Confirm it.`);
    lines.push('');
  }

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

  if (blueprint.decisions.length) {
    lines.push('## Design decisions', '', '| Question | Answer | From |', '|---|---|---|');
    for (const decision of blueprint.decisions) lines.push(`| ${mdEscape(decision.question)} | ${mdEscape(decision.answer)} | ${decision.source === 'admin' ? 'admin' : 'assumed (model recommendation)'} |`);
    lines.push('');
  }
  if (blueprint.entityTypes.length) {
    lines.push('## Entity model', '', '| Entity type | Status | One record is | Attributes | Purpose |', '|---|---|---|---|---|');
    for (const plan of blueprint.entityTypes) {
      lines.push(`| \`${plan.code}\` ${mdEscape(plan.name)}${plan.parentCode ? ` (under \`${plan.parentCode}\`)` : ''} | ${plan.status} | ${mdEscape(plan.identity)} | ${plan.attributes.map((code) => `\`${code}\``).join(', ')} | ${mdEscape(plan.purpose)}${plan.reason ? ` ${mdEscape(plan.reason)}` : ''} |`);
    }
    lines.push('');
  }
  if (blueprint.relationshipTypes.length) {
    lines.push('### Relationship types', '', '| Code | Status | From | To | Cardinality | Why |', '|---|---|---|---|---|---|');
    for (const plan of blueprint.relationshipTypes) lines.push(`| \`${plan.code}\` | ${plan.status} | ${plan.fromDomain || ''} | ${plan.toDomain || ''} | ${mdEscape(plan.cardinality)} | ${mdEscape(plan.reason)} |`);
    lines.push('');
  }
  if (blueprint.taxonomies.length) {
    lines.push('### Taxonomies', '');
    for (const plan of blueprint.taxonomies) lines.push(`- **${plan.name}** (${plan.levels.join(' \u203a ')}): ${plan.storage}${plan.source ? ` Source: ${plan.source}.` : ''}${plan.reason ? ` ${plan.reason}` : ''}`);
    lines.push('');
  }
  if (blueprint.compliance.length) {
    lines.push('## Compliance mapping', '', 'Rules are interpreted by `compliance.evaluate_rule`; fund limits live in `compliance.rule_thresholds`; which funds a rule covers is `compliance.rule_scope_assignments`.', '', '| Prototype rule | Maps to | Detail | Tables |', '|---|---|---|---|');
    for (const plan of blueprint.compliance) lines.push(`| ${mdEscape(plan.prototypeRule)} | ${plan.mapsTo} | ${mdEscape(plan.detail)} | ${plan.tables.map((table) => `\`${table}\``).join(', ')} |`);
    lines.push('');
  }
  if (blueprint.computations.length) {
    lines.push('## Calculations and where each runs', '', 'Each calculation has one home; the surface calls it and does not copy it (`docs/GUARDRAILS.md`, rule 2).', '', '| Calculation | Inputs | Output | Runs in | Status | Detail |', '|---|---|---|---|---|---|');
    for (const plan of blueprint.computations) lines.push(`| ${mdEscape(plan.name)} | ${mdEscape(plan.inputs.join(', '))} | ${mdEscape(plan.output)} | \`${mdEscape(plan.runsIn)}\` | ${plan.status} | ${mdEscape(plan.detail)} |`);
    lines.push('');
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

  lines.push('## Standards and guardrails', '', 'Each standard gives the house rule, how to meet it where this surface is built, what to measure, and what this surface in particular must do. The rule is the requirement; the last line adds to it and never replaces it. Tick a box only after you have measured it.', '');
  for (const finding of blueprint.standards) {
    const standard = standardById(finding.id);
    lines.push(`### [ ] ${finding.title}${finding.level === 'gap' ? ' \u26a0 the prototype breaks this' : ''}`, '');
    if (standard) {
      lines.push(`- **Rule:** ${standard.rule}`);
      lines.push(`- **How:** ${standardHowTo(standard, request.placement)}`);
      for (const check of standard.accept) lines.push(`- **Accept:** ${check}`);
      if (finding.note && finding.note !== standard.rule) lines.push(`- **For this surface:** ${finding.note}`);
    } else {
      lines.push(`- ${finding.note}`);
    }
    lines.push('');
  }
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
    relationships: catalog.relationships.slice(0, 300),
    complianceRules: (catalog.complianceRules || []).slice(0, 300),
    referenceLists: (catalog.referenceLists || []).slice(0, 300),
    tools: catalog.tools.map(compactTool),
    skills: catalog.skills,
    surfaces: catalog.surfaces,
  };
}
