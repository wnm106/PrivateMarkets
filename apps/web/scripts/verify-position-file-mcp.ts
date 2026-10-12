import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerPositionFileTools } from '@tapestrai/mcp-server/src/tools/position-file-tools';

config({ path: resolve(__dirname, '../.env.local') });

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Pass the position file csv path');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const registry = new ToolRegistry(supabase);
  registerPositionFileTools(registry);
  const names = registry.listTools().map((tool: { name: string }) => tool.name);
  for (const name of [
    'list_position_file_imports',
    'list_position_file_mapping_targets',
    'create_position_file_import',
    'get_position_file_import',
    'update_position_file_import',
    'process_position_file_import',
  ]) {
    assert(names.includes(name), `missing MCP tool ${name}`);
  }

  const remote = createClient('https://example.com', 'remote-key', { auth: { persistSession: false, autoRefreshToken: false } });
  const remoteRegistry = new ToolRegistry(remote);
  registerPositionFileTools(remoteRegistry);
  let refused = false;
  try {
    await remoteRegistry.executeTool('list_position_file_imports', {});
  } catch (error: any) {
    refused = String(error.message).includes('local database');
  }
  assert(refused, 'a non-local Supabase client was allowed to list imports');

  const listed = await registry.executeTool('list_position_file_imports', {});
  assert(listed.sourceCode === 'POSITION_FILE' && Array.isArray(listed.instances), 'queue list missing');

  const targets = await registry.executeTool('list_position_file_mapping_targets', {});
  assert(targets.targets.some((target: { key: string }) => target.key === 'attribute:ISSUER:INDUSTRY'), 'issuer industry target missing');
  assert(targets.targets.some((target: { key: string }) => target.key === 'attribute:FUND:INDUSTRY'), 'fund industry target missing');

  const created = await registry.executeTool('create_position_file_import', {
    fileName: 'Position_FIle.csv',
    contentBase64: readFileSync(csvPath).toString('base64'),
  });
  assert(created.columnMappings.length === 42, `expected 42 columns, got ${created.columnMappings.length}`);
  assert(created.status === 'READY', created.status);
  const rating = created.columnMappings.find((column: { sourceColumn: string }) => column.sourceColumn === 'issuer credit rating');
  assert(rating?.attributeCode === 'CREDIT_RATING' && rating.transform.kind === 'list', 'credit rating suggestion');

  const industry = created.columnMappings.find((column: { sourceColumn: string }) => column.sourceColumn === 'issuer industry');
  const fundTarget = targets.targets.find((target: { key: string }) => target.key === 'attribute:FUND:INDUSTRY');
  const edited = created.columnMappings.map((column: { sourceColumn: string }) => column.sourceColumn === 'issuer industry'
    ? { ...column, role: 'attribute', domainCode: 'FUND', attributeCode: 'INDUSTRY', parentDomainCode: null, transform: { kind: 'uppercase' }, suggestion: { method: 'manual', confidence: 1, reason: 'Chosen manually' } }
    : column);
  assert(fundTarget, 'fund target required for the edit');
  const saved = await registry.executeTool('update_position_file_import', {
    instanceId: created.id,
    asOfDate: '2026-09-30',
    columnMappings: edited,
  });
  const savedIndustry = saved.columnMappings.find((column: { sourceColumn: string }) => column.sourceColumn === 'issuer industry');
  assert(savedIndustry.domainCode === 'FUND' && savedIndustry.transform.kind === 'uppercase', 'mapping was not saved');

  const restoredMappings = saved.columnMappings.map((column: { sourceColumn: string }) => column.sourceColumn === 'issuer industry' ? industry : column);
  const processed = await registry.executeTool('process_position_file_import', {
    instanceId: created.id,
    asOfDate: '2026-09-30',
    columnMappings: restoredMappings,
  });
  assert(processed.status === 'SUCCEEDED', processed.errorMessage || processed.status);
  assert(processed.resultSummary.created === 0 && processed.resultSummary.matched === 56, JSON.stringify(processed.resultSummary));
  assert(processed.resultSummary.attributesCreated === 0, `created ${processed.resultSummary.attributesCreated} attribute rows`);

  const again = await registry.executeTool('process_position_file_import', { instanceId: created.id });
  assert(again.status === 'SUCCEEDED' && again.resultSummary.attributesCreated === 0 && again.resultSummary.attributesUpdated === 0, JSON.stringify(again.resultSummary));
  assert(again.runs.length === 2, `expected 2 runs, got ${again.runs.length}`);

  console.log(JSON.stringify({ instanceId: again.id, tools: names, result: again.resultSummary }, null, 2));
  console.log('Position file MCP tools verified.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
