# Agent instructions

## Surfaces with tabs must publish every tab to the assistant

This is required for every surface, existing and new. Read `docs/SURFACE_TABS.md` before you build or change a surface, and follow it.

- A surface with tabs publishes **all** its tabs to the assistant, whether or not each is open. Never publish only the open tab.
- Each tab publishes `label`, `purpose` and `data`, plus `howToRead` where a term, level or sign could be misread. `data` is the story the tab tells, derived the way the tab derives it, not raw records.
- Use `usePublishTabs` (one load feeds every tab), or `usePublishTab` with `useWarmTabs` (each tab loads its own data), from `apps/web/lib/view-context.ts`. A surface built on the SDK calls `host.usePublishTabs`.
- A tab that has not loaded publishes `data: null`. Build tab data from the same variables the tab draws, with the user's As Of and Knowledge dates applied.
- Do not finish a surface change until each tab is published and the checklist in `docs/SURFACE_TABS.md` is met. If you cannot meet it, say which tab is missing and why. Do not skip it silently.
