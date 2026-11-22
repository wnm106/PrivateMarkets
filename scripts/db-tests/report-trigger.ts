/**
 * Database test for the report trigger: a stored file read as a filed report
 * records one event, and a REPORT trigger that fits starts one run given that
 * file as importInstanceId. See supabase/migrations/20261122110000_report_trigger.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/report-trigger.ts
 *
 * The checks are in report-trigger.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'report-trigger.sql'), 'utf8'));
    console.log('Report trigger: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Report trigger failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
