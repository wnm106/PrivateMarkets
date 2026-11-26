import { parseAsOf, serialToIsoDate } from './excel-date';
import { looksLikeReference, parseTapFormula, type FormulaArgument } from './formula';

/**
 * Manual overrides from selected TAP cells (docs/EXCEL_ADDIN.md).
 *
 * A TAP formula says which value a cell shows: attribute, record and as-of. The pane
 * reads that from the formula (and from the cells it points at), the person types the
 * new value, previews, and saves. Nothing is written from a formula.
 */

export const MAX_OVERRIDE_CELLS = 50;

export const TAP_OVERRIDE_PREVIEW_QUERY = `query TapOverridePreview($overrides: [TapOverrideInput!]!) {
  tapOverridePreview(overrides: $overrides) {
    attribute entity validFrom attributeCode attributeName dataType entityCode entityName domainCode
    currentValue currentText newValue newText status message candidates
  }
}`;

export const SUBMIT_TAP_OVERRIDES_MUTATION = `mutation SubmitTapOverrides($overrides: [TapOverrideInput!]!, $reason: String!) {
  submitTapOverrides(overrides: $overrides, reason: $reason) {
    attribute entity validFrom attributeCode attributeName dataType entityCode entityName domainCode
    currentValue currentText newValue newText status message candidates
  }
}`;

export interface OverridePlan {
  attribute: string;
  entity: string;
  validFrom: string | null;
  attributeCode: string | null;
  attributeName: string | null;
  dataType: string | null;
  entityCode: string | null;
  entityName: string | null;
  domainCode: string | null;
  currentValue: number | string | boolean | null;
  currentText: string;
  newValue: number | string | boolean | null;
  newText: string | null;
  status: string;
  message: string | null;
  candidates: string[];
}

/** One selected TAP cell, ready to take a new value. */
export interface OverrideRow {
  address: string;
  attribute: string;
  entity: string;
  /** YYYY-MM-DD: the formula's as-of, or today. */
  validFrom: string;
  /** What the cell shows now. */
  shown: unknown;
}

export interface SelectedCell {
  address: string;
  formula: unknown;
  value: unknown;
}

export type CellReading = { ok: true; row: OverrideRow } | { ok: false; address: string; problem: string };

/** A reference inside a formula, resolved against the sheet of the cell it sits in. */
export interface CellReference {
  sheet: string;
  address: string;
}

function unquoteSheet(sheet: string): string {
  return sheet.startsWith("'") && sheet.endsWith("'") ? sheet.slice(1, -1).replace(/''/g, "'") : sheet;
}

/** "Sheet1!C2" or "'Q3 marks'!C2" to its sheet and cell. */
export function splitAddress(address: string): CellReference {
  const bang = address.lastIndexOf('!');
  if (bang < 0) return { sheet: '', address: address.replace(/\$/g, '') };
  return { sheet: unquoteSheet(address.slice(0, bang)), address: address.slice(bang + 1).replace(/\$/g, '') };
}

export function referenceKey(reference: CellReference): string {
  return `${reference.sheet}!${reference.address}`.toUpperCase();
}

/** A formula argument that is a plain cell reference, resolved to its sheet. */
export function argumentReference(argument: FormulaArgument | null, cellSheet: string): CellReference | null {
  if (!argument || argument.kind !== 'expression' || !looksLikeReference(argument.value)) return null;
  const reference = splitAddress(argument.value);
  return { sheet: reference.sheet || cellSheet, address: reference.address };
}

/** Every cell the selected formulas point at, so the pane can read them in one go. */
export function referencesIn(cells: readonly SelectedCell[]): CellReference[] {
  const found = new Map<string, CellReference>();
  for (const cell of cells) {
    const formula = parseTapFormula(cell.formula);
    if (!formula) continue;
    const sheet = splitAddress(cell.address).sheet;
    for (const argument of [formula.attribute, formula.entity, formula.asOf]) {
      const reference = argumentReference(argument, sheet);
      if (reference) found.set(referenceKey(reference), reference);
    }
  }
  return [...found.values()];
}

function argumentValue(argument: FormulaArgument | null, cellSheet: string, values: ReadonlyMap<string, unknown>): { ok: true; value: unknown } | { ok: false } {
  if (!argument) return { ok: true, value: null };
  if (argument.kind === 'text') return { ok: true, value: argument.value };
  const reference = argumentReference(argument, cellSheet);
  if (!reference) return { ok: false };
  return { ok: true, value: values.get(referenceKey(reference)) ?? null };
}

