/**
 * Fields on a tree list (such as GICS) depend on each other: a field's value must
 * sit under its controlling field's value. For one record's values from a file,
 * this works out which levels above can be filled in from the tree, and which
 * values sit under a different parent than the file gives.
 */

export interface TreeAttribute {
  listCode: string;
  level: number | null;
  controllingCode: string | null;
}

export interface TreeFill {
  attributeCode: string;
  value: string;
  /** The field whose value implied this one. */
  from: string;
}

export interface TreeConflict {
  attributeCode: string;
  value: string;
  controllingCode: string;
  controllingValue: string;
  /** The parent the tree has for `value`. */
  expected: string;
}

/** Each list's parent code for every value code. */
export type ListParents = Map<string, Map<string, string | null>>;

export function planTreeValues(
  values: Map<string, string>,
  attributeOf: (attributeCode: string) => TreeAttribute | undefined,
  parents: ListParents,
): { fills: TreeFill[]; conflicts: TreeConflict[] } {
  const fills = new Map<string, TreeFill>();
  const conflicts = new Map<string, TreeConflict>();
  // Deepest levels first, so one walk up fills every level above.
  const start = [...values.keys()]
    .map((code) => ({ code, field: attributeOf(code) }))
    .filter((item): item is { code: string; field: TreeAttribute } => Boolean(item.field?.controllingCode))
    .sort((a, b) => (b.field.level || 0) - (a.field.level || 0));

  for (const item of start) {
    let code = item.code;
    let field: TreeAttribute | undefined = item.field;
    let value = (values.get(code) || fills.get(code)?.value || '').trim();
    const seen = new Set([code]);
    while (field?.controllingCode && value && !seen.has(field.controllingCode)) {
      const aboveCode = field.controllingCode;
      seen.add(aboveCode);
      const above = attributeOf(aboveCode);
      if (!above || above.listCode !== field.listCode) break;
      const parent = parents.get(field.listCode)?.get(value);
      if (!parent) break;
      const given = values.get(aboveCode)?.trim() || fills.get(aboveCode)?.value;
      if (!given) {
        fills.set(aboveCode, { attributeCode: aboveCode, value: parent, from: item.code });
      } else if (given !== parent) {
        conflicts.set(code, { attributeCode: code, value, controllingCode: aboveCode, controllingValue: given, expected: parent });
        break;
      }
      code = aboveCode;
      field = above;
      value = parent;
    }
  }
  return { fills: [...fills.values()], conflicts: [...conflicts.values()] };
}
