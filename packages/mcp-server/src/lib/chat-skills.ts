/**
 * Guided chat skills.
 *
 * A skill is an answer ledger plus phase gates. The model may propose slot
 * updates; the route decides whether a draft or a write is allowed. The ledger
 * is stored on the conversation so a later prompt refines one answer instead of
 * restarting the interview. Reference artifacts are injected on the phases that
 * produce output, so each run follows the same structure.
 */
import { DASHBOARD_SHELL, ENTITY_SPEC, NARRATIVE_BLOCKS, type SkillArtifact } from './skill-artifacts';

export type SkillId = 'design-dashboard' | 'design-narrative' | 'create-entity';
export type SkillPhase = 'guided' | 'spec' | 'build' | 'apply';
export type SlotStatus = 'empty' | 'stated' | 'ambiguous' | 'resolved' | 'confirmed';

export interface SlotCandidate {
  id: string;
  label: string;
  why: string;
}

export interface SlotDef {
  id: string;
  label: string;
  prompt: string;
  clarity: string;
  required: boolean;
  /** Confirmed only after the user accepts it. A single tool match stays resolved. */
  identity?: boolean;
  /** Cleared back to stated when this slot's value changes. */
  dependents?: string[];
}

export interface SkillDef {
  id: SkillId;
  name: string;
  /** Tool profile to use while the skill is active. */
  toolContext: 'report-designer' | 'entity-admin';
  intro: string;
  placeholder: string;
  /** Shown in Admin → Skills. How a person starts this skill. */
  startsWhen: string;
  /** Each inner list is satisfied by any one of those tool names. */
  discovery: string[][];
  /** Required before a dashboard or narrative proposal may be emitted. */
  previewTools: string[];
  /** Hidden until phase is apply. */
  writeTools: string[];
  /** Never offered by this skill. */
  denyTools: string[];
  slots: SlotDef[];
  prefix: string;
  /** Sample outputs. The body is included only in the artifact's phases. */
  artifacts: SkillArtifact[];
}

export interface SlotValue {
  status: SlotStatus;
  value?: string;
  assumption?: string;
  candidates?: SlotCandidate[];
}

export interface SkillState {
  skillId: SkillId;
  slots: Record<string, SlotValue>;
  discoveries: string[];
}

export interface SkillView {
  id: SkillId;
  name: string;
  phase: SkillPhase;
  phaseLabel: string;
  decidedCount: number;
  requiredCount: number;
  decided: Array<{ label: string; value: string }>;
  open?: { id: string; label: string; status: SlotStatus; prompt: string };
}

const PHASE_LABEL: Record<SkillPhase, string> = {
  guided: 'A few decisions first',
  spec: 'Ready for your confirmation',
  build: 'Checking the data',
  apply: 'Ready to apply',
};

const DESIGN_SYSTEM = `You are a senior product designer working inside tapestr.ai.

<design_system>
- Typography: system UI font only (the sandbox cannot load fonts). Tabular numerals for every figure. Scale: 12/14/16/20/28px. At most two weights in one view.
- Color: one accent, used only for primary actions and the single figure that must be seen first. Neutral grays for everything else. Light background.
- Spacing: 4px grid. Cards use 16-24px padding and 16px gaps.
- Surfaces: 1px borders at low contrast, 8px radius, no shadows.
- Data viz: muted categorical colors, direct labels, light gridlines, no chart junk. Use tapestr.charts (bar, line, donut). Record-level browsing is a query with "grid": true, rendered by the host, not drawn in the HTML.
</design_system>

<avoid>
Gradients on backgrounds, emoji as icons, more than one accent color, centered text in data tables,
legends when direct labels fit, decorative animation, generic placeholder names like "Item 1",
five identical KPI cards, rainbow charts, invented attribute or relationship codes.
</avoid>

<point_of_view>
Dense and editorial, like a Bloomberg terminal crossed with Linear. The reader is a portfolio manager scanning for exceptions. Density, tabular numerals, right-aligned figures, and restrained color are what read as credible.
</point_of_view>

<stack>
The HTML is a fragment in a sandboxed iframe with no network. Inline style and script only. Read data from tapestr.onData. Format with tapestr.fmt. Draw charts with tapestr.charts. Escape text with tapestr.esc. Do not load Chart.js, fonts, images, or stylesheets. Aggregates for KPIs and charts. Never pull thousands of rows into the page.
</stack>

<example>
Match this density throughout:
<div class="kpi"><span class="kpi-label">Covenant breaches</span><span class="kpi-value">3</span><span class="kpi-note">of 42 positions</span></div>
.kpi { border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 20px; }
.kpi-label { font-size: 12px; color: #71717a; }
.kpi-value { display: block; font-size: 28px; font-variant-numeric: tabular-nums; font-weight: 600; }
.kpi-note { font-size: 12px; color: #71717a; }
</example>`;

