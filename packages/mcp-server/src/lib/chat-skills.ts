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

export type SkillId =
  | 'design-dashboard'
  | 'design-narrative'
  | 'create-entity'
  | 'add-field'
  | 'create-compliance-rule'
  | 'change-compliance-rule'
  | 'start-workflow'
  | 'create-relationship-type'
  | 'create-dq-rule'
  | 'manual-override';
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
  toolContext: 'report-designer' | 'entity-admin' | 'compliance' | 'data-quality' | 'workflow' | 'lineage';
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

const FIELD_SLOTS: SlotDef[] = [
  {
    id: 'domain',
    label: 'Entity type',
    prompt: 'Which entity type should the field go on?',
    clarity: 'A real domain code from list_domain_types, not a loose noun.',
    required: true,
    identity: true,
    dependents: ['reuse', 'template', 'specAccepted'],
  },
  {
    id: 'meaning',
    label: 'Meaning',
    prompt: 'What does the field hold? Give me a business name and an example value.',
    clarity: 'A name and a real example such as "Maturity date, 2029-06-30". "Some date" does not pass.',
    required: true,
    dependents: ['reuse', 'dataType', 'specAccepted'],
  },
  {
    id: 'reuse',
    label: 'Reuse',
    prompt: 'An existing field may already hold this. Should I reuse it, or is this a new field?',
    clarity: 'One existing attribute code the user accepted, or an explicit "new" after seeing the near matches. Two matches stay ambiguous.',
    required: true,
    identity: true,
    dependents: ['dataType', 'template', 'specAccepted'],
  },
  {
    id: 'dataType',
    label: 'Data type',
    prompt: 'What kind of value is it: text, number, whole number, true or false, date, currency, percentage or a pick-list?',
    clarity: 'One data type that fits the example value. A reused field keeps its own type.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'required',
    label: 'Required',
    prompt: 'Must every record have a value, or is it optional?',
    clarity: 'Required or optional, and for which records if only some.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'values',
    label: 'Allowed values',
    prompt: 'It is a pick-list: which values may a person choose?',
    clarity: 'The full list, or an explicit "not a pick-list".',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'template',
    label: 'Template and order',
    prompt: 'Which template should show it, and where in the order?',
    clarity: 'One template code from get_template_metadata and a position among the existing fields.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the field I would add. Should I add it?',
    clarity: 'The user explicitly accepts the spec. A single tool match is not acceptance.',
    required: true,
    identity: true,
  },
];

const COMPLIANCE_RULE_SLOTS: SlotDef[] = [
  {
    id: 'purpose',
    label: 'Purpose',
    prompt: 'What risk does this rule limit, in one sentence? For example: no more than 5% of a fund in one issuer.',
    clarity: 'A limit a reviewer could check: a measure, a basis and a threshold. "Keep exposure under control" does not pass.',
    required: true,
    dependents: ['category', 'measure', 'basis', 'limit', 'specAccepted'],
  },
  {
    id: 'anchor',
    label: 'Anchor',
    prompt: 'Which entity type is the limit applied to, such as a fund?',
    clarity: 'A real domain code from list_domain_types.',
    required: true,
    identity: true,
    dependents: ['measure', 'basis', 'grouping', 'scope', 'specAccepted'],
  },
  {
    id: 'category',
    label: 'Category',
    prompt: 'Which kind of rule is it: concentration, exposure, diversification, eligibility, leverage, liquidity, coverage, collateral quality or other?',
    clarity: 'One of the rule categories the tool accepts.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'measure',
    label: 'What is measured',
    prompt: 'What is added up or counted: which attribute, summed, counted, averaged or taken as the maximum?',
    clarity: 'One attribute code that exists on the base records, with an aggregation, and the base record type.',
    required: true,
    identity: true,
    dependents: ['basis', 'grouping', 'specAccepted'],
  },
  {
    id: 'basis',
    label: 'Compared with',
    prompt: 'What is it compared with: the whole fund, the same group, a fixed number, or an attribute on the fund such as NAV?',
    clarity: 'A denominator: the anchor total, the same group, a constant or a named anchor attribute. A count or a plain total has none.',
    required: true,
    identity: true,
    dependents: ['limit', 'specAccepted'],
  },
  {
    id: 'grouping',
    label: 'Grouping',
    prompt: 'Is the limit applied to each group, such as each issuer or each sector, or to the total?',
    clarity: 'A group-by attribute or relationship path that exists, or an explicit "no grouping".',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'limit',
    label: 'Limit',
    prompt: 'What are the limits: the hard limit that is a breach, and a soft limit for a warning if you want one? Is it a maximum or a minimum?',
    clarity: 'A hard limit with its unit (percentage, ratio, currency or count) and direction. A soft limit is optional.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'conditions',
    label: 'Conditions',
    prompt: 'Does it count every position, or only some, such as only senior secured?',
    clarity: 'Named conditions on real attributes, or an explicit "every position".',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'scope',
    label: 'Scope',
    prompt: 'Does it apply to every record of that type, or only to some, or to all except some?',
    clarity: 'Applies to all, or the named records to include or carve out.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'effective',
    label: 'Effective from',
    prompt: 'From what date does it apply?',
    clarity: 'A date, or "today".',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'name',
    label: 'Code and name',
    prompt: 'What should the rule be called? I will suggest a code.',
    clarity: 'A name and an UPPER_SNAKE code that list_compliance_rules does not already use.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the rule I would create. Should I create it?',
    clarity: 'The user explicitly accepts the spec. A single tool match is not acceptance.',
    required: true,
    identity: true,
  },
];

