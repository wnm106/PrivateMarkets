import { SKILLS, skillById, type SkillDef, type SkillId } from '@tapestrai/mcp-server/src/lib/chat-skills';

export type StudioSection = 'purpose' | 'inputs' | 'procedure' | 'tools' | 'references' | 'checks' | 'examples';
export type SkillGate = 'none' | 'confirm' | 'validate';
export type SkillLoad = 'always' | 'trigger' | 'phase' | 'request';
export type CheckKind = 'det' | 'rub';
export type ArtifactRole = 'Template' | 'Schema' | 'Constraints' | 'Output format' | 'Example' | 'Query' | 'Reference';

export interface SkillPurpose {
  trigger: string;
  notTrigger: string;
  outcome: string;
  done: string;
}

export interface StudioSlot {
  id: string;
  name: string;
  required: boolean;
  ask: string;
  passes: string;
}

export interface StudioPhase {
  id: string;
  name: string;
  gate: SkillGate;
}

export interface StudioTool {
  id: string;
  name: string;
  phase: string;
  rule: string;
  enabled: boolean;
}

export interface StudioRef {
  id: string;
  name: string;
  role: ArtifactRole;
  load: SkillLoad;
  phase: string;
  instruction: string;
  content: string;
}

export interface StudioCheck {
  id: string;
  kind: CheckKind;
  text: string;
  enabled: boolean;
}

export interface StudioExample {
  id: string;
  title: string;
  body: string;
}

export interface SkillDocument {
  seq: number;
  skill: SkillPurpose;
  slots: StudioSlot[];
  phases: StudioPhase[];
  tools: StudioTool[];
  refs: StudioRef[];
  checks: StudioCheck[];
  examples: StudioExample[];
}

export interface SkillStudioRecord {
  version: number;
  dirty: boolean;
  document: SkillDocument;
}

export const STUDIO_SECTIONS: Array<{ id: StudioSection; label: string; title: string; sub: string }> = [
  { id: 'purpose', label: 'Purpose', title: 'Purpose', sub: 'When the skill starts and what exists when it is done.' },
  { id: 'inputs', label: 'Inputs', title: 'Inputs', sub: 'Slots the agent must fill, how it asks, and what counts as a clear answer.' },
  { id: 'procedure', label: 'Procedure', title: 'Procedure', sub: 'Ordered phases. A gate stops the agent from advancing until it is met.' },
  { id: 'tools', label: 'Tools', title: 'Tools', sub: 'Which tools the skill may use, in which phase, and the rules.' },
  { id: 'references', label: 'References', title: 'Reference artifacts', sub: 'Files stored with the skill. Each has a load rule, so the agent pulls it into context only when needed.' },
  { id: 'checks', label: 'Checks', title: 'Checks', sub: 'Deterministic checks run in code. Rubric checks are judged by the model.' },
  { id: 'examples', label: 'Examples', title: 'Examples', sub: 'Worked transcripts, including rejected answers.' },
];

export const LOAD_LABEL: Record<SkillLoad, string> = {
  always: 'Always',
  trigger: 'On trigger',
  phase: 'At phase',
  request: 'On request',
};

const STORAGE_PREFIX = 'tapestr-skill-studio:v1:';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'html', 'htm', 'csv', 'sql', 'xml', 'yaml', 'yml']);

export function tokenCount(text: string) {
  return Math.ceil((text || '').length / 4);
}

export function phaseName(document: SkillDocument, phaseId: string) {
  if (phaseId === 'any') return 'Any phase';
  return document.phases.find((phase) => phase.id === phaseId)?.name || 'None';
}

export function roleForFilename(name: string): ArtifactRole {
  if (/\.html?$/i.test(name)) return 'Template';
  if (/\.json$/i.test(name)) return 'Schema';
  if (/\.sql$/i.test(name)) return 'Query';
  return 'Reference';
}

export function isTextArtifact(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (TEXT_EXTENSIONS.has(extension)) return true;
  return file.type.startsWith('text/');
}