const GUIDED = `You are a guided assistant. Fill the answer ledger. Do not design or write ahead of it.

Every reply, in this order:
1. One sentence that restates what you just understood.
2. One line naming the decided slots and the single open slot.
3. Exactly one question: the earliest open required slot. If the user asked a side question, answer it in one or two sentences, then ask that slot.
4. A fenced block tagged skill, containing only JSON. The user does not see this block.

\`\`\`skill
{"updates":[{"id":"slot-id","status":"stated|resolved|confirmed|ambiguous|empty","value":"concrete answer","assumption":"optional one sentence","candidates":[{"id":"CODE","label":"Business name","why":"what distinguishes it"}]}]}
\`\`\`

Status rules:
- stated: the user said something that fails the clarity test. Restate your interpretation. Do not move on.
- resolved: one concrete value, or exactly one tool match. Put the match in assumption and say it in the sentence.
- ambiguous: two or more real matches. Stop. List the candidates with the fact that distinguishes them. Do not pick, merge, or invent a third code.
- confirmed: the user explicitly accepted this value. Identity slots stay resolved until they do.
- empty: not addressed.

A short "yes" confirms the spec only. It does not invent the other answers. When the user corrects one answer, update that slot and leave the rest. Codes come from tools. Zero matches: say so, name the closest real codes, and ask.`;

const DASHBOARD_SLOTS: SlotDef[] = [
  {
    id: 'anchor',
    label: 'Anchor',
    prompt: 'Which entity type is this dashboard about?',
    clarity: 'A real domain code from list or template metadata, not a loose noun.',
    required: true,
    identity: true,
    dependents: ['measures', 'sample', 'filters', 'specAccepted'],
  },
  {
    id: 'audience',
    label: 'Audience',
    prompt: 'Who opens this, and in what role?',
    clarity: 'A role. "Portfolio manager" passes. "The team" does not.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'decision',
    label: 'Decision',
    prompt: 'What decision does this support, and when do they make it?',
    clarity: 'An action plus a moment. "Scan for covenant breaches each morning" passes. "See the fund" does not.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'twoSecond',
    label: 'Two-second read',
    prompt: 'What single figure or exception must be obvious immediately?',
    clarity: 'One measure, not a row of peer KPIs.',
    required: true,
    dependents: ['measures', 'specAccepted'],
  },
  {
    id: 'drillDown',
    label: 'Drill-down',
    prompt: 'What should appear only after that first figure: a grid, a related entity, or a trend?',
    clarity: 'A concrete next layer, or an explicit "the first screen is the whole job".',
    required: false,
    dependents: ['specAccepted'],
  },
  {
    id: 'measures',
    label: 'Measures',
    prompt: 'Which attribute or aggregation should each number use?',
    clarity: 'Every metric tied to one attribute code or aggregation the tools returned.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'sample',
    label: 'Sample entity',
    prompt: 'Which real entity should I preview the queries against?',
    clarity: 'One entity id or code from find_sample_entities, or one the user names.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'filters',
    label: 'Filters',
    prompt: 'Which filter inputs do you want, or should there be none beyond the as-of date?',
    clarity: 'Named inputs, or an explicit "no filters".',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'I have enough to build this. Should I go ahead?',
    clarity: 'The user explicitly accepts the brief.',
    required: true,
    identity: true,
  },
];

