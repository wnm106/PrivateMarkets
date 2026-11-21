/**
 * Database test for workflow notices: a form or a screen that opens, comes
 * back, or passes its due date tells the people who can act on it, and a
 * finished one is no longer news. See supabase/migrations/20261121150000_workflow_step_notices.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/workflow-notices.ts
 *
 * The checks are in workflow-notices.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'workflow-notices.sql'), 'utf8'));
    console.log('Workflow notices: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Workflow notices failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
