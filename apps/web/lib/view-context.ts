'use client';

import { useEffect, useRef, useState } from 'react';

export type ViewActivity = 'viewing' | 'editing' | 'creating';

/** The record or configuration the user is looking at, beyond the URL. */
export interface ViewFocus {
  activity?: ViewActivity;
  kind: string;
  label: string;
  summary?: string;
  id?: string;
  domainCode?: string;
  entityCode?: string;
  entityId?: string;
  snapshot?: Record<string, unknown>;
}

interface StackEntry {
  id: number;
  focus: ViewFocus | null;
}

interface ViewContextState {
  focus: ViewFocus | null;
  /** Live data from the active page, or from the panel open on that page. */
  pageData: Record<string, unknown> | null;
  version: number;
}

type Listener = (state: ViewContextState) => void;

/** What one tab of a surface tells the assistant. See docs/SURFACE_TABS.md. */
export interface TabPayload {
  /** The tab's label as the user sees it. */
  label: string;
  /** One sentence on what the tab is for and the question it answers. */
  purpose: string;
  /** Terms or rules needed to read the data, such as which level to report at. */
  howToRead?: string;
  /** The figures and labels the tab shows, as the tab derives them. Null while the tab loads. */
  data: Record<string, unknown> | null;
}

/**
 * A copy of the data without its attribute source references (keys named `sources` or
 * ending in `Sources`). Those point the UI at an attribute and mean nothing to a reader.
 */
export function withoutSources<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutSources(item)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'sources' && !key.endsWith('Sources'))
        .map(([key, item]) => [key, withoutSources(item)]),
    ) as T;
  }
  return value;
}

let nextId = 1;
let stack: StackEntry[] = [];
let pageStack: Array<{ id: number; data: Record<string, unknown> | null }> = [];
let tabStack: Array<{ id: number; key: string; entry: TabPayload | null }> = [];
let state: ViewContextState = { focus: null, pageData: null, version: 0 };
const listeners = new Set<Listener>();

/** The page's own data plus every published tab, keyed by tab. */
export function combinePageData(
  base: Record<string, unknown> | null,
  tabs: Array<{ key: string; entry: TabPayload | null }>,
): Record<string, unknown> | null {
  // A key can be published twice: a surface's placeholder for a tab that has not
  // loaded (data: null) and the tab's own entry once it has. The loaded one wins;
  // otherwise the latest.
  const byKey = new Map<string, TabPayload>();
  for (const { key, entry } of tabs) {
    if (entry === null) continue;
    const held = byKey.get(key);
    if (held && held.data !== null && entry.data === null) continue;
    byKey.delete(key);
    byKey.set(key, entry);
  }
  const published = [...byKey].map(([key, entry]) => ({ key, entry }));
  if (!published.length) return base;
  return {
    ...(base || {}),
    tabs: Object.fromEntries(published.map(({ key, entry }) => [key, {
      label: entry.label,
      purpose: entry.purpose,
      ...(entry.howToRead ? { howToRead: entry.howToRead } : {}),
      ...(entry.data
        ? { data: entry.data }
        : { note: 'This tab has not finished loading. Say so instead of guessing its figures.' }),
    }])),
  };
}

// While a surface publishes all its tabs at once, listeners hear about it once, not once per tab.
let batchDepth = 0;
let batchDirty = false;

function batched(run: () => void) {
  batchDepth++;
  try {
    run();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && batchDirty) {
      batchDirty = false;
      emit();
    }
  }
}

function emit() {
  if (batchDepth > 0) {
    batchDirty = true;
    return;
  }
  const focus = [...stack].reverse().find((entry) => entry.focus)?.focus ?? null;
  const base = [...pageStack].reverse().find((entry) => entry.data)?.data ?? null;
  const pageData = combinePageData(base, tabStack);
  state = { focus, pageData, version: state.version + 1 };
  for (const listener of listeners) listener(state);
}

function publish(id: number, focus: ViewFocus | null) {
  const existing = stack.find((entry) => entry.id === id);
  if (existing) existing.focus = focus;
  else stack.push({ id, focus });
  emit();
}

function remove(id: number) {
  stack = stack.filter((entry) => entry.id !== id);
  emit();
}

export function getViewContext(): ViewContextState {
  return state;
}

export function subscribeViewContext(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/**
 * Publishes what this screen is showing. Nested publishers stack: a panel
 * opened on a page wins while it is mounted, and the page's focus returns
 * when the panel closes.
 */
export function usePublishViewContext(focus: ViewFocus | null) {
  const idRef = useRef(0);
  const serialized = JSON.stringify(focus ?? null);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (!idRef.current) idRef.current = nextId++;
    publish(idRef.current, focusRef.current);
  }, [serialized]);

  useEffect(() => () => {
    if (idRef.current) remove(idRef.current);
  }, []);
}

function publishPage(id: number, data: Record<string, unknown> | null) {
  const existing = pageStack.find((entry) => entry.id === id);
  if (existing) existing.data = data;
  else pageStack.push({ id, data });
  emit();
}

function removePage(id: number) {
  pageStack = pageStack.filter((entry) => entry.id !== id);
  emit();
}

/**
 * Publishes the JSON the active page is showing. A tab or panel mounted on
 * the page replaces the page's own data while it is open.
 */
