/** What a curated session may open. An unrestricted session ignores the lists. */
export interface ModuleScope {
  restricted: boolean;
  surfaces: readonly string[];
  tools: readonly string[];
}

export const OPEN_SCOPE: ModuleScope = { restricted: false, surfaces: [], tools: [] };

/** A mounted surface is available when the session uses the full catalog, or the surface was saved for the client. */
export function moduleAllowsSurface(scope: ModuleScope | null | undefined, code: string): boolean {
  if (!scope?.restricted) return true;
  return scope.surfaces.includes(code);
}

/** Pages and tools follow the saved tool list. An unrestricted session keeps every item. */
export function filterByTools<T extends { href: string }>(items: readonly T[], scope: ModuleScope | null | undefined): T[] {
  if (!scope?.restricted) return [...items];
  const allowed = new Set(scope.tools);
  return items.filter((item) => allowed.has(item.href));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Reads tenancy.module_scope(). A missing or unexpected payload stays unrestricted. */
export function parseModuleScope(value: unknown): ModuleScope {
  if (!value || typeof value !== 'object') return OPEN_SCOPE;
  const row = value as { restricted?: unknown; surfaces?: unknown; tools?: unknown };
  if (row.restricted !== true) return OPEN_SCOPE;
  return { restricted: true, surfaces: stringList(row.surfaces), tools: stringList(row.tools) };
}
