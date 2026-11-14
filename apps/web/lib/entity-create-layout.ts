import { sectionColumnCount, sectionKey, type AttributeSectionOrder } from './attribute-layout';

export interface CreateAttributePlacement {
  /** Section recorded on the template assignment, when the template places the attribute in one. */
  templateSection?: string | null;
  /** Section on the attribute definition. */
  displaySection?: string | null;
  displayOrder?: number | null;
  displayGroup?: number | null;
  name: string;
}

export interface GroupedCreateSection<T> {
  section: string;
  displayOrder: number;
  columnCount: number;
  items: T[];
}

/** The section an attribute belongs to on the create screen. A template section wins. */
export function createAttributeSection(attribute: CreateAttributePlacement): string {
  const assigned = attribute.templateSection?.trim() || attribute.displaySection?.trim();
  return assigned || 'General';
}

/**
 * Group template attributes into the sections they are assigned to.
 * Template sections set the order when the template defines them.
 * Otherwise the entity type's section sequence is used.
 */
export function groupCreateAttributes<T extends CreateAttributePlacement>(
  attributes: T[],
  templateSections: AttributeSectionOrder[],
  attributeSections: AttributeSectionOrder[],
): Array<GroupedCreateSection<T>> {
  const templateRank = new Map(templateSections.map((section) => [sectionKey(section.sectionName), section]));
  const attributeRank = new Map(attributeSections.map((section) => [sectionKey(section.sectionName), section]));
  const buckets = new Map<string, { section: string; items: T[] }>();

  for (const attribute of attributes) {
    const section = createAttributeSection(attribute);
    const key = sectionKey(section);
    const bucket = buckets.get(key) || { section, items: [] };
    bucket.items.push(attribute);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .map((bucket) => {
      const key = sectionKey(bucket.section);
      const template = templateRank.get(key);
      const known = attributeRank.get(key);
      const items = [...bucket.items].sort((left, right) => {
        const order = (left.displayOrder ?? 0) - (right.displayOrder ?? 0);
        if (order !== 0) return order;
        const group = (left.displayGroup ?? 0) - (right.displayGroup ?? 0);
        if (group !== 0) return group;
        return left.name.localeCompare(right.name);
      });
      const fallback = items.reduce((min, item) => Math.min(min, item.displayOrder ?? item.displayGroup ?? 0), 0);
      return {
        section: template?.sectionName || known?.sectionName || bucket.section,
        displayOrder: template?.displayOrder ?? known?.displayOrder ?? 1000 + fallback,
        columnCount: sectionColumnCount(known?.columnCount),
        items,
      };
    })
    .sort((left, right) => left.displayOrder - right.displayOrder || left.section.localeCompare(right.section));
}
