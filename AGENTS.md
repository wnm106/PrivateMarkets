# Agent instructions

## Surfaces with tabs must publish every tab to the assistant

This is required for every surface, existing and new. Read `docs/SURFACE_TABS.md` before you build or change a surface, and follow it.

- A surface with tabs publishes **all** its tabs to the assistant, whether or not each is open. Never publish only the open tab.
- Each tab publishes `label`, `purpose` and `data`, plus `howToRead` where a term, level or sign could be misread. `data` is the story the tab tells, derived the way the tab derives it, not raw records.
- Use `usePublishTabs` (one load feeds every tab), or `usePublishTab` with `useWarmTabs` (each tab loads its own data), from `apps/web/lib/view-context.ts`. A surface built on the SDK calls `host.usePublishTabs`.
- A tab that has not loaded publishes `data: null`. Build tab data from the same variables the tab draws, with the user's As Of and Knowledge dates applied.
- Do not finish a surface change until each tab is published and the checklist in `docs/SURFACE_TABS.md` is met. If you cannot meet it, say which tab is missing and why. Do not skip it silently.

## Surfaces: every value answers right-click, and done is measured

This is required for every surface, existing and new. Read "What every value and every screen must do" in `surfaces/README.md` before you build or change a surface, and follow it.

- Every value on every tab answers right-click: a value from an attribute opens its sources, and a figure worked out from others opens how it is worked out. That includes each cell of a grid, editable inputs, rails and side lists. One link under a table is not a binding.
- Nothing is clipped, cut off or below 12px, an empty row is not a row of empty boxes, and the surface has one stylesheet with each class defined once.
- When you build from a Surface Builder brief, ask the questions it lists before you build, use its attribute codes, and keep a "Left out or changed" list. Do not drop a control or a binding quietly.
- Do not report a surface as done from reading your code. Open it in the browser, run the acceptance script on every tab at 1440x900 and 1920x1080, and hand back the results. If a line fails, say which and why.

## Guardrails: one engine for every client

Read `docs/GUARDRAILS.md` before changing a database function, a migration, compliance or capacity code, or a surface.

- No code names a client, rule or entity by its code. Put the difference in data: rule metadata, a fund threshold, a client flag, or an id passed in.
- One interpreter per concept. Rules are interpreted by `compliance.evaluate_rule`. Which rules a deal is scored on, and for which funds, is `compliance.deal_score_plans`. Capacity reads the evaluator and is solved in `compliance-capacity.ts`. Call these; do not copy them.
- Migrations change schema and functions. Records go in `supabase/seed`. Never edit an applied migration.
- Run `npm run guard` before you finish. The Stop hook runs it too. CI also rebuilds the database from migrations and runs `npm run guard:db` and `npm run test:db`. Do not finish a change that breaks any of them; if you cannot meet one, say which and why.
