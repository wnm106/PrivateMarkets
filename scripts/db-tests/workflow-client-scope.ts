/**
 * Database test for workflow client scope: staff see and act on the workflows,
 * runs and reviews of the client they are working in, not every client. See
 * supabase/migrations/20261123130000_workflow_scope_to_open_client.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/workflow-client-scope.ts
 *
 * The checks are in workflow-client-scope.sql, inside a transaction that is rolled back.
 * Exits non-zero on any failure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL');
  const client = new Client({ connectionString: url });
  client.on('notice', (notice) => console.log(`${notice.severity}: ${notice.message}`));
  await client.connect();
  try {
    await client.query(readFileSync(join(__dirname, 'workflow-client-scope.sql'), 'utf8'));
    console.log('Workflow client scope: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Workflow client scope failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
