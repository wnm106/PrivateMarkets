/**
 * Lists that form a tree, such as GICS: each value may sit under a parent value,
 * and a field takes one level of the tree. A field's controlling field holds the
 * parent level, and only children of its value are valid choices.
 */

export interface TreeOption {
  value: string;
  /** The value this one sits under. Null at the top, or for flat lists. */
  parent?: string | null;
  level?: number | null;
}

export interface TreeField {
  listCode: string | null;
  listLevel?: number | null;
  controllingCode?: string | null;
}

/** The values of one level, or every value when the field takes no level. */
export function optionsAtLevel<T extends TreeOption>(options: T[], level: number | null | undefined): T[] {
  if (!level) return options;
  return options.filter((option) => option.level === level);
}

/**
 * Choices once the controlling field holds `parentValue`: only its children.
 * A blank parent, or one that is not on the list, leaves every choice open, so
 * someone who knows only the lowest level can still pick it.
 */
export function optionsUnder<T extends TreeOption>(options: T[], parentValue: string | null | undefined, all: Map<string, TreeOption>): T[] {
  const parent = (parentValue || '').trim();
  if (!parent || !all.has(parent)) return options;
  return options.filter((option) => option.parent === parent);
}

/**
 * True when a value is on the list but does not sit under the controlling field's
 * value. Blank or unknown values on either side are not a conflict.
 */
export function outsideParent(value: string | null | undefined, parentValue: string | null | undefined, all: Map<string, TreeOption>): boolean {
  const own = all.get((value || '').trim());
  const parent = (parentValue || '').trim();
  if (!own || !parent || !all.has(parent)) return false;
  return own.parent !== parent;
}

/**
 * The fields to save when `value` is picked for `attributeCode`: the field itself,
 * plus each controlling field above it set to the matching ancestor, where that
 * field does not already hold it.
 */
export function fillAncestors(
  attributeCode: string,
  value: string,
  fieldOf: (attributeCode: string) => TreeField | undefined,
  all: Map<string, TreeOption>,
  current: Record<string, string>,
): Record<string, string> {
  const changes: Record<string, string> = { [attributeCode]: value };
  const seen = new Set([attributeCode]);
  let field = fieldOf(attributeCode);
  let option = all.get(value);
  while (field?.controllingCode && option?.parent && !seen.has(field.controllingCode)) {
    const above = field.controllingCode;
    seen.add(above);
    const aboveField = fieldOf(above);
    // Only fill a field that takes its values from the same list.
    if (!aboveField || aboveField.listCode !== field.listCode) break;
    if ((current[above] || '').trim() !== option.parent) changes[above] = option.parent;
    field = aboveField;
    option = all.get(option.parent);
  }
  return changes;
}
