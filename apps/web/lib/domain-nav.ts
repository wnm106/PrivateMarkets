export interface DomainNavItem {
  code: string;
  name: string;
  groupName: string;
  groupOrder: number;
  displayOrder: number;
  parentCode: string | null;
}

export interface DomainNavRow<T extends DomainNavItem> {
  domain: T;
  depth: number;
  showGroup: boolean;
}

function byOrder<T extends DomainNavItem>(a: T, b: T): number {
  return a.displayOrder - b.displayOrder || a.name.localeCompare(b.name);
}

function nestGroup<T extends DomainNavItem>(items: T[]): Array<{ domain: T; depth: number }> {
  const byCode = new Map(items.map((item) => [item.code, item]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = item.parentCode ? byCode.get(item.parentCode) : undefined;
    if (parent && parent.code !== item.code) {
      const list = children.get(parent.code) || [];
      list.push(item);
      children.set(parent.code, list);
    } else {
      roots.push(item);
    }
  }

  const rows: Array<{ domain: T; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (item: T, depth: number) => {
    if (seen.has(item.code)) return;
    seen.add(item.code);
    rows.push({ domain: item, depth });
    for (const child of (children.get(item.code) || []).sort(byOrder)) walk(child, depth + 1);
  };
  for (const root of roots.sort(byOrder)) walk(root, 0);
  for (const item of [...items].sort(byOrder)) walk(item, 0);
  return rows;
}

/** Directory order: each catalog band, then each type under its directory parent. */
export function nestDomainLinks<T extends DomainNavItem>(domains: T[]): Array<DomainNavRow<T>> {
  const groups = new Map<string, { order: number; items: T[] }>();
  for (const domain of domains) {
    const group = groups.get(domain.groupName) || { order: domain.groupOrder, items: [] };
    group.order = Math.min(group.order, domain.groupOrder);
    group.items.push(domain);
    groups.set(domain.groupName, group);
  }
  const rows: Array<DomainNavRow<T>> = [];
  const ordered = [...groups.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  for (const [, group] of ordered) {
    nestGroup(group.items).forEach((row, index) => {
      rows.push({ domain: row.domain, depth: row.depth, showGroup: index === 0 });
    });
  }
  return rows;
}
