import type { SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, localSupabase } from './feed-loader';
import { previewImportInstance, processImportInstance } from './import-instances';
import {
  batchesMissing,
  insertChunks,
  planDrift,
  resultDigest,
  type CellEdit,
  type RecordEvent,
  type ResultDigest,
  type ValueEvent,
} from './load-batch-store';
import type { ColumnAssignment } from './suggest';
import type { EntityResolution, EntityResolutionDecision, FeedLoadResult } from './types';
import { coerceAttributeValue } from './values';

/**
 * Staging a load.
 *
 * Stage runs the loader without writing and keeps what it would do. The staged
 * values are checked against the data quality rules as the records would stand,
 * a person can correct a value, and Promote runs the real loader on the same
 * file with those corrections. Nothing is live until then. Revert takes a
 * promoted batch back.
 */

export const NOT_SET_UP = 'Staging is not set up on this database yet. Apply supabase/migrations/20261119100000_load_batches.sql.';

export type BatchStatus = 'STAGED' | 'PROMOTING' | 'PROMOTED' | 'REVERTED' | 'DISCARDED' | 'FAILED';

export interface BatchSummary {
  id: string;
  importInstanceId: string | null;
  fileName: string;
  mapCode: string | null;
  sourceCode: string | null;
  asOfDate: string;
  origin: 'STAGED' | 'DIRECT';
  status: BatchStatus;
  stagedAt: string;
  promotedAt: string | null;
  revertedAt: string | null;
  plan: ResultDigest | null;
  result: ResultDigest | null;
  drift: string[];
  overrideReason: string | null;
  errorMessage: string | null;
  revertResult: RevertResult | null;
  editCount: number;
}

export interface RevertResult {
  valuesRetired: number;
  valuesLeft: number;
  changesRestored: number;
  changesLeft: number;
  linksRemoved: number;
  recordsDeactivated: number;
  recordsLeft: number;
}

export interface QualityFailure {
  recordId: string;
  entityId: string | null;
  domainCode: string;
  fileCode: string;
  entityName: string;
  recordAction: 'CREATE' | 'MATCH';
  ruleCode: string;
  ruleName: string;
  severity: string;
  attributeCode: string | null;
  attributeName: string | null;
  message: string | null;
  actualValue: string | null;
  /** NEW: the batch brings this failure. EXISTING: the record fails it today. */
  state: 'NEW' | 'EXISTING';
  valueId: string | null;
  editable: boolean;
  stagedValue: string | null;
  /** Where the value sits in the file: the row and column it was read from. Absent when it came from no one cell. */
  originRow?: number | null;
  originColumn?: string | null;
}

export interface BatchQuality {
  batchId: string;
  asOf: string;
  recordCount: number;
  ruleCount: number;
  summary: { newFailures: number; existingFailures: number; cleared: number; missingRequired: number; blocking: number; outranked: number };
  failures: QualityFailure[];
  cleared: { recordId: string; domainCode: string; fileCode: string; entityName: string; ruleCode: string; ruleName: string; attributeCode: string | null }[];
  missing: { recordId: string; domainCode: string; fileCode: string; entityName: string; recordAction: string; attributeCode: string; attributeName: string; state: 'NEW' | 'EXISTING' }[];
  outranked: { valueId: string; recordId: string; fileCode: string; entityName: string; attributeCode: string; attributeName: string; proposed: string | null; winning: string | null }[];
}

export interface StagedValue {
  id: string;
  recordId: string;
  domainCode: string;
  fileCode: string;
  entityName: string;
  attributeCode: string;
  validFrom: string;
  action: 'INSERT' | 'UPDATE' | 'UNCHANGED';
  rawValue: string | null;
  proposedValue: string | null;
  currentValue: string | null;
  editedRaw: string | null;
  editedValue: string | null;
  editReason: string | null;
  editable: boolean;
}

