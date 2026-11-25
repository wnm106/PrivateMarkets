/**
 * Database test for license switches: one surface, workflow, page or assistant
 * tool group turned on or off for one client, over its modules. See
 * supabase/migrations/20261125100000_client_license_switches.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/license-switches.ts
 *
 * The checks are in license-switches.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'license-switches.sql'), 'utf8'));
    console.log('License switches: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`License switches failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
