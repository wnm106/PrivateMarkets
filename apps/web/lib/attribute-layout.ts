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

export type FieldVisibility = 'all' | 'required' | 'populated' | 'missing';

/** Fields that match the attribute-page radio: every field, required ones, only stored values, or only blanks. */
export function fieldsForVisibility<T extends { populated: boolean; required?: boolean }>(
  items: T[],
  visibility: FieldVisibility,
): T[] {
  if (visibility === 'required') return items.filter((item) => item.required === true);
  if (visibility === 'populated') return items.filter((item) => item.populated);
  if (visibility === 'missing') return items.filter((item) => !item.populated);
  return items;
}

/**
 * Fields whose name, code, section or value contains every word of the search, ignoring case.
 * A blank search keeps every field.
 */
export function fieldsMatchingSearch<T extends { name: string; key: string; section?: string; value?: string | null }>(
  items: T[],
  search: string,
): T[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((item) => {
    const text = [item.name, item.key, item.key.replace(/_/g, ' '), item.section, item.value].filter(Boolean).join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
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

/** DOM id slug for an attribute section. Blank and punctuation-only names become `general`. */
export function sectionAnchor(name?: string | null) {
  const slug = sectionKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'general';
}

/** Stable nav targets for attribute sections, with a suffix when two names share a slug. */
export function attributeSectionLinks(names: string[]): Array<{ id: string; label: string }> {
  const used = new Set<string>();
  return names.map((label) => {
    const base = `attr-${sectionAnchor(label)}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { id, label };
  });
}

export interface DisplaySection<T> {
  section: string;
  displayOrder: number;
  columnCount: number;
  items: T[];
}

/** Sections in display order, including sections that do not have an attribute yet. */
export function sectionsForDisplay<T extends AttributeDisplayItem>(
  items: T[],
  sections: AttributeSectionOrder[],
): DisplaySection<T>[] {
  const grouped = groupForDisplay(items, sections);
  const rank = new Map(sections.map((section) => [sectionKey(section.sectionName), section]));
  const seen = new Set(grouped.map((group) => sectionKey(group.section)));
  const filled: DisplaySection<T>[] = grouped.map((group) => ({
    ...group,
    columnCount: sectionColumnCount(rank.get(sectionKey(group.section))?.columnCount),
  }));
  const empty: DisplaySection<T>[] = sections
    .filter((section) => !seen.has(sectionKey(section.sectionName)))
    .map((section) => ({
      section: section.sectionName,
      displayOrder: section.displayOrder,
      columnCount: sectionColumnCount(section.columnCount),
      items: [],
    }));
  return [...filled, ...empty].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.section.localeCompare(b.section),
  );
}

export interface MovableAttribute {
  id: string;
  owned: boolean;
}

export type AttributeDropTarget =
  | { kind: 'section'; section: string }
  | { kind: 'before' | 'after'; attributeId: string };

/**
 * Where an owned attribute lands after a drop.
 * The returned ids are the destination section's owned attributes, in order.
 * A drop that does not change that order returns null.
 */
export function planAttributeMove(
  groups: Array<{ section: string; items: MovableAttribute[] }>,
  attributeId: string,
  target: AttributeDropTarget,
): { section: string; attributeIds: string[] } | null {
  const source = groups.find((group) => group.items.some((item) => item.id === attributeId));
  const moving = source?.items.find((item) => item.id === attributeId);
  if (!source || !moving?.owned) return null;
  if (target.kind !== 'section' && target.attributeId === attributeId) return null;

  const destination = target.kind === 'section'
    ? groups.find((group) => sectionKey(group.section) === sectionKey(target.section))
      ?? { section: target.section, items: [] as MovableAttribute[] }
    : groups.find((group) => group.items.some((item) => item.id === target.attributeId));
  if (!destination) return null;

  const sameSection = sectionKey(source.section) === sectionKey(destination.section);
  const base = sameSection ? source.items.filter((item) => item.id !== attributeId) : [...destination.items];
  let index = base.length;
  if (target.kind !== 'section') {
    const at = base.findIndex((item) => item.id === target.attributeId);
    if (at < 0) return null;
    index = target.kind === 'before' ? at : at + 1;
  }
  const nextItems = [...base.slice(0, index), moving, ...base.slice(index)];
  const unchanged = sameSection && nextItems.every((item, position) => item.id === source.items[position]?.id);
  if (unchanged) return null;
  return {
    section: destination.section,
    attributeIds: nextItems.filter((item) => item.owned).map((item) => item.id),
  };
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

/** Attributes flattened in the record editor's order: by section, then by position within the section. */
export function attributesInDisplayOrder<T extends AttributeDisplayItem>(
  items: T[],
  sections: AttributeSectionOrder[],
): T[] {
  return groupForDisplay(items, sections).flatMap((group) => group.items);
}

function clamp(value: number | null | undefined, min: number, max: number) {
  const span = Number(value);
  if (!Number.isFinite(span)) return min;
  return Math.min(max, Math.max(min, Math.round(span)));
}
