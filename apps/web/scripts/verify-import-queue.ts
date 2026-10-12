import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createImportInstance, listMappingCatalog, processImportInstance } from '../lib/feeds/import-instances';
import { dependencyLoadOrder } from '../lib/feeds/load-order';
import { applyTarget, feedMapFromAssignments, mappingTargets, previewTransform, targetKey } from '../lib/feeds/suggest';

config({ path: resolve(__dirname, '../.env.local') });

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function industryValues(client: ReturnType<typeof db>) {
  const entity = await client.schema('entity_instances').from('master_entities').select('id').eq('entity_code', 'ISS-0001').single();
  if (entity.error || !entity.data) throw new Error(entity.error?.message || 'ISS-0001 is missing');
  const attribute = await client.schema('metadata_register').from('attribute_register').select('id').eq('attribute_code', 'INDUSTRY').single();
  if (attribute.error || !attribute.data) throw new Error(attribute.error?.message || 'INDUSTRY is missing');
  const values = await client.schema('golden_master').from('entity_attribute_values').select('golden_value, valid_from, valid_to').eq('entity_id', entity.data.id).eq('attribute_id', attribute.data.id);
  if (values.error) throw new Error(values.error.message);
  return values.data || [];
}

async function attributeRowCount(client: ReturnType<typeof db>) {
  const count = await client.schema('golden_master').from('entity_attribute_values').select('id', { count: 'exact', head: true });
  if (count.error) throw new Error(count.error.message);
  return count.count || 0;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Pass the position file csv path');
  const bytes = readFileSync(csvPath);
  const client = db();
  const before = await attributeRowCount(client);
  const originalIndustry = await industryValues(client);
  const historicalBefore = originalIndustry.filter((row) => String(row.valid_from).slice(0, 10) === '2026-09-30').map((row) => row.golden_value);
  assert(historicalBefore.includes('Industrial Machinery'), `expected stored industry, got ${historicalBefore.join('|')}`);

  const instance = await createImportInstance('Position_FIle.csv', 'text/csv', bytes);
  assert(instance.columnMappings.length === instance.headers.length, `mapping rows ${instance.columnMappings.length} headers ${instance.headers.length}`);
  assert(instance.headers.length === 42, `expected 42 source columns, got ${instance.headers.length}`);
  assert(instance.columnMappings.every((column) => column.role !== 'ignore'), `unmapped columns ${instance.columnMappings.filter((column) => column.role === 'ignore').map((column) => column.sourceColumn).join(', ')}`);

  const rating = instance.columnMappings.find((column) => column.sourceColumn === 'issuer credit rating');
  assert(rating?.role === 'attribute' && rating.domainCode === 'ISSUER' && rating.attributeCode === 'CREDIT_RATING', `credit rating mapped to ${rating?.domainCode}:${rating?.attributeCode}`);
  assert(rating?.transform.kind === 'list' && rating.suggestion.method === 'source_map', `credit rating suggestion ${rating?.transform.kind} ${rating?.suggestion.method}`);

  const expense = instance.columnMappings.find((column) => column.sourceColumn === 'fund expense ratio');
  assert(expense?.attributeCode === 'EXPENSE_RATIO' && expense.domainCode === 'FUND', 'expense ratio target');
  assert(expense?.transform.kind === 'percent' && previewTransform('1%', expense.transform) === '0.01', `percent transform ${expense?.transform.kind} ${expense ? previewTransform('1%', expense.transform) : ''}`);

  const industry = instance.columnMappings.find((column) => column.sourceColumn === 'issuer industry');
  assert(industry?.attributeCode === 'INDUSTRY' && industry.domainCode === 'ISSUER' && industry.transform.kind === 'trim', 'industry suggestion');

  const catalog = await listMappingCatalog();
  const fundIndustry = mappingTargets(catalog.attributes, catalog.domains).find((target) => target.key === 'attribute:FUND:INDUSTRY');
  assert(fundIndustry, 'FUND industry is a selectable target');
  const manual = applyTarget(industry!, fundIndustry!);
  assert(manual.domainCode === 'FUND' && manual.attributeCode === 'INDUSTRY' && manual.suggestion.method === 'manual', 'manual retarget');
  assert(targetKey(manual) === 'attribute:FUND:INDUSTRY', 'manual target key');

  const order = dependencyLoadOrder(feedMapFromAssignments(instance.columnMappings).domains);
  assert(order.indexOf('ISSUER') < order.indexOf('SECURITY'), `issuer before security, got ${order.join(',')}`);
  assert(order.indexOf('FUND') < order.indexOf('POSITION'), `fund before position, got ${order.join(',')}`);
  assert(order.indexOf('SECURITY') < order.indexOf('POSITION'), `security before position, got ${order.join(',')}`);

  const stored = await client.schema('entity_instances').from('import_instances').select('source_base64, parsed_rows, row_count, status, as_of_date').eq('id', instance.id).single();
  if (stored.error || !stored.data) throw new Error(stored.error?.message || 'stored instance missing');
  assert(Buffer.from(stored.data.source_base64, 'base64').equals(bytes), 'original file bytes were not kept');
  assert(stored.data.row_count === 20 && stored.data.parsed_rows.length === 20, `stored rows ${stored.data.row_count}`);
  assert(String(stored.data.parsed_rows[0]['fund aum']).includes(','), 'stored source still has the formatted amount');
  assert(stored.data.status === 'READY' && stored.data.as_of_date === '2026-09-30', `queue state ${stored.data.status} ${stored.data.as_of_date}`);

  const processed = await processImportInstance(instance.id, instance.columnMappings, '2026-09-30');
  assert(processed.status === 'SUCCEEDED', processed.errorMessage || processed.status);
  assert(processed.resultSummary?.created === 0 && processed.resultSummary.matched === 56 && processed.resultSummary.failed === 0, `entities ${JSON.stringify(processed.resultSummary)}`);
  assert(processed.resultSummary.attributesCreated === 0, `reprocess created ${processed.resultSummary.attributesCreated} attribute rows`);
  assert(processed.resultSummary.relationshipsMatched === 60, `relationships matched ${processed.resultSummary.relationshipsMatched}`);
  const afterFirst = await attributeRowCount(client);
  assert(afterFirst === before, `attribute rows grew from ${before} to ${afterFirst}`);

  const upperMappings = processed.columnMappings.map((column) => (
    column.sourceColumn === 'issuer industry' ? { ...column, transform: { kind: 'uppercase' as const } } : column
  ));
  const upper = await processImportInstance(instance.id, upperMappings, '2026-09-30');
  assert(upper.status === 'SUCCEEDED', upper.errorMessage || upper.status);
  assert((upper.resultSummary?.attributesUpdated || 0) > 0, 'uppercase transform did not update industry');
  const upperValues = await industryValues(client);
  assert(upperValues.some((row) => String(row.valid_from).slice(0, 10) === '2026-09-30' && row.golden_value === 'INDUSTRIAL MACHINERY'), 'historical industry was not transformed');
  assert(upperValues.filter((row) => String(row.valid_to).slice(0, 10) === '9999-12-31').every((row) => row.golden_value === 'Industrial Machinery'), 'open industry slice changed');

  const restored = await processImportInstance(instance.id, processed.columnMappings, '2026-09-30');
  assert(restored.status === 'SUCCEEDED' && restored.resultSummary?.attributesCreated === 0, `restore ${restored.errorMessage}`);
  const restoredValues = await industryValues(client);
  assert(restoredValues.filter((row) => String(row.valid_from).slice(0, 10) === '2026-09-30').every((row) => row.golden_value === 'Industrial Machinery'), `industry left as ${restoredValues.map((row) => row.golden_value).join('|')}`);

  const again = await processImportInstance(instance.id);
  assert(again.status === 'SUCCEEDED', again.errorMessage || again.status);
  assert(again.resultSummary?.created === 0 && again.resultSummary.attributesCreated === 0 && again.resultSummary.attributesUpdated === 0, `stored reprocess ${JSON.stringify(again.resultSummary)}`);
  assert(again.runs.length === 4, `expected 4 runs, got ${again.runs.length}`);
  assert(await attributeRowCount(client) === before, 'reprocess changed the stored attribute row count');

  console.log(JSON.stringify({
    instanceId: again.id,
    columns: again.columnMappings.length,
    order,
    runs: again.runs,
    result: again.resultSummary,
  }, null, 2));
  console.log('Import instance queue verified.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