const WORKFLOW_SLOTS: SlotDef[] = [
  {
    id: 'workflow',
    label: 'Workflow',
    prompt: 'Which workflow should I start?',
    clarity: 'One published workflow from list_workflows. Two near matches stay ambiguous. An unpublished workflow cannot be started.',
    required: true,
    identity: true,
    dependents: ['records', 'inputs', 'specAccepted'],
  },
  {
    id: 'records',
    label: 'Records',
    prompt: 'Which records should it run on?',
    clarity: 'Named records of the type the workflow works on, found with list_entities. A workflow that requires records does not run on everything.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'inputs',
    label: 'Other values',
    prompt: 'It asks for some values. What should I use for each?',
    clarity: 'A value for every input the workflow lists, or an explicit "this workflow asks for none".',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Start',
    prompt: 'I will start this run. Should I go ahead?',
    clarity: 'The user explicitly confirms the workflow, the records and every value.',
    required: true,
    identity: true,
  },
];

const RELATIONSHIP_TYPE_SLOTS: SlotDef[] = [
  {
    id: 'parent',
    label: 'Parent type',
    prompt: 'Which entity type is on the parent side?',
    clarity: 'A real domain code from list_domain_types.',
    required: true,
    identity: true,
    dependents: ['meaning', 'cardinality', 'name', 'specAccepted'],
  },
  {
    id: 'child',
    label: 'Child type',
    prompt: 'Which entity type is on the child side?',
    clarity: 'A real domain code from list_domain_types.',
    required: true,
    identity: true,
    dependents: ['meaning', 'cardinality', 'name', 'specAccepted'],
  },
  {
    id: 'meaning',
    label: 'Meaning',
    prompt: 'Say it as a sentence, parent first: for example "A fund holds positions".',
    clarity: 'A sentence that names both types and the verb, so the direction is not in doubt.',
    required: true,
    dependents: ['name', 'specAccepted'],
  },
  {
    id: 'cardinality',
    label: 'How many',
    prompt: 'How many of each: can one parent have many children, and can a child have more than one parent?',
    clarity: 'One of one-to-one, one-to-many, many-to-one or composite, with the reason.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'duplicate',
    label: 'Existing links',
    prompt: 'These types may already be linked. Should I reuse that link, or is this a different relationship?',
    clarity: 'No existing relationship between the two types means the same thing, or the user said why this one differs.',
    required: true,
    identity: true,
    dependents: ['name', 'specAccepted'],
  },
  {
    id: 'name',
    label: 'Code and name',
    prompt: 'What should it be called? I will suggest a code.',
    clarity: 'A name and an UPPER_SNAKE code that get_relationship_types does not already use.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the relationship I would create. Should I create it?',
    clarity: 'The user explicitly accepts the spec.',
    required: true,
    identity: true,
  },
];