const NARRATIVE_SLOTS: SlotDef[] = [
  {
    id: 'anchor',
    label: 'Anchor',
    prompt: 'Which entity type is this narrative about?',
    clarity: 'A real domain code.',
    required: true,
    identity: true,
    dependents: ['evidence', 'sample', 'specAccepted'],
  },
  {
    id: 'audience',
    label: 'Audience',
    prompt: 'Who reads this narrative?',
    clarity: 'A role, not "users".',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'decision',
    label: 'Decision',
    prompt: 'What decision should the narrative leave them able to make?',
    clarity: 'An action, not a topic.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'question',
    label: 'Question',
    prompt: 'What exact question must the narrative answer?',
    clarity: 'One question a reviewer could mark right or wrong against the data.',
    required: true,
    dependents: ['evidence', 'specAccepted'],
  },
  {
    id: 'evidence',
    label: 'Evidence',
    prompt: 'Which data sets should it be allowed to use?',
    clarity: 'Query keys tied to real attributes or relationships. No number that does not come from a query.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'blocks',
    label: 'Output',
    prompt: 'Which blocks do you want, in order: markdown, table, chart, insights?',
    clarity: 'An ordered list of block types. A chart names the measure it plots.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'sample',
    label: 'Sample entity',
    prompt: 'Which real entity should I preview the queries against?',
    clarity: 'One entity id or code.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'I have enough to write this narrative. Should I go ahead?',
    clarity: 'The user explicitly accepts the brief.',
    required: true,
    identity: true,
  },
];

const ENTITY_SLOTS: SlotDef[] = [
  {
    id: 'domain',
    label: 'Domain',
    prompt: 'Are we extending an existing entity type, or creating a new one? What should it be called?',
    clarity: 'An existing domain code, or a new UPPER_SNAKE code the user chose after seeing near-duplicates.',
    required: true,
    identity: true,
    dependents: ['identity', 'fields', 'template', 'relationships', 'specAccepted'],
  },
  {
    id: 'records',
    label: 'Example records',
    prompt: 'Give me two or three realistic examples of one record, in your own words.',
    clarity: 'Examples that name the fields, not only the entity name.',
    required: true,
    dependents: ['fields', 'specAccepted'],
  },
  {
    id: 'identity',
    label: 'Identifier',
    prompt: 'Which field or fields uniquely name one record?',
    clarity: 'Attribute codes that exist or that the user confirmed as new, and which of them is primary.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'fields',
    label: 'Fields',
    prompt: 'For each field: the business name, the data type, whether it is required, and whether to reuse an existing attribute.',
    clarity: 'Every field is reused or explicitly new. A description that hits two attributes stays ambiguous.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'template',
    label: 'Template',
    prompt: 'Should these fields go on the existing template, or a new one? What order should they appear in?',
    clarity: 'One template code and a display order.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'relationships',
    label: 'Relationships',
    prompt: 'Which existing entity types does this connect to, or is it standalone?',
    clarity: 'Each link names a real relationship code, or an explicit "none".',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the model I would create. Should I create it?',
    clarity: 'The user explicitly accepts the spec. A single tool match is not acceptance.',
    required: true,
    identity: true,
  },
];

const REPORT_DISCOVERY = [
  ['get_template_metadata'],
  ['get_relationship_types'],
  ['find_sample_entities'],
];

