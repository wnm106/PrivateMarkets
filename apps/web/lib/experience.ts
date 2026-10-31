import type { EntityData } from '@/components/detail/types';

export interface ExperienceSection {
  key: string;
  title: string;
  kind: string;
  placement: string;
  domainCode?: string | null;
  relationshipCode?: string | null;
  direction?: string | null;
  columns: string[];
  dashboardCode?: string | null;
  templateCode?: string | null;
}

export interface ExperiencePipelineStage {
  code: string;
  label: string;
}

export interface ExperiencePipeline {
  stageAttribute: string;
  stages: ExperiencePipelineStage[];
  cardAttributes: string[];
}

export interface RecordExperience {
  id: string;
  experienceCode: string;
  experienceName: string;
  description?: string | null;
  anchorDomainCode: string;
  sections: ExperienceSection[];
  pipeline?: ExperiencePipeline | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface CatalogAttribute {
  attributeCode: string;
  attributeName: string;
  dataType?: string | null;
  displaySection?: string | null;
  displayGroup?: number | null;
  isEditable?: boolean | null;
  isVisible?: boolean | null;
  isDerived?: boolean | null;
  domainCode?: string | null;
}

export interface RelatedRef {
  id: string;
  code: string;
  name: string;
  domainCode: string;
}

export const EXPERIENCE_FIELDS = `
  id
  experienceCode
  experienceName
  description
  anchorDomainCode
  isDefault
  isActive
  sections {
    key
    title
    kind
    placement
    domainCode
    relationshipCode
    direction
    columns
    dashboardCode
    templateCode
  }
  pipeline {
    stageAttribute
    cardAttributes
    stages { code label }
  }
`;

export const RECORD_EXPERIENCE_QUERY = `
  query RecordExperience($experienceCode: String!) {
    recordExperience(experienceCode: $experienceCode) { ${EXPERIENCE_FIELDS} }
  }
`;

export const RECORD_EXPERIENCES_QUERY = `
  query RecordExperiences($anchorDomainCode: String, $isActive: Boolean) {
    recordExperiences(anchorDomainCode: $anchorDomainCode, isActive: $isActive) { ${EXPERIENCE_FIELDS} }
  }
`;

export function attributeText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
    const value = (raw as { value: unknown }).value;
    return value == null ? '' : String(value);
  }
  return String(raw);
}

export function relatedRefs(entity: EntityData, section: ExperienceSection): RelatedRef[] {
  if (!section.relationshipCode) {
    return [{
      id: entity.id,
      code: entity.entityCode,
      name: entity.entityName,
      domainCode: entity.domainCode,
    }];
  }
  const up = (section.direction || 'DOWN').toUpperCase() === 'UP';
  if (up) {
    return (entity.parentRelationships || [])
      .filter((rel) => rel.relationshipCode === section.relationshipCode)
      .map((rel) => ({
        id: rel.parentEntityId,
        code: rel.parentEntityCode,
        name: rel.parentEntityName,
        domainCode: rel.parentDomainCode,
      }));
  }
  return (entity.childRelationships || [])
    .filter((rel) => rel.relationshipCode === section.relationshipCode)
    .map((rel) => ({
      id: rel.childEntityId,
      code: rel.childEntityCode,
      name: rel.childEntityName,
      domainCode: rel.childDomainCode,
    }));
}

/** Visible attributes for a section. Pinned columns lead; every other visible attribute follows, so a newly added attribute still appears. */
export function fieldsForSection(
  catalog: CatalogAttribute[],
  assignedCodes: Set<string>,
  domainCode: string,
  columns: string[],
): CatalogAttribute[] {
  const visible = catalog.filter((attr) => {
    if (attr.isVisible === false) return false;
    return attr.domainCode === domainCode || assignedCodes.has(attr.attributeCode);
  });
  const byOrder = (a: CatalogAttribute, b: CatalogAttribute) =>
    (a.displayGroup ?? 0) - (b.displayGroup ?? 0) || a.attributeName.localeCompare(b.attributeName);
  if (columns.length === 0) return [...visible].sort(byOrder);
  const byCode = new Map(visible.map((attr) => [attr.attributeCode, attr]));
  const pinned = columns.map((code) => byCode.get(code)).filter((attr): attr is CatalogAttribute => Boolean(attr));
  const pinnedCodes = new Set(columns);
  const rest = visible.filter((attr) => !pinnedCodes.has(attr.attributeCode)).sort(byOrder);
  return [...pinned, ...rest];
}

export function groupFields(fields: CatalogAttribute[]): Array<{ section: string; fields: CatalogAttribute[] }> {
  const groups = new Map<string, CatalogAttribute[]>();
  for (const field of fields) {
    const section = field.displaySection || 'General';
    const list = groups.get(section) || [];
    list.push(field);
    groups.set(section, list);
  }
  return Array.from(groups.entries()).map(([section, sectionFields]) => ({ section, fields: sectionFields }));
}

export function readOnlyField(field: CatalogAttribute): boolean {
  return field.isDerived === true || field.isEditable === false;
}

export function inputKind(dataType?: string | null): 'text' | 'number' | 'date' | 'checkbox' {
  const type = (dataType || '').toUpperCase();
  if (type === 'DATE') return 'date';
  if (type === 'BOOLEAN') return 'checkbox';
  if (['NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE'].includes(type)) return 'number';
  return 'text';
}
