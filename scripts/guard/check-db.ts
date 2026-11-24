/**
 * Guardrail checks against a database built from supabase/migrations.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/guard/check-db.ts
 *
 * 1. No database function names a rule, client or entity by its code
 *    (hardcodes.sql). scripts/guard/allowlist.json holds the exceptions, each
 *    with a reason:
 *      [{ "kind": "rule", "function": "compliance.example", "code": "SOME_RULE", "reason": "..." }]
 *    Keep it empty.
 * 2. Provisional rows are read only where docs/PROVISIONAL_RECORDS.md says
 *    (provisional.sql). A function that names a provisional table or column is
 *    listed in provisional-readers.json with a reason, and a function that
 *    takes p_scope defaults it to null and passes it through
 *    entity_instances.scope_for_caller.
 * 3. Every function that reads the entity attribute tables directly is listed
 *    as a db line in direct-reads.txt (direct-reads.sql). That list only
 *    shrinks; npm run guard refuses new lines.
 *
 * 4. No record exists without a parent its entity type requires
 *    (required-parents.sql). The application refuses to create one; this
 *    catches a migration or a seed, which write rows directly.
 *
 * An entry in any list that no longer matches fails the check, so no list can
 * go stale.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

interface Finding { kind: string; function_name: string; code: string }
interface Allowed { kind: string; function: string; code: string; reason: string }
interface ProvisionalFinding { kind: string; function_name: string; detail: string }
interface ProvisionalReader { function: string; reason: string }
interface DirectRead { function_name: string; table_name: string }

const dir = join(__dirname);
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

async function hardcodes(db: Client, problems: string[]) {
  const allowed = JSON.parse(read('allowlist.json')) as Allowed[];
  const { rows } = await db.query<Finding>(read('hardcodes.sql'));
  const key = (kind: string, fn: string, code: string) => `${kind}|${fn}|${code}`;
  const allowedKeys = new Set(allowed.map((item) => key(item.kind, item.function, item.code)));
  const found = new Set(rows.map((row) => key(row.kind, row.function_name, row.code)));
  for (const row of rows) {
    if (!allowedKeys.has(key(row.kind, row.function_name, row.code))) problems.push(`${row.function_name} names the ${row.kind} ${row.code}`);
  }
  for (const item of allowed) {
    if (!item.reason) problems.push(`allowlist entry ${item.function} ${item.code} has no reason`);
    if (!found.has(key(item.kind, item.function, item.code))) problems.push(`allowlist entry ${item.function} ${item.code} no longer matches; remove it`);
  }
  return allowed.length;
}

async function provisional(db: Client, problems: string[]) {
  const readers = JSON.parse(read('provisional-readers.json')) as ProvisionalReader[];
  const { rows } = await db.query<ProvisionalFinding>(read('provisional.sql'));
  const listed = new Set(readers.map((item) => item.function));
  const holding = new Set(rows.filter((row) => row.kind === 'held-rows').map((row) => row.function_name));
  for (const row of rows) {
    if (row.kind === 'held-rows' && !listed.has(row.function_name)) {
      problems.push(`${row.function_name} reads provisional rows but is not in provisional-readers.json. Read them through the shared readers, or list it with a reason`);
    }
    if (row.kind === 'scope-arg') {
      problems.push(`${row.function_name}(${row.detail}) takes p_scope but does not default it to null and pass it through entity_instances.scope_for_caller(p_scope)`);
    }
  }
  for (const item of readers) {
    if (!item.reason) problems.push(`provisional-readers.json entry ${item.function} has no reason`);
    if (!holding.has(item.function)) problems.push(`provisional-readers.json entry ${item.function} no longer reads provisional rows; remove it`);
  }
  return readers.length;
}

async function directReads(db: Client, problems: string[]) {
  const listed = new Set(
    read('direct-reads.txt').split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[0] === 'db' && parts.length === 3)
      .map(([, fn, table]) => `${fn} ${table}`),
  );
  const { rows } = await db.query<DirectRead>(read('direct-reads.sql'));
  const found = new Set(rows.map((row) => `${row.function_name} ${row.table_name}`));
  for (const key of found) {
    if (!listed.has(key)) problems.push(`${key.replace(' ', ' reads ')} directly. Read it through the shared readers (docs/PROVISIONAL_RECORDS.md)`);
  }
  for (const key of listed) {
    if (!found.has(key)) problems.push(`direct-reads.txt line "db ${key}" no longer matches; remove it`);
  }
  return found.size;
}

async function requiredParents(db: Client, problems: string[]) {
  const found = (await db.query<{ domain_code: string; entity_code: string; relationship_code: string; required_domain_code: string }>(read('required-parents.sql'))).rows;
  // One line per entity type and missing parent, with a few codes, so 100 rows read as one problem.
  const groups = new Map<string, string[]>();
  for (const row of found) {
    const key = `${row.domain_code} without ${row.required_domain_code} (${row.relationship_code})`;
    groups.set(key, [...(groups.get(key) || []), row.entity_code]);
  }
  for (const [key, codes] of groups) {
    problems.push(`${codes.length} ${key}: ${codes.slice(0, 5).join(', ')}${codes.length > 5 ? ', ...' : ''}. Link each to its parent in the migration or seed that creates it`);
  }
  return found.length;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to a database built from supabase/migrations.');
  const db = new Client({ connectionString: url });
  await db.connect();
  const problems: string[] = [];
  let counts: number[];
  try {
    counts = [await hardcodes(db, problems), await provisional(db, problems), await directReads(db, problems), await requiredParents(db, problems)];
  } finally {
    await db.end();
  }
  if (problems.length) {
    console.error(`Guardrails (database): ${problems.length} problem(s). See docs/GUARDRAILS.md.\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(2);
  }
  console.log(`Guardrails (database): no function names a rule, client or entity by code (${counts[0]} allowed); provisional rows are read only by the ${counts[1]} listed reader(s); ${counts[2]} direct read(s) left to move onto the shared readers; no record is missing a parent its entity type requires.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