export const SKILLS: SkillDef[] = [
  {
    id: 'design-dashboard',
    name: 'Dashboard',
    toolContext: 'report-designer',
    intro: 'I will ask a few decisions before I design anything. Start with who uses this dashboard and what they decide.',
    placeholder: 'Who uses it, and what decision does it support?',
    startsWhen: 'A dashboard designer is open, or you ask to design a dashboard.',
    discovery: REPORT_DISCOVERY,
    previewTools: ['preview_data_queries'],
    writeTools: [],
    denyTools: [],
    slots: DASHBOARD_SLOTS,
    prefix: `${DESIGN_SYSTEM}

<task>
Design one dashboard. Layout follows the job in the ledger: the two-second read is first, drill-down is second. Preview every dataQueries array with preview_data_queries against the sample entity, then fix errors and empty results.
When phase is apply, end the visible reply with one fenced json block and nothing else inside it: { "dashboardName"?, "description"?, "htmlTemplate"?, "dataQueries"?, "parameters"? }. dataQueries and parameters are complete arrays when present. Include empty, loading, and error states. Hover and focus are visible. Figures are right-aligned.
If the user attaches a screenshot, list violations of hierarchy, contrast, alignment, and spacing against the design system and the reference shell, then emit a corrected json block.
</task>`,
    artifacts: [DASHBOARD_SHELL],
  },
  {
    id: 'design-narrative',
    name: 'Narrative',
    toolContext: 'report-designer',
    intro: 'I will pin down the question and the evidence before I write the narrative.',
    placeholder: 'What question should this narrative answer?',
    startsWhen: 'A narrative designer is open, or you ask to build a narrative.',
    discovery: REPORT_DISCOVERY,
    previewTools: ['preview_data_queries'],
    writeTools: [],
    denyTools: [],
    slots: NARRATIVE_SLOTS,
    prefix: `${DESIGN_SYSTEM}

<task>
Design one narrative: instructions, data queries, parameters, and ordered output blocks. Instructions name the query keys they may cite. A block is { "type": "markdown"|"table"|"chart"|"insights", "key", "title", "guidance" }. Charts use a muted palette and direct labels. Do not ask the model to invent a figure that no query returns.
When phase is apply, end the visible reply with one fenced json block: { "narrativeName"?, "description"?, "instructions"?, "dataQueries"?, "parameters"?, "outputBlocks"? }. Included arrays replace the draft, so send them complete.
</task>`,
    artifacts: [NARRATIVE_BLOCKS],
  },
  {
    id: 'create-entity',
    name: 'Entity',
    toolContext: 'entity-admin',
    intro: 'I will reuse existing fields where they fit, and I will not create anything until you confirm the model.',
    placeholder: 'What entity type do you want, and what is an example record?',
    startsWhen: 'You ask to create an entity type, add a field, or design a template.',
    discovery: [
      ['list_domain_types'],
      ['search_attributes', 'get_attribute_metadata'],
      ['get_relationship_types'],
      ['get_template_metadata'],
    ],
    previewTools: [],
    writeTools: [
      'create_domain_type',
      'create_attribute',
      'create_template',
      'assign_attribute_to_template',
      'create_entity_identifier',
      'create_relationship_type',
    ],
    denyTools: [
      'create_entity',
      'create_relationship',
      'create_intersection',
      'create_intersection_type',
      'update_intersection',
    ],
    slots: ENTITY_SLOTS,
    prefix: `<model>
The generic entity model stores every entity type in one structure.
- Domain: one domain_types row. Code is UPPER_SNAKE.
- Fields: attribute_register. Reuse an existing attribute code when the meaning and data type match. "New" is a choice the user confirms after seeing the candidates.
- Data types: STRING, NUMBER, INTEGER, DECIMAL, BOOLEAN, DATE, TIMESTAMP, JSON, REFERENCE, REFERENCE_LIST, CURRENCY, PERCENTAGE, EMAIL, URL, PHONE.
- Template: one domain_templates row and template_attribute_assignments with a real display order.
- Identifier: one primary entity identifier made of those attributes.
- Relationships: relationship types between real domains. Standalone is a valid answer.
</model>

<avoid>
A new attribute that duplicates an existing code, a domain with no identifier, display order left at 0 for every field, a relationship invented without checking get_relationship_types, creating a second domain when the user meant to extend one.
</avoid>

<task>
Search before you propose. list_domain_types, search_attributes, get_template_metadata, and get_relationship_types are required before you ask the user to confirm. When a name hits two attributes, stop on that field and ask.
When phase is apply, create in this order: domain if it is new, attributes that are actually new, template, assignments, identifier, relationships. Read the template back and tell the user what was created. Do not create entity instances.
</task>`,
    artifacts: [ENTITY_SPEC],
  },
];

