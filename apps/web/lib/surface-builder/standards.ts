/**
 * The house standards every surface meets, as data. The Surface Builder checks
 * a prototype against them and writes each into the build instructions, so a
 * new surface starts with the right-click, editing, assistant and guardrail
 * behaviour the rest of the platform has.
 *
 * Each standard names the doc or module that is its source of truth. Keep them
 * in step with those files; do not restate a rule here that they do not hold.
 */
import type { PrototypeOutline } from './prototype';

export type StandardArea = 'interaction' | 'assistant' | 'data' | 'guardrail' | 'ux';

export interface SurfaceStandard {
  id: string;
  area: StandardArea;
  title: string;
  /** What the surface must do, in one or two sentences. */
  rule: string;
  /** How to meet it in this codebase. */
  howTo: string;
  /** Files or docs that hold the rule. */
  references: string[];
}

export const SURFACE_STANDARDS: SurfaceStandard[] = [
  {
    id: 'right-click-inspect',
    area: 'interaction',
    title: 'Right-click opens the value\u2019s sources',
    rule: 'Every figure or field that comes from an attribute is bound to its entity and attribute, and right-click opens the source panel (sources, history, golden value, override).',
    howTo: 'Wrap the value in InspectValue with attrBind(entityId, domainCode, attributeCode, name), or call useInspectBind() from a context provider as FundSurface does. Values with no attribute (a derived total) render unbound and say how they are derived.',
    references: ['apps/web/components/detail/InspectValue.tsx', 'apps/web/components/detail/AttributeInspect.tsx', 'apps/web/components/funds/FundSurface.tsx'],
  },
  {
    id: 'inline-edit',
    area: 'interaction',
    title: 'Editable values edit in place',
    rule: 'A value a user may correct edits in place and writes through the golden-record path as a manual value with its source, never by updating a row directly.',
    howTo: 'Use AttributeCellEditor or SourceAttributedFieldRow, with inlineDraft and inlineCommitValue from lib/inline-field.ts. Writes go through the existing attribute value and override mutations, so precedence, history and audit apply.',
    references: ['apps/web/lib/inline-field.ts', 'apps/web/components/entities/AttributeCellEditor.tsx', 'apps/web/components/detail/SourceAttributedFieldRow.tsx', 'packages/graphql/src/lib/golden-write.ts'],
  },
  {
    id: 'publish-tabs',
    area: 'assistant',
    title: 'Every tab is published to the assistant',
    rule: 'All tabs publish label, purpose and data (and howToRead where a term or sign could be misread), open or not. A tab still loading publishes data: null.',
    howTo: 'One load: usePublishTabs. Each tab loads its own data: usePublishTab with useWarmTabs, rendering each tab in <div hidden>. An SDK surface calls host.usePublishTabs. Build data from the same variables the tab draws; cap lists, totals first; strip sources with withoutSources.',
    references: ['docs/SURFACE_TABS.md', 'apps/web/lib/view-context.ts'],
  },
  {
    id: 'view-focus',
    area: 'assistant',
    title: 'The page tells the assistant what record is open',
    rule: 'A surface anchored on a record publishes its focus, so the assistant knows which entity the user means.',
    howTo: 'usePublishViewContext(entityViewFocus(entity)); a hidden tab component passes null when inactive.',
    references: ['apps/web/lib/view-context.ts'],
  },
  {
    id: 'temporal-dates',
    area: 'data',
    title: 'As Of and Knowledge dates apply',
    rule: 'Every figure is loaded with the user\u2019s As Of and Knowledge dates, and the surface reloads when they change.',
    howTo: 'Pass asOfDate and knowledgeDate to every query (host.asOfDate in the SDK). Never default to today on the server.',
    references: ['docs/BI_TEMPORAL.md', 'apps/web/lib/temporal.ts'],
  },
  {
    id: 'attributes-not-columns',
    area: 'data',
    title: 'Fields are attributes, not new columns',
    rule: 'A field the surface shows is an attribute of an entity type, or a calculation over attributes. A new field is added as an attribute (seeded), not as a table column.',
    howTo: 'Reuse the matched attribute codes. Add new ones with the Field skill (add-field) or a seed file; add derived figures as calculated attributes or a data query.',
    references: ['docs/ARCHITECTURE.md', 'packages/mcp-server/src/lib/chat-skills.ts'],
  },
  {
    id: 'no-codes-in-code',
    area: 'guardrail',
    title: 'No code names a client, rule or entity by its code',
    rule: 'The surface\u2019s behaviour for one client or entity lives in data: rule metadata, a fund threshold, a client flag or an id passed in.',
    howTo: 'Gate a client surface with manifest.clients, not an if on client_code. Read differences from attributes or rule metadata.',
    references: ['docs/GUARDRAILS.md', 'scripts/guard/check-static.mjs'],
  },
  {
    id: 'one-interpreter',
    area: 'guardrail',
    title: 'One interpreter per concept',
    rule: 'Compliance, scoring plans and capacity are read from their one engine; the surface calls them and does not reimplement them.',
    howTo: 'compliance.evaluate_rule, compliance.deal_score_plans and compliance-capacity.ts. Reuse the existing GraphQL or tool that already reads them.',
    references: ['docs/GUARDRAILS.md'],
  },
  {
    id: 'migrations-schema-only',
    area: 'guardrail',
    title: 'Migrations change schema; records go in seed',
    rule: 'New attributes, entity types, relationship types and surface catalog rows are records and go in supabase/seed. A migration only changes schema or functions, and an applied one is never edited.',
    howTo: 'Add seed files for catalog rows. Add a new migration only for a new table or function. Run npm run guard.',
    references: ['docs/MIGRATIONS.md', 'docs/GUARDRAILS.md'],
  },
  {
    id: 'sdk-boundary',
    area: 'guardrail',
    title: 'A client surface uses only the surface SDK',
    rule: 'A surface under surfaces/<code>/ imports only React, @tapestrai/surface-sdk, @tapestrai/ui and its own files.',
    howTo: 'Use useSurfaceHost(): query, mutate, href, navigate, asOfDate, permissions, usePublishTabs. Register it in apps/web/lib/surface-registry.ts. npm run lint:surfaces checks it.',
    references: ['surfaces/README.md', 'packages/surface-sdk/src/index.ts'],
  },
  {
    id: 'agent-proposes',
    area: 'guardrail',
    title: 'An agent proposes, a person approves, a fixed step applies',
    rule: 'An agentic capability the surface starts reads with read-only tools and proposes changes; a person approves; a fixed step applies them.',
    howTo: 'Build it as a workflow (Agent step, Human review step, Apply approved changes). Mark any tool that writes or sends data outside explicitly.',
    references: ['docs/WORKFLOWS.md', 'packages/graphql/src/lib/workflow-graph.ts'],
  },
  {
    id: 'states',
    area: 'ux',
    title: 'Loading, empty and error states',
    rule: 'Every tab and panel shows a loading state, an empty state that says why, and an error that says what to do.',
    howTo: 'Use the view-fade wrapper and the existing empty and error patterns; never a blank panel.',
    references: ['apps/web/styles/globals.css'],
  },
  {
    id: 'design-system',
    area: 'ux',
    title: 'House design system',
    rule: 'Dense and editorial: tabular numerals, right-aligned figures, one accent, 1px low-contrast borders, 8px radius, no shadows or gradients, direct chart labels.',
    howTo: 'Use the host classes (page-header, crumbs, da-tabs, da-* and pipe-* panels) and @tapestrai/ui. Do not ship a surface stylesheet or load external fonts or chart libraries.',
    references: ['packages/mcp-server/src/lib/chat-skills.ts (DESIGN_SYSTEM)', 'packages/ui/src'],
  },
  {
    id: 'crumbs-and-links',
    area: 'ux',
    title: 'Crumbs and record links',
    rule: 'The surface sets its crumbs and links every record name to its golden record.',
    howTo: 'host.useCrumbs / the crumbs header; surface-links.ts for record hrefs.',
    references: ['apps/web/lib/surface-links.ts', 'apps/web/lib/surface-nav.ts'],
  },
];

