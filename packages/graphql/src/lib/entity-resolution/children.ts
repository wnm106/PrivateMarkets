import { conflictingSeriesNumbers, jaroWinkler, normalizeName } from './similarity';

export interface ChildRecord {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  createdAt?: string | null;
  descendantCount: number;
}

export interface ChildCollision {
  /** The child that survives. The older record, or the one already on the kept parent when ages tie. */
  kept: ChildRecord;
  moved: ChildRecord;
  exact: boolean;
}

export interface ChildPlan {
  moving: number;
  descendantMoving: number;
  exactCount: number;
  reviewCount: number;
  collisions: ChildCollision[];
}

function age(record: ChildRecord): number | null {
  if (!record.createdAt) return null;
  const time = Date.parse(record.createdAt);
  return Number.isNaN(time) ? null : time;
}

function olderFirst(existing: ChildRecord, incoming: ChildRecord): { kept: ChildRecord; moved: ChildRecord } {
  const existingAge = age(existing);
  const incomingAge = age(incoming);
  if (existingAge == null || incomingAge == null || existingAge <= incomingAge) {
    return { kept: existing, moved: incoming };
  }
  return { kept: incoming, moved: existing };
}

function sameName(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return a.length >= 2 && a === b && !conflictingSeriesNumbers(left, right);
}

function closeName(left: string, right: string): boolean {
  if (sameName(left, right) || conflictingSeriesNumbers(left, right)) return false;
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a.length < 4 || b.length < 4) return false;
  return jaroWinkler(a, b) >= 0.9;
}

/**
 * Children of the retired record move onto the survivor.
 * A child collides only with a child already under the survivor.
 * The same name is exact. A near name without a conflicting series number is a review match.
 */
export function planChildMerge(keptChildren: ChildRecord[], movedChildren: ChildRecord[]): ChildPlan {
  const available = new Map(keptChildren.map((child) => [child.id, child]));
  const collisions: ChildCollision[] = [];
  const claimedMoved = new Set<string>();

  const take = (incoming: ChildRecord, match: (existing: ChildRecord) => boolean) => {
    for (const existing of available.values()) {
      if (existing.domainCode !== incoming.domainCode) continue;
      if (!match(existing.entityName, incoming.entityName)) continue;
      const pair = olderFirst(existing, incoming);
      collisions.push({ ...pair, exact: sameName(existing.entityName, incoming.entityName) });
      available.delete(existing.id);
      claimedMoved.add(incoming.id);
      return;
    }
  };

  for (const incoming of movedChildren) take(incoming, sameName);
  const fuzzyBudget = keptChildren.length * movedChildren.length;
  if (fuzzyBudget <= 4000) {
    for (const incoming of movedChildren) {
      if (claimedMoved.has(incoming.id)) continue;
      take(incoming, closeName);
    }
  }

  const moving = movedChildren.length;
  const descendantMoving = moving + movedChildren.reduce((sum, child) => sum + child.descendantCount, 0);
  return {
    moving,
    descendantMoving,
    exactCount: collisions.filter((collision) => collision.exact).length,
    reviewCount: collisions.filter((collision) => !collision.exact).length,
    collisions,
  };
}
