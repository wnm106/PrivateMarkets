/** Widest attribute row that still keeps a 1×1 cell readable beside the record sidebar. */
export const ATTRIBUTE_GRID_COLUMNS = 4;
/** Tallest cell. Notes and JSON use 2 or 3; everything else stays 1. */
export const ATTRIBUTE_GRID_MAX_ROWS = 3;

export interface AttributeSectionOrder {
  sectionName: string;
  displayOrder: number;
  columnCount?: number | null;
}

export interface AttributeDisplayItem {
  section: string;
  sortOrder: number;
  name: string;
}

export function clampAttributeSpan(columns?: number | null, rows?: number | null, maxColumns = ATTRIBUTE_GRID_COLUMNS) {
  return {
    columns: clamp(columns, 1, clamp(maxColumns, 1, ATTRIBUTE_GRID_COLUMNS)),
    rows: clamp(rows, 1, ATTRIBUTE_GRID_MAX_ROWS),
  };
}

export function sectionColumnCount(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return ATTRIBUTE_GRID_COLUMNS;
  return clamp(value, 1, ATTRIBUTE_GRID_COLUMNS);
}

export function sectionKey(name?: string | null) {
  return (name || 'General').trim().toLowerCase() || 'general';
}

export function groupForDisplay<T extends AttributeDisplayItem>(
  items: T[],
  sections: AttributeSectionOrder[],
): Array<{ section: string; displayOrder: number; items: T[] }> {
  const buckets = new Map<string, { section: string; items: T[] }>();
  for (const item of items) {
    const section = item.section?.trim() || 'General';
    const key = sectionKey(section);
    const bucket = buckets.get(key) || { section, items: [] };
    bucket.items.push(item);
    buckets.set(key, bucket);
  }

  const rank = new Map(sections.map((section) => [sectionKey(section.sectionName), section]));
  return Array.from(buckets.values())
    .map((bucket) => {
      const itemsInOrder = [...bucket.items].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );
      const fallback = itemsInOrder.reduce((min, item) => Math.min(min, item.sortOrder), 0);
      const known = rank.get(sectionKey(bucket.section));
      return {
        section: bucket.section,
        displayOrder: known?.displayOrder ?? 1000 + fallback,
        columnCount: sectionColumnCount(known?.columnCount),
        items: itemsInOrder,
      };
    })
    .sort((a, b) => a.displayOrder - b.displayOrder || a.section.localeCompare(b.section));
}

function clamp(value: number | null | undefined, min: number, max: number) {
  const span = Number(value);
  if (!Number.isFinite(span)) return min;
  return Math.min(max, Math.max(min, Math.round(span)));
}