export type FindingLevel = 'meets' | 'gap' | 'todo';

export interface StandardFinding {
  id: string;
  title: string;
  area: StandardArea;
  level: FindingLevel;
  /** What the prototype shows, and what the build must add. */
  note: string;
}

/**
 * Check the prototype against each standard. A prototype is static, so most
 * standards are "todo": the build must add them. A "gap" is something the
 * prototype does that the standard forbids, which the build must change.
 */
export function checkStandards(outline: PrototypeOutline): StandardFinding[] {
  const figures = outline.fields.filter((field) => field.kind !== 'input').length
    + outline.tables.reduce((sum, table) => sum + table.columns.length, 0);
  return SURFACE_STANDARDS.map((standard) => {
    const finding = (level: FindingLevel, note: string): StandardFinding => ({ id: standard.id, title: standard.title, area: standard.area, level, note });
    switch (standard.id) {
      case 'right-click-inspect':
        return outline.signals.contextMenu
          ? finding('todo', `The prototype has a context menu. Replace it with the house source panel on each of the ${figures} bound values.`)
          : finding('todo', `Bind each of the ${figures} figures and columns to its attribute so right-click opens its sources.`);
      case 'inline-edit':
        return outline.signals.inlineEdit
          ? finding('todo', 'The prototype edits values in the page. Route every edit through AttributeCellEditor and the golden write path.')
          : finding('todo', 'Decide which values are editable; make those inline-editable through the golden write path and keep the rest read-only.');
      case 'publish-tabs':
        return outline.tabs.length > 0
          ? finding('todo', `Publish all ${outline.tabs.length} tabs (${outline.tabs.join(', ')}) with label, purpose and data.`)
          : finding('todo', 'The prototype has no tabs. Publish the page\u2019s story with usePublishPageData, or one tab if it grows tabs.');
      case 'temporal-dates':
        return outline.signals.asOfDate
          ? finding('meets', 'The prototype shows an As Of date. Wire it to the user\u2019s As Of and Knowledge dates, not a local picker.')
          : finding('todo', 'Show the As Of date the figures are read at and load every query with the user\u2019s dates.');
      case 'design-system':
        return outline.signals.externalScripts.length > 0
          ? finding('gap', `The prototype loads ${outline.signals.externalScripts.length} external script(s) (${outline.signals.externalScripts.slice(0, 3).join(', ')}). Replace with host charts and classes.`)
          : finding('todo', 'Restyle with host classes; drop prototype-only CSS.');
      case 'states':
        return outline.signals.emptyState && outline.signals.loadingState
          ? finding('meets', 'The prototype draws loading and empty states. Keep them and add an error state.')
          : finding('todo', `Add ${[!outline.signals.loadingState && 'loading', !outline.signals.emptyState && 'empty', 'error'].filter(Boolean).join(', ')} states for every tab.`);
      default:
        return finding('todo', standard.rule);
    }
  });
}
