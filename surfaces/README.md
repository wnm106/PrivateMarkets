# Client surfaces

A surface is a custom screen built on the platform. Each lives in `surfaces/<code>/` as its own workspace package and is mounted by the host app at `/s/<code>`.

## Rules

- Import only React, `@tapestrai/surface-sdk`, `@tapestrai/ui`, and your own files. `npm run lint` in `surfaces/` fails on anything else (`@/…`, `apps/…`, other surfaces).
- Talk to the platform through `useSurfaceHost()`: `query`, `mutate`, `href`, `useCrumbs`, `usePublishTabs`, `usePublishFocus`, `inspectAttribute`, `asOfDate`, `permissions`, `clientCode`. Keep GraphQL documents inside the surface.
- Use `host.navigate`, `host.basePath`, `host.useQueryParam` and `SurfaceLink` for navigation and URL state; do not import `next/navigation` or `next/link`.
- Styling comes from the host's global stylesheet and `@tapestrai/ui` (for example the `pipe-*` and `da-*` classes). A surface does not ship its own global CSS yet.
- A surface with tabs must tell the assistant what every tab shows, open or not, with `host.usePublishTabs`. Follow `docs/SURFACE_TABS.md`.
- Tell the assistant which record is open with `host.usePublishFocus`, and pass null when none is.
- Do not define routes, middleware, or auth. The host owns them.
- Row-level security and tenancy enforce data isolation. Surface gating (`clients`, `requiredPermissions`) only controls who sees the screen.

## What every value and every screen must do

These are the house standards a surface is checked against (`apps/web/lib/surface-builder/standards.ts` holds them with how to meet each). `surfaces/ocio` is the worked example.

**Every value answers right-click.**

- A value that comes from an attribute opens its sources: call `host.inspectAttribute` from `onContextMenu`, through one shared component, and render `data-attr="<CODE>"` on the element.
- A figure worked out from other values (a total, a share, a ratio, a count, a status) opens a panel that says how it is worked out and lists the records behind it, each bound in turn. Render `data-derived` on it.
- This holds everywhere a value is drawn: ribbons, each cell of a grid, editable inputs, rails, side lists, cards, totals and footers. A grid whose cells all come from one attribute binds each cell. One link under the table is not a binding.
- An editable input opens its sources on right-click unless it is already being typed in.
- A bound or derived value shows it on hover (a dotted underline).

**Dense, but nothing clipped, cut off or too small.** At 1440 pixels wide with the app sidebar open:

- No text below 12px, except the kit's uppercase tags.
- An input is as wide as the longest value it can show, implied values included (about 64px for money, 58px for a percent, 40px for a count).
- A row with nothing in it is one quiet line with a way to add to it, not a row of empty boxes.
- Names wrap. They are not cut off with an ellipsis.
- A table that can grow taller than the window scrolls in its own frame with a sticky header.
- A side panel that repeats the main area can be hidden.

**One stylesheet.** What the house kit lacks goes in one scoped block of `x-` classes, each defined once and meaning one thing on every tab. Never paste together style blocks that were written for separate views.

**Nothing dropped quietly.** If a brief or a view shows a control, a column or a value, it is in the build, or it is in a "Left out or changed" list handed back with the work. A question a brief lists as open is put to the person; the builder does not answer it.

**Done is measured.** Before a surface is reported as done, open it in the browser with real records and run the acceptance script on every tab at 1440x900 and 1920x1080. The Surface Builder ships it as `acceptance.js` in each handoff folder (source: `apps/web/lib/surface-builder/acceptance.ts`; `surfaces/ocio/acceptance.js` is a copy to start from). It counts figures that do not answer right-click, clipped inputs, cut-off text, small text, rows of empty boxes, tables that lose their header, classes defined twice and sideways scroll. Hand back its tables. A failing line means not done.

## Layout

```
surfaces/<code>/
  package.json
  src/manifest.ts   server-safe metadata: code, title, version, sdkVersion, clients, requiredPermissions
  src/index.tsx     default export defineSurface({ manifest, Component })
```

## Add a surface

1. Copy `surfaces/fund-index`, rename the package and `code`.
2. Add one entry to `apps/web/lib/surface-registry.ts` (manifest + lazy loader).
3. Restrict it with `clients: ['ACME']` in the manifest when it is client specific.
4. Open `/s/<code>` locally against the seeded Supabase stack.

## Working with a forward deployed engineer

- Give the engineer write access to `surfaces/<client>-*/` only (`CODEOWNERS`) and run CI on that path.
- Surface changes ship in their own PR. Anything needing a platform change (new attribute, SDK method) is a separate PR to the core team.
- Bump `manifest.version` on each release; bump `SURFACE_SDK_VERSION` only for breaking host API changes. The host refuses a surface built for another SDK version.
- If the surface must live outside this repo (client-owned or confidential), publish `@tapestrai/surface-sdk` and keep the surface in a private repo that is added as a workspace or git submodule at build time. The contract above is unchanged.
