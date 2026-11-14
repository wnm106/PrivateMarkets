# Client surfaces

A surface is a custom screen built on the platform. Each lives in `surfaces/<code>/` as its own workspace package and is mounted by the host app at `/s/<code>`.

## Rules

- Import only React, `@tapestrai/surface-sdk`, `@tapestrai/ui`, and your own files. `npm run lint` in `surfaces/` fails on anything else (`@/…`, `apps/…`, other surfaces).
- Talk to the platform through `useSurfaceHost()`: `query`, `mutate`, `href`, `useCrumbs`, `asOfDate`, `permissions`, `clientCode`. Keep GraphQL documents inside the surface.
- Do not define routes, middleware, or auth. The host owns them.
- Row-level security and tenancy enforce data isolation. Surface gating (`clients`, `requiredPermissions`) only controls who sees the screen.

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
