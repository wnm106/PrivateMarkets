'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { graphqlQuery, ENTITY_GRAPH_QUERY } from '@/lib/graphql';

export interface GraphNode {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  depth: number;
  direction: string;
}

export interface GraphEdge {
  id: string;
  parentEntityId: string;
  childEntityId: string;
  relationshipCode: string;
  relationshipType: string;
  isPrimary: boolean;
  metadata?: Record<string, unknown> | null;
}

const ROUTES: Record<string, string> = {
  FUND: 'funds',
  ISSUER: 'issuers',
  SECURITY: 'securities',
  DEAL: 'deals',
  INVESTOR: 'investors',
  POSITION: 'positions',
  PRICE: 'prices',
  CASH_FLOW: 'cash-flows',
};

export function entityHref(domainCode: string, id: string) {
  const slug = ROUTES[domainCode.toUpperCase()] || domainCode.toLowerCase().replace(/_/g, '-');
  return `/${slug}/${id}`;
}

function metaSummary(metadata?: Record<string, unknown> | null) {
  if (!metadata) return '';
  const parts = Object.entries(metadata)
    .filter(([key, value]) => key !== 'merged_from_entity_id' && value != null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${String(value)}`);
  return parts.join(' · ');
}

export function EntityGraphPanel({ entityId }: { entityId: string }) {
  const [rootId, setRootId] = useState(entityId);
  const [depth, setDepth] = useState(3);
  const [relationshipCode, setRelationshipCode] = useState('');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRootId(entityId);
  }, [entityId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    graphqlQuery<{ entityGraph: { nodes: GraphNode[]; edges: GraphEdge[] } }, { entityId: string; depth: number; relationshipCodes: string[] | null }>(
      ENTITY_GRAPH_QUERY,
      {
        entityId: rootId,
        depth,
        relationshipCodes: relationshipCode ? [relationshipCode] : null,
      },
      'network-only',
    ).then(({ data, error: queryError }) => {
      if (cancelled) return;
      if (queryError) setError(queryError.message || 'Could not load the relationship graph');
      else {
        setNodes(data?.entityGraph?.nodes || []);
        setEdges(data?.entityGraph?.edges || []);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [rootId, depth, relationshipCode]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const codes = useMemo(() => [...new Set(edges.map((edge) => edge.relationshipCode))].sort(), [edges]);
  const groups = [
    { key: 'UP', title: 'Above this record' },
    { key: 'ROOT', title: 'This record' },
    { key: 'DOWN', title: 'Below this record' },
    { key: 'CROSS', title: 'Reached from more than one direction' },
  ];

  return (
    <section id="relationship-graph" className="field-section" style={{ marginTop: 28 }}>
      <div className="field-section-head">
        <div>
          <div className="field-section-name">Relationship graph</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, maxWidth: 720 }}>
            Parent, beneficial-ownership, counterparty, and facility links stay on the edge.
            Walking the graph does not copy them onto the entity.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '12px 0 16px' }}>
        <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          Depth{' '}
          <select className="text-input" value={depth} onChange={(event) => setDepth(Number(event.target.value))} style={{ marginLeft: 6 }}>
            {[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          Relationship{' '}
          <select className="text-input" value={relationshipCode} onChange={(event) => setRelationshipCode(event.target.value)} style={{ marginLeft: 6 }}>
            <option value="">All</option>
            {codes.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
        {rootId !== entityId && (
          <button className="btn btn-sm" onClick={() => setRootId(entityId)}>Back to this record</button>
        )}
      </div>

      {loading && <div style={{ color: 'var(--ink-3)', padding: '12px 0' }}>Loading relationships…</div>}
      {error && <div style={{ color: 'var(--red)', padding: '12px 0' }}>{error}</div>}

      {!loading && !error && edges.length === 0 && (
        <div style={{ color: 'var(--ink-3)', fontSize: 13, padding: '8px 0 16px' }}>
          No current relationships. Add a parent, beneficial owner, counterparty, or facility link and it will show here, including when the other record is a different entity type.
        </div>
      )}

      {!loading && !error && nodes.length > 0 && (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <div>
            {groups.map((group) => {
              const members = nodes.filter((node) => node.direction === group.key);
              if (members.length === 0) return null;
              return (
                <div key={group.key} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>{group.title}</div>
                  {members.map((node) => (
                    <div key={node.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                      <button
                        onClick={() => setRootId(node.id)}
                        style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: 'var(--ink)' }}
                      >
                        <div style={{ fontWeight: node.id === rootId ? 600 : 500 }}>{node.entityName}</div>
                        <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{node.domainCode} · {node.entityCode} · {node.depth} hop{node.depth === 1 ? '' : 's'}</div>
                      </button>
                      <Link href={entityHref(node.domainCode, node.id)} style={{ fontSize: 12, alignSelf: 'center' }}>Open</Link>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>Edges</div>
            {edges.map((edge) => {
              const parent = byId.get(edge.parentEntityId);
              const child = byId.get(edge.childEntityId);
              const extra = metaSummary(edge.metadata);
              return (
                <div key={edge.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                  <div>
                    {parent?.entityName || 'Parent'} <span style={{ color: 'var(--ink-3)' }}>— {edge.relationshipType || edge.relationshipCode} →</span> {child?.entityName || 'Child'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                    {edge.relationshipCode}
                    {parent?.domainCode && child?.domainCode ? ` · ${parent.domainCode} to ${child.domainCode}` : ''}
                    {extra ? ` · ${extra}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
