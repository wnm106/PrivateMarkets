#!/usr/bin/env bash
# Database checks: the migration chain applies on a fresh database, and the
# tenant-isolation tests in supabase/tests pass.
#
#   scripts/db-test.sh                 Build a throwaway Postgres cluster, load
#                                      the Supabase stand-ins, apply every
#                                      migration and the seed, then run the tests.
#   scripts/db-test.sh --db-url URL    Run the checks against a database that is
#                                      already built (CI does this after
#                                      `supabase db start` + `supabase db reset`).
#
# Steps, in both modes:
#   1. (local only) supabase/tests/supabase_stub.sql, then every file in
#      supabase/migrations matching ^[0-9]+_.*\.sql$ in name order, each in one
#      transaction together with its supabase_migrations.schema_migrations row
#      (a plain INSERT, as the Supabase CLI writes it), then the seed files
#      listed in supabase/config.toml ([db.seed] sql_paths).
#   2. Every migration version on disk is unique and recorded in
#      supabase_migrations.schema_migrations.
#   3. supabase/tests/fixture.sql (two clients, committed).
#   4. Each supabase/tests/NN_*.sql, each in a transaction that rolls back.
#
# Exits non-zero on the first failing migration or seed, and after the tests
# if any check failed.
#
# Environment (local mode):
#   PG_BIN          Postgres binaries (initdb, pg_ctl). Default: pg_config --bindir,
#                   else the newest /usr/lib/postgresql/*/bin. Needs pgvector.
#   DB_TEST_PORT    Port for the throwaway cluster (127.0.0.1). Default: random.
#   DB_TEST_KEEP=1  Keep the cluster running afterwards and print how to reach it.
#   PG_RUN_AS       Command prefix for initdb/pg_ctl when running as root.
#                   Default as root: unshare --user --map-user=1000 --map-group=1000
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MIGRATIONS="$ROOT/supabase/migrations"
TESTS="$ROOT/supabase/tests"
DB_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --db-url) DB_URL="${2:?--db-url needs a URL}"; shift 2 ;;
    -h|--help) sed -n '2,36p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s\n' "$*"; }
die() { printf 'db-test: %s\n' "$*" >&2; exit 1; }

command -v psql >/dev/null || die "psql is not installed"

# ------------------------------------------------------------------ migration list
mapfile -t MIGRATION_FILES < <(cd "$MIGRATIONS" && LC_ALL=C ls | grep -E '^[0-9]+_.*\.sql$')
[ "${#MIGRATION_FILES[@]}" -gt 0 ] || die "no migrations found in $MIGRATIONS"
DUPLICATES=$(printf '%s\n' "${MIGRATION_FILES[@]}" | sed 's/_.*//' | sort | uniq -d)
# The local build records one row per version, as the Supabase CLI does, so a shared
# version cannot apply there. scripts/db-replay/replay.sh (CI) applies both files.
[ -z "$DUPLICATES" ] || [ -n "$DB_URL" ] || die "migration versions used by more than one file: $(echo $DUPLICATES)"

# Seed files from supabase/config.toml, [db.seed] sql_paths (relative to supabase/).
SEED_FILES=()
while IFS= read -r p; do
  [ -n "$p" ] && SEED_FILES+=("$ROOT/supabase/${p#./}")
done < <(awk '/^\[db\.seed\]/{s=1;next} /^\[/{s=0} s && /^sql_paths/' "$ROOT/supabase/config.toml" \
          | grep -o '"[^"]*"' | tr -d '"')

# ------------------------------------------------------------------ local cluster
WORK=""
PGCTL_PREFIX=()
cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    if [ "${DB_TEST_KEEP:-0}" = "1" ]; then
      log "cluster kept: data $WORK/data, $DB_URL (stop: ${PGCTL_PREFIX[*]} $PG_BIN/pg_ctl -D $WORK/data stop)"
    else
      "${PGCTL_PREFIX[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
      rm -rf "$WORK"
    fi
  fi
}

if [ -z "$DB_URL" ]; then
  if [ -z "${PG_BIN:-}" ]; then
    if command -v pg_config >/dev/null && [ -x "$(pg_config --bindir)/initdb" ]; then
      PG_BIN=$(pg_config --bindir)
    else
      PG_BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
    fi
  fi
  [ -n "${PG_BIN:-}" ] && [ -x "$PG_BIN/initdb" ] || die "initdb not found; set PG_BIN"
  if [ "$(id -u)" = "0" ]; then
    if [ -n "${PG_RUN_AS:-}" ]; then
      read -r -a PGCTL_PREFIX <<< "$PG_RUN_AS"
    else
      PGCTL_PREFIX=(unshare --user --map-user=1000 --map-group=1000)
    fi
  fi
  PORT=${DB_TEST_PORT:-$((54400 + RANDOM % 1000))}
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/db-test.XXXXXX")
  chmod 755 "$WORK"
  trap cleanup EXIT
  log "== throwaway cluster: $("$PG_BIN/postgres" --version), port $PORT, $WORK"
  "${PGCTL_PREFIX[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 \
    >"$WORK/initdb.log" 2>&1 || { cat "$WORK/initdb.log"; die "initdb failed"; }
  cat >>"$WORK/data/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = ''