const SKILL_BY_ID: Record<SkillId, SkillDef> = {
  'design-dashboard': SKILLS[0],
  'design-narrative': SKILLS[1],
  'create-entity': SKILLS[2],
};

export function skillById(id: unknown): SkillDef | null {
  if (id === 'design-dashboard' || id === 'design-narrative' || id === 'create-entity') return SKILL_BY_ID[id];
  return null;
}

/** Starts a skill from an explicit designer selection or from a create/design request. */
export function skillFromUserText(text: string): SkillDef | null {
  const create = /\b(create|design|build|add|draft|make)\b/i.test(text);
  if (!create) return null;
  if (/\bnarrative\b/i.test(text)) return SKILL_BY_ID['design-narrative'];
  if (/\bdashboard\b/i.test(text)) return SKILL_BY_ID['design-dashboard'];
  if (/\b(entity type|new domain|new attribute|attribute|field|template)\b/i.test(text)) return SKILL_BY_ID['create-entity'];
  return null;
}

export function emptySkillState(skill: SkillDef): SkillState {
  const slots: Record<string, SlotValue> = {};
  for (const slot of skill.slots) slots[slot.id] = { status: 'empty' };
  return { skillId: skill.id, slots, discoveries: [] };
}

export function coerceSkillState(skill: SkillDef, raw: unknown): SkillState {
  const base = emptySkillState(skill);
  if (!raw || typeof raw !== 'object') return base;
  const stored = raw as Partial<SkillState>;
  if (stored.skillId !== skill.id) return base;
  for (const slot of skill.slots) {
    const value = stored.slots?.[slot.id];
    if (!value || typeof value !== 'object') continue;
    const status = value.status;
    if (status !== 'empty' && status !== 'stated' && status !== 'ambiguous' && status !== 'resolved' && status !== 'confirmed') continue;
    base.slots[slot.id] = {
      status,
      value: typeof value.value === 'string' ? value.value : undefined,
      assumption: typeof value.assumption === 'string' ? value.assumption : undefined,
      candidates: Array.isArray(value.candidates)
        ? value.candidates.filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string').map((c) => ({
            id: String(c.id),
            label: String(c.label),
            why: typeof c.why === 'string' ? c.why : '',
          }))
        : undefined,
    };
  }
  if (Array.isArray(stored.discoveries)) {
    base.discoveries = stored.discoveries.filter((name) => typeof name === 'string');
  }
  return base;
}

export function userAccepted(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/\b(but|except|change|instead|actually|wait)\b/i.test(trimmed)) return false;
  return /^(yes|yep|yeah|ok|okay|apply|confirm|confirmed|go ahead|build it|create it|looks good|do it|that'?s right|that is right|ship it)\b/i.test(trimmed);
}

function mentions(text: string, value: string | undefined): boolean {
  if (!value) return false;
  const hay = text.toLowerCase();
  return value
    .split(/[,/]|\band\b/i)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .some((part) => hay.includes(part));
}

function slotReady(slot: SlotValue | undefined): boolean {
  return slot?.status === 'resolved' || slot?.status === 'confirmed';
}

export function discoveriesMet(skill: SkillDef, state: SkillState): boolean {
  return skill.discovery.every((group) => group.some((name) => state.discoveries.includes(name)));
}

export function previewMet(skill: SkillDef, state: SkillState): boolean {
  if (!skill.previewTools.length) return true;
  return skill.previewTools.some((name) => state.discoveries.includes(name));
}

