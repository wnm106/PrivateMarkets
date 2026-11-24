import type { AttributeSectionOrder } from './attribute-layout';

/** A field on the record view, as GoldenRecordSections draws it. */
export interface RecordField {
  attributeCode: string;
  attributeName: string;
  required: boolean;
  displaySection: string;
  sortOrder: number;
  spanColumns?: number | null;
  spanRows?: number | null;
  dataType?: string;
  isDerived?: boolean;
  derivationFormula?: string | null;
  isEditable?: boolean;
}

/** A template as the domainTemplates query returns it. */
export interface RecordTemplate {
  templateCode: string;
  sections?: Array<{ sectionCode?: string | null; sectionName: string; displayOrder: number }> | null;
  attributes?: Array<{
    isRequired?: boolean | null;
    displayOrder?: number | null;
    displayLabel?: string | null;
    sectionName?: string | null;
    attribute: { attributeCode: string };
  }> | null;
}

/** Where a stored value goes when the record's template does not place its field. */
export const OTHER_FIELDS_SECTION = 'Other fields';

/**
 * The record view laid out by the record's template: the template's fields, in
 * its sections and order, with its labels and required flags. A template that
 * defines no sections is not a layout, so the view keeps the entity type's
 * layout (null). A value stored on a field the template leaves out is still
 * shown, under Other fields, so laying out by template never hides data.
 */
export function recordTemplateLayout(
  register: RecordField[],
  template: RecordTemplate | null | undefined,
  storedCodes: Iterable<string>,
): { fields: RecordField[]; sections: AttributeSectionOrder[] } | null {
  const templateSections = [...(template?.sections || [])].sort((a, b) => a.displayOrder - b.displayOrder);
  const assignments = template?.attributes || [];
  if (!template || templateSections.length === 0 || assignments.length === 0) return null;

  const byCode = new Map(register.map((field) => [field.attributeCode, field]));
  const fields: RecordField[] = [];
  const placed = new Set<string>();
  for (const assignment of assignments) {
    const code = assignment.attribute.attributeCode;
    const known = byCode.get(code);
    if (!known || placed.has(code)) continue;
    placed.add(code);
    fields.push({
      ...known,
      attributeName: assignment.displayLabel?.trim() || known.attributeName,
      required: assignment.isRequired === true,
      displaySection: assignment.sectionName?.trim() || known.displaySection || OTHER_FIELDS_SECTION,
      sortOrder: assignment.displayOrder ?? known.sortOrder,
    });
  }
  if (fields.length === 0) return null;

  const others: RecordField[] = [];
  for (const code of storedCodes) {
    const known = byCode.get(code);
    if (!known || placed.has(code)) continue;
    placed.add(code);
    others.push({ ...known, required: false, displaySection: OTHER_FIELDS_SECTION });
  }

  const sections: AttributeSectionOrder[] = templateSections.map((section, index) => ({
    sectionName: section.sectionName,
    displayOrder: index + 1,
  }));
  // Fields whose section the template does not name keep their own, after the template's.
  const named = new Set(sections.map((section) => section.sectionName.trim().toLowerCase()));
  let next = sections.length + 1;
  for (const field of fields) {
    const key = field.displaySection.trim().toLowerCase();
    if (named.has(key)) continue;
    named.add(key);
    sections.push({ sectionName: field.displaySection, displayOrder: next++ });
  }
  if (others.length > 0) sections.push({ sectionName: OTHER_FIELDS_SECTION, displayOrder: 100000 });

  return { fields: [...fields, ...others], sections };
}
