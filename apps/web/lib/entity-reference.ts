'use client';

import { useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';

/** A record a reference field points to. */
export interface EntityRef {
  id: string;
  entityName: string;
  entityCode: string;
  domainCode: string;
}

const ENTITY_REF_BY_ID = `query EntityRefById($id: ID) { entity(id: $id) { id entityName entityCode domainCode } }`;
const ENTITY_REF_BY_CODE = `query EntityRefByCode($entityCode: String) { entity(entityCode: $entityCode) { id entityName entityCode domainCode } }`;
const ENTITY_REF_SEARCH = `
  query EntityRefSearch($filter: EntityFilter, $pagination: PaginationInput) {
    entities(filter: $filter, pagination: $pagination) {
      edges { node { id entityName entityCode domainCode } }
    }
  }
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolved = new Map<string, EntityRef | null>();
const inflight = new Map<string, Promise<EntityRef | null>>();

/** The cached record for a stored value, or undefined while it is unknown. */
export function peekEntityRef(value: string | null | undefined): EntityRef | null | undefined {
  const key = (value || '').trim();
  if (!key) return null;
  return resolved.get(key);
}

/** Remember a record, so a value just picked shows its name at once. */
export function rememberEntityRef(ref: EntityRef) {
  resolved.set(ref.id, ref);
}

/**
 * The record a stored reference value names. The value is normally the master id.
 * Older values that hold an entity code still resolve. Anything else returns null.
 */
export function resolveEntityRef(value: string | null | undefined): Promise<EntityRef | null> {
  const key = (value || '').trim();
  if (!key) return Promise.resolve(null);
  if (resolved.has(key)) return Promise.resolve(resolved.get(key) ?? null);
  const running = inflight.get(key);
  if (running) return running;
  const byId = UUID.test(key);
  const request = graphqlQuery<{ entity: EntityRef | null }>(
    byId ? ENTITY_REF_BY_ID : ENTITY_REF_BY_CODE,
    byId ? { id: key } : { entityCode: key },
    'cache-first',
  )
    .then((result) => {
      const ref = result.data?.entity || null;
      // A failed request is not remembered, so the next render asks again.
      if (result.error && !ref) return null;
      resolved.set(key, ref);
      if (ref) resolved.set(ref.id, ref);
      return ref;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Records of one type whose name contains the text, by name. */
export async function searchEntityRefs(domainCode: string, text: string, limit = 20): Promise<EntityRef[]> {
  const filter: Record<string, unknown> = { domainCode, isActive: true };
  const trimmed = text.trim();
  if (trimmed) filter.entityName = trimmed;
  const result = await graphqlQuery<{ entities: { edges: Array<{ node: EntityRef }> } }>(
    ENTITY_REF_SEARCH,
    { filter, pagination: { first: limit } },
    'network-only',
  );
  const refs = (result.data?.entities?.edges || []).map((edge) => edge.node);
  for (const ref of refs) resolved.set(ref.id, ref);
  return refs;
}

/** The page of a referenced record. */
export function entityRefHref(ref: EntityRef): string {
  return `${domainHref(ref.domainCode)}/${ref.id}`;
}

/**
 * The record a reference value points to. Undefined while loading, null when
 * the value is empty or names no record the user can see.
 */
export function useEntityRef(value: string | null | undefined, enabled = true): EntityRef | null | undefined {
  const [ref, setRef] = useState<EntityRef | null | undefined>(() => (enabled ? peekEntityRef(value) : null));

  useEffect(() => {
    if (!enabled) {
      setRef(null);
      return;
    }
    const cached = peekEntityRef(value);
    setRef(cached);
    if (cached !== undefined) return;
    let cancelled = false;
    void resolveEntityRef(value).then((next) => {
      if (!cancelled) setRef(next);
    });
    return () => {
      cancelled = true;
    };
  }, [value, enabled]);

  return ref;
}