const CHANGE_COMPLIANCE_SLOTS: SlotDef[] = [
  {
    id: 'rule',
    label: 'Rule',
    prompt: 'Which rule do you want to change?',
    clarity: 'One rule code returned by list_compliance_rules. Two rules with similar names stay ambiguous.',
    required: true,
    identity: true,
    dependents: ['current', 'change', 'newValue', 'effective', 'impact', 'specAccepted'],
  },
  {
    id: 'current',
    label: 'What it says today',
    prompt: 'Here is the rule as it stands today, with its current limit and scope. Is this the rule you mean?',
    clarity: 'The rule read with get_compliance_rule: its current version, limits, conditions and scope, stated back in one plain sentence, and the user agrees it is the one.',
    required: true,
    identity: true,
    dependents: ['change', 'newValue', 'specAccepted'],
  },
  {
    id: 'change',
    label: 'What changes',
    prompt: 'What should change: its name, category or description, whether it is active, the limit or the math, or who it applies to?',
    clarity: 'One of: name, category or description; stop or restart the rule; the math or limits (a new version); the scope (add or remove a record). Deleting a rule is not offered here.',
    required: true,
    dependents: ['newValue', 'effective', 'impact', 'specAccepted'],
  },
  {
    id: 'newValue',
    label: 'New value',
    prompt: 'What should it be instead?',
    clarity: 'The new values in the same units the rule uses (5% is 5 as a percentage unless the tool says otherwise). For a new version, only the fields that change, with attribute and relationship codes taken from tools. For scope, the named records and INCLUDE or EXCLUDE.',
    required: true,
    identity: true,
    dependents: ['impact', 'specAccepted'],
  },
  {
    id: 'effective',
    label: 'Effective from',
    prompt: 'From what date should the change apply?',
    clarity: 'A date, or "today", for a change to the math or limits. For any other change, resolved as not needed.',
    required: true,
    dependents: ['impact', 'specAccepted'],
  },
  {
    id: 'impact',
    label: 'What it affects',
    prompt: 'Here is what this changes and what it leaves alone. Is that what you expect?',
    clarity: 'The user has been told which funds the rule covers, that earlier versions and past results are kept, and that a stopped rule is no longer scored. For a limit that gets tighter, the breaches it could create are named when an evaluation shows them.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the change I would make. Should I make it?',
    clarity: 'The user explicitly accepts the rule, the change, the new value and the date. A single tool match is not acceptance.',
    required: true,
    identity: true,
  },
];

const DQ_RULE_SLOTS: SlotDef[] = [
  {
    id: 'domain',
    label: 'Entity type',
    prompt: 'Which entity type should the rule check?',
    clarity: 'A real domain code from list_domain_types.',
    required: true,
    identity: true,
    dependents: ['attribute', 'expression', 'specAccepted'],
  },
  {
    id: 'problem',
    label: 'The problem',
    prompt: 'What is wrong with a bad record? Give me an example of one that should fail.',
    clarity: 'A condition on named fields with a bad example, such as "maturity date before close date". "Bad data" does not pass.',
    required: true,
    dependents: ['attribute', 'type', 'expression', 'specAccepted'],
  },
  {
    id: 'attribute',
    label: 'Field',
    prompt: 'Which field is the rule about, or is it about the record as a whole?',
    clarity: 'One attribute code from search_attributes or get_template_metadata, or an explicit "the whole record".',
    required: true,
    identity: true,
    dependents: ['expression', 'specAccepted'],
  },
  {
    id: 'type',
    label: 'Kind of check',
    prompt: 'Is this a completeness, validity, consistency, timeliness or uniqueness check?',
    clarity: 'One of the five rule types. Missing values are completeness, impossible values are validity, two fields that disagree are consistency, stale values are timeliness and duplicates are uniqueness.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'expression',
    label: 'Failing condition',
    prompt: 'Here is the condition that marks a failing record. Does it say what you mean?',
    clarity: 'A SQL predicate that is TRUE for records that FAIL, tried with preview_dq_rule on real records. One that fails every record is probably the wrong way round. A blank meets no condition about its value, so MARKET_CAP < 0 does not fail a blank market cap.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'severity',
    label: 'Severity',
    prompt: 'How serious is a failure: critical, high, medium or low?',
    clarity: 'One of the four severities, and what it would block or who it would alert, if the user said.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'name',
    label: 'Code and name',
    prompt: 'What should the rule be called? I will suggest a code.',
    clarity: 'A name and an UPPER_SNAKE code that list_dq_rules does not already use. A near duplicate stays ambiguous.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the rule I would create. Should I create it?',
    clarity: 'The user explicitly accepts the spec.',
    required: true,
    identity: true,
  },
];

