'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { domainHref } from '@/lib/domain-routes';
import { RELATIONSHIP_TYPES_QUERY, graphqlQuery } from '@/lib/graphql';
import { domainLabel, recordParentLinks, type ParentRelationshipType } from '@/lib/parent-entities';
import type { EntityData } from './types';

export function ParentEntities({
  domainCode,
  parents,
  children,
}: {
  domainCode: string;
  parents?: EntityData['parentRelationships'];
  children?: EntityData['childRelationships'];
}) {
  const [types, setTypes] = useState<ParentRelationshipType[]>([]);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ relationshipTypes: ParentRelationshipType[] }, Record<string, never>>(
      RELATIONSHIP_TYPES_QUERY,
      {},
      'network-only',
    ).then((result) => {
      if (!cancelled) setTypes(result.data?.relationshipTypes || []);
    });
    return () => { cancelled = true; };
  }, []);

  const links = recordParentLinks(parents || [], children || [], types, domainCode);
  if (links.length === 0) return null;

  return (
    <section className="parent-entities" aria-label="Parent entities">
      <div className="parent-entities-label">Parents</div>
      <div className="parent-entities-list">
        {links.map((link) => (
          <Link
            key={link.entityId}
            href={`${domainHref(link.domainCode)}/${link.entityId}`}
            className="parent-entity"
          >
            <span>{domainLabel(link.domainCode || 'Entity')}</span>
            <strong>{link.entityName}</strong>
          </Link>
        ))}
      </div>
    </section>
  );
}
