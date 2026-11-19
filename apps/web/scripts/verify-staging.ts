import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'path';
import { createImportInstance } from '../lib/feeds/import-instances';
import { discardBatch, editStagedValue, listStagedValues, stageImportInstance } from '../lib/feeds/load-batches';

/**
 * Stages a two-row issuer file (one issuer that exists, one that does not),
 * corrects a staged value, then discards the batch. Nothing is promoted, so no
 * live record changes. The uploaded file stays in the Load data queue.
 *
 *   npx tsx scripts/verify-staging.ts <client code>
 */

config({ path: resolve(__dirname, '../.env.local') });

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function main() {
  const clientCode = process.argv[2];
  if (!clientCode) throw new Error('Pass the client code');
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const client = await db.schema('tenancy').from('clients').select('id').eq('client_code', clientCode).single();
  if (client.error || !client.data) throw new Error(client.error?.message || 'Client not found');
  const clientId = client.data.id as string;

  const issuer = await db.schema('entity_instances').from('master_entities')
    .select('entity_code, entity_name').eq('client_id', clientId).eq('domain_code', 'ISSUER').eq('is_active', true).limit(1).single();
  if (issuer.error || !issuer.data) throw new Error(issuer.error?.message || 'No issuer to match against');
  const newCode = `ZZ-STAGE-TEST-${Date.now()}`;
  const csv = [
    'Issuer Code,Issuer Name,Industry',
    `${issuer.data.entity_code},"${String(issuer.data.entity_name).replace(/"/g, '""')}",Staging Test Industry`,
    `${newCode},Staging Test Issuer,Staging Test Industry`,
  ].join('\n');

  const before = await db.schema('golden_master').from('entity_attribute_values').select('id', { count: 'exact', head: true });
  const instance = await createImportInstance('staging-check.csv', 'text/csv', Buffer.from(csv), clientId);
  console.log('mapping:', instance.columnMappings.map((item) => `${item.sourceColumn} -> ${item.role}${item.domainCode ? `:${item.domainCode}` : ''}${item.attributeCode ? `:${item.attributeCode}` : ''}`).join(' | '));

  const asOf = new Date().toISOString().slice(0, 10);
  const outcome = await stageImportInstance(instance.id, clientId, { columnMappings: instance.columnMappings, asOfDate: asOf });
  if (outcome.kind !== 'staged') {
    console.log('needs resolution:', JSON.stringify(outcome.resolutions.map((item) => item.message)));
    return;
  }
  const batch = outcome.batch;
  console.log('staged:', JSON.stringify({ status: batch.status, records: batch.records, values: batch.values, plan: batch.plan?.domains }));
  console.log('quality:', JSON.stringify({ ...batch.quality?.summary, rules: batch.quality?.ruleCount, records: batch.quality?.recordCount }));
  console.log('failures:', JSON.stringify((batch.quality?.failures || []).slice(0, 5).map((item) => `${item.state} ${item.severity} ${item.fileCode} ${item.ruleCode}: ${item.message}`)));
  assert(batch.status === 'STAGED', `status ${batch.status}`);
  assert(batch.records.created === 1 && batch.records.matched === 1, `records ${JSON.stringify(batch.records)}`);

  const values = await listStagedValues(batch.id, clientId);
  console.log('values:', JSON.stringify(values.map((item) => `${item.fileCode} ${item.attributeCode} ${item.action}: ${item.currentValue} -> ${item.proposedValue}`)));
  const target = values.find((item) => item.editable && item.fileCode === newCode);
  assert(target, 'a staged value that can be corrected');
  const edited = await editStagedValue(batch.id, target!.id, clientId, { value: 'Corrected Industry', reason: 'staging check' });
  assert(edited.values.edited === 1, `edited count ${edited.values.edited}`);
  const after = await listStagedValues(batch.id, clientId, { editedOnly: true });
  assert(after.length === 1 && after[0].editedValue === 'Corrected Industry', 'the correction was stored');
  console.log('corrected:', `${after[0].attributeCode} ${after[0].proposedValue} -> ${after[0].editedValue}`);

  const discarded = await discardBatch(batch.id, clientId);
  assert(discarded.status === 'DISCARDED', `status ${discarded.status}`);

  const [liveValues, created, tagged] = await Promise.all([
    db.schema('golden_master').from('entity_attribute_values').select('id', { count: 'exact', head: true }),
    db.schema('entity_instances').from('master_entities').select('id', { count: 'exact', head: true }).eq('entity_code', newCode),
    db.schema('golden_master').from('entity_attribute_values').select('id', { count: 'exact', head: true }).eq('load_batch_id', batch.id),
  ]);
  assert(created.count === 0, 'the new issuer was not created');
  assert(tagged.count === 0, 'no live value carries the batch');
  console.log('live records untouched:', JSON.stringify({ valuesBefore: before.count, valuesAfter: liveValues.count, newIssuerRows: created.count, valuesTagged: tagged.count }));
  console.log('ok: staged, corrected, discarded. Import instance', instance.id, 'is left in the queue.');
}

main().catch((error) => {
  console.error('FAILED:', error?.message || error);
  process.exit(1);
});