interface PhasePlan {
  id: string;
  name: string;
  gate: SkillGate;
}

interface ToolPlan {
  name: string;
  phase: string;
  rule: string;
}

function slotName(label: string, identity: boolean | undefined) {
  return identity ? `${label} · confirm` : label;
}

function purposeFor(skill: SkillDef, extra: Pick<SkillPurpose, 'notTrigger' | 'outcome' | 'done'>): SkillPurpose {
  return {
    trigger: `${skill.startsWhen} ${skill.intro}`,
    ...extra,
  };
}

function plans(skill: SkillDef): { purpose: SkillPurpose; phases: PhasePlan[]; tools: ToolPlan[]; checks: Array<Omit<StudioCheck, 'id'>>; examples: Array<Omit<StudioExample, 'id'>> } {
  if (skill.id === 'design-narrative') {
    return {
      purpose: purposeFor(skill, {
        notTrigger: 'Editing the wording of a narrative that already exists, or answering a one-off question about a record.',
        outcome: 'A narrative whose instructions, queries, and ordered blocks answer one question for a named role.',
        done: 'The user accepted the brief, every figure cites a query key, and the preview ran against the sample entity.',
      }),
      phases: [
        { id: 'p1', name: 'Anchor', gate: 'confirm' },
        { id: 'p2', name: 'Question', gate: 'none' },
        { id: 'p3', name: 'Evidence and sample', gate: 'confirm' },
        { id: 'p4', name: 'Brief', gate: 'confirm' },
        { id: 'p5', name: 'Build', gate: 'validate' },
      ],
      tools: [
        { name: 'get_template_metadata', phase: 'p1', rule: 'Ground the anchor in a real domain from this tool.' },
        { name: 'get_relationship_types', phase: 'p3', rule: 'Cite a relationship only when the evidence actually uses it.' },
        { name: 'find_sample_entities', phase: 'p3', rule: 'Offer entities from this tool before asking open questions.' },
        { name: 'preview_data_queries', phase: 'p5', rule: 'Preview every query. Do not cite a figure the preview did not return.' },
      ],
      checks: [
        { kind: 'det', text: 'Every figure cites a query key', enabled: true },
        { kind: 'det', text: 'Each block is markdown, table, chart, or insights', enabled: true },
        { kind: 'rub', text: 'Answers the one question in the ledger', enabled: true },
        { kind: 'rub', text: 'Does not estimate a number that is not in the rows', enabled: true },
      ],
      examples: [
        {
          title: 'Rejected: "the team"',
          body: 'User: It is for the team.\nAgent: "The team" is not a role. Do you mean the portfolio manager?',
        },
      ],
    };
  }
  if (skill.id === 'create-entity') {
    return {
      purpose: purposeFor(skill, {
        notTrigger: 'Creating one entity instance, loading a file, or editing a value on an existing record.',
        outcome: 'A domain, template, fields, identifier, and relationships, reusing attributes where the meaning matches.',
        done: 'The user accepted the spec, every field is reused or explicitly new, and the template was read back after create.',
      }),
      phases: [
        { id: 'p1', name: 'Domain', gate: 'confirm' },
        { id: 'p2', name: 'Example records', gate: 'none' },
        { id: 'p3', name: 'Fields and identifier', gate: 'confirm' },
        { id: 'p4', name: 'Relationships', gate: 'none' },
        { id: 'p5', name: 'Spec', gate: 'confirm' },
        { id: 'p6', name: 'Create', gate: 'validate' },
      ],
      tools: [
        { name: 'list_domain_types', phase: 'p1', rule: 'Search before proposing a new domain. Stop if a near-duplicate exists.' },
        { name: 'search_attributes', phase: 'p3', rule: 'When a name hits two attributes, stop and ask. Do not invent a third code.' },
        { name: 'get_attribute_metadata', phase: 'p3', rule: 'Confirm the data type of a reused attribute before assigning it.' },
        { name: 'get_template_metadata', phase: 'p4', rule: 'Put fields on an existing template when the user is extending one.' },
        { name: 'get_relationship_types', phase: 'p4', rule: 'Reuse a relationship code when one already connects these domains.' },
        { name: 'create_domain_type', phase: 'p6', rule: 'Create the domain first, and only when the spec says it is new.' },
        { name: 'create_attribute', phase: 'p6', rule: 'Create an attribute only when the user confirmed it is new.' },
        { name: 'create_template', phase: 'p6', rule: 'Create a template only when the spec does not reuse one.' },
        { name: 'assign_attribute_to_template', phase: 'p6', rule: 'Assign with the display order from the spec. Do not leave every field at 0.' },
        { name: 'create_entity_identifier', phase: 'p6', rule: 'One primary identifier, made of attributes on the template.' },
        { name: 'create_relationship_type', phase: 'p6', rule: 'Create a relationship only when the spec says it does not already exist.' },
      ],
      checks: [
        { kind: 'det', text: 'The domain code is UPPER_SNAKE or an existing domain code', enabled: true },
        { kind: 'det', text: 'Every field is reused or explicitly new', enabled: true },
        { kind: 'rub', text: 'No new attribute duplicates an existing code', enabled: true },
        { kind: 'rub', text: 'A primary identifier is named', enabled: true },
      ],
      examples: [
        {
          title: 'Rejected: "some fields"',
          body: 'User: Add some fields for the call.\nAgent: "Some fields" is not a model. Name two or three realistic records, including the amounts and dates.',
        },
      ],
    };
  }
  return {
    purpose: purposeFor(skill, {
      notTrigger: 'Questions about an existing dashboard, or an ad hoc report that is not a designed screen.',
      outcome: 'A dashboard with one primary measure, one chart, and one detail table, tied to a named role’s decision.',
      done: 'The user accepted the brief, every metric maps to a returned attribute code, and the preview renders with the sample entity.',
    }),
    phases: [
      { id: 'p1', name: 'Anchor', gate: 'confirm' },
      { id: 'p2', name: 'Audience and decision', gate: 'none' },
      { id: 'p3', name: 'Measures and sample', gate: 'confirm' },
      { id: 'p4', name: 'Brief', gate: 'confirm' },
      { id: 'p5', name: 'Build', gate: 'validate' },
    ],
    tools: [
      { name: 'get_template_metadata', phase: 'p1', rule: 'Ground the anchor question in domains and templates this tool returns.' },
      { name: 'get_relationship_types', phase: 'p3', rule: 'Use a relationship only when the drill-down needs it.' },
      { name: 'find_sample_entities', phase: 'p3', rule: 'Offer entities from this tool before asking open questions.' },
      { name: 'preview_data_queries', phase: 'p5', rule: 'Never invent metric codes. Preview every query against the sample entity.' },
    ],
    checks: [
      { kind: 'det', text: 'The HTML parses and renders', enabled: true },
      { kind: 'det', text: 'Every metric maps to a returned attribute code', enabled: true },
      { kind: 'rub', text: 'Exactly one primary figure', enabled: true },
      { kind: 'rub', text: 'Reads in two seconds for the stated role', enabled: true },
    ],
    examples: [
      {
        title: 'Rejected: "the team"',
        body: 'User: It is for the team.\nAgent: "The team" is not a role. Do you mean the portfolio manager?',
      },
    ],
  };
}

