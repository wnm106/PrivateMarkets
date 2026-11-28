#!/usr/bin/env node
/**
 * Fast guardrail check on what changed. No database needed, so agent hooks
 * and pull requests can run it on every change.
 *
 *   node scripts/guard/check-static.mjs                 # changes since origin/master (or HEAD), plus uncommitted and untracked
 *   node scripts/guard/check-static.mjs --base <ref>    # changes since <ref>
 *
 * Rules (docs/GUARDRAILS.md):
 *   1. A database function names no client, entity or rule by code. Client
 *      differences live in data: thresholds, rule metadata, client flags.
 *   2. Application code does not decide behaviour by comparing a rule code or
 *      client code to a literal.
 *   3. A migration changes schema and functions. Records (entities, attribute
 *      values, relationships) belong in supabase/seed. A migration that must
 *      move data says why with a line: -- guard: data-migration <reason>
 *   4. An applied migration is never edited. Add a new one.
 * The database check (check-db.ts) is the complete version of rule 1.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
// --hook: run as a Claude Code Stop hook. Problems block the agent from
// finishing (exit 2, shown to the agent) the first time; if it stops again
// with problems left, they are reported to the person instead of looping.
const asHook = args.includes('--hook');
let hookRetry = false;
if (asHook) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    hookRetry = Boolean(input.stop_hook_active);
  } catch { /* no input */ }
}

function git(...argv) {
  return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function tryGit(...argv) {
  try { return git(...argv); } catch { return null; }
}

const base = baseArg
  || tryGit('merge-base', 'HEAD', 'origin/master')
  || tryGit('merge-base', 'HEAD', 'origin/main')
  || 'HEAD';

/** path -> status (A added, M modified) for committed, staged, unstaged and untracked changes since base. */
const changed = new Map();
for (const line of (tryGit('diff', '--name-status', '--no-renames', base) || '').split('\n')) {
  const [status, path] = line.split('\t');
  if (path && status !== 'D') changed.set(path, status[0]);
}
for (const path of (tryGit('ls-files', '--others', '--exclude-standard') || '').split('\n')) {
  if (path) changed.set(path, 'A');
}

/** Lines added since base for one file (all lines for a new file). */
function addedLines(path, status) {
  if (status === 'A' || tryGit('cat-file', '-e', `${base}:${path}`) === null) {
    return readFileSync(path, 'utf8').split('\n').map((text, index) => ({ line: index + 1, text }));
  }
  const diff = tryGit('diff', '-U0', base, '--', path) || '';
  const out = [];
  let next = 0;
  for (const row of diff.split('\n')) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (row.startsWith('+') && !row.startsWith('+++')) { out.push({ line: next, text: row.slice(1) }); next += 1; }
    else if (!row.startsWith('-')) next += 1;
  }
  return out;
}

const problems = [];
const report = (path, line, message) => problems.push(`${path}:${line}  ${message}`);

/** Each function body in a SQL file, with the line it starts on. */
function functionBodies(sql) {
  const bodies = [];
  const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*?\bAS\s+(\$[A-Za-z_]*\$)/gi;
  let match;
  while ((match = head.exec(sql))) {
    const tag = match[1];
    const start = match.index + match[0].length;
    const end = sql.indexOf(tag, start);
    if (end < 0) break;
    bodies.push({ text: sql.slice(start, end), line: sql.slice(0, start).split('\n').length });
    head.lastIndex = end + tag.length;
  }
  return bodies;
}

