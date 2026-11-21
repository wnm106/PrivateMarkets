/**
 * TAP: one attribute of one record, as of a date. This is what the Excel function
 * =TAP("attribute", "record", "as of") asks for (docs/EXCEL_ADDIN.md).
 *
 * A cell names things the way a person would, so each reference is matched exactly,
 * ignoring case: a record by its code, name or another stored name, an attribute by
 * its code, a stored alias or its name. The value is the winning value the record
 * screen shows: `golden_master.winning_attribute_values`, then an on-read calculation
 * when nothing is stored. Every read runs as the caller, so a person sees only what
 * they can already see in the app.
 */

import { loadOnReadValues } from './on-read-values';
import { loadWinningValues, type WinningValueRow } from './temporal-attributes';

export type TapErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_ATTRIBUTE'
  | 'AMBIGUOUS_ATTRIBUTE'
  | 'UNKNOWN_ENTITY'
  | 'AMBIGUOUS_ENTITY'
  | 'NO_VALUE';

export type TapValueType = 'NUMBER' | 'TEXT' | 'BOOLEAN' | 'DATE';

export interface TapRequest {
  attribute: string;
  entity: string;
  asOfDate?: string | null;
}

export interface TapResult {
  attribute: string;
  entity: string;
  asOfDate: string | null;
  attributeCode: string | null;
  attributeName: string | null;
  dataType: string | null;
  entityId: string | null;
  entityCode: string | null;
  entityName: string | null;
  domainCode: string | null;
  value: number | string | boolean | null;
  valueType: TapValueType | null;
  validFrom: string | null;
  error: TapErrorCode | null;
  message: string | null;
  candidates: string[];
}

export type AttributeMatchKind = 'CODE' | 'ALIAS' | 'NAME' | 'BUILT_IN';
export type EntityMatchKind = 'CODE' | 'NAME' | 'ALIAS';

export interface TapAttributeMatch {
  attributeId: string | null;
  attributeCode: string;
  attributeName: string;
  dataType: string;
  domainCode: string | null;
  matchKind: AttributeMatchKind;
}

export interface TapEntityMatch {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  matchKind: EntityMatchKind;
}

/** Fields every record has. A registered attribute with the same code wins. */
const BUILT_IN_FIELDS: Record<string, { name: string; pick: (entity: TapEntityMatch) => string }> = {
  entity_code: { name: 'Code', pick: (entity) => entity.entityCode },
  entity_name: { name: 'Name', pick: (entity) => entity.entityName },
};

export const TAP_MAX_REQUESTS = 500;

const ATTRIBUTE_TIER: Record<AttributeMatchKind, number> = { CODE: 0, ALIAS: 1, NAME: 2, BUILT_IN: 3 };
const ENTITY_TIER: Record<EntityMatchKind, number> = { CODE: 0, NAME: 1, ALIAS: 2 };
const NUMERIC_TYPES = new Set(['NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE', 'FLOAT']);

/** The key a reference is matched under. */
export function tapKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** A calendar date as YYYY-MM-DD. Blank means today's values. */
export function normalizeTapDate(value: unknown): { ok: true; date: string | null } | { ok: false; message: string } {
  const text = String(value ?? '').trim();
  if (!text) return { ok: true, date: null };
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { ok: false, message: `As of "${text}" is not a date. Use YYYY-MM-DD or a date cell.` };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, message: `As of "${text}" is not a calendar date.` };
  }
  return { ok: true, date: text };
}

function attributeLabel(match: TapAttributeMatch): string {
  return `${match.attributeCode} (${match.attributeName}${match.domainCode ? `, ${match.domainCode}` : ''})`;
}

function entityLabel(match: TapEntityMatch): string {
  return `${match.entityCode} (${match.entityName}, ${match.domainCode})`;
}

function fits(attribute: TapAttributeMatch, entity: TapEntityMatch): boolean {
  return !attribute.domainCode || attribute.domainCode.toUpperCase() === entity.domainCode.toUpperCase();
}

function uniqueBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const value = key(row);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/**
 * Pick the one attribute and the one record a cell means.
 * A record code always means that record. Then a pair whose entity type carries the
 * attribute wins, then the closer attribute match, then the closer record match.
 * Two pairs that tie are ambiguous, and the cell is told which codes to use instead.
 */