function outputPhase(skill: SkillDef, phases: PhasePlan[]) {
  const build = phases.find((phase) => phase.gate === 'validate');
  const spec = phases.find((phase) => /brief|spec/i.test(phase.name));
  if (skill.id === 'create-entity') return spec?.id || phases[phases.length - 1].id;
  return build?.id || phases[phases.length - 1].id;
}

export function publishedSkillDocument(skillId: SkillId): SkillDocument {
  const skill = skillById(skillId) ?? SKILLS[0];
  const plan = plans(skill);
  const refs: StudioRef[] = skill.artifacts.map((artifact, index) => ({
    id: `r${index + 1}`,
    name: `${artifact.id}.${artifact.body.trim().startsWith('<') ? 'html' : artifact.body.trim().startsWith('{') ? 'json' : 'md'}`,
    role: artifact.body.trim().startsWith('<') ? 'Template' : artifact.body.trim().startsWith('{') ? 'Output format' : 'Reference',
    load: 'phase' as const,
    phase: outputPhase(skill, plan.phases),
    instruction: artifact.instruction,
    content: artifact.body,
  }));
  if (skill.id === 'design-dashboard') {
    refs.push(
      {
        id: 'r-brief',
        name: 'brief-format.md',
        role: 'Output format',
        load: 'phase',
        phase: 'p4',
        instruction: 'Present the brief in exactly this shape before asking for acceptance.',
        content: 'Audience: …\nDecision: …\nPrimary measure: …\nFilters: …\nSample entity: …\nReply "accept" to build.',
      },
      {
        id: 'r-style',
        name: 'style-rules.md',
        role: 'Constraints',
        load: 'always',
        phase: 'any',
        instruction: 'Apply to every build.',
        content: 'One primary figure. One chart. Right-align numbers. Tabular numerals. One accent, used only for the primary figure.',
      },
      {
        id: 'r-transcript',
        name: 'good-transcript.md',
        role: 'Example',
        load: 'request',
        phase: 'any',
        instruction: 'Fetch when unsure how to pace the conversation.',
        content: 'User: I need a dashboard.\nAgent: Which of these domains is it for?',
      },
    );
  }
  return {
    seq: 100,
    skill: plan.purpose,
    slots: skill.slots.map((slot) => ({
      id: slot.id,
      name: slotName(slot.label, slot.identity),
      required: slot.required,
      ask: slot.prompt,
      passes: slot.clarity,
    })),
    phases: plan.phases,
    tools: plan.tools.map((tool, index) => ({
      id: `t${index + 1}`,
      name: tool.name,
      phase: tool.phase,
      rule: tool.rule,
      enabled: true,
    })),
    refs,
    checks: plan.checks.map((check, index) => ({ ...check, id: `c${index + 1}` })),
    examples: plan.examples.map((example, index) => ({ ...example, id: `e${index + 1}` })),
  };
}

