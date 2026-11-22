/**
 * Database test for provisional scopes: entity_instances.scope_for_caller hands a
 * scope only to who may read it, and only while it is open, and a held record must
 * say what it is assumed to be. See supabase/migrations/20261122180000_provisional_scopes.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/provisional-scopes.ts
 *
 * The checks are in provisional-scopes.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'provisional-scopes.sql'), 'utf8'));
    console.log('Provisional scopes: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Provisional scopes failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