const ENTITY_CODE = /'([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)'/g;
// A to_char or to_date pattern such as 'YYYY-MM-DD' reads like a code but names nothing.
const DATE_FORMAT = /^(?:YYYY|IYYY|YY|MM|MON|MONTH|DD|DY|HH24|HH12|HH|MI|SS|Q|IW|WW)(?:-(?:YYYY|IYYY|YY|MM|MON|MONTH|DD|DY|HH24|HH12|HH|MI|SS|Q|IW|WW))+$/;
const CODE_COMPARE = /\b(client_code|rule_code|entity_code)\s*(?:=|<>|!=|IN\s*\()\s*'/i;
const DATA_TABLES = /\b(INSERT\s+INTO|UPDATE)\s+(entity_instances\.master_entities|golden_master\.entity_attribute_values|entity_instances\.entity_relationships)\b/i;

for (const [path, status] of changed) {
  if (!existsSync(path)) continue;

  if (/^supabase\/migrations\/[^/]+\.sql$/.test(path)) {
    const sql = readFileSync(path, 'utf8');
    if (status !== 'A' && tryGit('cat-file', '-e', `${base}:${path}`) !== null) {
      report(path, 1, 'An applied migration was edited. Put the change in a new migration.');
      continue;
    }
    for (const body of functionBodies(sql)) {
      body.text.split('\n').forEach((text, offset) => {
        const line = body.line + offset;
        if (/^\s*--/.test(text)) return;
        if (CODE_COMPARE.test(text)) report(path, line, 'A function compares a client, rule or entity code to a literal. Decide from data (a flag, rule metadata, a threshold) or take the id as an argument.');
        for (const found of text.matchAll(ENTITY_CODE)) if (!DATE_FORMAT.test(found[1])) report(path, line, `A function names the record ${found[1]}. Pass ids in, or find the record by a flag.`);
      });
    }
    // Statements outside function bodies: a function that writes records at run time is fine.
    let outside = sql;
    for (const body of functionBodies(sql)) outside = outside.replace(body.text, body.text.replace(/[^\n]/g, ' '));
    if (DATA_TABLES.test(outside) && !/--\s*guard:\s*data-migration\s+\S/.test(sql)) {
      const line = outside.split('\n').findIndex((text) => DATA_TABLES.test(text)) + 1;
      report(path, line, 'A migration writes records. Sample and client data go in supabase/seed. If this data move is needed, add: -- guard: data-migration <reason>');
    }
    continue;
  }

  if (/^(apps|packages|surfaces)\/.+\.(ts|tsx|mjs|js)$/.test(path) && !/\.test\.|\/__tests__\/|node_modules|\.d\.ts$/.test(path)) {
    for (const { line, text } of addedLines(path, status)) {
      if (/^\s*(\/\/|\*)/.test(text)) continue;
      if (/\b(rule_?code|ruleCode|client_?code|clientCode)\s*(===|!==|==|!=)\s*['"`]/.test(text)
        || /\.(eq|neq)\(\s*['"](rule_code|client_code)['"]\s*,\s*['"`]/.test(text)
        || /\.in\(\s*['"](rule_code|client_code)['"]/.test(text)) {
        report(path, line, 'Behaviour keyed to a rule or client code. Read it from the rule (metadata, version) or the client record instead.');
      }
      // A prefix, suffix or substring test on a code is the same thing: entity_code.startsWith('BENCH-').
      if (/\b(rule_?code|ruleCode|client_?code|clientCode|entity_?code|entityCode)\)?\s*\.\s*(startsWith|endsWith|includes)\(\s*['"`]/.test(text)) {
        report(path, line, 'Behaviour keyed to part of a rule, client or record code. Decide from a flag or metadata on the record instead.');
      }
    }
  }
}

// 5. Direct reads of the entity attribute tables (docs/PROVISIONAL_RECORDS.md).
//    scripts/guard/direct-reads.txt lists the ones not yet on the shared
//    readers. It only shrinks: no new line, no new unlisted read, and no line
//    that no longer matches. npm run guard:db checks its db lines.
const DIRECT_READS = 'scripts/guard/direct-reads.txt';
const DIRECT_READ = /\.from\(\s*['"`](entity_attribute_values|entity_relationships|master_entities)['"`]\s*\)\s*\.select\(/g;
const isAppCode = (path) => /^(apps|packages|surfaces)\/.+\.(ts|tsx|mjs|js)$/.test(path) && !/\.test\.|\/__tests__\/|node_modules|\.d\.ts$/.test(path);
const isListLine = (text) => /^\s*(db|ts)\s+\S+\s+\S+\s*$/.test(text);
if (existsSync(DIRECT_READS)) {
  const listLines = readFileSync(DIRECT_READS, 'utf8').split(/\r?\n/);
  const listedTs = new Map();
  listLines.forEach((text, index) => {
    const [kind, path, table] = text.trim().split(/\s+/);
    if (kind === 'ts') listedTs.set(`${path} ${table}`, index + 1);
  });
  if (changed.has(DIRECT_READS) && tryGit('cat-file', '-e', `${base}:${DIRECT_READS}`) !== null) {
    for (const { line, text } of addedLines(DIRECT_READS, changed.get(DIRECT_READS))) {
      if (isListLine(text)) report(DIRECT_READS, line, 'A direct read was added to the list. The list only shrinks: read through the shared readers instead.');
    }
  }
  const readsIn = (path) => {
    const text = readFileSync(path, 'utf8');
    return [...text.matchAll(DIRECT_READ)].map((found) => ({ table: found[1], line: text.slice(0, found.index).split('\n').length }));
  };
  for (const [path] of changed) {
    if (!existsSync(path) || !isAppCode(path)) continue;
    for (const { table, line } of readsIn(path)) {
      if (!listedTs.has(`${path} ${table}`)) report(path, line, `Reads ${table} directly. Read it through the shared readers (docs/PROVISIONAL_RECORDS.md) so provisional scopes can see it.`);
    }
  }
  for (const [key, line] of listedTs) {
    const [path, table] = key.split(' ');
    if (!existsSync(path) || !readsIn(path).some((found) => found.table === table)) {
      report(DIRECT_READS, line, `"ts ${key}" no longer matches a direct read; remove the line.`);
    }
  }
}

if (problems.length) {
  console.error(`Guardrails: ${problems.length} problem(s) since ${base.slice(0, 12)}. See docs/GUARDRAILS.md.\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  if (asHook && hookRetry) {
    console.error('\nThe agent is stopping with these left. Fix them or explain them in the pull request.');
    process.exit(1);
  }
  process.exit(2);
}
console.log(`Guardrails: no problems in ${changed.size} changed file(s) since ${base.slice(0, 12)}.`);