export interface BatchDetail extends BatchSummary {
  records: { created: number; matched: number };
  values: { added: number; changed: number; unchanged: number; edited: number };
  quality: BatchQuality | null;
  /** Why the batch cannot be promoted as it stands. Empty when it can. */
  blockedBy: string[];
}

export type StageOutcome =
  | { kind: 'staged'; batch: BatchDetail }
  | { kind: 'needs_resolution'; resolutions: EntityResolution[] };

function useClient(client?: SupabaseClient): SupabaseClient {
  const db = client || localSupabase();
  assertLocalSupabase(db);
  return db;
}

function fail(error: { code?: string; message?: string } | null, fallback: string): never {
  if (batchesMissing(error)) throw new Error(NOT_SET_UP);
  throw new Error(error?.message || fallback);
}

function toSummary(row: any, editCount = 0): BatchSummary {
  return {
    id: row.id,
    importInstanceId: row.import_instance_id || null,
    fileName: row.file_name,
    mapCode: row.map_code || null,
    sourceCode: row.source_code || null,
    asOfDate: String(row.as_of_date).slice(0, 10),
    origin: row.origin,
    status: row.status,
    stagedAt: row.staged_at,
    promotedAt: row.promoted_at || null,
    revertedAt: row.reverted_at || null,
    plan: row.plan || null,
    result: row.result || null,
    drift: Array.isArray(row.drift) ? row.drift : [],
    overrideReason: row.override_reason || null,
    errorMessage: row.error_message || null,
    revertResult: row.revert_result || null,
    editCount,
  };
}

async function readBatch(db: SupabaseClient, id: string, clientId: string): Promise<any> {
  const row = await db.schema('entity_instances').from('load_batches').select('*').eq('id', id).eq('client_id', clientId).maybeSingle();
  if (row.error) fail(row.error, 'The batch could not be read');
  if (!row.data) throw new Error('Batch not found');
  return row.data;
}

async function countValues(db: SupabaseClient, batchId: string, filter: (query: any) => any): Promise<number> {
  const query = filter(db.schema('entity_instances').from('load_batch_values').select('id', { count: 'exact', head: true }).eq('batch_id', batchId));
  const counted = await query;
  if (counted.error) fail(counted.error, 'The staged values could not be counted');
  return counted.count || 0;
}

/** Why a staged batch may not be promoted yet. A reason given by a person lifts the quality block. */
export function promoteBlockers(status: BatchStatus, quality: BatchQuality | null, overrideReason?: string | null): string[] {
  const reasons: string[] = [];
  if (status !== 'STAGED') reasons.push(`This batch is ${status.toLowerCase()}. Only a staged batch can be promoted.`);
  const blocking = quality?.summary.blocking || 0;
  if (blocking > 0 && !overrideReason?.trim()) {
    reasons.push(`${blocking} critical ${blocking === 1 ? 'check fails' : 'checks fail'} because of this batch. Correct the values, or give a reason to promote anyway.`);
  }
  return reasons;
}

export async function batchQuality(id: string, clientId: string, client?: SupabaseClient): Promise<BatchQuality> {
  const db = useClient(client);
  const checked = await db.rpc('load_batch_quality', { p_batch_id: id, p_client_id: clientId });
  if (checked.error) fail(checked.error, 'The data quality checks could not be run');
  const quality = checked.data as BatchQuality;
  // Each failing value is tied back to its cell in the file, so the screen can show where it was read.
  const ids = [...new Set(quality.failures.map((item) => item.valueId).filter((value): value is string => Boolean(value)))];
  if (ids.length > 0) {
    const origins = await db.schema('entity_instances').from('load_batch_values').select('id, origin_row, origin_column').in('id', ids.slice(0, 500));
    const byId = new Map((origins.data || []).map((row: any) => [row.id, row]));
    for (const failure of quality.failures) {
      const origin = failure.valueId ? byId.get(failure.valueId) : null;
      failure.originRow = origin?.origin_row ?? null;
      failure.originColumn = origin?.origin_column ?? null;
    }
  }
  return quality;
}