export function chooseTapPair(
  attributes: readonly TapAttributeMatch[],
  entities: readonly TapEntityMatch[],
):
  | { ok: true; attribute: TapAttributeMatch; entity: TapEntityMatch }
  | { ok: false; error: TapErrorCode; message: string; candidates: string[] } {
  // The closest match of each attribute and record is the one kept.
  const attributeChoices = uniqueBy(
    [...attributes].sort((a, b) => ATTRIBUTE_TIER[a.matchKind] - ATTRIBUTE_TIER[b.matchKind]),
    (row) => `${row.attributeCode}|${row.domainCode || ''}`,
  );
  const entityChoices = uniqueBy(
    [...entities].sort((a, b) => ENTITY_TIER[a.matchKind] - ENTITY_TIER[b.matchKind]),
    (row) => row.id,
  );
  if (!attributeChoices.length) {
    return { ok: false, error: 'UNKNOWN_ATTRIBUTE', message: 'No attribute has that code, alias or name.', candidates: [] };
  }
  if (!entityChoices.length) {
    return { ok: false, error: 'UNKNOWN_ENTITY', message: 'No record you can see has that code or name.', candidates: [] };
  }

  const scored = attributeChoices.flatMap((attribute) => entityChoices.map((entity) => ({
    attribute,
    entity,
    key: [
      entity.matchKind === 'CODE' ? 0 : 1,
      fits(attribute, entity) ? 0 : 1,
      ATTRIBUTE_TIER[attribute.matchKind],
      ENTITY_TIER[entity.matchKind],
    ],
  })));
  const compare = (a: number[], b: number[]) => {
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
  };
  scored.sort((a, b) => compare(a.key, b.key));
  const best = scored.filter((pair) => compare(pair.key, scored[0].key) === 0);
  const bestEntities = uniqueBy(best.map((pair) => pair.entity), (row) => row.id);
  const bestAttributes = uniqueBy(best.map((pair) => pair.attribute), (row) => row.attributeCode);
  if (bestEntities.length > 1) {
    return {
      ok: false,
      error: 'AMBIGUOUS_ENTITY',
      message: `${bestEntities.length} records match. Use the record code.`,
      candidates: bestEntities.slice(0, 8).map(entityLabel),
    };
  }
  if (bestAttributes.length > 1) {
    return {
      ok: false,
      error: 'AMBIGUOUS_ATTRIBUTE',
      message: `${bestAttributes.length} attributes match. Use the attribute code.`,
      candidates: bestAttributes.slice(0, 8).map(attributeLabel),
    };
  }
  return { ok: true, attribute: best[0].attribute, entity: best[0].entity };
}

/** The value a cell shows, typed by the attribute's data type. */
export function tapCellValue(
  dataType: string | null | undefined,
  stored: { text?: string | null; numeric?: number | string | null; date?: string | null; timestamp?: string | null },
): { value: number | string | boolean; valueType: TapValueType } | null {
  const type = String(dataType || '').toUpperCase();
  const text = stored.text == null ? '' : String(stored.text).trim();
  if (NUMERIC_TYPES.has(type)) {
    const raw = stored.numeric ?? (text === '' ? null : text.replace(/,/g, ''));
    const number = raw == null || raw === '' ? Number.NaN : Number(raw);
    if (Number.isFinite(number)) return { value: number, valueType: 'NUMBER' };
    return text ? { value: text, valueType: 'TEXT' } : null;
  }
  if (type === 'BOOLEAN') {
    const lowered = text.toLowerCase();
    if (['true', 't', 'yes', 'y', '1'].includes(lowered)) return { value: true, valueType: 'BOOLEAN' };
    if (['false', 'f', 'no', 'n', '0'].includes(lowered)) return { value: false, valueType: 'BOOLEAN' };
    return text ? { value: text, valueType: 'TEXT' } : null;
  }
  if (type === 'DATE') {
    const day = String(stored.date || text).match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (day) return { value: day, valueType: 'DATE' };
    return text ? { value: text, valueType: 'TEXT' } : null;
  }
  if (type === 'TIMESTAMP') {
    const instant = stored.timestamp || text;
    return instant ? { value: String(instant), valueType: 'TEXT' } : null;
  }
  return text ? { value: text, valueType: 'TEXT' } : null;
}

