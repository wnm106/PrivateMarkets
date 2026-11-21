import { coerceAttributeValue } from './attribute-values';
import { planSourceVersion } from './source-version';

/**
 * Writing one source's value on one record, and the manual override built on it.
 *
 * A new value versions its own source only, bitemporally: the rows it replaces are
 * closed in system time, their earlier days are written again, and a value already
 * scheduled later stays (planSourceVersion). Other sources are untouched; which
 * source wins is still decided by precedence, where an open manual entry beats all.
 *
 * Every manual override goes through writeManualOverride: the record screen and
 * conflict resolution (submitManualOverride), chat and workflow steps
 * (submit_manual_override), and Excel (submitTapOverrides). Each write runs as the
 * caller, so row security refuses a record the caller may not write.
 */

export const OPEN_SYSTEM_TO = '9999-12-31 23:59:59';

type WriteClient = {
  from: (table: string) => any;
  schema: (name: string) => { from: (table: string) => any };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export interface StoredValue {
  golden_value: string;
  golden_value_numeric: number | null;
  golden_value_date: string | null;
}

export type OverrideErrorCode = 'INVALID_VALUE' | 'REASON_REQUIRED' | 'NO_ACCESS' | 'NOT_SET_UP';

export class ManualOverrideError extends Error {
  constructor(readonly code: OverrideErrorCode, message: string) {
    super(message);
    this.name = 'ManualOverrideError';
  }
}

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

/** The earlier part of a row being replaced, written again as its own row. */
export function versionCopy(current: any, validFrom: string, validTo: string, now: string, userId: string | null | undefined) {
  return {
    entity_id: current.entity_id,
    attribute_id: current.attribute_id,
    source_id: current.source_id,
    golden_value: current.golden_value,
    golden_value_jsonb: current.golden_value_jsonb,
    golden_value_numeric: current.golden_value_numeric,
    golden_value_date: current.golden_value_date,
    golden_value_timestamp: current.golden_value_timestamp,
    golden_value_boolean: current.golden_value_boolean,
    valid_from: validFrom,
    valid_to: validTo,
    system_from: now,
    system_to: OPEN_SYSTEM_TO,
    precedence_rank: current.precedence_rank,
    confidence_score: current.confidence_score,
    is_manual_override: current.is_manual_override,
    override_reason: current.override_reason,
    metadata: current.metadata,
    last_received_at: current.last_received_at,
    created_by: userId ?? current.created_by,
  };
}

function isRowSecurityError(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '42501' || /row-level security|permission denied/i.test(error?.message || '');
}

function fail(error: { code?: string; message?: string }): never {
  if (isRowSecurityError(error)) throw new ManualOverrideError('NO_ACCESS', 'You cannot change this record.');
  throw Object.assign(new Error(error.message || 'The value could not be written.'), { code: error.code });
}

/** Write one value for one source on one record from `validFrom`. Returns the new row's id. */
export async function writeSourceVersion(
  supabase: WriteClient,
  input: {
    entityId: string;
    attributeId: string;
    sourceId: string;
    validFrom: string;
    stored: StoredValue;
    precedenceRank: number;
    isManualOverride: boolean;
    overrideReason?: string | null;
    userId?: string | null;
  },
): Promise<{ id: string }> {
  const validFrom = dateOnly(input.validFrom);
  const now = new Date().toISOString();
  const { data: currentRows, error: currentError } = await supabase
    .from('entity_attribute_values')
    .select('*')
    .eq('entity_id', input.entityId)
    .eq('attribute_id', input.attributeId)
    .eq('source_id', input.sourceId)
    .gte('valid_to', validFrom)
    .eq('system_to', OPEN_SYSTEM_TO);
  if (currentError) fail(currentError);

  const plan = planSourceVersion<any>(currentRows || [], validFrom);
  for (const current of plan.close) {
    const { error } = await supabase.from('entity_attribute_values').update({ system_to: now }).eq('id', current.id);
    if (error) fail(error);
  }
  for (const { row: current, validTo } of plan.keepBefore) {
    const { error } = await supabase
      .from('entity_attribute_values')
      .insert(versionCopy(current, dateOnly(current.valid_from), validTo, now, current.created_by));
    if (error) fail(error);
  }

  const { data, error } = await supabase
    .from('entity_attribute_values')
    .insert({
      entity_id: input.entityId,
      attribute_id: input.attributeId,
      source_id: input.sourceId,
      ...input.stored,
      valid_from: validFrom,
      valid_to: plan.newValidTo,
      system_from: now,
      system_to: OPEN_SYSTEM_TO,
      precedence_rank: input.precedenceRank,
      is_manual_override: input.isManualOverride,
      override_reason: input.overrideReason ?? null,
      created_by: input.userId ?? null,
    })
    .select('id')
    .single();
  if (error) fail(error);
  return { id: String(data.id) };
}

/** A typed value as an override stores it, read the way a file load reads it. */
export function storedOverrideValue(raw: unknown, dataType: string | null | undefined): { ok: true; stored: StoredValue } | { ok: false; message: string } {
  const text = raw === null || raw === undefined ? '' : String(raw);
  const coerced = coerceAttributeValue(text, String(dataType || 'STRING').toUpperCase());
  if (!coerced) return { ok: false, message: 'A manual entry needs a value. To remove one, clear the manual entry in Tapestry.' };
  if ('error' in coerced) return { ok: false, message: `${coerced.error}.` };
  return {
    ok: true,
    stored: {
      golden_value: coerced.golden_value,
      golden_value_numeric: coerced.golden_value_numeric,
      golden_value_date: coerced.golden_value_date,
    },
  };
}

const manualSources = new WeakMap<object, Promise<string>>();

/** The Manual Entry source. */
export function manualSourceId(supabase: WriteClient): Promise<string> {
  const cached = manualSources.get(supabase);
  if (cached) return cached;
  const pending = (async () => {
    const { data, error } = await supabase
      .schema('entity_instances')
      .from('source_registry')
      .select('id')
      .eq('source_code', 'MANUAL')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.id) throw new ManualOverrideError('NOT_SET_UP', 'There is no Manual Entry source.');
    return String(data.id);
  })();
  manualSources.set(supabase, pending);
  pending.catch(() => manualSources.delete(supabase));
  return pending;
}

