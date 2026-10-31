import { describe, expect, it } from 'vitest';
import { planChildMerge, type ChildRecord } from './children';

function child(partial: Partial<ChildRecord> & Pick<ChildRecord, 'id' | 'entityName'>): ChildRecord {
  return {
    entityCode: partial.id || partial.entityName,
    domainCode: 'SECURITY',
    createdAt: '2026-03-01T00:00:00Z',
    descendantCount: 0,
    ...partial,
  };
}

describe('planChildMerge', () => {
  it('moves children and merges only an exact same-name sibling', () => {
    const plan = planChildMerge(
      [
        child({ id: 'sec-old', entityName: 'Bench Security 1', createdAt: '2026-01-01T00:00:00Z', descendantCount: 4 }),
        child({ id: 'sec-other', entityName: 'Bench Security 2' }),
        child({ id: 'fund-1', entityName: 'Bench Fund 1', domainCode: 'FUND' }),
      ],
      [
        child({ id: 'sec-new', entityName: 'Bench Security 1', createdAt: '2026-08-01T00:00:00Z', descendantCount: 2 }),
        child({ id: 'sec-3', entityName: 'Bench Security 3', descendantCount: 1 }),
        child({ id: 'fund-3', entityName: 'Bench Fund 3', domainCode: 'FUND' }),
      ],
    );
    expect(plan.moving).toBe(3);
    expect(plan.descendantMoving).toBe(6);
    expect(plan.exactCount).toBe(1);
    expect(plan.reviewCount).toBe(0);
    expect(plan.collisions[0].kept.id).toBe('sec-old');
    expect(plan.collisions[0].moved.id).toBe('sec-new');
  });

  it('keeps the older child when the moved record was created first', () => {
    const plan = planChildMerge(
      [child({ id: 'newer', entityName: 'Northwind Note', createdAt: '2026-09-01T00:00:00Z' })],
      [child({ id: 'older', entityName: 'Northwind Note', createdAt: '2024-01-01T00:00:00Z' })],
    );
    expect(plan.collisions[0].kept.id).toBe('older');
    expect(plan.collisions[0].moved.id).toBe('newer');
  });

  it('treats a legal suffix as the same name and sends a longer near name to review', () => {
    const plan = planChildMerge(
      [
        child({ id: 'inc', entityName: 'Harborline Foods Inc' }),
        child({ id: 'capital', entityName: 'Northgate Capital' }),
      ],
      [
        child({ id: 'plain', entityName: 'Harborline Foods' }),
        child({ id: 'partners', entityName: 'Northgate Capital Partners LP' }),
      ],
    );
    expect(plan.exactCount).toBe(1);
    expect(plan.reviewCount).toBe(1);
    expect(plan.collisions.find((collision) => collision.exact)?.moved.id).toBe('plain');
    expect(plan.collisions.find((collision) => !collision.exact)?.moved.id).toBe('partners');
  });
});
