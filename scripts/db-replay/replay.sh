#!/usr/bin/env bash
# Build a database from supabase/migrations on plain Postgres, the way a fresh
# project would get it, and fail if a migration does not apply.
#
#   DATABASE_URL=postgres://postgres@localhost:5432/postgres scripts/db-replay/replay.sh
#
# The database must be empty and the role a superuser, with pgvector available.
# Older migrations that cannot apply in order on a fresh database are listed in
# legacy.txt with how they are applied. Every other migration must apply
# cleanly, in one transaction, with triggers and foreign keys on.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
migrations="$root/supabase/migrations"
seed="$root/supabase/seed/001_seed_data.sql"
logs="${REPLAY_LOGS:-$(mktemp -d)}"
: "${DATABASE_URL:?Set DATABASE_URL}"
psql_run() { psql "$DATABASE_URL" -q -X -v ON_ERROR_STOP=1 "$@"; }
mkdir -p "$logs"

declare -A mode
while read -r file how _; do
  [[ -z "${file:-}" || "$file" == \#* ]] && continue
  mode["$file"]="$how"
done < "$here/legacy.txt"
seed_before="$(awk '$1 == "seed-before" {print $2}' "$here/legacy.txt")"
legacy_client="$(awk '$1 == "legacy-client" {print $2}' "$here/legacy.txt")"

psql_run -f "$here/shim.sql" > "$logs/_shim.log" 2>&1 || { cat "$logs/_shim.log"; exit 1; }
psql_run -c "ALTER DATABASE $(psql "$DATABASE_URL" -AtXc 'select current_database()') SET search_path = public, extensions" > /dev/null

failed=0
seeded=0
for path in $(ls "$migrations"/*.sql | sort); do
  file="$(basename "$path")"
  [[ "$file" == _skip* ]] && continue
  if [[ $seeded == 0 && -n "$seed_before" && ! "$file" < "$seed_before" ]]; then
    # The seed defines attributes that later migrations depend on.
    PGOPTIONS="-c session_replication_role=replica" psql_run -f "$seed" > "$logs/_seed.log" 2>&1 \
      || { echo "SEED failed: $(grep -m1 ERROR "$logs/_seed.log")"; failed=1; }
    seeded=1
  fi
  if [[ -n "$legacy_client" ]]; then
    psql_run -c "DO \$\$ BEGIN IF to_regclass('tenancy.clients') IS NOT NULL THEN
      INSERT INTO tenancy.clients (id, client_code, client_name) VALUES ('$legacy_client', 'LEGACY_SAMPLE', 'Legacy sample client') ON CONFLICT DO NOTHING; END IF; END \$\$" > /dev/null 2>&1
  fi
  how="${mode[$file]:-clean}"
  src="$path"
  if [[ "$how" == views* ]]; then
    sed -E 's/CREATE OR REPLACE VIEW ([A-Za-z_."]+)/DROP VIEW IF EXISTS \1 CASCADE; CREATE VIEW \1/I' "$path" > "$logs/$file.views.sql"
    src="$logs/$file.views.sql"
  fi
  opts=""
  [[ "$how" == *replica* ]] && opts="-c session_replication_role=replica"
  if PGOPTIONS="$opts" psql_run -1 -f "$src" > "$logs/$file.log" 2>&1; then
    psql_run -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${file%%_*}', '$file') ON CONFLICT DO NOTHING" > /dev/null
    [[ "$how" == broken ]] && echo "NOTE  $file now applies; remove it from legacy.txt"
  elif [[ "$how" == broken ]]; then
    echo "skip  $file (listed as broken in legacy.txt): $(grep -m1 ERROR "$logs/$file.log" | cut -c1-160)"
  else
    echo "FAIL  $file: $(grep -m1 ERROR "$logs/$file.log")"
    failed=1
  fi
done

[[ $failed == 0 ]] && echo "Replay complete. Logs in $logs" || echo "Replay failed. Logs in $logs"
exit $failed