export async function getBatch(id: string, clientId: string, client?: SupabaseClient): Promise<BatchDetail> {
  const db = useClient(client);
  const row = await readBatch(db, id, clientId);
  const staged = row.origin === 'STAGED';
  const [created, matched, added, changed, unchanged, edited] = staged
    ? await Promise.all([
        db.schema('entity_instances').from('load_batch_records').select('id', { count: 'exact', head: true }).eq('batch_id', id).eq('action', 'CREATE'),
        db.schema('entity_instances').from('load_batch_records').select('id', { count: 'exact', head: true }).eq('batch_id', id).eq('action', 'MATCH'),
        countValues(db, id, (query) => query.eq('action', 'INSERT')),
        countValues(db, id, (query) => query.eq('action', 'UPDATE')),
        countValues(db, id, (query) => query.eq('action', 'UNCHANGED')),
        countValues(db, id, (query) => query.not('edited_raw', 'is', null)),
      ])
    : [{ count: 0 }, { count: 0 }, 0, 0, 0, 0];
  // The checks describe a batch that has not been written. Once it is live, the data quality page is the place to look.
  const quality = staged && row.status === 'STAGED' ? await batchQuality(id, clientId, db) : null;
  return {
    ...toSummary(row, edited as number),
    records: { created: (created as any).count || 0, matched: (matched as any).count || 0 },
    values: { added: added as number, changed: changed as number, unchanged: unchanged as number, edited: edited as number },
    quality,
    blockedBy: row.status === 'STAGED' ? promoteBlockers(row.status, quality) : [],
  };
}

export async function listBatches(clientId: string, importInstanceId?: string | null, client?: SupabaseClient): Promise<BatchSummary[]> {
  const db = useClient(client);
  let query = db.schema('entity_instances').from('load_batches').select('*').eq('client_id', clientId).neq('status', 'DISCARDED');
  if (importInstanceId) query = query.eq('import_instance_id', importInstanceId);
  const rows = await query.order('staged_at', { ascending: false }).limit(50);
  if (rows.error) {
    // Before the tables exist there is simply nothing staged.
    if (batchesMissing(rows.error)) return [];
    throw new Error(rows.error.message);
  }
  return (rows.data || []).map((row) => toSummary(row));
}

/**
 * Run the load without writing and keep what it would do. A batch already
 * staged for the same file is replaced. When a record in the file matches more
 * than one stored record, nothing is staged and the choices are returned.
 */