function requiredSlots(skill: SkillDef): SlotDef[] {
  return skill.slots.filter((slot) => slot.required && slot.id !== 'specAccepted');
}

export function skillPhase(skill: SkillDef, state: SkillState): SkillPhase {
  const open = requiredSlots(skill).filter((slot) => !slotReady(state.slots[slot.id]));
  if (open.length || !discoveriesMet(skill, state)) return 'guided';
  if (state.slots.specAccepted?.status !== 'confirmed') return 'spec';
  if (!previewMet(skill, state)) return 'build';
  return 'apply';
}

export function nextOpenSlot(skill: SkillDef, state: SkillState): SlotDef | null {
  const phase = skillPhase(skill, state);
  if (phase === 'apply' || phase === 'build') return null;
  for (const slot of skill.slots) {
    if (!slot.required) continue;
    const current = state.slots[slot.id];
    if (slot.id === 'specAccepted' && phase !== 'spec') continue;
    if (!current || current.status === 'empty' || current.status === 'stated' || current.status === 'ambiguous') return slot;
  }
  return null;
}

function resetDependents(skill: SkillDef, state: SkillState, slotId: string) {
  const def = skill.slots.find((slot) => slot.id === slotId);
  for (const dependentId of def?.dependents ?? []) {
    const dependent = state.slots[dependentId];
    if (!dependent || dependent.status === 'empty') continue;
    state.slots[dependentId] = { status: 'stated', value: dependent.value, assumption: 'Re-check this after the earlier answer changed.' };
  }
}

/** Applies a user turn before the model runs: picks an ambiguous candidate, or accepts the spec. */
export function ingestUserTurn(skill: SkillDef, state: SkillState, userText: string): SkillState {
  const next: SkillState = {
    skillId: state.skillId,
    discoveries: [...state.discoveries],
    slots: Object.fromEntries(Object.entries(state.slots).map(([id, slot]) => [id, { ...slot, candidates: slot.candidates ? [...slot.candidates] : undefined }])),
  };

  for (const def of skill.slots) {
    const slot = next.slots[def.id];
    if (slot?.status !== 'ambiguous' || !slot.candidates?.length) continue;
    const hits = slot.candidates.filter((candidate) => {
      const hay = userText.toLowerCase();
      return hay.includes(candidate.id.toLowerCase()) || hay.includes(candidate.label.toLowerCase());
    });
    if (hits.length === 1) {
      next.slots[def.id] = { status: 'confirmed', value: hits[0].id, assumption: hits[0].why };
      resetDependents(skill, next, def.id);
    }
  }

  if (
    userAccepted(userText) &&
    requiredSlots(skill).every((slot) => slotReady(next.slots[slot.id])) &&
    discoveriesMet(skill, next)
  ) {
    next.slots.specAccepted = { status: 'confirmed', value: 'User accepted the spec.' };
  }

  return next;
}

interface SlotUpdate {
  id?: string;
  status?: string;
  value?: string;
  assumption?: string;
  candidates?: SlotCandidate[];
}

function parseUpdates(text: string): { visible: string; updates: SlotUpdate[] } {
  const updates: SlotUpdate[] = [];
  const visible = text.replace(/```skill\s*([\s\S]*?)```/gi, (_all, body: string) => {
    try {
      const parsed = JSON.parse(body);
      const list = Array.isArray(parsed?.updates) ? parsed.updates : Array.isArray(parsed) ? parsed : [];
      for (const item of list) {
        if (item && typeof item === 'object') updates.push(item as SlotUpdate);
      }
    } catch {
      // Ignore a malformed ledger block. The previous ledger stands.
    }
    return '';
  });
  return { visible: visible.replace(/\n{3,}/g, '\n\n').trim(), updates };
}

function asStatus(value: string | undefined): SlotStatus | null {
  if (value === 'empty' || value === 'stated' || value === 'ambiguous' || value === 'resolved' || value === 'confirmed') return value;
  return null;
}

