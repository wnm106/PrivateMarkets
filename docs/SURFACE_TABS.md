# Surface tabs and the assistant

The assistant answers from what the user has on screen before it queries anything. A surface with tabs must therefore tell the assistant what **every** tab shows, whether or not that tab is open. This page is the required pattern. It applies to every surface, existing and new.

## The rule

1. **Every tab is published, open or not.** The assistant sees all of them at once under `tabs` in its page data. Never publish only the open tab, and never rely on the visible-page scan for a surface's tabs.
2. **Publish the story, not the records.** Each tab publishes the figures and labels as the tab derives them: the totals, groupings, flags and rankings the user reads. Do not hand over raw rows for the assistant to reshape.
3. **Each tab carries three things.** `label` is the tab name the user sees. `purpose` is one sentence on what the tab is for and the question it answers. `howToRead` holds the terms and rules needed to read the data, such as which level to report at, a sign convention or what a flag means. Omit `howToRead` only when nothing needs explaining.
4. **A tab that has not loaded says so.** Publish `data: null`. The assistant then tells the user the tab has not loaded and does not guess its figures.
5. **The user's dates apply.** Build every tab from data loaded with the user's As Of and Knowledge dates, the same data the tab draws.
6. **Cap the size.** Limit long lists to a sensible number of rows (the existing surfaces use 40 to 120). Put the totals and flags first so a capped list still tells the story.
7. **Strip what only the UI needs.** Remove attribute source references, element ids and styling hints. `withoutSources` in `apps/web/lib/view-context.ts` removes the source references.
8. **Use one source of truth.** Build the tab's data in the same function, or from the same variables, that renders the tab, so the assistant and the screen never disagree.

## How to publish

Both hooks are in `apps/web/lib/view-context.ts`.

**A surface that loads all its tabs' data in one request** builds a record of tabs and publishes it once with `usePublishTabs`. This is the preferred shape. See `fundTabs` in `components/funds/FundSurface.tsx` and `recTabs` in `components/fund-rec/FundRecWorkspace.tsx`.

```tsx
usePublishTabs(surface ? {
  nav: {
    label: 'NAV',
    purpose: 'What the fund is worth at the reporting date.',
    howToRead: 'Amounts are dollars from the administrator.',
    data: { nav: surface.nav, rollforward: surface.rollforward },
  },
  // ...one entry per tab
} : {});
```

**A surface whose tabs each load their own data** has each tab component publish itself with `usePublishTab(key, payload)`, and keeps every tab mounted so all of them publish. Use `useWarmTabs(keys, activeTab)` and render each tab in `<div hidden={tab !== key}>` once `warmed.has(key)`. The open tab mounts at once and the others follow one at a time, so the page does not open with a burst of requests. See `components/allocation/AllocationBoard.tsx` and the `Deal*` tabs.

**A surface built on the surface SDK** (`surfaces/<code>/`) calls `host.usePublishTabs(...)` with the same payload. It must not import from `apps/web`.

If a section renders live content that cannot be derived without opening it, such as an embedded dashboard, publish its label, purpose and a `note` saying its figures are read when the tab is open. Say so in the tab's `data`; do not publish an empty tab.

## Components mounted on a hidden tab

A tab kept mounted but hidden must not take over the page. Do these:

- Render it as `<div hidden={tab !== key}>` once `warmed.has(key)`. If a layout rule targets the tab's markup as a direct child, add a rule for the wrapper and a `[hidden] { display: none }` rule, because a class that sets `display` overrides `hidden`. See `.entity-home-pane` in `styles/globals.css`.
- A component that publishes its page focus (`usePublishViewContext`) takes an `active` prop and passes `null` when it is not active. See `DataQualityDashboard`.
- Give a reusable tab component (a grid, a documents list) an opt-in way to publish, such as `publishAs`, so it publishes only where it is a tab. See `EntityAttributeTable`.
- The page's visible-page scan ignores anything inside `[hidden]`, so a hidden tab is described only by what it publishes.

## What counts as a surface

The rule covers every screen that presents data under tabs: the fund surface, the deal page, fund reconciliation, working views, golden records, entity homes, the data quality dashboard, the document page and the agent usage page. Tabs that are only filters over one list (the reconciliation board's filter, the actual-returns period presets) are not tabs of a surface.

Admin screens whose tabs are forms for editing configuration are not covered yet: tenancy and security, the entity-type editor, expression functions, the attribute panel and the skill, surface and rule editors. Their tabs hold settings, not a story about the data, and the security pages hold access grants. Convert one if people will ask the assistant about what it shows.

## Checklist for a new surface

- [ ] Every tab is published with `label`, `purpose` and `data`.
- [ ] `howToRead` covers every term, level or sign convention a reader could get wrong.
- [ ] A tab still loading publishes `data: null`.
- [ ] Data is built from the same variables the tab draws, with the user's dates applied.
- [ ] Long lists are capped, totals first.
- [ ] No source references or ids that only the UI uses.
- [ ] `npm run test` in `apps/web` passes, including `view-context.test.ts`.

## What the assistant does with it

The chat route (`apps/web/app/api/chat/route.ts`) tells the assistant to answer from the screen data first and to call a tool only when the screen data lacks what it needs. It applies the user's As Of and Knowledge dates to every tool call. House terms (portfolio versus sub-portfolio) are defined there once for every page.
