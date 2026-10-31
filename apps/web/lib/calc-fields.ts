export interface CalcRelationship {
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode: string | null;
  childDomainCode: string | null;
}

export interface CalcAttributeOption {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  domainCode: string | null;
}

export interface CalcPlace {
  domainCode: string;
  traversal: 'SELF' | 'UP' | 'DOWN';
  relationshipCodes: string[];
  relationshipNames: string[];
}

export interface CalcFieldChoice extends CalcAttributeOption {
  place: CalcPlace;
  groupLabel: string;
}

export interface CalcOperandBinding {
  attributeCode: string;
  traversal: 'SELF' | 'UP' | 'DOWN';
  relationshipCodes: string[];
}

export function domainLabel(code: string | null | undefined, names: Record<string, string>): string {
  if (!code) return 'Shared';
  return names[code] || code.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Places a calculation can read, staying on one direction so the calc engine can follow the path. */
export function reachablePlaces(rootDomain: string, relationships: CalcRelationship[], depth = 2): CalcPlace[] {
  const places: CalcPlace[] = [{
    domainCode: rootDomain,
    traversal: 'SELF',
    relationshipCodes: [],
    relationshipNames: [],
  }];
  const seen = new Set<string>([rootDomain]);
  let frontier = places.slice();

  for (let step = 0; step < depth; step += 1) {
    const next: CalcPlace[] = [];
    for (const place of frontier) {
      for (const relationship of relationships) {
        const down = relationship.parentDomainCode === place.domainCode;
        const up = relationship.childDomainCode === place.domainCode;
        if (!down && !up) continue;
        const traversal: 'UP' | 'DOWN' = down ? 'DOWN' : 'UP';
        if (place.traversal !== 'SELF' && place.traversal !== traversal) continue;
        const target = down ? relationship.childDomainCode : relationship.parentDomainCode;
        if (!target || target === place.domainCode) continue;
        const relationshipCodes = [...place.relationshipCodes, relationship.relationshipCode];
        const key = `${traversal}:${relationshipCodes.join('>')}:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hop: CalcPlace = {
          domainCode: target,
          traversal,
          relationshipCodes,
          relationshipNames: [...place.relationshipNames, relationship.relationshipName || relationship.relationshipCode],
        };
        places.push(hop);
        next.push(hop);
      }
    }
    frontier = next;
  }
  return places;
}

export function placeLabel(place: CalcPlace, names: Record<string, string>): string {
  const entity = domainLabel(place.domainCode, names);
  if (place.traversal === 'SELF') return `this ${entity}`;
  const via = place.relationshipNames.filter(Boolean).join(' → ');
  return via ? `${entity} via ${via}` : entity;
}

export function fieldChoices(
  rootDomain: string,
  attributes: CalcAttributeOption[],
  relationships: CalcRelationship[],
  names: Record<string, string>,
  selfOnly = false,
): CalcFieldChoice[] {
  const places = reachablePlaces(rootDomain, relationships).filter((place) => !selfOnly || place.traversal === 'SELF');
  const choices: CalcFieldChoice[] = [];
  for (const place of places) {
    const groupLabel = placeLabel(place, names);
    for (const attribute of attributes) {
      const home = attribute.domainCode;
      const onThisRecord = place.traversal === 'SELF' && (!home || home === rootDomain);
      const onRelated = place.traversal !== 'SELF' && home === place.domainCode;
      if (!onThisRecord && !onRelated) continue;
      choices.push({ ...attribute, place, groupLabel });
    }
  }
  return choices;
}

export function choicesForCode(choices: CalcFieldChoice[], attributeCode: string): CalcFieldChoice[] {
  return choices.filter((choice) => choice.attributeCode === attributeCode);
}

export function inferBinding(
  attributeCode: string,
  choices: CalcFieldChoice[],
  rootDomain: string,
  existing?: CalcOperandBinding | null,
): CalcOperandBinding {
  if (existing && existing.attributeCode === attributeCode) return existing;
  const matches = choicesForCode(choices, attributeCode);
  const self = matches.find((choice) => choice.place.traversal === 'SELF');
  const chosen = self || matches[0];
  if (!chosen) {
    return { attributeCode, traversal: 'SELF', relationshipCodes: [] };
  }
  return {
    attributeCode,
    traversal: chosen.place.traversal,
    relationshipCodes: chosen.place.relationshipCodes,
  };
}

export function bindingLabel(
  binding: CalcOperandBinding,
  rootDomain: string,
  relationships: CalcRelationship[],
  names: Record<string, string>,
): string {
  if (binding.traversal === 'SELF' || binding.relationshipCodes.length === 0) {
    return `this ${domainLabel(rootDomain, names)}`;
  }
  let domain = rootDomain;
  const via: string[] = [];
  for (const code of binding.relationshipCodes) {
    const relationship = relationships.find((item) => item.relationshipCode === code);
    via.push(relationship?.relationshipName || code);
    if (!relationship) continue;
    if (binding.traversal === 'DOWN' && relationship.parentDomainCode === domain && relationship.childDomainCode) {
      domain = relationship.childDomainCode;
    } else if (binding.traversal === 'UP' && relationship.childDomainCode === domain && relationship.parentDomainCode) {
      domain = relationship.parentDomainCode;
    }
  }
  return `${domainLabel(domain, names)} via ${via.join(' → ')}`;
}

export function sameBinding(left: CalcOperandBinding, right: CalcOperandBinding): boolean {
  return left.traversal === right.traversal
    && left.relationshipCodes.join('|') === right.relationshipCodes.join('|');
}