const OVERRIDE_SLOTS: SlotDef[] = [
  {
    id: 'record',
    label: 'Record',
    prompt: 'Which record is the value on?',
    clarity: 'One record found with list_entities or get_entity. Two records with the same name stay ambiguous.',
    required: true,
    identity: true,
    dependents: ['attribute', 'value', 'specAccepted'],
  },
  {
    id: 'attribute',
    label: 'Field',
    prompt: 'Which field should be overridden?',
    clarity: 'One attribute code from search_attributes or the record\'s template.',
    required: true,
    identity: true,
    dependents: ['value', 'specAccepted'],
  },
  {
    id: 'current',
    label: 'Current value',
    prompt: 'The field currently holds this value from this source. Is that the value you want to replace?',
    clarity: 'The prevailing value and its source, read with get_field_lineage, and the user knows which source is being outranked.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'value',
    label: 'New value',
    prompt: 'What should the value be?',
    clarity: 'A value in the field\'s own format: a date as YYYY-MM-DD, a percentage as the field stores it, a list value that exists.',
    required: true,
    identity: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'validFrom',
    label: 'Effective from',
    prompt: 'From what date should it apply?',
    clarity: 'A date. The override then wins over every other source from that date.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'reason',
    label: 'Reason',
    prompt: 'Why is the override needed? This is kept with the value.',
    clarity: 'A reason a reviewer would accept, such as "administrator figure is stale, confirmed by email". "Correction" does not pass.',
    required: true,
    dependents: ['specAccepted'],
  },
  {
    id: 'specAccepted',
    label: 'Spec',
    prompt: 'Here is the override I would store. Should I store it?',
    clarity: 'The user explicitly accepts the record, field, value, date and reason.',
    required: true,
    identity: true,
  },
];

