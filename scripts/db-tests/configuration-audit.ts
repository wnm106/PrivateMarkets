/**
 * Database test for the configuration audit: changes are recorded against the
 * right client, without secrets or bookkeeping, and read only by those who may. See
 * supabase/migrations/20261125100000_configuration_audit.sql.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/configuration-audit.ts
 *
 * The checks are in configuration-audit.sql, inside a transaction that is rolled back.
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
    await client.query(readFileSync(join(__dirname, 'configuration-audit.sql'), 'utf8'));
    console.log('Configuration audit: every check passed.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Configuration audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