fsync = off
synchronous_commit = off
full_page_writes = off
shared_buffers = 256MB
work_mem = 32MB
maintenance_work_mem = 256MB
EOF
  "${PGCTL_PREFIX[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -w start >/dev/null \
    || { tail -20 "$WORK/postgres.log"; die "postgres did not start"; }
  DB_URL="postgresql://postgres@127.0.0.1:$PORT/postgres"
fi

PSQL=(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1)

# ------------------------------------------------------------------ 1. build (local only)
if [ -n "$WORK" ]; then
  "${PSQL[@]}" -c 'SELECT 1' >/dev/null || die "cannot connect to $DB_URL"
  "${PSQL[@]}" -f "$TESTS/supabase_stub.sql" >"$WORK/stub.log" 2>&1 || { cat "$WORK/stub.log"; die "Supabase stub failed"; }
  log "== applying ${#MIGRATION_FILES[@]} migrations"
  for f in "${MIGRATION_FILES[@]}"; do
    version=${f%%_*}; name=${f#*_}; name=${name%.sql}
    if ! "${PSQL[@]}" -1 -f "$MIGRATIONS/$f" \
         -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '$name')" \
         >"$WORK/migration.log" 2>&1; then
      log "FAILED: $f"
      grep -E -A4 'ERROR' "$WORK/migration.log" | head -20
      exit 1
    fi
  done
  for s in "${SEED_FILES[@]}"; do
    log "== seed: ${s#$ROOT/}"
    "${PSQL[@]}" -1 -f "$s" >"$WORK/seed.log" 2>&1 || { grep -E -A4 'ERROR' "$WORK/seed.log" | head -20; die "seed failed: $s"; }
  done
fi

# ------------------------------------------------------------------ 2. migration history
log "== migration history"
RECORDED=$("${PSQL[@]}" -At -c 'SELECT version FROM supabase_migrations.schema_migrations') \
  || die "cannot read supabase_migrations.schema_migrations"
# A migration scripts/db-replay/legacy.txt lists as broken may be missing from a replayed database.
BROKEN=$(awk '$2 == "broken" {sub(/_.*/, "", $1); print $1}' "$ROOT/scripts/db-replay/legacy.txt" | tr -d '\r')
MISSING=$(comm -23 <(printf '%s\n' "${MIGRATION_FILES[@]}" | sed 's/_.*//' | sort -u) <(printf '%s\n' "$RECORDED" $BROKEN | sort -u))
[ -z "$MISSING" ] || die "migrations not recorded as applied: $(echo $MISSING)"
log "all ${#MIGRATION_FILES[@]} migration versions recorded"

# ------------------------------------------------------------------ 3. fixture
log "== fixture"
FIXTURE_LOG=$(mktemp "${TMPDIR:-/tmp}/db-test-fixture.XXXXXX")
if ! "${PSQL[@]}" -f "$TESTS/fixture.sql" >"$FIXTURE_LOG" 2>&1; then
  grep -E -A4 'ERROR' "$FIXTURE_LOG" | head -20; rm -f "$FIXTURE_LOG"; die "fixture failed"
fi
rm -f "$FIXTURE_LOG"

# ------------------------------------------------------------------ 4. tests
log "== tests"
total_pass=0; total_fail=0; failed_files=()
for t in "$TESTS"/[0-9][0-9]_*.sql; do
  out=$("${PSQL[@]}" -f "$t" 2>&1) && status=0 || status=$?
  pass=$(printf '%s\n' "$out" | grep -c 'NOTICE:  PASS ' || true)
  fail=$(printf '%s\n' "$out" | grep -c 'WARNING:  FAIL ' || true)
  total_pass=$((total_pass + pass)); total_fail=$((total_fail + fail))
  if [ "$status" -ne 0 ]; then
    failed_files+=("$(basename "$t")")
    log "FAIL $(basename "$t"): $pass passed, $fail failed"
    printf '%s\n' "$out" | grep -E 'FAIL |ERROR' | sed 's/^psql:[^ ]* //' | head -40
  else
    log "ok   $(basename "$t"): $pass passed"
  fi
done

log "== $total_pass checks passed, $total_fail failed, ${#failed_files[@]} test file(s) failed"
[ "${#failed_files[@]}" -eq 0 ] || exit 1