function applyUpdates(skill: SkillDef, state: SkillState, updates: SlotUpdate[], userText: string) {
  const accepted = userAccepted(userText);
  for (const update of updates) {
    const def = skill.slots.find((slot) => slot.id === update.id);
    if (!def) continue;
    let status = asStatus(update.status);
    if (!status) continue;
    const candidates = Array.isArray(update.candidates)
      ? update.candidates.filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string')
      : undefined;
    if (status === 'ambiguous') {
      if (!candidates || candidates.length < 2) status = candidates?.length === 1 ? 'resolved' : 'stated';
    }
    if (status === 'confirmed' && def.identity) {
      if (def.id === 'specAccepted') {
        const othersReady = requiredSlots(skill).every((slot) => slotReady(state.slots[slot.id]));
        status = accepted && othersReady && discoveriesMet(skill, state) ? 'confirmed' : 'stated';
      } else if (!accepted && !mentions(userText, update.value)) {
        status = 'resolved';
      }
    }
    const previous = state.slots[def.id];
    const value = typeof update.value === 'string' ? update.value : previous?.value;
    const changed = value !== previous?.value && def.id !== 'specAccepted';
    state.slots[def.id] = {
      status,
      value,
      assumption: typeof update.assumption === 'string' ? update.assumption : undefined,
      candidates: status === 'ambiguous' ? candidates : undefined,
    };
    if (changed) resetDependents(skill, state, def.id);
  }
}

const PROPOSAL_KEYS = ['dashboardName', 'narrativeName', 'htmlTemplate', 'instructions', 'dataQueries', 'parameters', 'outputBlocks'];

function isProposal(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => PROPOSAL_KEYS.includes(key));
}

