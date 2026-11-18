/**
 * Which template a record uses.
 *
 * A relationship type can say that the records on one stored side take their
 * template from the record on the other side. The stored columns are named
 * parent and child, but the parent column holds the record that carries the
 * link (a statement period) and the child column holds the record it points
 * to (the issuer). The rule therefore names the supplying side outright.
 *
 * Order: the record's own override, the choice on the linked record for the
 * record's date, the template stamped on the record.
 */

export type TemplateSide = 'PARENT' | 'CHILD';
export type TemplateSourceKind = 'OVERRIDE' | 'INHERITED' | 'OWN' | 'NONE';

export interface InheritanceRule {
  relationshipCode: string;
  relationshipName?: string | null;
  parentDomainCode: string;
  childDomainCode: string;
  templateFromSide: TemplateSide;
}

export interface TemplateChoice {
  id?: string;
  entityId: string;
  /** Null when the choice is the record's own override. */
  relationshipCode: string | null;
  templateId: string;
  validFrom: string;
  validTo: string;
}

export interface TemplateLink {
  relationshipCode: string;
  /** Stored side the linked record sits on. */
  side: TemplateSide;
  entityId: string;
  entityName?: string | null;
  /** Entity type of the linked record, when known. */
  domainCode?: string | null;
}

export interface TemplateRecord {
  id: string;
  domainCode: string;
  ownTemplateId: string | null;
  /** Date the choice is read for: the record's period date, or the as-of date. */
  onDate: string;
  links: TemplateLink[];
}

export interface EffectiveTemplate {
  entityId: string;
  templateId: string | null;
  source: TemplateSourceKind;
  /** The linked record that supplies, or could supply, the template. */
  fromEntityId: string | null;
  fromEntityName: string | null;
  relationshipCode: string | null;
  onDate: string;
}

const OPEN_END = '9999-12-31';

function code(value: string | null | undefined): string {
  return (value || '').trim().toUpperCase();
}

function day(value: string | null | undefined): string {
  return (value || '').slice(0, 10);
}

export function templateSide(value: unknown): TemplateSide | null {
  const side = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return side === 'PARENT' || side === 'CHILD' ? side : null;
}

/** Entity type whose records choose the template. */
export function supplyingDomain(rule: InheritanceRule): string {
  return code(rule.templateFromSide === 'CHILD' ? rule.childDomainCode : rule.parentDomainCode);
}

/** Entity type whose records receive the template. */
export function inheritingDomain(rule: InheritanceRule): string {
  return code(rule.templateFromSide === 'CHILD' ? rule.parentDomainCode : rule.childDomainCode);
}

export function rulesForInheritor(domainCode: string, rules: InheritanceRule[]): InheritanceRule[] {
  const domain = code(domainCode);
  return rules.filter((rule) => inheritingDomain(rule) === domain && supplyingDomain(rule) !== '');
}

export function rulesForSupplier(domainCode: string, rules: InheritanceRule[]): InheritanceRule[] {
  const domain = code(domainCode);
  return rules.filter((rule) => supplyingDomain(rule) === domain && inheritingDomain(rule) !== '');
}

/** The choice in force on a date. The latest start wins if rows overlap. */
/**
 * Whether a link reaches the record that supplies the template. Some
 * relationships are stored in both directions, so the linked record's entity
 * type decides when it is known. The stored side decides otherwise, and
 * always when both ends are the same entity type.
 */
export function linkSupplies(link: TemplateLink, rule: InheritanceRule): boolean {
  if (code(link.relationshipCode) !== code(rule.relationshipCode)) return false;
  const supplier = supplyingDomain(rule);
  if (link.domainCode && supplier !== inheritingDomain(rule)) return code(link.domainCode) === supplier;
  return link.side === rule.templateFromSide;
}

export function choiceOn(
  choices: TemplateChoice[],
  entityId: string,
  relationshipCode: string | null,
  onDate: string,
): TemplateChoice | null {
  const wanted = code(relationshipCode);
  const date = day(onDate) || OPEN_END;
  let best: TemplateChoice | null = null;
  for (const choice of choices) {
    if (choice.entityId !== entityId || code(choice.relationshipCode) !== wanted) continue;
    if (day(choice.validFrom) > date || (day(choice.validTo) || OPEN_END) < date) continue;
    if (!best || day(choice.validFrom) > day(best.validFrom)) best = choice;
  }
  return best;
}

export function resolveEffectiveTemplate(
  record: TemplateRecord,
  rules: InheritanceRule[],
  choices: TemplateChoice[],
): EffectiveTemplate {
  const result: EffectiveTemplate = {
    entityId: record.id,
    templateId: record.ownTemplateId,
    source: record.ownTemplateId ? 'OWN' : 'NONE',
    fromEntityId: null,
    fromEntityName: null,
    relationshipCode: null,
    onDate: day(record.onDate),
  };

  let inherited: { choice: TemplateChoice; link: TemplateLink } | null = null;
  let supplier: TemplateLink | null = null;
  const applicable = [...rulesForInheritor(record.domainCode, rules)]
    .sort((a, b) => a.relationshipCode.localeCompare(b.relationshipCode));
  for (const rule of applicable) {
    const links = record.links.filter((link) => linkSupplies(link, rule));
    for (const link of links) {
      if (!supplier) supplier = link;
      const choice = choiceOn(choices, link.entityId, rule.relationshipCode, record.onDate);
      if (choice && !inherited) inherited = { choice, link };
    }
  }

  const named = inherited?.link || supplier;
  if (named) {
    result.fromEntityId = named.entityId;
    result.fromEntityName = named.entityName || null;
    result.relationshipCode = named.relationshipCode;
  }

  const override = choiceOn(choices, record.id, null, record.onDate);
  if (override) {
    result.templateId = override.templateId;
    result.source = 'OVERRIDE';
  } else if (inherited) {
    result.templateId = inherited.choice.templateId;
    result.source = 'INHERITED';
  }
  return result;
}
