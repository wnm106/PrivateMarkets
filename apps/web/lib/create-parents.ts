import {
  domainLabel,
  domainPlacements,
  type DomainPlacement,
  type ParentLinkCount,
  type ParentRelationshipType,
} from './parent-entities';

export interface CreateRelationshipType extends ParentRelationshipType {
  relationshipName?: string | null;
  isRequired?: boolean | null;
}

export interface CreateIntersectionMember {
  domainCode: string;
  memberRole?: string | null;
  isRequired?: boolean | null;
  displayOrder?: number | null;
}

/** One parent the create screen asks for before anything else. */
export interface CreateParentSlot {
  key: string;
  domainCode: string;
  label: string;
  relationshipCode: string;
  relationshipName: string;
  /** UP stores the chosen record as the parent. DOWN stores it as the child. */
  direction: 'UP' | 'DOWN';
  required: boolean;
  displayOrder: number;
}

export interface ParentSelection {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  relationshipCode: string;
  relationshipName: string;
  isPrimary: boolean;
  validFrom: string;
}

/**
 * Parents to pick while creating a record.
 * An intersection such as Position lists each member, required ones first in member order.
 * Any other entity type lists the single parent it belongs to, such as a security's issuer.
 */
export function createParentSlots(
  domainCode: string,
  relationships: CreateRelationshipType[],
  options: {
    names?: Record<string, string>;
    linkCounts?: ParentLinkCount[];
    intersectionMembers?: CreateIntersectionMember[];
  } = {},
): CreateParentSlot[] {
  const domain = domainCode.trim().toUpperCase();
  if (!domain) return [];

  const names = options.names || {};
  const placements = domainPlacements(domain, relationships, options.linkCounts || []);
  const byCode = new Map(relationships.map((relationship) => [relationship.relationshipCode.trim().toUpperCase(), relationship]));
  const members = (options.intersectionMembers || [])
    .map((member) => ({
      ...member,
      domainCode: member.domainCode.trim().toUpperCase(),
    }))
    .filter((member) => member.domainCode && member.domainCode !== domain)
    .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0) || left.domainCode.localeCompare(right.domainCode));

  const usedTargets = new Set<string>();
  const slots: CreateParentSlot[] = [];
  const push = (placement: DomainPlacement, required: boolean, displayOrder: number, key: string) => {
    if (usedTargets.has(placement.target)) return;
    usedTargets.add(placement.target);
    const relationship = byCode.get(placement.relationshipCode.trim().toUpperCase());
    const label = names[placement.target] || names[placement.target.toUpperCase()] || domainLabel(placement.target);
    slots.push({
      key,
      domainCode: placement.target,
      label,
      relationshipCode: placement.relationshipCode,
      relationshipName: relationship?.relationshipName?.trim() || label,
      direction: placement.direction,
      required,
      displayOrder,
    });
  };

  members.forEach((member, index) => {
    const placement = bestPlacement(placements, member.domainCode, domain, false);
    if (!placement) return;
    const relationship = byCode.get(placement.relationshipCode.trim().toUpperCase());
    push(
      placement,
      Boolean(member.isRequired) || Boolean(relationship?.isRequired),
      member.displayOrder ?? index,
      member.memberRole?.trim() || member.domainCode,
    );
  });

  // An intersection's parents are its members. A position does not also pick its tranche.
  const extras = members.length > 0 ? [] : singularPlacements(placements, domain)
    .sort((left, right) => {
      const leftRequired = byCode.get(left.relationshipCode.trim().toUpperCase())?.isRequired ? 0 : 1;
      const rightRequired = byCode.get(right.relationshipCode.trim().toUpperCase())?.isRequired ? 0 : 1;
      if (leftRequired !== rightRequired) return leftRequired - rightRequired;
      return labelOf(left.target, names).localeCompare(labelOf(right.target, names));
    });
  extras.forEach((placement, index) => {
    const relationship = byCode.get(placement.relationshipCode.trim().toUpperCase());
    push(placement, Boolean(relationship?.isRequired), 1000 + index, placement.relationshipCode);
  });

  return slots.sort((left, right) => left.displayOrder - right.displayOrder || left.label.localeCompare(right.label));
}

