/**
 * The two ways application code changes a golden value.
 *
 * writeGoldenValue records "this source says the value is X from this date",
 * through golden_master.write_value. Rows from that source that overlap the new
 * period stop being current knowledge and their parts outside it are written
 * again, so every other date keeps its value and every earlier knowledge date
 * keeps its answer.
 *
 * endGoldenValue records "this source has no value from this date", until its
 * next later value, as write_value would. The part of the row before the date
 * stays current; nothing is deleted or edited.
 *
 * Both run with whatever client they are given, so row level security and the
 * guard_value_rows trigger decide for a signed-in caller.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const OPEN_SYSTEM_TO = '9999-12-31 23:59:59';

/** Columns golden_master.write_value takes for the new row. Omitted ones keep their defaults. */
export interface GoldenValueColumns {
  golden_value?: string | null;
  golden_value_numeric?: number | null;
  golden_value_date?: string | null;
  golden_value_timestamp?: string | null;
  golden_value_boolean?: boolean | null;
  golden_value_jsonb?: unknown;
  precedence_rank?: number | null;
  is_manual_override?: boolean | null;
  override_reason?: string | null;
  confidence_score?: number | null;
  metadata?: Record<string, unknown> | null;
  period_grain?: string | null;
  statement_basis?: string | null;
  source_value_id?: string | null;
  load_batch_id?: string | null;
}

export interface GoldenWrite {
  entityId: string;
  attributeId: string;
  sourceId: string;
  /** First date the value holds (YYYY-MM-DD). */
  validFrom: string;
  value: GoldenValueColumns;
  /** Last date the value holds. Null: until this source's next later value, or open-ended. */
  validTo?: string | null;
}

function message(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
}

/** Writes one source's value for a period as current knowledge. Returns the new row id. */
export async function writeGoldenValue(supabase: SupabaseClient, input: GoldenWrite): Promise<string> {
  const value: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(input.value)) {
    if (column !== undefined) value[key] = column;
  }
  const { data, error } = await supabase.schema('golden_master').rpc('write_value', {
    p_entity_id: input.entityId,
    p_attribute_id: input.attributeId,
    p_source_id: input.sourceId,
    p_valid_from: input.validFrom,
    p_value: value,
    p_valid_to: input.validTo ?? null,
  });
  if (error) throw new Error(message(error, 'The value could not be saved.'));
  if (typeof data !== 'string') throw new Error('The value was not saved.');
  return data;
}

function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Ends one source's current value on `from`, for the plain series (no period
 * grain or statement basis). The current row covering `from` stops being current
 * knowledge, so the source has no value from `from` until its next later value;
 * values dated after it are kept, as write_value keeps them. The row's part
 * before `from` is written again as current knowledge first, so a failure part
 * way never leaves an earlier date without its value. Returns how many rows
 * were ended.
 */
export async function endGoldenValue(
  supabase: SupabaseClient,
  input: { entityId: string; attributeId: string; sourceId: string; from: string },
): Promise<number> {
  const table = () => supabase.schema('golden_master').from('entity_attribute_values');
  const { data: rows, error } = await table()
    .select('*')
    .eq('entity_id', input.entityId)
    .eq('attribute_id', input.attributeId)
    .eq('source_id', input.sourceId)
    .eq('system_to', OPEN_SYSTEM_TO)
    .is('period_grain', null)
    .is('statement_basis', null)
    .lte('valid_from', input.from)
    .gte('valid_to', input.from);
  if (error) throw new Error(message(error, 'The value could not be read.'));

  let ended = 0;
  for (const row of (rows || []) as Array<Record<string, any>>) {
    const started = String(row.valid_from).slice(0, 10);
    if (started < input.from) {
      const { error: keepError } = await table().insert({
        entity_id: row.entity_id,
        attribute_id: row.attribute_id,
        source_id: row.source_id,
        source_value_id: row.source_value_id ?? null,
        golden_value: row.golden_value,
        golden_value_jsonb: row.golden_value_jsonb ?? null,
        golden_value_numeric: row.golden_value_numeric,
        golden_value_date: row.golden_value_date ?? null,
        golden_value_timestamp: row.golden_value_timestamp ?? null,
        golden_value_boolean: row.golden_value_boolean ?? null,
        valid_from: started,
        valid_to: dayBefore(input.from),
        precedence_rank: row.precedence_rank,
        confidence_score: row.confidence_score ?? null,
        is_manual_override: row.is_manual_override ?? false,
        override_reason: row.override_reason ?? null,
        competing_values: row.competing_values ?? [],
        metadata: { ...(row.metadata || {}), reasserted_from: row.id },
        period_grain: row.period_grain ?? null,
        statement_basis: row.statement_basis ?? null,
        load_batch_id: row.load_batch_id ?? null,
        last_received_at: row.last_received_at ?? null,
      });
      if (keepError) throw new Error(message(keepError, 'The earlier value could not be kept.'));
    }
    const { data: closed, error: closeError } = await table()
      .update({ system_to: new Date().toISOString() })
      .eq('id', row.id)
      .eq('system_to', OPEN_SYSTEM_TO)
      .select('id');
    if (closeError) throw new Error(message(closeError, 'The value could not be ended.'));
    if (!closed?.length) throw new Error('The value could not be ended. You may not edit this record.');
    ended += 1;
  }
  return ended;
}
