/**
 * Guardrail check against a database built from supabase/migrations: no
 * database function names a rule, client or entity by its code.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/guard/check-db.ts
 *
 * scripts/guard/allowlist.json holds the exceptions, each with a reason:
 *   [{ "kind": "rule", "function": "compliance.example", "code": "SOME_RULE", "reason": "..." }]
 * Keep it empty. An entry that no longer matches fails the check, so the list
 * cannot go stale.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

interface Finding { kind: string; function_name: string; code: string }
interface Allowed { kind: string; function: string; code: string; reason: string }

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to a database built from supabase/migrations.');
  const dir = join(__dirname);
  const sql = readFileSync(join(dir, 'hardcodes.sql'), 'utf8');
  const allowed = JSON.parse(readFileSync(join(dir, 'allowlist.json'), 'utf8')) as Allowed[];
  const db = new Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query<Finding>(sql);
  await db.end();

  const key = (kind: string, fn: string, code: string) => `${kind}|${fn}|${code}`;
  const allowedKeys = new Set(allowed.map((item) => key(item.kind, item.function, item.code)));
  const found = new Set(rows.map((row) => key(row.kind, row.function_name, row.code)));
  const problems = rows.filter((row) => !allowedKeys.has(key(row.kind, row.function_name, row.code)))
    .map((row) => `${row.function_name} names the ${row.kind} ${row.code}`);
  for (const item of allowed) {
    if (!item.reason) problems.push(`allowlist entry ${item.function} ${item.code} has no reason`);
    if (!found.has(key(item.kind, item.function, item.code))) problems.push(`allowlist entry ${item.function} ${item.code} no longer matches; remove it`);
  }
  if (problems.length) {
    console.error(`Guardrails (database): ${problems.length} problem(s). See docs/GUARDRAILS.md.\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(2);
  }
  console.log(`Guardrails (database): no function names a rule, client or entity by code (${allowed.length} allowed).`);
}

main().catch((error) => { console.error(error); process.exit(1); });
