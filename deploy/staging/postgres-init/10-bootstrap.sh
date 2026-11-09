#!/bin/sh
set -eu

for name in \
  GOTRUE_DB_PASSWORD \
  MIGRATOR_DATABASE_PASSWORD \
  R23_GATEWAY_PASSWORD \
  CANDIDATE_GATEWAY_PASSWORD \
  APP_EVALUATOR_PASSWORD \
  CONTROL_WORKER_PASSWORD
do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf '%s\n' "Missing required PostgreSQL bootstrap variable: $name" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v gotrue_password="$GOTRUE_DB_PASSWORD" \
  -f /opt/hirearchy/bootstrap-auth.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /opt/hirearchy/bootstrap-roles.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /opt/hirearchy/bootstrap-internal-roles.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /opt/hirearchy/bootstrap-verifier.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$MIGRATOR_DATABASE_PASSWORD" \
  -v gateway_password="$R23_GATEWAY_PASSWORD" \
  -v candidate_password="$CANDIDATE_GATEWAY_PASSWORD" \
  -v evaluator_password="$APP_EVALUATOR_PASSWORD" \
  -v control_password="$CONTROL_WORKER_PASSWORD" \
  -f /opt/hirearchy/bootstrap-passwords.sql