/** Read one selected cell as an override row, or say why it cannot be overridden from here. */
export function readOverrideCell(cell: SelectedCell, values: ReadonlyMap<string, unknown>, today: string): CellReading {
  const formula = parseTapFormula(cell.formula);
  if (!formula) return { ok: false, address: cell.address, problem: 'Not a TAP formula.' };
  const sheet = splitAddress(cell.address).sheet;
  const attribute = argumentValue(formula.attribute, sheet, values);
  const entity = argumentValue(formula.entity, sheet, values);
  const asOf = argumentValue(formula.asOf, sheet, values);
  if (!attribute.ok || !entity.ok || !asOf.ok) {
    return { ok: false, address: cell.address, problem: 'Its arguments are not plain text or cell references, so the pane cannot tell which value it shows.' };
  }
  const attributeText = String(attribute.value ?? '').trim();
  const entityText = String(entity.value ?? '').trim();
  if (!attributeText || !entityText) return { ok: false, address: cell.address, problem: 'The attribute or record is blank.' };
  const date = typeof asOf.value === 'number' ? { ok: true as const, date: serialToIsoDate(asOf.value) } : parseAsOf(asOf.value);
  if (!date.ok) return { ok: false, address: cell.address, problem: date.message };
  return {
    ok: true,
    row: { address: cell.address, attribute: attributeText, entity: entityText, validFrom: date.date || today, shown: cell.value },
  };
}

/** Plain words for each status. */
export function statusText(plan: Pick<OverridePlan, 'status' | 'message'>): string {
  const words: Record<string, string> = {
    READY: 'Will be saved',
    SAVED: 'Saved',
    PENDING_APPROVAL: 'Sent for approval',
    UNCHANGED: 'Unchanged, skipped',
    STALE: 'Changed since you checked',
    DUPLICATE: 'Listed twice',
    INVALID_REQUEST: 'Not a valid date',
    INVALID_VALUE: 'Not a valid value',
    NOT_EDITABLE: 'Not editable',
    NO_ACCESS: 'You cannot change this record',
    UNKNOWN_ATTRIBUTE: 'Attribute not found',
    AMBIGUOUS_ATTRIBUTE: 'More than one attribute matches',
    UNKNOWN_ENTITY: 'Record not found',
    AMBIGUOUS_ENTITY: 'More than one record matches',
    FAILED: 'Not saved',
  };
  const label = words[plan.status] || plan.status;
  if (!plan.message || plan.status === 'READY' || plan.status === 'SAVED' || plan.status === 'PENDING_APPROVAL') return label;
  const same = (text: string) => text.trim().replace(/\.$/, '').toLowerCase();
  return same(plan.message) === same(label) ? plan.message : `${label}: ${plan.message}`;
}

export function summarize(plans: readonly Pick<OverridePlan, 'status'>[]): string {
  const counts = new Map<string, number>();
  for (const plan of plans) counts.set(plan.status, (counts.get(plan.status) || 0) + 1);
  const part = (status: string, word: string) => (counts.get(status) ? `${counts.get(status)} ${word}` : null);
  const other = plans.filter((plan) => !['READY', 'SAVED', 'PENDING_APPROVAL', 'UNCHANGED'].includes(plan.status)).length;
  return [
    part('SAVED', 'saved'),
    part('PENDING_APPROVAL', 'sent for approval'),
    part('READY', 'ready to save'),
    part('UNCHANGED', 'unchanged'),
    other ? `${other} need attention` : null,
  ].filter(Boolean).join(', ') || 'Nothing to save.';
}

/** Column letters to a 0-based index: A is 0, AA is 26. */
export function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

export function columnLetters(index: number): string {
  let letters = '';
  let rest = index + 1;
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/** An address Excel accepts back, quoting a sheet name that needs it. */
export function formatAddress(sheet: string, cell: string): string {
  if (!sheet) return cell;
  const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  return `${quoted}!${cell}`;
}

/** The address of the cell at (row, column) inside a range whose address is "Sheet1!B2:D5". */
export function cellAddressAt(rangeAddress: string, row: number, column: number): string {
  const { sheet, address } = splitAddress(rangeAddress);
  const match = address.split(':')[0].match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return rangeAddress;
  return formatAddress(sheet, `${columnLetters(columnIndex(match[1]) + column)}${Number(match[2]) + row}`);
}
