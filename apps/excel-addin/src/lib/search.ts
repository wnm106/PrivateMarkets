/** Shaping search results for the formula builder. The searches themselves run on the server. */

export const SEARCH_ATTRIBUTES_QUERY = `query SearchAttributes($query: String!, $limit: Int) {
  searchAttributes(query: $query, limit: $limit) {
    attributes { attributeCode attributeName description dataType domainCode matchedAlias match }
    entityNames { attributeCode attributeName domainCode matchedAlias match }
  }
}`;

export const SEARCH_ENTITIES_QUERY = `query SearchEntities($query: String!, $limit: Int) {
  searchEntities(query: $query, limit: $limit) { id entityCode entityName domainCode domainName match matchedName }
}`;

export interface AttributeHit {
  attributeCode: string;
  attributeName: string | null;
  description?: string | null;
  dataType?: string | null;
  domainCode: string | null;
  matchedAlias: string | null;
  match: string;
}

export interface EntityHit {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  match: string;
  matchedName: string | null;
}

/** One row the builder offers for the attribute argument. `code` is what goes in the formula. */
export interface AttributeChoice {
  code: string;
  label: string;
  detail: string;
  domainCode: string | null;
}

export interface EntityChoice {
  code: string;
  label: string;
  detail: string;
  domainCode: string;
  fitsAttribute: boolean;
}

/** Fields, then words that mean a record's own name. A record's name is ENTITY_NAME in a formula. */
export function attributeChoices(result: { attributes: AttributeHit[]; entityNames: AttributeHit[] }): AttributeChoice[] {
  const rows: AttributeChoice[] = result.attributes.map((hit) => ({
    code: hit.attributeCode,
    label: hit.attributeName || hit.attributeCode,
    detail: [hit.domainCode, hit.dataType?.toLowerCase(), hit.matchedAlias ? `also "${hit.matchedAlias}"` : null].filter(Boolean).join(' · '),
    domainCode: hit.domainCode,
  }));
  const seen = new Set<string>();
  for (const hit of result.entityNames) {
    const key = `${hit.domainCode}|${hit.matchedAlias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      code: 'ENTITY_NAME',
      label: `Record name${hit.matchedAlias ? ` ("${hit.matchedAlias}")` : ''}`,
      detail: [hit.domainCode, 'the record’s own name'].filter(Boolean).join(' · '),
      domainCode: hit.domainCode,
    });
  }
  return rows;
}

/** Records of the chosen attribute's entity type come first. */
export function entityChoices(hits: EntityHit[], attributeDomain: string | null): EntityChoice[] {
  const domain = (attributeDomain || '').toUpperCase();
  const rows = hits.map((hit, index) => ({
    index,
    choice: {
      code: hit.entityCode,
      label: hit.entityName,
      detail: [
        hit.domainName || hit.domainCode,
        hit.match === 'ALIAS' && hit.matchedName ? `also "${hit.matchedName}"` : null,
        (hit.match === 'PARENT' || hit.match === 'RELATED') && hit.matchedName ? `via ${hit.matchedName}` : null,
      ].filter(Boolean).join(' · '),
      domainCode: hit.domainCode,
      fitsAttribute: !domain || hit.domainCode.toUpperCase() === domain,
    },
  }));
  rows.sort((a, b) => Number(b.choice.fitsAttribute) - Number(a.choice.fitsAttribute) || a.index - b.index);
  return rows.map((row) => row.choice);
}
