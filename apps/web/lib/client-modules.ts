/** What a license switch turned off for this session, whatever its modules. */
export interface ModuleBlocks {
  surface: readonly string[];
  workflow: readonly string[];
  tool: readonly string[];
  assistant_tool: readonly string[];
}

/**
 * What this session may open. A curated session is limited to its lists; any
 * session loses what is in blocked. tenancy.module_scope() works both out.
 */
export interface ModuleScope {
  restricted: boolean;
  surfaces: readonly string[];
  tools: readonly string[];
  blocked?: ModuleBlocks;
}

export const NO_BLOCKS: ModuleBlocks = { surface: [], workflow: [], tool: [], assistant_tool: [] };

export const OPEN_SCOPE: ModuleScope = { restricted: false, surfaces: [], tools: [], blocked: NO_BLOCKS };

function blockedOf(scope: ModuleScope | null | undefined, kind: keyof ModuleBlocks): readonly string[] {
  return scope?.blocked?.[kind] ?? [];
}

/** A mounted surface is available unless a switch turned it off, and, for a curated session, only if it was saved for the client. */
export function moduleAllowsSurface(scope: ModuleScope | null | undefined, code: string): boolean {
  if (blockedOf(scope, 'surface').includes(code)) return false;
  if (!scope?.restricted) return true;
  return scope.surfaces.includes(code);
}

/** Whether a page href is available, by the same rule as a surface. */
export function moduleAllowsTool(scope: ModuleScope | null | undefined, href: string): boolean {
  if (blockedOf(scope, 'tool').includes(href)) return false;
  if (!scope?.restricted) return true;
  return scope.tools.includes(href);
}

/** Whether a group of assistant tools (a tool category) is licensed. Groups are on unless switched off. */
export function moduleAllowsToolGroup(scope: ModuleScope | null | undefined, category: string): boolean {
  return !blockedOf(scope, 'assistant_tool').includes(category);
}

/** Pages and tools follow the saved tool list and the switches. */
export function filterByTools<T extends { href: string }>(items: readonly T[], scope: ModuleScope | null | undefined): T[] {
  return items.filter((item) => moduleAllowsTool(scope, item.href));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function parseBlocks(value: unknown): ModuleBlocks {
  if (!value || typeof value !== 'object') return NO_BLOCKS;
  const row = value as Record<string, unknown>;
  return {
    surface: stringList(row.surface),
    workflow: stringList(row.workflow),
    tool: stringList(row.tool),
    assistant_tool: stringList(row.assistant_tool),
  };
}

/** Reads tenancy.module_scope(). A missing or unexpected payload stays unrestricted. */
export function parseModuleScope(value: unknown): ModuleScope {
  if (!value || typeof value !== 'object') return OPEN_SCOPE;
  const row = value as { restricted?: unknown; surfaces?: unknown; tools?: unknown; blocked?: unknown };
  const blocked = parseBlocks(row.blocked);
  if (row.restricted !== true) return { ...OPEN_SCOPE, blocked };
  return { restricted: true, surfaces: stringList(row.surfaces), tools: stringList(row.tools), blocked };
}
