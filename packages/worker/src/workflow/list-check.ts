import { LIST_VALUE_TOOL, matchListValue, setPath, valueSlots, type ListValue, type ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';

/**
 * Holds a proposed change to the lists its values come from.
 *
 * When an attribute takes its value from a list, a proposed value has to be on
 * that list. Three things can happen to a value that is not written as a code:
 *
 *   it is certainly a list value (the label, a synonym, different case)
 *       it is stored as the code, and the agent is told
 *   it is not on the list, and the change depends on one that adds it
 *       it stands: the reviewer decides on both together
 *   it is not on the list
 *       the change is not recorded. The agent is shown the list and asked to
 *       pick the value that means the same, leave it to the reviewer, or
 *       propose adding it.
 *
 * Deciding that "Consumer Goods" means Consumer Staples is a judgement, so it
 * is made by the agent, with the list in front of it, and shown to the reviewer.
 */

export type ListLookup = (attributeCode: string) => Promise<ListValue[] | null>;

export type ListCheck = { item: ProposalItem; notes: string[] } | { refusal: string };

const MAX_LISTED = 80;

function describe(values: ListValue[]): string {
  const shown = values.slice(0, MAX_LISTED).map((value) => (value.label && value.label !== value.code ? `${value.code} (${value.label})` : value.code));
  return `${shown.join(', ')}${values.length > MAX_LISTED ? `, and ${values.length - MAX_LISTED} more` : ''}`;
}

function same(a: unknown, b: unknown): boolean {
  const fold = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return fold(a) !== '' && fold(a) === fold(b);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Checks one proposed change. `pool` is every change proposed so far in this
 * step, including the others in the same call, so a change can depend on one
 * that arrives with it.
 */
export async function checkListValues(item: ProposalItem, pool: ProposalItem[], lists: ListLookup): Promise<ListCheck> {
  if (item.tool === LIST_VALUE_TOOL) {
    const attributeCode = String(item.args.attributeCode || '');
    const values = await lists(attributeCode);
    if (!values) return { refusal: `"${item.summary}": ${attributeCode || 'that attribute'} does not take its value from a list, so there is nothing to add to.` };
    const existing = matchListValue(values, item.args.valueCode) || matchListValue(values, item.args.valueLabel);
    if (existing) {
      return { refusal: `"${item.summary}": ${attributeCode} already has this value, as ${existing.code} (${existing.label}). Do not add it again. Set ${existing.code} on the record instead.` };
    }
    return { item, notes: [] };
  }

  const additions = pool.filter((candidate) => candidate.tool === LIST_VALUE_TOOL && (item.dependsOn || []).includes(candidate.id));
  const beingAdded = (attributeCode: string, value: unknown) => additions.some((addition) => addition.args.attributeCode === attributeCode && same(addition.args.valueCode, value));

  let checked = item;
  const notes: string[] = [];
  for (const slot of valueSlots(item)) {
    const values = await lists(slot.attributeCode);
    if (!values || values.length === 0) continue;
    const offList = (value: unknown) =>
      `"${item.summary}": "${String(value)}" is not a value ${slot.attributeCode} accepts. It accepts: ${describe(values)}. ` +
      'If one of these means the same thing, use its code and say in the rationale what you mapped from. ' +
      'If none does, either leave the value out and ask the reviewer with no suggestion, or propose adding it: one change using add_attribute_list_value with an id, and this change again with dependsOn naming that id.';

    const current = slot.key === 'value' ? checked.args.value : record(checked.args.attributes)[slot.attributeCode];
    if (current !== undefined && current !== null && String(current).trim() !== '') {
      const match = matchListValue(values, current);
      if (match) {
        if (match.code !== current) {
          checked = { ...checked, args: setPath(checked.args, slot.key, match.code) };
          notes.push(`${slot.attributeCode} "${String(current)}" was stored as its list code ${match.code}.`);
        }
      } else if (!beingAdded(slot.attributeCode, current)) {
        return { refusal: offList(current) };
      }
    }

    const field = checked.missing.find((candidate) => candidate.key === slot.key);
    if (field && field.suggested !== undefined && field.suggested !== null && String(field.suggested).trim() !== '') {
      const match = matchListValue(values, field.suggested);
      if (match) {
        if (match.code !== field.suggested) {
          checked = { ...checked, missing: checked.missing.map((candidate) => (candidate === field ? { ...candidate, suggested: match.code } : candidate)) };
          notes.push(`The suggestion "${String(field.suggested)}" for ${slot.attributeCode} was stored as its list code ${match.code}.`);
        }
      } else if (!beingAdded(slot.attributeCode, field.suggested)) {
        return { refusal: offList(field.suggested) };
      }
    }
  }
  return { item: checked, notes };
}
