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
  /**
   * How to meet it in a client surface (surfaces/<code>/), which may not import the app.
   * When absent, howTo applies as written.
   */
  howToSdk?: string;
  /** What must be true of the built surface, each line checkable by measuring or reading it. */
  accept: string[];
  /** Files or docs that hold the rule. */
  references: string[];
}

export type SurfacePlacement = 'record-tab' | 'sdk-surface' | 'app-page';

/** How to meet a standard where the surface is being built. An SDK surface is never told to import the app. */
export function standardHowTo(standard: SurfaceStandard, placement?: SurfacePlacement | null): string {
  return placement === 'sdk-surface' && standard.howToSdk ? standard.howToSdk : standard.howTo;
}

export function standardById(id: string): SurfaceStandard | undefined {
  return SURFACE_STANDARDS.find((standard) => standard.id === id);
}

export const SURFACE_STANDARDS: SurfaceStandard[] = [
  {
    id: 'right-click-inspect',
    area: 'interaction',
    title: 'Right-click opens the value\u2019s sources',
    rule: 'Every value on every tab answers right-click. A value that comes from an attribute opens the source panel (sources, history, golden value, override) for its entity and attribute. A figure worked out from other values opens how it is worked out and the records behind it. This holds everywhere a value is drawn: ribbons, grid cells, editable inputs, rails, side lists, cards, totals and footers. A grid whose cells all come from one attribute binds each cell, not the table or a footnote under it.',
    howTo: 'Wrap the value in InspectValue with attrBind(entityId, domainCode, attributeCode, name), or call useInspectBind() from a context provider as FundSurface does. A derived figure gets a right-click panel that states the formula and lists the records it adds up, each bound in turn. Keep data-attr on bound values and data-derived on derived ones so the acceptance script can count them. Show a hover affordance (a dotted underline) so a person can tell a value is inspectable.',
    howToSdk: 'Call host.inspectAttribute({ entityId, entityName, domainCode, attributeCode, attributeName, value }) from onContextMenu, through one shared component, and render data-attr on the element. An editable input opens its sources on right-click unless it is already being typed in. A derived figure gets a right-click panel that states the formula and lists the records it adds up, each bound in turn; render data-derived on it. Show a hover affordance (a dotted underline). Do not import InspectValue: a surface may not import the app.',
    accept: [
      'On every tab, the acceptance script reports 0 figures that do not answer right-click.',
      'Each tab shows at least as many bound values as its file in views/ has data-attr.',
      'Right-click on a grid cell, a ribbon figure, a rail figure and a side-list figure each opens a panel (tried by hand, one of each).',
    ],
    references: ['apps/web/components/detail/InspectValue.tsx', 'apps/web/components/detail/AttributeInspect.tsx', 'apps/web/components/funds/FundSurface.tsx'],
  },
  {
    id: 'inline-edit',
    area: 'interaction',
    title: 'Editable values edit in place',
    rule: 'A value a user may correct edits in place and writes through the golden-record path as a manual value with its source, never by updating a row directly.',
    howTo: 'Use AttributeCellEditor or SourceAttributedFieldRow, with inlineDraft and inlineCommitValue from lib/inline-field.ts. Writes go through the existing attribute value and override mutations, so precedence, history and audit apply.',
    howToSdk: 'Edit in place and write with host.mutate through the submitManualOverride mutation, effective from host.asOfDate, with a reason that says what changed. Show the change at once, put it back if the write is refused, and offer undo. Every element marked data-editable in views/ is editable where it stands.',
    accept: [
      'Every element marked data-editable in views/ edits in place in the build, or is listed under "Left out" with the reason.',
      'A refused write puts the old value back and says why.',
    ],
    references: ['apps/web/lib/inline-field.ts', 'apps/web/components/entities/AttributeCellEditor.tsx', 'apps/web/components/detail/SourceAttributedFieldRow.tsx', 'packages/graphql/src/lib/golden-write.ts'],
  },
  {
    id: 'publish-tabs',
    area: 'assistant',
    title: 'Every tab is published to the assistant',
    rule: 'All tabs publish label, purpose and data (and howToRead where a term or sign could be misread), open or not. A tab still loading publishes data: null.',
    howTo: 'One load: usePublishTabs. Each tab loads its own data: usePublishTab with useWarmTabs, rendering each tab in <div hidden>. An SDK surface calls host.usePublishTabs. Build data from the same variables the tab draws; cap lists, totals first; strip sources with withoutSources.',
    accept: [
      'Every tab and top-level view is in the published record, open or not, with label, purpose and data.',
      'A tab that has not loaded publishes data: null.',
    ],
    references: ['docs/SURFACE_TABS.md', 'apps/web/lib/view-context.ts'],
  },
  {
    id: 'view-focus',
    area: 'assistant',
    title: 'The page tells the assistant what record is open',
    rule: 'A surface anchored on a record publishes its focus, so the assistant knows which entity the user means.',
    howTo: 'usePublishViewContext(entityViewFocus(entity)); a hidden tab component passes null when inactive.',
    howToSdk: 'Call host.usePublishFocus({ entityId, entityName, entityCode, domainCode, summary, snapshot }) with the record that is open, and null when none is.',
    accept: ['With a record open, the assistant\u2019s view focus names that record; with none open it is cleared.'],
    references: ['apps/web/lib/view-context.ts'],
  },
  {
    id: 'temporal-dates',
    area: 'data',
    title: 'As Of and Knowledge dates apply',
    rule: 'Every figure is loaded with the user\u2019s As Of and Knowledge dates, and the surface reloads when they change.',
    howTo: 'Pass asOfDate and knowledgeDate to every query (host.asOfDate in the SDK). Never default to today on the server.',
    accept: ['Changing the As Of date reloads the surface and changes its figures.'],
    references: ['docs/BI_TEMPORAL.md', 'apps/web/lib/temporal.ts'],
  },
  {
    id: 'attributes-not-columns',
    area: 'data',
    title: 'Fields are attributes, not new columns',
    rule: 'A field the surface shows is an attribute of an entity type, or a calculation over attributes. A new field is added as an attribute (seeded), not as a table column.',
    howTo: 'Reuse the matched attribute codes. Add new ones with the Field skill (add-field) or a seed file; add derived figures as calculated attributes or a data query. Use the attribute codes the blueprint names, exactly. If a code has to differ, say so and list the mapping; do not rename quietly.',
    accept: ['Every attribute code in the build is one the blueprint names, or is in a mapping table in the hand-back.'],
    references: ['docs/ARCHITECTURE.md', 'packages/mcp-server/src/lib/chat-skills.ts'],
  },
  {
    id: 'no-codes-in-code',
    area: 'guardrail',
    title: 'No code names a client, rule or entity by its code',
    rule: 'The surface\u2019s behaviour for one client or entity lives in data: rule metadata, a fund threshold, a client flag or an id passed in.',
    howTo: 'Gate a client surface with manifest.clients, not an if on client_code. Read differences from attributes or rule metadata.',
    accept: ['npm run guard passes.'],
    references: ['docs/GUARDRAILS.md', 'scripts/guard/check-static.mjs'],
  },
  {
    id: 'one-interpreter',
    area: 'guardrail',
    title: 'One interpreter per concept',
    rule: 'Compliance, scoring plans and capacity are read from their one engine; the surface calls them and does not reimplement them.',
    howTo: 'compliance.evaluate_rule, compliance.deal_score_plans and compliance-capacity.ts. Reuse the existing GraphQL or tool that already reads them. A calculation the blueprint lists runs in the home it names. If the blueprint names no home for a figure the surface must work out, stop and ask where it runs before writing it inside the surface.',
    accept: ['No rule is evaluated in the surface.', 'Every calculation runs where the blueprint says, or the hand-back lists the ones that run in the surface and why.'],
    references: ['docs/GUARDRAILS.md'],
  },
  {
    id: 'migrations-schema-only',
    area: 'guardrail',
    title: 'Migrations change schema; records go in seed',
    rule: 'New attributes, entity types, relationship types and surface catalog rows are records and go in supabase/seed. A migration only changes schema or functions, and an applied one is never edited.',
    howTo: 'Add seed files for catalog rows. Add a new migration only for a new table or function. Run npm run guard.',
    accept: ['npm run guard passes; no applied migration is edited.'],
    references: ['docs/MIGRATIONS.md', 'docs/GUARDRAILS.md'],
  },
  {
    id: 'sdk-boundary',
    area: 'guardrail',
    title: 'A client surface uses only the surface SDK',
    rule: 'A surface under surfaces/<code>/ imports only React, @tapestrai/surface-sdk, @tapestrai/ui and its own files.',
    howTo: 'Use useSurfaceHost(): query, mutate, href, navigate, asOfDate, permissions, usePublishTabs, usePublishFocus, inspectAttribute. Register it in apps/web/lib/surface-registry.ts. npm run lint:surfaces checks it.',
    accept: ['npm run lint:surfaces passes.'],
    references: ['surfaces/README.md', 'packages/surface-sdk/src/index.ts'],
  },
  {
    id: 'agent-proposes',
    area: 'guardrail',
    title: 'An agent proposes, a person approves, a fixed step applies',
    rule: 'An agentic capability the surface starts reads with read-only tools and proposes changes; a person approves; a fixed step applies them.',
    howTo: 'Build it as a workflow (Agent step, Human review step, Apply approved changes). Mark any tool that writes or sends data outside explicitly.',
    accept: ['Nothing an agent proposes is written before a person approves it.'],
    references: ['docs/WORKFLOWS.md', 'packages/graphql/src/lib/workflow-graph.ts'],
  },
  {
    id: 'states',
    area: 'ux',
    title: 'Loading, empty and error states',
    rule: 'Every tab and panel shows a loading state, an empty state that says why, and an error that says what to do.',
    howTo: 'Use the view-fade wrapper and the existing empty and error patterns; never a blank panel.',
    accept: ['Each tab has been seen loading, empty and failing (stop the request to see the last).'],
    references: ['apps/web/styles/globals.css'],
  },
  {
    id: 'design-system',
    area: 'ux',
    title: 'House design system',
    rule: 'Dense and editorial: tabular numerals, right-aligned figures, one accent, 1px low-contrast borders, 8px radius, no shadows or gradients, direct chart labels.',
    howTo: 'Use the host classes (page-header, crumbs, da-tabs, da-* and pipe-* panels) and @tapestrai/ui. Do not load external fonts or chart libraries. What the kit lacks goes in one small scoped block of x- classes built from kit tokens.',
    accept: ['No colour, font or shadow in the surface that is not a kit token.'],
    references: ['packages/mcp-server/src/lib/chat-skills.ts (DESIGN_SYSTEM)', 'packages/ui/src'],
  },
  {
    id: 'legibility',
    area: 'ux',
    title: 'Dense, but nothing clipped, cut off or too small',
    rule: 'Dense does not mean cramped. At 1440 pixels wide with the app sidebar open, every value, placeholder and name shows in full; no text is below 12px except the kit\u2019s uppercase tags; an input is as wide as the longest value it can show, implied values included; a row with nothing in it is one quiet line with a way to add to it, not a row of empty boxes; a table taller than the window keeps its header in view; a side panel that repeats what the main area shows can be hidden. Where a file in views/ breaks one of these, the rule wins over the view: fix it and say so.',
    howTo: 'Size inputs from the longest formatted value (money about 64px, percent about 58px, a count about 40px, at 12.5px text). Let names wrap instead of truncating. Give a tall grid its own scroll frame with a sticky header and a sticky first column. Draw empty min and max inputs without a border until they are hovered or focused. Design the main column for about 1100px: the app sidebar, the rail and the assistant or source panel take the rest.',
    accept: [
      'The acceptance script reports 0 clipped inputs, 0 cut-off text, 0 text below 12px and 0 rows of empty boxes on every tab, at 1440x900 and at 1920x1080.',
      'Tall tables keep their header, and the page does not scroll sideways.',
    ],
    references: ['surfaces/README.md'],
  },
  {
    id: 'one-stylesheet',
    area: 'ux',
    title: 'One stylesheet, each class defined once',
    rule: 'The surface has one block of its own styles, and each class in it is defined once and means the same thing on every tab. The files in views/ were designed one at a time and reuse class names with different rules: their style blocks are never pasted together.',
    howTo: 'Start from views/shared.css in the handoff bundle, which holds every x- rule once. Settle each class listed under "Class conflicts" in the brief, keep only the classes the build uses, and scope every selector to the surface root.',
    accept: ['The acceptance script reports 0 selectors defined more than once.', 'No class in the surface\u2019s styles is unused.'],
    references: ['surfaces/README.md'],
  },
  {
    id: 'view-fidelity',
    area: 'ux',
    title: 'Nothing in the views is dropped without saying so',
    rule: 'Every tab, region, column, control and bound value in views/ is in the build. Anything left out, moved or changed is listed in the hand-back with the reason; nothing disappears quietly. A question the brief lists as open is put to the person before the part it affects is built, not answered by the builder.',
    howTo: 'Work through the controls and bindings the brief lists for each view and tick each off. Keep a "Left out or changed" list as you build and hand it back with the work.',
    accept: [
      'Every control the brief lists for a view is in the build or in the "Left out or changed" list.',
      'Every open question in the brief has the person\u2019s answer recorded, or the part it affects is not built.',
    ],
    references: ['surfaces/README.md'],
  },
  {
    id: 'measured-done',
    area: 'ux',
    title: 'Done is measured in the browser, not asserted',
    rule: 'Before the surface is reported as done, it is opened in the browser with real records, the acceptance script is run on every tab at both widths, and the results are handed back, failing lines included. A surface with a failing line is reported as not done, with the line and the reason.',
    howTo: 'Run acceptance.js from the handoff bundle in the browser console (or the browser tool\u2019s script runner) on each tab. Right-click one value of each kind by hand. Type a value into one editable cell and undo it.',
    accept: ['The hand-back contains the acceptance table for every tab at 1440x900 and 1920x1080.'],
    references: ['apps/web/lib/surface-builder/acceptance.ts'],
  },
  {
    id: 'crumbs-and-links',
    area: 'ux',
    title: 'Crumbs and record links',
    rule: 'The surface sets its crumbs and links every record name to its golden record.',
    howTo: 'host.useCrumbs / the crumbs header; surface-links.ts for record hrefs.',
    howToSdk: 'host.useCrumbs for the trail and host.href(path) for record links. The open record\u2019s name, and each record named in a list (a commitment, a deal), links to its golden record.',
    accept: ['The open record\u2019s name and each listed record\u2019s name link to its golden record.'],
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
export function checkStandards(outline: PrototypeOutline, placement?: SurfacePlacement | null): StandardFinding[] {
  const sdk = placement === 'sdk-surface';
  const figures = outline.fields.filter((field) => field.kind !== 'input').length
    + outline.tables.reduce((sum, table) => sum + table.columns.length, 0);
  return SURFACE_STANDARDS.map((standard) => {
    const finding = (level: FindingLevel, note: string): StandardFinding => ({ id: standard.id, title: standard.title, area: standard.area, level, note });
    switch (standard.id) {
      case 'right-click-inspect':
        return outline.signals.contextMenu
          ? finding('todo', `The prototype has a context menu. Replace it with the house source panel on each of the ${figures} bound values, and a "how it is worked out" panel on each derived figure.`)
          : finding('todo', `Bind each of the ${figures} figures and columns to its attribute so right-click opens its sources, cell by cell in every grid, and give each derived figure a "how it is worked out" panel.`);
      case 'inline-edit':
        return outline.signals.inlineEdit
          ? finding('todo', sdk
            ? 'The prototype edits values in the page. Route every edit through host.mutate and the manual override mutation, in place, with undo.'
            : 'The prototype edits values in the page. Route every edit through AttributeCellEditor and the golden write path.')
          : finding('todo', 'Decide which values are editable; make those inline-editable through the golden write path and keep the rest read-only.');
      case 'publish-tabs':
        return outline.tabs.length > 0
          ? finding('todo', `Publish all ${outline.tabs.length} tabs (${outline.tabs.join(', ')}) with label, purpose and data.`)
          : finding('todo', 'The prototype has no tabs. Publish the page\u2019s story with usePublishPageData, or one tab if it grows tabs.');
      case 'temporal-dates':
        return outline.signals.asOfDate
          ? finding('todo', 'The prototype shows an As Of date, but a prototype reads its own fixed date. Load every query with the user\u2019s As Of and Knowledge dates, not a local picker or a constant.')
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
