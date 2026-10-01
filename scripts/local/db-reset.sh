#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY. Drops the application schemas in the local Supabase
# Postgres container and re-applies every migration in order.
# Refuses to run against anything that is not localhost.
set -euo pipefail

DB_URL="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) echo "Refusing to reset a non-local database: $DB_URL" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop schema if exists app cascade;
drop schema if exists public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres;
-- Re-create Supabase's (permissive) default privileges so that our migrations
-- are tested against the same starting point as a hosted Supabase project.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges grant execute on functions to public;
-- Local test users live in auth.users; profiles are recreated by the seed.
delete from auth.users;
SQL

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done

# PostgREST caches the schema; ask it to reload.
psql "$DB_URL" -q -c "notify pgrst, 'reload schema';"
echo "database reset complete"
