'use client';

import { useEffect, useRef } from 'react';

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
  version: number;
}

type Listener = (state: ViewContextState) => void;

let nextId = 1;
let stack: StackEntry[] = [];
let state: ViewContextState = { focus: null, version: 0 };
const listeners = new Set<Listener>();

function emit() {
  const focus = [...stack].reverse().find((entry) => entry.focus)?.focus ?? null;
  state = { focus, version: state.version + 1 };
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
