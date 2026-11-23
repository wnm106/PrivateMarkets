/**
 * Database test for data quality rules: an expression describes the exception,
 * a record fails when it meets every condition of a group, and a blank value
 * meets no condition about its value. See supabase/migrations/20261122210000_dq_rules_describe_exceptions.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/dq-exception-rules.ts
 *
 * The checks are in dq-exception-rules.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'dq-exception-rules.sql'), 'utf8'));
    console.log('DQ exception rules: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`DQ exception rules failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