export async function stageImportInstance(
  importInstanceId: string,
  clientId: string,
  input: { columnMappings?: ColumnAssignment[]; asOfDate?: string; decisions?: EntityResolutionDecision[]; userId?: string | null } = {},
  client?: SupabaseClient,
): Promise<StageOutcome> {
  const db = useClient(client);
  const instance = await db.schema('entity_instances').from('import_instances')
    .select('id, file_name, map_code, source_code, as_of_date, column_mappings')
    .eq('id', importInstanceId).eq('client_id', clientId).maybeSingle();
  if (instance.error) throw new Error(instance.error.message);
  if (!instance.data) throw new Error('Import instance not found');
  const asOf = input.asOfDate || instance.data.as_of_date;
  if (!asOf) throw new Error('Choose today or a specific as-of date');
  const mappings = input.columnMappings || (instance.data.column_mappings as ColumnAssignment[]);

  const records: RecordEvent[] = [];
  const values: ValueEvent[] = [];
  const plan = await previewImportInstance(importInstanceId, clientId, mappings, asOf, db, {
    decisions: input.decisions,
    recorder: {
      record: (event) => { records.push(event); },
      value: (event) => { values.push(event); },
    },
  });
  if (plan.resolutions.length > 0) return { kind: 'needs_resolution', resolutions: plan.resolutions };

  const superseded = await db.schema('entity_instances').from('load_batches')
    .update({ status: 'DISCARDED' })
    .eq('client_id', clientId).eq('import_instance_id', importInstanceId).eq('status', 'STAGED');
  if (superseded.error) fail(superseded.error, 'The earlier staged batch could not be replaced');

  const inserted = await db.schema('entity_instances').from('load_batches').insert({
    client_id: clientId,
    import_instance_id: importInstanceId,
    file_name: instance.data.file_name,
    map_code: plan.mapCode,
    source_code: instance.data.source_code || plan.sourceCode,
    as_of_date: asOf,
    origin: 'STAGED',
    status: 'STAGED',
    column_mappings: mappings,
    decisions: input.decisions || null,
    plan: resultDigest(plan),
    staged_by: input.userId || null,
  }).select('id').single();
  if (inserted.error || !inserted.data) fail(inserted.error, 'The batch could not be stored');
  const batchId = inserted.data!.id as string;

  try {
    const recordRows = dedupeRecords(records).map((event) => ({
      batch_id: batchId,
      domain_code: event.domainCode,
      file_code: event.fileCode,
      entity_name: event.name,
      action: event.action,
      entity_id: event.entityId,
      template_id: event.templateId,
      matched_via: event.via || null,
    }));
    await insertChunks(db, 'load_batch_records', recordRows);
    const stored = await pageAll<{ id: string; domain_code: string; file_code: string }>((from, to) =>
      db.schema('entity_instances').from('load_batch_records').select('id, domain_code, file_code').eq('batch_id', batchId).order('id').range(from, to));
    const recordIds = new Map(stored.map((row) => [`${row.domain_code}|${row.file_code}`, row.id]));
    const valueRows = values.flatMap((event) => {
      const recordId = recordIds.get(`${event.domainCode}|${event.fileCode}`);
      if (!recordId) return [];
      return [{
        batch_id: batchId,
        record_id: recordId,
        attribute_id: event.attributeId,
        attribute_code: event.attributeCode,
        source_id: event.sourceId,
        precedence_rank: event.precedenceRank,
        valid_from: event.validFrom,
        action: event.action,
        raw_value: event.raw,
        proposed_value: event.proposed,
        current_value: event.current,
        origin_row: event.row ?? null,
        origin_column: event.column ?? null,
      }];
    });
    await insertChunks(db, 'load_batch_values', valueRows);
  } catch (error) {
    // Half a plan is worse than none: the checks would pass on values that are missing.
    await db.schema('entity_instances').from('load_batches').delete().eq('id', batchId);
    throw error;
  }
  return { kind: 'staged', batch: await getBatch(batchId, clientId, db) };
}

