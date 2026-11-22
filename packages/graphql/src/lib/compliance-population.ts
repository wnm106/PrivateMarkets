/**
 * Keys for a compliance condition's population values.
 *
 * Which records a rule's conditions select is decided in the database, by the
 * evaluator's matcher (compliance.entity_matches_condition_set, through
 * compliance.preview_population). This file only names each condition's value
 * column the way the rule form does, so the preview's values line up with it.
 */

export interface RelationshipHopRef {
  relationshipCode: string;
  direction: string;
  recursive?: boolean;
}

export function hopKey(hop: RelationshipHopRef): string {
  return `${(hop.direction || 'UP').toUpperCase()}:${hop.relationshipCode}`;
}

export function pathKey(path?: RelationshipHopRef[] | null): string {
  return (path || []).filter((h) => h?.relationshipCode).map(hopKey).join('|');
}

/** Stable key for a condition's attribute, shared by the preview payload and the form. */
export function conditionValueKey(path: RelationshipHopRef[] | null | undefined, attributeCode: string): string {
  const prefix = pathKey(path);
  return prefix ? `${prefix}\u001f${attributeCode}` : attributeCode;
}