export function createParentSummary(slots: CreateParentSlot[]): string {
  const required = slots.filter((slot) => slot.required).map((slot) => slot.label);
  const optional = slots.filter((slot) => !slot.required).map((slot) => slot.label);
  if (required.length && optional.length) {
    return `${joinLabels(required)} ${required.length === 1 ? 'is' : 'are'} required. ${joinLabels(optional)} ${optional.length === 1 ? 'is' : 'are'} optional.`;
  }
  if (required.length === 1) return `${required[0]} is required.`;
  if (required.length > 1) return `${joinLabels(required)} are required.`;
  if (optional.length === 1) return `Select the ${optional[0].toLowerCase()}.`;
  if (optional.length > 1) return `Select the ${joinLabels(optional.map((label) => label.toLowerCase()))}.`;
  return '';
}

export function selectedParent<T extends { relationshipCode: string }>(
  parents: readonly T[],
  children: readonly T[],
  slot: Pick<CreateParentSlot, 'relationshipCode' | 'direction'>,
): T | null {
  const code = slot.relationshipCode.trim().toUpperCase();
  const rows = slot.direction === 'UP' ? parents : children;
  return rows.find((row) => row.relationshipCode.trim().toUpperCase() === code) ?? null;
}

export function unfilledRequiredParents<T extends { relationshipCode: string }>(
  slots: readonly CreateParentSlot[],
  parents: readonly T[],
  children: readonly T[],
): CreateParentSlot[] {
  return slots.filter((slot) => slot.required && !selectedParent(parents, children, slot));
}

/** Replace the record chosen for one parent slot, on the side that relationship stores. */
export function assignParentSlot<T extends { relationshipCode: string }>(
  parents: readonly T[],
  children: readonly T[],
  slot: Pick<CreateParentSlot, 'relationshipCode' | 'direction'>,
  entry: T | null,
): { parentRelationships: T[]; childRelationships: T[] } {
  const code = slot.relationshipCode.trim().toUpperCase();
  const drop = (rows: readonly T[]) => rows.filter((row) => row.relationshipCode.trim().toUpperCase() !== code);
  const parentRelationships = drop(parents);
  const childRelationships = drop(children);
  if (entry) {
    if (slot.direction === 'UP') parentRelationships.push(entry);
    else childRelationships.push(entry);
  }
  return { parentRelationships, childRelationships };
}

function singularPlacements(placements: DomainPlacement[], domain: string): DomainPlacement[] {
  const chosen = new Map<string, DomainPlacement>();
  for (const placement of placements) {
    if (!placement.singular) continue;
    const current = chosen.get(placement.target);
    if (!current || comparePlacements(domain)(placement, current) < 0) chosen.set(placement.target, placement);
  }
  return [...chosen.values()];
}

function bestPlacement(
  placements: DomainPlacement[],
  target: string,
  domain: string,
  singularOnly: boolean,
): DomainPlacement | null {
  const matches = placements.filter((placement) => placement.target === target && (!singularOnly || placement.singular));
  matches.sort(comparePlacements(domain));
  return matches[0] || null;
}

function comparePlacements(domain: string) {
  return (left: DomainPlacement, right: DomainPlacement) => {
    if (left.singular !== right.singular) return left.singular ? -1 : 1;
    if (right.weight !== left.weight) return right.weight - left.weight;
    const leftOwn = left.relationshipCode.toUpperCase().startsWith(`${domain}_`) ? 0 : 1;
    const rightOwn = right.relationshipCode.toUpperCase().startsWith(`${domain}_`) ? 0 : 1;
    return leftOwn - rightOwn || left.relationshipCode.localeCompare(right.relationshipCode);
  };
}

function labelOf(domain: string, names: Record<string, string>): string {
  return names[domain] || names[domain.toUpperCase()] || domainLabel(domain);
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}