export function publishedRecord(skillId: SkillId): SkillStudioRecord {
  return { version: 1, dirty: false, document: publishedSkillDocument(skillId) };
}

function isDocument(value: unknown): value is SkillDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as SkillDocument;
  return Boolean(doc.skill && Array.isArray(doc.slots) && Array.isArray(doc.phases) && Array.isArray(doc.tools) && Array.isArray(doc.refs) && Array.isArray(doc.checks) && Array.isArray(doc.examples));
}

export function loadSkillStudio(skillId: SkillId): SkillStudioRecord {
  const seeded = publishedRecord(skillId);
  if (typeof window === 'undefined') return seeded;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + skillId);
    if (!raw) return seeded;
    const parsed = JSON.parse(raw) as Partial<SkillStudioRecord>;
    if (!isDocument(parsed.document) || typeof parsed.version !== 'number') return seeded;
    return { version: parsed.version, dirty: Boolean(parsed.dirty), document: parsed.document };
  } catch {
    return seeded;
  }
}

export function saveSkillStudio(skillId: SkillId, record: SkillStudioRecord) {
  window.localStorage.setItem(STORAGE_PREFIX + skillId, JSON.stringify(record));
}

export type SectionTone = 'ok' | 'warn' | 'count';

export function sectionTone(document: SkillDocument, section: StudioSection): { tone: SectionTone; mark: string } {
  const purpose = document.skill;
  if (section === 'purpose') {
    const full = [purpose.trigger, purpose.notTrigger, purpose.outcome, purpose.done].every((part) => part.trim());
    return { tone: full ? 'ok' : 'warn', mark: '●' };
  }
  if (section === 'inputs') return { tone: document.slots.length ? 'ok' : 'warn', mark: '●' };
  if (section === 'procedure') return { tone: document.phases.some((phase) => phase.gate === 'validate') ? 'ok' : 'warn', mark: '●' };
  if (section === 'tools') return { tone: document.tools.some((tool) => tool.enabled) ? 'ok' : 'warn', mark: '●' };
  if (section === 'references') return { tone: 'count', mark: String(document.refs.length) };
  if (section === 'checks') return { tone: document.checks.some((check) => check.enabled && check.kind === 'det') ? 'ok' : 'warn', mark: '●' };
  return { tone: 'count', mark: String(document.examples.length) };
}