function emptyResult(request: TapRequest, asOfDate: string | null): TapResult {
  return {
    attribute: String(request.attribute ?? ''),
    entity: String(request.entity ?? ''),
    asOfDate,
    attributeCode: null,
    attributeName: null,
    dataType: null,
    entityId: null,
    entityCode: null,
    entityName: null,
    domainCode: null,
    value: null,
    valueType: null,
    validFrom: null,
    error: null,
    message: null,
    candidates: [],
  };
}

type TapClient = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  schema: (name: string) => { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> };
};

async function matchAttributes(supabase: TapClient, refs: string[]): Promise<Map<string, TapAttributeMatch[]>> {
  const byRef = new Map<string, TapAttributeMatch[]>();
  if (!refs.length) return byRef;
  const { data, error } = await supabase.rpc('tap_attribute_matches', { p_refs: refs });
  if (error) throw new Error(error.message || 'Attributes could not be matched.');
  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const key = tapKey(row.ref);
    const list = byRef.get(key) || [];
    list.push({
      attributeId: String(row.attribute_id),
      attributeCode: String(row.attribute_code),
      attributeName: String(row.attribute_name || row.attribute_code),
      dataType: String(row.data_type || 'STRING'),
      domainCode: row.domain_code ? String(row.domain_code) : null,
      matchKind: (String(row.match_kind) as AttributeMatchKind) || 'NAME',
    });
    byRef.set(key, list);
  }
  for (const ref of refs) {
    const key = tapKey(ref);
    const builtIn = BUILT_IN_FIELDS[key];
    if (!builtIn || byRef.get(key)?.some((match) => match.matchKind === 'CODE')) continue;
    const list = byRef.get(key) || [];
    list.push({ attributeId: null, attributeCode: key.toUpperCase(), attributeName: builtIn.name, dataType: 'STRING', domainCode: null, matchKind: 'BUILT_IN' });
    byRef.set(key, list);
  }
  return byRef;
}

async function matchEntities(supabase: TapClient, refs: string[]): Promise<Map<string, TapEntityMatch[]>> {
  const byRef = new Map<string, TapEntityMatch[]>();
  if (!refs.length) return byRef;
  const { data, error } = await supabase.rpc('tap_entity_matches', { p_refs: refs });
  if (error) throw new Error(error.message || 'Records could not be matched.');
  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const key = tapKey(row.ref);
    const list = byRef.get(key) || [];
    list.push({
      id: String(row.id),
      entityCode: String(row.entity_code),
      entityName: String(row.entity_name || row.entity_code),
      domainCode: String(row.domain_code || ''),
      matchKind: (String(row.match_kind) as EntityMatchKind) || 'NAME',
    });
    byRef.set(key, list);
  }
  return byRef;
}

async function onReadAttributeIds(supabase: TapClient, attributeIds: string[]): Promise<Set<string>> {
  if (!attributeIds.length) return new Set();
  const { data, error } = await supabase
    .from('calc_definitions')
    .select('attribute_id')
    .eq('evaluation_mode', 'ON_READ')
    .in('attribute_id', attributeIds);
  if (error) return new Set();
  return new Set(((data || []) as Array<{ attribute_id: string }>).map((row) => String(row.attribute_id)));
}

