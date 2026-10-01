#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY: start a local Supabase-equivalent stack in Docker
# (Postgres, GoTrue auth, PostgREST, Storage API) plus the small API gateway.
# Uses the same images Supabase runs. Not used in staging/production.
set -euo pipefail
SECRET=super-secret-jwt-token-with-at-least-32-characters-long
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker info >/dev/null 2>&1 || { (dockerd >/tmp/dockerd.log 2>&1 &); for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; }
docker network create pp >/dev/null 2>&1 || true

if ! docker ps -a --format '{{.Names}}' | grep -q '^pp-db$'; then
  docker run -d --name pp-db --network pp -p 54322:5432 -e POSTGRES_PASSWORD=postgres \
    -e JWT_SECRET=$SECRET -e JWT_EXP=3600 supabase/postgres:15.8.1.060 >/dev/null
fi
docker start pp-db >/dev/null
for i in $(seq 1 60); do PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 2; done
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U supabase_admin -d postgres -q -c \
  "alter user authenticator with password 'postgres'; alter user supabase_auth_admin with password 'postgres'; alter user supabase_storage_admin with password 'postgres';"

ANON=$(grep '^SUPABASE_ANON_KEY=' "$ROOT/.env.local" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$ANON" ]; then node "$ROOT/scripts/local/keys.mjs"; ANON=$(grep '^SUPABASE_ANON_KEY=' "$ROOT/.env.local" | cut -d= -f2); fi
SERVICE=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ROOT/.env.local" | cut -d= -f2)

if ! docker ps -a --format '{{.Names}}' | grep -q '^pp-auth$'; then
  docker run -d --name pp-auth --network pp -p 9999:9999 \
    -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:54321 \
    -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:postgres@pp-db:5432/postgres" \
    -e GOTRUE_SITE_URL=http://localhost:3000 -e GOTRUE_DISABLE_SIGNUP=true \
    -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
    -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_SECRET=$SECRET \
    -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_SMTP_ADMIN_EMAIL=admin@example.com \
    supabase/gotrue:v2.164.0 >/dev/null
fi
if ! docker ps -a --format '{{.Names}}' | grep -q '^pp-rest$'; then
  docker run -d --name pp-rest --network pp -p 3001:3000 \
    -e PGRST_DB_URI="postgres://authenticator:postgres@pp-db:5432/postgres" -e PGRST_DB_SCHEMAS=public,graphql_public \
    -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=$SECRET postgrest/postgrest:v12.2.3 >/dev/null
fi
if ! docker ps -a --format '{{.Names}}' | grep -q '^pp-storage$'; then
  docker run -d --name pp-storage --network pp -p 5000:5000 \
    -e ANON_KEY=$ANON -e SERVICE_KEY=$SERVICE -e AUTH_JWT_SECRET=$SECRET -e PGRST_JWT_SECRET=$SECRET \
    -e POSTGREST_URL=http://pp-rest:3000 -e DATABASE_URL="postgres://supabase_storage_admin:postgres@pp-db:5432/postgres" \
    -e FILE_SIZE_LIMIT=52428800 -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
    -e TENANT_ID=stub -e REGION=local -e GLOBAL_S3_BUCKET=stub -e ENABLE_IMAGE_TRANSFORMATION=false \
    supabase/storage-api:v1.11.13 >/dev/null
fi
docker start pp-auth pp-rest pp-storage >/dev/null
pgrep -f scripts/local/gateway.mjs >/dev/null || (nohup node "$ROOT/scripts/local/gateway.mjs" >/tmp/pp-gateway.log 2>&1 &)
sleep 4
curl -sf http://127.0.0.1:54321/auth/v1/health >/dev/null && echo "auth ok"
curl -sf -o /dev/null http://127.0.0.1:3001/ && echo "rest ok"
curl -sf -o /dev/null http://127.0.0.1:5000/status && echo "storage ok" || echo "storage not ready yet"