/**
 * Store a Manual Entry value. From `validFrom` it wins over every other source until
 * it is cleared or a later manual entry replaces it. The caller refreshes calculations.
 */
export async function writeManualOverride(
  supabase: WriteClient,
  input: {
    entityId: string;
    attribute: { id: string; data_type?: string | null };
    value: unknown;
    validFrom?: string | null;
    reason: string | null | undefined;
    userId?: string | null;
  },
): Promise<{ id: string; stored: StoredValue }> {
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw new ManualOverrideError('REASON_REQUIRED', 'A reason is required for a manual entry.');
  const value = storedOverrideValue(input.value, input.attribute.data_type);
  if (!value.ok) throw new ManualOverrideError('INVALID_VALUE', value.message);
  const sourceId = await manualSourceId(supabase);
  const written = await writeSourceVersion(supabase, {
    entityId: input.entityId,
    attributeId: input.attribute.id,
    sourceId,
    validFrom: input.validFrom || new Date().toISOString().slice(0, 10),
    stored: value.stored,
    precedenceRank: 1,
    isManualOverride: true,
    overrideReason: reason.slice(0, 1000),
    userId: input.userId,
  });
  return { id: written.id, stored: value.stored };
}

/**
 * Recalculate what depends on one record after a write. The shared queue can hold a
 * job for every position, and draining it in one request times out, so this is bounded.
 */
export async function refreshCalculations(supabase: WriteClient, entityId: string): Promise<void> {
  const { error } = await supabase.rpc('process_entity_calculated_attributes', { p_entity_id: entityId, p_limit: 20 });
  if (error) console.error('Calculated attributes were not refreshed:', error.message);
}