/** Answer a batch of TAP requests. One bad cell never fails the others. */
export async function resolveTapRequests(
  supabase: TapClient,
  requests: readonly TapRequest[],
  knowledgeDate?: string | null,
): Promise<TapResult[]> {
  if (requests.length > TAP_MAX_REQUESTS) {
    throw new Error(`At most ${TAP_MAX_REQUESTS} TAP requests can be sent at once.`);
  }

  const results = requests.map((request) => {
    const date = normalizeTapDate(request.asOfDate);
    const result = emptyResult(request, date.ok ? date.date : null);
    if (!date.ok) {
      result.error = 'INVALID_REQUEST';
      result.message = date.message;
    } else if (!tapKey(request.attribute)) {
      result.error = 'INVALID_REQUEST';
      result.message = 'An attribute is required.';
    } else if (!tapKey(request.entity)) {
      result.error = 'INVALID_REQUEST';
      result.message = 'A record is required.';
    }
    return result;
  });

  const open = results.filter((result) => !result.error);
  const attributeRefs = [...new Set(open.map((result) => result.attribute.trim()))];
  const entityRefs = [...new Set(open.map((result) => result.entity.trim()))];
  const [attributeMatches, entityMatches] = await Promise.all([
    matchAttributes(supabase, attributeRefs),
    matchEntities(supabase, entityRefs),
  ]);

  const chosen: Array<{ result: TapResult; attribute: TapAttributeMatch; entity: TapEntityMatch }> = [];
  for (const result of open) {
    const choice = chooseTapPair(
      attributeMatches.get(tapKey(result.attribute)) || [],
      entityMatches.get(tapKey(result.entity)) || [],
    );
    if (!choice.ok) {
      result.error = choice.error;
      result.message = choice.message;
      result.candidates = choice.candidates;
      continue;
    }
    Object.assign(result, {
      attributeCode: choice.attribute.attributeCode,
      attributeName: choice.attribute.attributeName,
      dataType: choice.attribute.dataType,
      entityId: choice.entity.id,
      entityCode: choice.entity.entityCode,
      entityName: choice.entity.entityName,
      domainCode: choice.entity.domainCode,
    });
    chosen.push({ result, attribute: choice.attribute, entity: choice.entity });
  }

  // Fields every record has.
  for (const { result, attribute, entity } of chosen) {
    if (attribute.matchKind !== 'BUILT_IN') continue;
    const builtIn = BUILT_IN_FIELDS[attribute.attributeCode.toLowerCase()];
    result.value = builtIn.pick(entity);
    result.valueType = 'TEXT';
  }

  // Stored values, one call per as-of date.
  const stored = chosen.filter((pair) => pair.attribute.attributeId);
  const byDate = new Map<string, typeof stored>();
  for (const pair of stored) {
    const key = pair.result.asOfDate || '';
    byDate.set(key, [...(byDate.get(key) || []), pair]);
  }
  const blanks: typeof stored = [];
  for (const [asOf, pairs] of byDate) {
    const rows = await loadWinningValues(
      supabase,
      pairs.map((pair) => pair.entity.id),
      pairs.map((pair) => pair.attribute.attributeId as string),
      asOf || null,
      knowledgeDate,
    );
    const winners = new Map<string, WinningValueRow>(rows.map((row) => [`${row.entity_id}|${row.attribute_id}`, row]));
    for (const pair of pairs) {
      const row = winners.get(`${pair.entity.id}|${pair.attribute.attributeId}`);
      const cell = row
        ? tapCellValue(pair.attribute.dataType, {
          text: row.golden_value,
          numeric: row.golden_value_numeric,
          date: row.golden_value_date,
          timestamp: row.golden_value_timestamp,
        })
        : null;
      if (!cell) {
        blanks.push(pair);
        continue;
      }
      pair.result.value = cell.value;
      pair.result.valueType = cell.valueType;
      pair.result.validFrom = row?.valid_from ?? null;
    }
  }

  // Nothing stored: an on-read calculation, as the record screen shows it.
  const calculated = await onReadAttributeIds(supabase, [...new Set(blanks.map((pair) => pair.attribute.attributeId as string))]);
  const reads = new Map<string, Promise<Awaited<ReturnType<typeof loadOnReadValues>>>>();
  for (const pair of blanks) {
    if (!calculated.has(pair.attribute.attributeId as string)) continue;
    const key = `${pair.entity.id}|${pair.result.asOfDate || ''}`;
    if (!reads.has(key)) reads.set(key, loadOnReadValues(supabase, pair.entity.id, pair.result.asOfDate, knowledgeDate));
  }
  for (const pair of blanks) {
    const read = reads.get(`${pair.entity.id}|${pair.result.asOfDate || ''}`);
    const value = read ? (await read).find((row) => row.attributeCode === pair.attribute.attributeCode) : undefined;
    const cell = value ? tapCellValue(pair.attribute.dataType, { text: value.valueText }) : null;
    if (cell) {
      pair.result.value = cell.value;
      pair.result.valueType = cell.valueType;
      continue;
    }
    pair.result.error = 'NO_VALUE';
    const when = pair.result.asOfDate ? `on ${pair.result.asOfDate}` : 'today';
    pair.result.message = fits(pair.attribute, pair.entity)
      ? `${pair.entity.entityCode} has no ${pair.attribute.attributeCode} ${when}.`
      : `${pair.attribute.attributeCode} belongs to ${pair.attribute.domainCode} records; ${pair.entity.entityCode} is ${pair.entity.domainCode}.`;
  }

  return results;
}
