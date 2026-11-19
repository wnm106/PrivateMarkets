import type { SupabaseClient } from '@supabase/supabase-js';
import type { LoadRecorder } from './feed-loader';
import type { FeedLoadResult } from './types';

/**
 * The rows behind a load batch. Kept apart from the staging flow so the loader's
 * own callers can open a batch for a load that was not staged.
 */

export type JournalEntry = Parameters<NonNullable<LoadRecorder['journal']>>[0];
export type RecordEvent = Parameters<NonNullable<LoadRecorder['record']>>[0];
export type ValueEvent = Parameters<NonNullable<LoadRecorder['value']>>[0];

/** A correction to one cell of the file, made on a staged batch. */
export interface CellEdit {
  row: number;
  column: string;
  value: string;
}

export interface BatchHeader {
  clientId: string;
  importInstanceId: string | null;
  fileName: string;
  mapCode: string | null;
  sourceCode: string | null;
  asOfDate: string;
  userId?: string | null;
}

const CHUNK = 500;

function batches(db: SupabaseClient) {
  return db.schema('entity_instances').from('load_batches');
}

/** True when the batch tables have not been created yet. Loads then run as they always did. */
export function batchesMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204' || /load_batch/i.test(error.message || '');
}

/** The file's rows with the staged corrections laid over them. The stored rows are not changed. */
export function applyCellEdits(rows: Record<string, string>[], edits: CellEdit[] | undefined): Record<string, string>[] {
  if (!edits || edits.length === 0) return rows;
  const byRow = new Map<number, CellEdit[]>();
  for (const edit of edits) byRow.set(edit.row, [...(byRow.get(edit.row) || []), edit]);
  return rows.map((row, index) => {
    const changes = byRow.get(index);
    if (!changes) return row;
    const next = { ...row };
    for (const change of changes) next[change.column] = change.value;
    return next;
  });
}

/**
 * Open a batch for a load that goes straight to live records. Returns null when
 * the batch tables are not there, so the load carries on without one.
 */
export async function openDirectBatch(db: SupabaseClient, header: BatchHeader): Promise<string | null> {
  const inserted = await batches(db).insert({
    client_id: header.clientId,
    import_instance_id: header.importInstanceId,
    file_name: header.fileName,
    map_code: header.mapCode,
    source_code: header.sourceCode,
    as_of_date: header.asOfDate,
    origin: 'DIRECT',
    status: 'PROMOTING',
    staged_by: header.userId || null,
    promoted_by: header.userId || null,
  }).select('id').single();
  if (inserted.error || !inserted.data) return null;
  return inserted.data.id as string;
}

export async function writeJournal(db: SupabaseClient, batchId: string, entries: JournalEntry[]): Promise<string | null> {
  for (let offset = 0; offset < entries.length; offset += CHUNK) {
    const chunk = entries.slice(offset, offset + CHUNK).map((entry) => ({
      batch_id: batchId,
      kind: entry.kind,
      target_id: entry.targetId,
      before: entry.before,
      after: entry.after,
    }));
    const insert = await db.schema('entity_instances').from('load_batch_journal').insert(chunk);
    if (insert.error) return insert.error.message;
  }
  return null;
}

/** Counts only. The rejects and normalisations stay on the file's own result. */
export function resultDigest(result: FeedLoadResult | null) {
  if (!result) return null;
  return {
    rowCount: result.rowCount,
    domains: result.domains.map((domain) => ({
      domainCode: domain.domainCode,
      distinctEntities: domain.distinctEntities,
      created: domain.created,
      matched: domain.matched,
      failed: domain.failed,
    })),
    attributes: result.attributes,
    relationships: result.relationships,
    rejectCount: result.rejectCount || 0,
    warnings: result.warnings.slice(0, 20),
    errors: result.errors.slice(0, 20),
  };
}

export type ResultDigest = NonNullable<ReturnType<typeof resultDigest>>;

/** Where a promote did something other than what was staged. Empty when they agree. */
export function planDrift(plan: ResultDigest | null, result: ResultDigest | null): string[] {
  if (!plan || !result) return [];
  const drift: string[] = [];
  const say = (label: string, planned: number, actual: number) => {
    if (planned !== actual) drift.push(`${label}: ${planned.toLocaleString('en-US')} staged, ${actual.toLocaleString('en-US')} written`);
  };
  for (const domain of plan.domains) {
    const actual = result.domains.find((item) => item.domainCode === domain.domainCode);
    say(`${domain.domainCode} records created`, domain.created, actual?.created || 0);
    say(`${domain.domainCode} records matched`, domain.matched, actual?.matched || 0);
    say(`${domain.domainCode} records refused`, domain.failed, actual?.failed || 0);
  }
  say('Values added', plan.attributes.created, result.attributes.created);
  say('Values changed', plan.attributes.updated, result.attributes.updated);
  say('Links added', plan.relationships.created, result.relationships.created);
  return drift;
}

export async function finishDirectBatch(
  db: SupabaseClient,
  batchId: string,
  outcome: { status: 'PROMOTED' | 'FAILED'; result: FeedLoadResult | null; errorMessage?: string | null },
): Promise<void> {
  await batches(db).update({
    status: outcome.status,
    result: resultDigest(outcome.result),
    error_message: outcome.errorMessage || null,
    promoted_at: new Date().toISOString(),
  }).eq('id', batchId);
}

/** A direct load that wrote nothing (it stopped to ask which record was meant) leaves no batch behind. */
export async function dropBatch(db: SupabaseClient, batchId: string): Promise<void> {
  await batches(db).delete().eq('id', batchId);
}

export async function insertChunks(db: SupabaseClient, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const insert = await db.schema('entity_instances').from(table).insert(rows.slice(offset, offset + CHUNK));
    if (insert.error) throw new Error(insert.error.message);
  }
}