/** The loader can name a record twice when two rows resolve to the same one. The first stands. */
export function dedupeRecords(records: RecordEvent[]): RecordEvent[] {
  const seen = new Set<string>();
  return records.filter((event) => {
    const key = `${event.domainCode}|${event.fileCode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pageAll<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await read(from, from + 999);
    if (page.error) throw new Error(page.error.message);
    const data = (page.data || []) as T[];
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/** The staged values of a batch: the ones a person corrected, the ones for a record, or the first few hundred. */
export async function listStagedValues(
  id: string,
  clientId: string,
  filter: { recordId?: string; editedOnly?: boolean; changesOnly?: boolean; limit?: number } = {},
  client?: SupabaseClient,
): Promise<StagedValue[]> {
  const db = useClient(client);
  await readBatch(db, id, clientId);
  let query = db.schema('entity_instances').from('load_batch_values')
    .select('id, record_id, attribute_code, valid_from, action, raw_value, proposed_value, current_value, edited_raw, edited_value, edit_reason, origin_row, origin_column, record:load_batch_records!inner(domain_code, file_code, entity_name)')
    .eq('batch_id', id);
  if (filter.recordId) query = query.eq('record_id', filter.recordId);
  if (filter.editedOnly) query = query.not('edited_raw', 'is', null);
  if (filter.changesOnly) query = query.neq('action', 'UNCHANGED');
  const rows = await query.order('record_id').order('attribute_code').limit(Math.min(Math.max(filter.limit || 200, 1), 1000));
  if (rows.error) fail(rows.error, 'The staged values could not be read');
  return (rows.data || []).map((row: any) => ({
    id: row.id,
    recordId: row.record_id,
    domainCode: row.record?.domain_code,
    fileCode: row.record?.file_code,
    entityName: row.record?.entity_name || row.record?.file_code,
    attributeCode: row.attribute_code,
    validFrom: String(row.valid_from).slice(0, 10),
    action: row.action,
    rawValue: row.raw_value,
    proposedValue: row.proposed_value,
    currentValue: row.current_value,
    editedRaw: row.edited_raw,
    editedValue: row.edited_value,
    editReason: row.edit_reason,
    editable: row.origin_row !== null && row.origin_column !== null,
  }));
}

/**
 * Correct one staged value. The correction is held to the attribute's type
 * here and goes through the loader's own cleanup when the batch is promoted.
 * A blank value takes the correction back.
 */
export async function editStagedValue(
  batchId: string,
  valueId: string,
  clientId: string,
  input: { value: string; reason?: string | null; userId?: string | null },
  client?: SupabaseClient,
): Promise<BatchDetail> {
  const db = useClient(client);
  const batch = await readBatch(db, batchId, clientId);
  if (batch.status !== 'STAGED') throw new Error('Only a staged batch can be corrected.');
  const found = await db.schema('entity_instances').from('load_batch_values')
    .select('id, attribute_id, attribute_code, origin_row, origin_column').eq('id', valueId).eq('batch_id', batchId).maybeSingle();
  if (found.error) fail(found.error, 'The staged value could not be read');
  if (!found.data) throw new Error('Staged value not found');
  if (found.data.origin_row === null || found.data.origin_column === null) {
    throw new Error('This value does not come from one cell of the file, so it cannot be corrected here. Change the mapping and stage again.');
  }
  const text = String(input.value ?? '').trim();
  let patch: Record<string, unknown>;
  if (!text) {
    patch = { edited_raw: null, edited_value: null, edit_reason: null, edited_by: null, edited_at: null };
  } else {
    const attribute = await db.schema('metadata_register').from('attribute_register').select('data_type').eq('id', found.data.attribute_id).maybeSingle();
    if (attribute.error) throw new Error(attribute.error.message);
    const coerced = coerceAttributeValue(text, attribute.data?.data_type || 'STRING');
    if (!coerced) throw new Error('Enter a value.');
    if ('error' in coerced) throw new Error(`${found.data.attribute_code}: ${coerced.error}`);
    patch = {
      edited_raw: text,
      edited_value: coerced.golden_value,
      edit_reason: input.reason?.trim() || null,
      edited_by: input.userId || null,
      edited_at: new Date().toISOString(),
    };
  }
  const saved = await db.schema('entity_instances').from('load_batch_values').update(patch).eq('id', valueId).eq('batch_id', batchId);
  if (saved.error) fail(saved.error, 'The correction could not be saved');
  return getBatch(batchId, clientId, db);
}

async function cellEdits(db: SupabaseClient, batchId: string): Promise<CellEdit[]> {
  const rows = await pageAll<{ origin_row: number; origin_column: string; edited_raw: string }>((from, to) =>
    db.schema('entity_instances').from('load_batch_values').select('origin_row, origin_column, edited_raw')
      .eq('batch_id', batchId).not('edited_raw', 'is', null).order('id').range(from, to));
  return rows.map((row) => ({ row: row.origin_row, column: row.origin_column, value: row.edited_raw }));
}

/**
 * Write a staged batch to live records. The real loader runs on the stored
 * file with the staged mapping, decisions and corrections, so what is written
 * is decided now, against the data as it is now. Where that differs from what
 * was staged, the batch says so.
 */
export async function promoteBatch(
  id: string,
  clientId: string,
  input: { userId?: string | null; overrideReason?: string | null } = {},
  client?: SupabaseClient,
): Promise<BatchDetail> {
  const db = useClient(client);
  const batch = await readBatch(db, id, clientId);
  if (batch.origin !== 'STAGED') throw new Error('This load was not staged, so there is nothing to promote.');
  if (!batch.import_instance_id) throw new Error('The file this batch was staged from has been removed.');
  const quality = batch.status === 'STAGED' ? await batchQuality(id, clientId, db) : null;
  const blockers = promoteBlockers(batch.status, quality, input.overrideReason);
  if (blockers.length > 0) throw new Error(blockers[0]);

  // Claim it. A second promote finds it no longer staged.
  const claimed = await db.schema('entity_instances').from('load_batches').update({
    status: 'PROMOTING',
    promoted_by: input.userId || null,
    override_reason: input.overrideReason?.trim() || null,
    error_message: null,
  }).eq('id', id).eq('status', 'STAGED').select('id');
  if (claimed.error) fail(claimed.error, 'The batch could not be promoted');
  if (!claimed.data || claimed.data.length === 0) throw new Error('This batch is already being promoted.');

  try {
    const edits = await cellEdits(db, id);
    const loaded = await processImportInstance(
      batch.import_instance_id,
      clientId,
      batch.column_mappings as ColumnAssignment[],
      String(batch.as_of_date).slice(0, 10),
      db,
      (batch.decisions as EntityResolutionDecision[] | null) || undefined,
      { id, cellEdits: edits, userId: input.userId },
    );
    if (loaded.status === 'NEEDS_RESOLUTION') {
      // Nothing was written: the data changed since staging and a record now matches more than one.
      await db.schema('entity_instances').from('load_batches').update({
        status: 'STAGED',
        error_message: 'A record in this file now matches more than one stored record. Stage the file again to choose.',
      }).eq('id', id);
      return getBatch(id, clientId, db);
    }
    const written = await db.schema('entity_instances').from('import_instances').select('result').eq('id', batch.import_instance_id).maybeSingle();
    const result = resultDigest((written.data?.result as FeedLoadResult | null) || null);
    const failed = loaded.status !== 'SUCCEEDED';
    const saved = await db.schema('entity_instances').from('load_batches').update({
      status: failed ? 'FAILED' : 'PROMOTED',
      promoted_at: new Date().toISOString(),
      result,
      drift: planDrift(batch.plan as ResultDigest | null, result),
      error_message: failed ? loaded.errorMessage || 'The load finished with problems.' : null,
    }).eq('id', id);
    if (saved.error) throw new Error(saved.error.message);
  } catch (error: any) {
    await db.schema('entity_instances').from('load_batches').update({
      status: 'FAILED',
      promoted_at: new Date().toISOString(),
      error_message: error?.message || 'The promote failed',
    }).eq('id', id);
    throw error;
  }
  return getBatch(id, clientId, db);
}

/** Take back what a promoted batch wrote, where it still stands. */
export async function revertBatch(id: string, clientId: string, userId?: string | null, client?: SupabaseClient): Promise<BatchDetail> {
  const db = useClient(client);
  await readBatch(db, id, clientId);
  const reverted = await db.rpc('load_batch_revert', { p_batch_id: id, p_client_id: clientId, p_user_id: userId || null });
  if (reverted.error) fail(reverted.error, 'The batch could not be reverted');
  return getBatch(id, clientId, db);
}

/** Drop a staged batch. Nothing live was changed, so there is nothing to undo. */
export async function discardBatch(id: string, clientId: string, client?: SupabaseClient): Promise<BatchDetail> {
  const db = useClient(client);
  const batch = await readBatch(db, id, clientId);
  if (batch.status !== 'STAGED') throw new Error('Only a staged batch can be discarded. A promoted one is reverted.');
  const saved = await db.schema('entity_instances').from('load_batches').update({ status: 'DISCARDED' }).eq('id', id);
  if (saved.error) fail(saved.error, 'The batch could not be discarded');
  return getBatch(id, clientId, db);
}