const WRITE_RULES = `Write only in phase apply, and only what the ledger holds. Never call a write tool before the user has accepted the spec. Codes come from tools. After the last write, read the result back and tell the user exactly what was created and where it can be changed.`;

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
Design one narrative. A short report is one section; a review, briefing, or pack is several sections that mirror the reader's outline. Each section has: key, title, purpose (the question it answers), instructions (naming the query keys it may cite), dataQueries, optional comparisons (as-of dates such as last quarter, one year ago, an inception date taken from a parameter), measures (derived columns), screens (thresholds applied to every row, e.g. cushion under 15%), scenarios (rate shocks, a stress where the largest names stop paying), blocks, agentic ({"enabled":true} lets the section call read-only tools for what the queries cannot reach), research (web queries, only used when allowExternalSearch is true), dependsOn (sections written first; an executive summary depends on all the others), and batch ({"query","size"}) to review a long list a group at a time.
A block is { "type": "markdown"|"kpis"|"table"|"scorecard"|"chart"|"insights"|"callouts"|"sources", "key", "title", "guidance" }. Charts are bar, line, pie, stacked, waterfall (NAV bridge, gross-to-net), or heatmap (covenant headroom). Do not ask the model to invent a figure that no query, measure, screen, scenario, or dated source returns; say "data not available" instead. Pick screens and scenarios over asking the model to compute. Say which entity types the narrative should be offered on (exposedDomains) and whether it may research the web.
Check the design with validate_narrative before you propose it. A single-section narrative may still use instructions, dataQueries, and outputBlocks.
When phase is apply, end the visible reply with one fenced json block: { "narrativeName"?, "description"?, "persona"?, "audience"?, "rules"?, "exposedDomains"?, "allowExternalSearch"?, "sections"?, "instructions"?, "dataQueries"?, "parameters"?, "outputBlocks"? }. Included arrays replace the draft, so send them complete.
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
  {
    id: 'add-field',
    name: 'Field',
    toolContext: 'entity-admin',
    intro: 'I will check whether the field already exists before I add anything, and I will not add it until you confirm.',
    placeholder: 'Which entity type needs the field, and what does it hold?',
    startsWhen: 'You ask to add a field or attribute to an entity type.',
    discovery: [
      ['list_domain_types'],
      ['search_attributes', 'get_attribute_metadata'],
      ['get_template_metadata'],
    ],
    previewTools: [],
    writeTools: ['create_attribute', 'add_attribute_list_value', 'assign_attribute_to_template'],
    denyTools: ['create_domain_type', 'create_template', 'create_entity', 'create_entity_identifier', 'create_relationship_type', 'create_relationship', 'create_intersection', 'create_intersection_type', 'update_intersection'],
    slots: FIELD_SLOTS,
    prefix: `<model>
A field is one row in attribute_register, shown on an entity type through a template assignment.
- Reuse an existing attribute when the meaning and the data type match. "New" is a choice the user confirms after seeing the near matches.
- Data types: STRING, NUMBER, INTEGER, DECIMAL, BOOLEAN, DATE, TIMESTAMP, JSON, REFERENCE, REFERENCE_LIST, CURRENCY, PERCENTAGE, EMAIL, URL, PHONE. create_attribute accepts STRING, NUMBER, INTEGER, BOOLEAN, DATE, TIMESTAMP, JSON, CURRENCY and PERCENTAGE. A pick-list is a field with values added by add_attribute_list_value.
- A field that is calculated from other fields cannot be created here. Say so, and point to Admin, Attributes.
- Required means every record must have a value, which shows up as missing data when it has none. Ask before making a field required on a type that already has records.
</model>

<task>
Search before you propose: list_domain_types, search_attributes and get_template_metadata are required before you ask the user to confirm. Show the near matches by code, name and type. Ask only the open slot. Skip the allowed-values question unless the field is a pick-list: then mark it resolved with "not a pick-list".
When phase is apply: create the attribute only if it is new, add each list value, then assign it to the template with the order and required flag from the ledger. Read the template back. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
  {
    id: 'create-compliance-rule',
    name: 'Compliance rule',
    toolContext: 'compliance',
    intro: 'I will pin down what is measured, what it is compared with and the limit before I create the rule.',
    placeholder: 'What limit should the rule enforce?',
    startsWhen: 'You ask to create or add a compliance rule, limit or concentration test.',
    discovery: [
      ['list_compliance_rules'],
      ['list_domain_types'],
      ['get_template_metadata'],
      ['get_relationship_types'],
    ],
    previewTools: [],
    writeTools: ['create_compliance_rule', 'create_compliance_rule_version', 'create_compliance_scope_assignment'],
    denyTools: ['update_compliance_rule', 'delete_compliance_rule', 'delete_compliance_scope_assignment'],
    slots: COMPLIANCE_RULE_SLOTS,
    prefix: `<model>
A compliance rule is an identity plus a version that holds the math.
- Identity: ruleCode, ruleName, ruleCategory, anchorDomainCode (the record the limit applies to), appliesToAll.
- Version: baseDomainCode and baseRollupPath (the records that are aggregated and how they reach the anchor), numeratorAttributeCode and numeratorAggregation, denominatorScope (SAME_GROUP, ANCHOR_TOTAL or CONSTANT) with denominatorSource (BASE or ANCHOR) and a denominator attribute or constant, groupByAttributeCode or groupByPath, resultUnit, hardLimitValue and softLimitValue or softLimitFactor, conditions, validFrom.
- The limit direction is set per fund, so leave limitDirection off unless the user needs the legacy form. A hard limit is a breach. A soft limit is a warning.
- Scope: appliesToAll true covers every record of the anchor type. Otherwise add INCLUDE or EXCLUDE assignments for named records.
</model>

<avoid>
A duplicate ruleCode, an attribute or relationship code that no tool returned, a denominator that is not what the user described (the whole fund is ANCHOR_TOTAL, the same issuer is SAME_GROUP), limits in the wrong unit (5% is 5 as a PERCENTAGE unless the tool says otherwise), and creating the rule before the user has seen the plain-language reading.
</avoid>

<task>
Before you ask the user to confirm, state the rule back in one plain sentence, for example "For each fund, the sum of market value in one issuer divided by the fund's NAV must not exceed 5%, warning at 4.5%, from today, for every fund." Use list_compliance_rules to avoid a duplicate code. Take attribute and relationship codes only from get_template_metadata and get_relationship_types. Ask only the open slot.
When phase is apply, in this order: create_compliance_rule, create_compliance_rule_version, then create_compliance_scope_assignment for each record the scope names. Then evaluate_compliance_rule on a real record when you can, and report the result. If a write fails, stop, say what is already created, and ask. Do not delete anything yourself. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
  {
    id: 'change-compliance-rule',
    name: 'Change a compliance rule',
    toolContext: 'compliance',
    intro: 'I will read the rule as it is today and tell you what the change affects before I make it.',
    placeholder: 'Which rule, and what should change?',
    startsWhen: 'You ask to change, edit, tighten, loosen, stop or restart a compliance rule, or to add or remove a record from its scope.',
    discovery: [
      ['list_compliance_rules'],
      ['get_compliance_rule'],
    ],
    previewTools: [],
    writeTools: ['update_compliance_rule', 'create_compliance_rule_version', 'create_compliance_scope_assignment', 'delete_compliance_scope_assignment'],
    denyTools: ['create_compliance_rule', 'delete_compliance_rule'],
    slots: CHANGE_COMPLIANCE_SLOTS,
    prefix: `<model>
A change to a rule is one of four things, and each has its own tool.
- Name, category, description or active flag: update_compliance_rule. It does not change the math.
- The math or the limits: create_compliance_rule_version with changeReason and validFrom. The old version is kept and the new one is current from validFrom. Send the complete version, so read the current one first and carry over every field that is not changing.
- Stopping a rule: update_compliance_rule with isActive false. History is kept and the rule is no longer scored. Restarting it is isActive true.
- Scope: create_compliance_scope_assignment adds INCLUDE or EXCLUDE for a named record. delete_compliance_scope_assignment removes one row, with the id from get_compliance_rule.
</model>

<avoid>
A rule code that list_compliance_rules did not return, changing the math with update_compliance_rule, a new version that drops a condition or limit the user did not mention, limits in the wrong unit, and deleting a rule. Deletion removes its versions and evaluation history, so it is not offered here: tell the user to stop the rule instead, and that a delete is made by an administrator in Admin.
</avoid>

<task>
Find the rule with list_compliance_rules, then read it with get_compliance_rule. Say back what it measures, what it is compared with, its limits and its scope in one plain sentence before you ask anything else. Ask only the open slot.
Before you ask the user to confirm, say what the change affects: the funds the rule covers, that earlier versions and past results are kept, and, for a stopped rule, that it is no longer scored. Where you can, run evaluate_compliance_rule on a real record to show what the new limit would report.
When phase is apply, make only the change in the ledger, then read the rule back with get_compliance_rule and tell the user what it says now. If a write fails, stop, say what has already changed, and ask. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
  {
    id: 'start-workflow',
    name: 'Workflow run',
    toolContext: 'workflow',
    intro: 'I will find the workflow, learn what it asks for and confirm the records before I start it.',
    placeholder: 'Which workflow, and which records?',
    startsWhen: 'You ask to start, run or launch a workflow.',
    discovery: [['list_workflows']],
    previewTools: [],
    writeTools: ['start_workflow_run'],
    denyTools: [],
    slots: WORKFLOW_SLOTS,
    prefix: `<model>
A workflow is a saved set of steps. A run starts from a published version. A workflow works on one type of record (appliesTo) or any. When requiresRecords is true a run must name records. It also asks for the values in inputs, each with a key, a label and a type of text, date or number.
Starting a run does real work: it can call tools, write records and wait for people to review. It cannot be undone from here.
</model>

<task>
Call list_workflows first and match the user's words to one published workflow by name or description. Two close matches stay ambiguous: list them with what tells them apart. A workflow that is not published cannot be started: say so.
Read appliesTo, requiresRecords and inputs from list_workflows. Find the records with list_entities for that type, using the user's words, and show the names and codes you matched. Ask for each input value by its label. Skip the records question if the workflow requires none and works on any type: mark it resolved with "no records needed".
Before you ask the user to confirm, list the workflow, the records by name and every value. When phase is apply call start_workflow_run once with input.filters ({ "domainCode", "entityIds" }) and each input value under its key. Report the run id and status, and say where the run can be followed. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
  {
    id: 'create-relationship-type',
    name: 'Relationship type',
    toolContext: 'entity-admin',
    intro: 'I will check how the two types already connect before I create a new relationship.',
    placeholder: 'Which two entity types should be linked, and how?',
    startsWhen: 'You ask to create or add a relationship type between two entity types.',
    discovery: [['list_domain_types'], ['get_relationship_types']],
    previewTools: [],
    writeTools: ['create_relationship_type'],
    denyTools: ['create_domain_type', 'create_attribute', 'create_template', 'assign_attribute_to_template', 'create_entity', 'create_entity_identifier', 'create_relationship', 'create_intersection', 'create_intersection_type', 'update_intersection'],
    slots: RELATIONSHIP_TYPE_SLOTS,
    prefix: `<model>
A relationship type defines how two entity types connect. It has a parent type, a child type and a cardinality: ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE or COMPOSITE. Compliance rules and roll-ups follow relationship types, so the direction matters: a rule that rolls positions up to a fund follows the position-to-fund relationship in a particular direction.
This skill defines the type only. It does not link any two records. Linking records is done on the records.
</model>

<avoid>
A parent and child the wrong way round, a type that duplicates an existing one with a new code, a cardinality that contradicts the user's sentence, and a code the user has not seen.
</avoid>

<task>
Call list_domain_types and get_relationship_types before you ask the user to confirm. List every relationship that already connects the two types, in either direction, with its code and cardinality, and ask whether to reuse one. Restate the sentence the user gave in the form "<parent> <verb> <child>", then the cardinality in plain words ("one fund has many positions; a position belongs to one fund").
When phase is apply call create_relationship_type once, then read it back with get_relationship_types. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
  {
    id: 'create-dq-rule',
    name: 'Data quality rule',
    toolContext: 'data-quality',
    intro: 'I will try the rule on real records before I create it, so you can see what it would catch.',
    placeholder: 'Which entity type, and what is wrong with a bad record?',
    startsWhen: 'You ask to create or add a data quality rule or validation.',
    discovery: [
      ['list_dq_rules'],
      ['list_domain_types'],
      ['search_attributes', 'get_template_metadata', 'get_attribute_metadata'],
    ],
    previewTools: ['preview_dq_rule'],
    writeTools: ['create_dq_rule'],
    denyTools: ['resolve_dq_exception'],
    slots: DQ_RULE_SLOTS,
    prefix: `<model>
A data quality rule has a type (COMPLETENESS, VALIDITY, CONSISTENCY, TIMELINESS or UNIQUENESS), a severity (CRITICAL, HIGH, MEDIUM or LOW) and an expression. The expression is a SQL predicate that is TRUE for a record that FAILS the rule, written against lowercase attribute codes. For example "maturity_date < close_date" fails a record whose maturity is before its close, and "price IS NULL" fails a record with no price.
Writing it the wrong way round is the common mistake: an expression that describes a good record fails every record that is fine.
</model>

<task>
Call list_dq_rules, list_domain_types and search_attributes before you ask the user to confirm. If a rule already covers the problem, say so and ask whether to change that rule in Admin, Data quality rules instead.
Write the expression from the user's description, using attribute codes the tools returned. Then call preview_dq_rule on that entity type and show how many of the sampled records would fail and a few examples. If it fails nearly every record, or none the user expected, say so and revise. If it returns an error, fix the expression and try again. The user must have seen the preview before you ask for confirmation.
When phase is apply call create_dq_rule once, then say what it will now catch and that it shows on the data quality page. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
  {
    id: 'manual-override',
    name: 'Manual override',
    toolContext: 'lineage',
    intro: 'I will show what the field holds now and where it comes from before I store an override.',
    placeholder: 'Which record and field, and what should the value be?',
    startsWhen: 'You ask to override, overwrite or manually set a value on a record.',
    discovery: [
      ['get_entity', 'list_entities'],
      ['search_attributes', 'get_attribute_metadata'],
      ['get_field_lineage'],
    ],
    previewTools: [],
    writeTools: ['submit_manual_override'],
    denyTools: [],
    slots: OVERRIDE_SLOTS,
    prefix: `<model>
A manual override stores a Manual Entry value on one record. An open manual value outranks every other source for that field from its effective date, so it replaces what the administrator or any feed sends until it is cleared. It is kept with its reason and the person who made it.
</model>

<avoid>
Overriding a calculated field (it is derived from others and would be recomputed), overriding the wrong record because two share a name, a value in the wrong format, and a reason that does not say why.
</avoid>

<task>
Find the record with list_entities or get_entity, the field with search_attributes, and read the field's lineage with get_field_lineage as of the date the user wants. Tell the user the current value, its source and any competing values before you ask for the new one. If the field is calculated, say it cannot be overridden and stop.
Check the new value against the field's data type (get_attribute_metadata): dates as YYYY-MM-DD, numbers without symbols, a list value that exists.
When phase is apply call submit_manual_override once with entityId, attributeCode, value, validFrom and overrideReason, then read the lineage again and show that the manual value now prevails. ${WRITE_RULES}
</task>`,
    artifacts: [],
  },
];

const SKILL_BY_ID = Object.fromEntries(SKILLS.map((skill) => [skill.id, skill])) as Record<SkillId, SkillDef>;

export function skillById(id: unknown): SkillDef | null {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SKILL_BY_ID, id) ? SKILL_BY_ID[id as SkillId] : null;
}

/** Starts a skill from an explicit designer selection or from a request to create, start or change something. */
export function skillFromUserText(text: string): SkillDef | null {
  const wantsToStart = /\b(start|run|launch|kick off|trigger)\b/i.test(text);
  if (wantsToStart && /\bworkflows?\b/i.test(text)) return SKILL_BY_ID['start-workflow'];

  // A question about overrides is not a request to make one.
  if (/\b(override|overwrite)\s+(the|a|an|this|that|its|their|our)\b/i.test(text)
    || /\b(apply|submit|enter|make|create|add|store|put in)\b[^.?!]{0,30}\boverride\b/i.test(text)) {
    return SKILL_BY_ID['manual-override'];
  }

  // Changing a rule that exists is not creating one.
  if (/\b(change|edit|update|modify|amend|raise|lower|tighten|loosen|stop|retire|deactivate|disable|restart|reactivate)\b[^.?!]{0,40}\b(compliance\s+)?(rule|limit)\b/i.test(text)
    && /\b(compliance|concentration|exposure|leverage|diversification|liquidity|limit)\b/i.test(text)
    && !/^\s*(what|which|who|how|why|when|where|show|list|is|are|does|do)\b/i.test(text)) {
    return SKILL_BY_ID['change-compliance-rule'];
  }

  const create = /\b(create|design|build|add|draft|make|define|set up|write)\b/i.test(text);
  if (!create) return null;
  if (/\bnarrative\b/i.test(text)) return SKILL_BY_ID['design-narrative'];
  if (/\bdashboard\b/i.test(text)) return SKILL_BY_ID['design-dashboard'];
  if (/\b(data quality|dq|validation)\b[^.?!]{0,30}\b(rule|check|test)\b/i.test(text)) return SKILL_BY_ID['create-dq-rule'];
  if (/\bcompliance\b[^.?!]{0,30}\b(rule|limit|test)\b|\b(concentration|exposure|leverage|diversification|liquidity)\s+(rule|limit|test)\b/i.test(text)) {
    return SKILL_BY_ID['create-compliance-rule'];
  }
  if (/\brelationship types?\b/i.test(text)) return SKILL_BY_ID['create-relationship-type'];
  if (/\b(entity type|new domain|template)\b/i.test(text)) return SKILL_BY_ID['create-entity'];
  if (/\b(attribute|field)\b/i.test(text)) return SKILL_BY_ID['add-field'];
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

const PROPOSAL_KEYS = [
  'dashboardName', 'narrativeName', 'htmlTemplate', 'instructions', 'dataQueries', 'parameters', 'outputBlocks',
  'sections', 'persona', 'audience', 'rules', 'exposedDomains', 'allowExternalSearch',
];

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
