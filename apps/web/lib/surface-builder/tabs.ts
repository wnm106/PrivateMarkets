/**
 * The Surface Builder's tabs, and what each tells the assistant. Built from the
 * same blueprint the tabs draw, so the screen and the assistant agree.
 */
import type { TabPayload } from '@/lib/view-context';
import type { SurfaceBlueprint } from './blueprint';

export const BUILDER_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'entities', label: 'Entities & attributes' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'workflows', label: 'Agentic workflows' },
  { key: 'standards', label: 'Standards & guardrails' },
  { key: 'build', label: 'Build plan' },
  { key: 'artifacts', label: 'HTML artifacts' },
] as const;

export type BuilderTabKey = typeof BUILDER_TABS[number]['key'];

const CAP = 60;

function count<T>(items: T[], test: (item: T) => boolean): number {
  return items.reduce((sum, item) => sum + (test(item) ? 1 : 0), 0);
}

export function builderTabs(blueprint: SurfaceBlueprint | null): Record<BuilderTabKey, TabPayload> {
  const b = blueprint;
  const label = (key: BuilderTabKey) => BUILDER_TABS.find((tab) => tab.key === key)!.label;
  return {
    overview: {
      label: label('overview'),
      purpose: 'What the prototype shows and how much of it the platform already covers.',
      howToRead: 'Source "baseline" means no model refined the draft. Warnings list catalog parts that could not be read and model codes that were rejected.',
      data: b ? {
        surface: b.request.name,
        summary: b.summary,
        source: b.source,
        prototype: { title: b.outline.title, tabs: b.outline.tabs, tables: b.outline.tables.length, charts: b.outline.charts.length, actions: b.outline.actions.slice(0, 30) },
        tabsPlanned: b.tabs.map((tab) => tab.label),
        openQuestions: b.openQuestions,
        warnings: b.warnings.slice(0, 20),
      } : null,
    },
    entities: {
      label: label('entities'),
      purpose: 'Which existing attributes each prototype value maps to, and which attributes must be added.',
      howToRead: 'reuse = an existing attribute code; new = add as a seed record; derived = computed from other attributes; ui = a label with no data. Only reuse codes exist in the catalog today.',
      data: b ? {
        totals: {
          values: b.fields.length,
          reuse: count(b.fields, (field) => field.decision === 'reuse'),
          new: count(b.fields, (field) => field.decision === 'new'),
          derived: count(b.fields, (field) => field.decision === 'derived'),
          editable: count(b.fields, (field) => field.editable === true),
        },
        newAttributes: b.newAttributes.slice(0, CAP).map((attribute) => ({ code: attribute.code, name: attribute.name, entityType: attribute.domainCode, type: attribute.dataType, reason: attribute.reason })),
        fields: b.fields.slice(0, CAP).map((field) => ({ label: field.label, tab: field.where, decision: field.decision, attribute: field.attributeCode, entityType: field.domainCode, editable: field.editable || undefined, note: field.note })),
        relationships: b.relationships,
      } : null,
    },
    capabilities: {
      label: label('capabilities'),
      purpose: 'The functional requirements the surface needs and whether a tool or query already meets each.',
      howToRead: 'exists = a registered tool or query does it; extend = one needs a change; new = it must be built.',
      data: b ? {
        totals: { exists: count(b.capabilities, (c) => c.status === 'exists'), extend: count(b.capabilities, (c) => c.status === 'extend'), new: count(b.capabilities, (c) => c.status === 'new') },
        capabilities: b.capabilities.slice(0, CAP).map((c) => ({ title: c.title, status: c.status, kind: c.kind, detail: c.detail, tools: c.tools })),
      } : null,
    },
    workflows: {
      label: label('workflows'),
      purpose: 'Agentic workflows needed to deliver capabilities a single query cannot.',
      howToRead: 'Steps are agent (reads and proposes), human (reviews or answers) or fixed (applies approved changes). An agent never writes directly.',
      data: b ? { workflows: b.workflows.map((w) => ({ name: w.name, trigger: w.trigger, outcome: w.outcome, steps: w.steps.map((s) => `${s.kind}: ${s.title}`) })) } : null,
    },
    standards: {
      label: label('standards'),
      purpose: 'Whether the surface will meet each house standard: right-click inspect, inline edit, tab publishing, dates, guardrails and design.',
      howToRead: 'meets = the prototype already does it; todo = the build must add it; gap = the prototype does something the standard forbids.',
      data: b ? {
        totals: { meets: count(b.standards, (s) => s.level === 'meets'), todo: count(b.standards, (s) => s.level === 'todo'), gap: count(b.standards, (s) => s.level === 'gap') },
        standards: b.standards.map((s) => ({ title: s.title, area: s.area, level: s.level, note: s.note })),
        uxNotes: b.uxNotes,
      } : null,
    },
    build: {
      label: label('build'),
      purpose: 'The ordered build steps and the files each touches.',
      data: b ? { steps: b.buildSteps.map((step, index) => ({ step: index + 1, title: step.title, detail: step.detail, files: step.files })) } : null,
    },
    artifacts: {
      label: label('artifacts'),
      purpose: 'Refined or additional HTML the build needs, such as a refined prototype with every value bound to its attribute.',
      data: b ? { artifacts: b.artifacts.map((artifact) => ({ title: artifact.title, purpose: artifact.purpose, hasHtml: Boolean(artifact.html), sizeKb: artifact.html ? Math.round(artifact.html.length / 1000) : 0 })) } : null,
    },
  };
}