function stripProposals(text: string): string {
  return text.replace(/```json\s*([\s\S]*?)```/gi, (fence, body: string) => {
    try {
      if (isProposal(JSON.parse(body))) return '';
    } catch {
      // Keep fences that are not a designer proposal.
    }
    return fence;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

export function skillAllowsTool(skill: SkillDef | null, state: SkillState | null, name: string): boolean {
  if (!skill || !state) return true;
  if (skill.denyTools.includes(name)) return false;
  if (skill.writeTools.includes(name)) return skillPhase(skill, state) === 'apply';
  return true;
}

export function skillSystemAddendum(skill: SkillDef, state: SkillState): string {
  const phase = skillPhase(skill, state);
  const open = nextOpenSlot(skill, state);
  const discovered = discoveriesMet(skill, state);
  const pending = skill.discovery
    .filter((group) => !group.some((name) => state.discoveries.includes(name)))
    .map((group) => group.join(' or '));
  const ledger = skill.slots.map((slot) => {
    const current = state.slots[slot.id] ?? { status: 'empty' as const };
    return {
      id: slot.id,
      label: slot.label,
      required: slot.required,
      identity: Boolean(slot.identity),
      clarity: slot.clarity,
      status: current.status,
      value: current.value ?? null,
      assumption: current.assumption ?? null,
      candidates: current.candidates ?? null,
    };
  });

  return `

## Active skill: ${skill.name}
This ledger overrides any instruction to ask only when something is ambiguous, and it overrides emitting a proposal or calling a create tool before phase is apply.
Phase: ${phase}. ${PHASE_LABEL[phase]}.
${pending.length ? `Call these tools before you ask the user to confirm: ${pending.join('; ')}.` : 'Discovery tools for this skill have been run.'}
${skill.previewTools.length && phase === 'build' ? `Call ${skill.previewTools.join(' or ')} and fix the queries before you emit a proposal.` : ''}
${!discovered ? 'Do not ask the user to confirm, and do not emit a proposal, until those tools have run.' : open ? `The only question you may ask this turn: ${open.prompt}` : phase === 'apply' ? 'The ledger is complete. Produce the apply output.' : 'Check the data, then produce the apply output.'}

${GUIDED}

${skill.prefix}

<ledger>
${JSON.stringify(ledger)}
</ledger>
${artifactBlock(skill, phase)}`;
}

/** Full reference bodies on the phases that produce output. Other phases only name them. */
export function artifactBlock(skill: SkillDef, phase: SkillPhase): string {
  if (!skill.artifacts.length) return '';
  const active = skill.artifacts.filter((artifact) => artifact.phases.includes(phase));
  if (!active.length) {
    const names = skill.artifacts.map((artifact) => artifact.title).join(', ');
    return `\n<reference_artifacts>\nHeld until output: ${names}. Do not invent a different layout.\n</reference_artifacts>`;
  }
  return active
    .map(
      (artifact) =>
        `\n<reference_artifact id="${artifact.id}" title="${artifact.title}">\n${artifact.instruction}\n\n${artifact.body}\n</reference_artifact>`
    )
    .join('\n');
}

export interface SkillTurnResult {
  state: SkillState;
  text: string;
  view: SkillView;
}

export function toSkillView(skill: SkillDef, state: SkillState): SkillView {
  const phase = skillPhase(skill, state);
  const required = skill.slots.filter((slot) => slot.required);
  const decided = required.filter((slot) => slotReady(state.slots[slot.id]));
  const open = nextOpenSlot(skill, state);
  const openValue = open ? state.slots[open.id] : undefined;
  return {
    id: skill.id,
    name: skill.name,
    phase,
    phaseLabel: PHASE_LABEL[phase],
    decidedCount: decided.length,
    requiredCount: required.length,
    decided: decided
      .filter((slot) => slot.id !== 'specAccepted')
      .map((slot) => ({ label: slot.label, value: state.slots[slot.id]?.value || slot.label })),
    open: open
      ? { id: open.id, label: open.label, status: openValue?.status ?? 'empty', prompt: open.prompt }
      : undefined,
  };
}

export function viewFromStored(raw: unknown): SkillView | null {
  if (!raw || typeof raw !== 'object') return null;
  const skill = skillById((raw as SkillState).skillId);
  if (!skill) return null;
  return toSkillView(skill, coerceSkillState(skill, raw));
}

/**
 * Merges the model's ledger block, records tools that succeeded, and withholds
 * a proposal until the phase allows it. Appends the one open question when the
 * reply did not ask anything.
 */
export function completeAssistantTurn(
  skill: SkillDef,
  state: SkillState,
  modelText: string,
  successfulTools: string[],
  userText: string
): SkillTurnResult {
  const next = ingestUserTurn(skill, state, '');
  next.discoveries = Array.from(new Set([...next.discoveries, ...successfulTools]));
  const parsed = parseUpdates(modelText);
  applyUpdates(skill, next, parsed.updates, userText);
  if (
    userAccepted(userText) &&
    requiredSlots(skill).every((slot) => slotReady(next.slots[slot.id])) &&
    discoveriesMet(skill, next)
  ) {
    next.slots.specAccepted = { status: 'confirmed', value: next.slots.specAccepted?.value || 'User accepted the spec.' };
  }

  let text = parsed.visible;
  if (skillPhase(skill, next) !== 'apply') text = stripProposals(text);
  const open = nextOpenSlot(skill, next);
  if (open && !text.includes('?')) {
    const assumption = next.slots[open.id]?.assumption;
    const prefix = assumption ? `${assumption} ` : '';
    text = [text, `${prefix}${open.prompt}`].filter(Boolean).join('\n\n');
  }
  if (!text && !discoveriesMet(skill, next)) {
    text = 'I still need to check the live data model before I ask you to confirm.';
  }
  if (!text) text = open?.prompt || (skillPhase(skill, next) === 'build' ? 'I am checking these queries against a real entity before I propose a draft.' : 'The ledger is complete.');
  return { state: next, text, view: toSkillView(skill, next) };
}
