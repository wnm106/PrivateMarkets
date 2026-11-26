/**
 * Database test for compliance rules as known: a run at a Knowledge date reads
 * the rule, its fund limits and its scope as known then. See
 * supabase/migrations/20261126100000_compliance_rules_as_known.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/compliance-as-known.ts
 *
 * The checks are in compliance-as-known.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'compliance-as-known.sql'), 'utf8'));
    console.log('Compliance as known: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Compliance as known failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
