'use client';

import { useEffect, useMemo, useState } from 'react';
import { EntityAttributeTable } from '@/components/entities/EntityAttributeTable';
import { domainHref } from '@/lib/domain-routes';
import { DOMAIN_TYPES_QUERY, graphqlQuery } from '@/lib/graphql';
import { domainLabel } from '@/lib/parent-entities';
import { orderRelationshipGrids, relationshipGrids, type RelatedEntityRef } from '@/lib/relationship-grids';

export function RelationshipEntityGrids({
  entityId,
  parents,
  children,
  asOfDate,
}: {
  entityId: string;
  parents: RelatedEntityRef[];
  children: RelatedEntityRef[];
  asOfDate?: string;
}) {
  const [names, setNames] = useState<Record<string, string> | null>(null);
  const pending = useMemo(
    () => relationshipGrids(parents, children, entityId),
    [parents, children, entityId],
  );

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string }> }, Record<string, never>>(
      DOMAIN_TYPES_QUERY,
      {},
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const domain of result.data?.domainTypes || []) {
        if (domain.domainCode && domain.domainName) next[domain.domainCode.toUpperCase()] = domain.domainName;
      }
      setNames(next);
    }).catch(() => {
      if (!cancelled) setNames({});
    });
    return () => { cancelled = true; };
  }, []);

  if (!names) {
    return (
      <div className="field-section" aria-busy="true">
        <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>Loading…</div>
      </div>
    );
  }

  const grids = orderRelationshipGrids(pending, names);
  if (grids.length === 0) {
    return (
      <div className="field-section">
        <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>No relationships.</div>
      </div>
    );
  }

  const repeated = new Set<string>();
  const seen = new Set<string>();
  for (const grid of grids) {
    if (seen.has(grid.domainCode)) repeated.add(grid.domainCode);
    seen.add(grid.domainCode);
  }

  return (
    <div className="relationship-grids">
      {grids.map((grid) => {
        const name = names[grid.domainCode] || domainLabel(grid.domainCode);
        return (
          <section key={`${grid.side}:${grid.domainCode}`} className="field-section" aria-label={name}>
            <div className="field-section-head">
              <div className="field-section-name">
                {name}
                {repeated.has(grid.domainCode) && (
                  <span className="relationship-grid-side">{grid.side === 'parent' ? 'From' : 'To'}</span>
                )}
              </div>
              <div className="field-section-count">{grid.entityIds.length}</div>
            </div>
            <EntityAttributeTable
              domainCode={grid.domainCode}
              domainKey={domainHref(grid.domainCode).replace(/^\//, '')}
              asOfDate={asOfDate}
              entityIds={grid.entityIds}
              embedded
              emptyMessage={`No ${name} records.`}
            />
          </section>
        );
      })}
    </div>
  );
}