export interface ContextGroup {
  label: string;
  tokens: number;
  color: string;
  files: string;
  inBar: boolean;
}

export function contextAtPhase(document: SkillDocument, phaseId: string): { groups: ContextGroup[]; loaded: number; warnings: string[] } {
  const bodyTokens = tokenCount(JSON.stringify([document.skill, document.slots, document.phases]));
  const sum = (refs: StudioRef[]) => refs.reduce((total, ref) => total + tokenCount(ref.content), 0);
  const always = document.refs.filter((ref) => ref.load === 'always');
  const trigger = document.refs.filter((ref) => ref.load === 'trigger');
  const atPhase = document.refs.filter((ref) => ref.load === 'phase' && ref.phase === phaseId);
  const onRequest = document.refs.filter((ref) => ref.load === 'request');
  const group = (label: string, color: string, refs: StudioRef[] | number, inBar: boolean, files?: string): ContextGroup => {
    const tokens = typeof refs === 'number' ? refs : sum(refs);
    return {
      label,
      tokens,
      color,
      inBar,
      files: files || (Array.isArray(refs) ? refs.map((ref) => ref.name).join(', ') : '') || 'none',
    };
  };
  const groups = [
    group('Skill body', '#566a88', bodyTokens, true, 'purpose, inputs, procedure'),
    group('Always', '#2f7d4f', always, true),
    group('On trigger', '#c98a0c', trigger, true),
    group(`At ${phaseName(document, phaseId)}`, '#1a8cff', atPhase, true),
    group('On request, not preloaded', '#6d28d9', onRequest, false),
  ];
  const loaded = bodyTokens + sum(always) + sum(trigger) + sum(atPhase);
  const warnings: string[] = [];
  for (const ref of [...always, ...trigger, ...atPhase]) {
    const share = loaded > 0 ? tokenCount(ref.content) / loaded : 0;
    if (share > 0.4) {
      warnings.push(`${ref.name} is ${Math.round(share * 100)}% of the context at this phase. Load it at the phase that needs it, or on request.`);
    }
  }
  if (!document.checks.some((check) => check.enabled && check.kind === 'det')) {
    warnings.push('No deterministic check is enabled. Nothing verifies the output outside the model.');
  }
  return { groups, loaded, warnings };
}

export function assembledContext(skillId: string, document: SkillDocument, phaseId: string) {
  const loadedRefs = document.refs.filter((ref) => {
    if (ref.load === 'always' || ref.load === 'trigger') return true;
    return ref.load === 'phase' && ref.phase === phaseId;
  });
  const lines = [
    `# ${skillId} · phase: ${phaseName(document, phaseId)}`,
    document.skill.trigger,
    '',
    'PROCEDURE',
    ...document.phases.map((phase, index) => `${index + 1}. ${phase.name}${phase.gate === 'none' ? '' : ` [gate: ${phase.gate}]`}`),
    ...loadedRefs.map((ref) => {
      const preview = ref.content.length > 140 ? `${ref.content.slice(0, 140)} …` : ref.content;
      return `\n--- ${ref.name} (${LOAD_LABEL[ref.load]})\n${ref.instruction}\n${preview}`;
    }),
  ];
  return lines.join('\n');
}

export function nextStudioId(document: SkillDocument) {
  document.seq += 1;
  return `x${document.seq}`;
}

export function cyclePhase(document: SkillDocument, current: string) {
  const ids = ['any', ...document.phases.map((phase) => phase.id)];
  const index = ids.indexOf(current);
  return ids[(index + 1) % ids.length];
}
