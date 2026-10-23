/**
 * Walk a relationship graph without collapsing edges onto entities.
 * Ownership, counterparty, and facility links stay on the edge that stored them.
 */

export interface GraphEdge {
  id: string;
  parentEntityId: string;
  childEntityId: string;
  relationshipCode: string;
  relationshipType: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface WalkedNode {
  id: string;
  depth: number;
  direction: 'ROOT' | 'UP' | 'DOWN' | 'CROSS';
}

export interface WalkedGraph {
  nodes: WalkedNode[];
  edges: GraphEdge[];
}

function pushEdge(index: Map<string, GraphEdge[]>, entityId: string, edge: GraphEdge) {
  const list = index.get(entityId);
  if (list) list.push(edge);
  else index.set(entityId, [edge]);
}

/**
 * Breadth-first walk from `rootId` up to `depth` hops.
 * Direction is relative to the root: UP follows a parent, DOWN follows a child.
 * A node reached by both is CROSS. Cycles stop at the first visit.
 */
export function walkEntityGraph(
  rootId: string,
  edges: GraphEdge[],
  depth: number,
  relationshipCodes?: string[] | null,
): WalkedGraph {
  const hops = Math.max(0, Math.min(8, depth));
  const allowed = relationshipCodes && relationshipCodes.length > 0
    ? new Set(relationshipCodes)
    : null;
  const filtered = edges.filter((edge) => !allowed || allowed.has(edge.relationshipCode));
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of filtered) {
    pushEdge(adjacency, edge.parentEntityId, edge);
    if (edge.childEntityId !== edge.parentEntityId) pushEdge(adjacency, edge.childEntityId, edge);
  }

  const nodes = new Map<string, WalkedNode>();
  nodes.set(rootId, { id: rootId, depth: 0, direction: 'ROOT' });
  const used = new Set<string>();
  let frontier = [rootId];

  for (let level = 0; level < hops; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      const origin = nodes.get(id);
      if (!origin) continue;
      for (const edge of adjacency.get(id) || []) {
        const step: 'UP' | 'DOWN' = edge.childEntityId === id ? 'UP' : 'DOWN';
        const other = step === 'UP' ? edge.parentEntityId : edge.childEntityId;
        if (!other || other === id) continue;
        used.add(edge.id);
        const existing = nodes.get(other);
        if (!existing) {
          const direction = origin.direction === 'ROOT' || origin.direction === step ? step : 'CROSS';
          nodes.set(other, { id: other, depth: level + 1, direction });
          next.push(other);
        } else if (existing.direction !== 'ROOT' && existing.direction !== step && existing.direction !== 'CROSS') {
          existing.direction = 'CROSS';
        }
      }
    }
    frontier = next;
  }

  const included = new Set(nodes.keys());
  return {
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
    edges: filtered.filter((edge) => used.has(edge.id) && included.has(edge.parentEntityId) && included.has(edge.childEntityId)),
  };
}