export function usePublishPageData(data: Record<string, unknown> | null) {
  const idRef = useRef(0);
  const serialized = JSON.stringify(data ?? null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!idRef.current) idRef.current = nextId++;
    publishPage(idRef.current, dataRef.current);
  }, [serialized]);

  useEffect(() => () => {
    if (idRef.current) removePage(idRef.current);
  }, []);
}

function publishTab(id: number, key: string, entry: TabPayload | null) {
  const existing = tabStack.find((item) => item.id === id);
  if (existing) {
    existing.key = key;
    existing.entry = entry;
  } else tabStack.push({ id, key, entry });
  emit();
}

function removeTab(id: number) {
  tabStack = tabStack.filter((item) => item.id !== id);
  emit();
}

/**
 * Publishes one tab of a surface. Every tab of a surface does this, mounted or not
 * on screen, so the assistant sees all of them at once under `tabs` and not only the
 * open one. Pass the data as the tab derives it, with its purpose, not raw records.
 */
export function usePublishTab(key: string, entry: TabPayload | null) {
  const idRef = useRef(0);
  const serialized = JSON.stringify(entry ?? null);
  const entryRef = useRef(entry);
  entryRef.current = entry;

  useEffect(() => {
    if (!idRef.current) idRef.current = nextId++;
    publishTab(idRef.current, key, entryRef.current);
  }, [key, serialized]);

  useEffect(() => () => {
    if (idRef.current) removeTab(idRef.current);
  }, []);
}

/**
 * Publishes every tab of a surface from one place, for a surface that already holds
 * all its tabs' data in one load. Use this instead of mounting each tab to publish it.
 * A null entry is a tab that has not loaded yet.
 */
export function usePublishTabs(tabs: Record<string, TabPayload | null>) {
  const ids = useRef(new Map<string, number>());
  const serialized = JSON.stringify(tabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const current = tabsRef.current;
    batched(() => {
      for (const [key, id] of [...ids.current]) {
        if (key in current) continue;
        removeTab(id);
        ids.current.delete(key);
      }
      for (const [key, entry] of Object.entries(current)) {
        let id = ids.current.get(key);
        if (!id) {
          id = nextId++;
          ids.current.set(key, id);
        }
        publishTab(id, key, entry);
      }
    });
  }, [serialized]);

  useEffect(() => () => {
    batched(() => {
      for (const id of ids.current.values()) removeTab(id);
    });
    ids.current.clear();
  }, []);
}

/**
 * The tabs to keep mounted. The open tab mounts at once; the rest follow one at a
 * time so their data loads and reaches the assistant without a burst of requests.
 * A warmed tab stays mounted, hidden, so its data stays current.
 */
export function useWarmTabs(keys: readonly string[], active: string, delayMs = 350): ReadonlySet<string> {
  const [warmed, setWarmed] = useState<ReadonlySet<string>>(() => new Set([active]));
  const keyList = keys.join('|');

  useEffect(() => {
    setWarmed((current) => (current.has(active) ? current : new Set([...current, active])));
  }, [active]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setWarmed((current) => {
        const next = keyList.split('|').find((key) => key && !current.has(key));
        return next ? new Set([...current, next]) : current;
      });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [keyList, warmed, delayMs]);

  return warmed;
}

function plainValue(value: unknown, depth = 0): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return plainValue((value as { value: unknown }).value, depth);
  }
  if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return depth > 1 ? undefined : value.slice(0, 8).map((item) => plainValue(item, depth + 1));
  return undefined;
}

interface EntityLike {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName?: string;
  templateName?: string;
  description?: string;
  isActive?: boolean;
  attributes?: Record<string, unknown>;
  parentRelationships?: Array<Record<string, unknown>>;
  childRelationships?: Array<Record<string, unknown>>;
}

function relationshipBrief(relationship: Record<string, unknown>, direction: 'parent' | 'child') {
  const prefix = direction === 'parent' ? 'parent' : 'child';
  return {
    relationshipCode: relationship.relationshipCode,
    direction,
    domainCode: relationship[`${prefix}DomainCode`],
    entityCode: relationship[`${prefix}EntityCode`],
    entityName: relationship[`${prefix}EntityName`],
  };
}

/** Compact snapshot of a golden record for the assistant. */
export function entityViewFocus(entity: EntityLike): ViewFocus {
  const attributes: Record<string, unknown> = {};
  for (const [code, raw] of Object.entries(entity.attributes || {}).slice(0, 80)) {
    const value = plainValue(raw);
    if (value !== undefined && value !== null && value !== '') attributes[code] = value;
  }

  return {
    activity: 'viewing',
    kind: 'entity',
    label: entity.entityName || entity.entityCode,
    id: entity.id,
    domainCode: entity.domainCode,
    entityCode: entity.entityCode,
    entityId: entity.id,
    summary: [entity.domainName, entity.templateName].filter(Boolean).join(' · ') || undefined,
    snapshot: {
      entityCode: entity.entityCode,
      entityName: entity.entityName,
      domainCode: entity.domainCode,
      domainName: entity.domainName,
      templateName: entity.templateName,
      description: typeof entity.description === 'string' ? entity.description.slice(0, 300) : undefined,
      isActive: entity.isActive,
      attributes,
      relationships: [
        ...(entity.parentRelationships || []).slice(0, 12).map((relationship) => relationshipBrief(relationship, 'parent')),
        ...(entity.childRelationships || []).slice(0, 12).map((relationship) => relationshipBrief(relationship, 'child')),
      ],
    },
  };
}
