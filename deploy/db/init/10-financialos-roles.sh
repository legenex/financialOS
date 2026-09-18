#!/usr/bin/env bash
# PostgreSQL first-start initialisation for FinancialOS (runs from /docker-entrypoint-initdb.d as the postgres user).
#
# Creates, idempotently:
#   * role fos_migrator  LOGIN, owner of the application database (runs migrations; not a superuser)
#   * role fos_app       LOGIN (API server)
#   * role fos_worker    LOGIN (background jobs)
#   * role fos_backup    LOGIN, read-only by default (pg_dump for backups; table grants come from the migrations)
#   * database $FOS_DB_NAME (default financialos), UTF-8, owned by fos_migrator, no PUBLIC access
#
# Passwords are read from secret files (/run/secrets/db-<role>-password) with psql backquote expansion, so
# they never appear in process arguments or logs. Table privileges are granted by the migrations.
set -euo pipefail

db_name="${FOS_DB_NAME:-financialos}"
secrets_dir="${FOS_DB_SECRETS_DIR:-/run/secrets}"

if ! [[ "$db_name" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "financialos-init: invalid database name" >&2
  exit 1
fi
for role in migrator app worker backup; do
  file="$secrets_dir/db-$role-password"
  if [ ! -s "$file" ]; then
    echo "financialos-init: missing secret file $file" >&2
    exit 1
  fi
  if grep -q "'" "$file"; then
    echo "financialos-init: $file must not contain quote characters" >&2
    exit 1
  fi
done

echo "financialos-init: creating roles and database $db_name"
psql -v ON_ERROR_STOP=1 --no-psqlrc --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v db_name="$db_name" -v secrets_dir="$secrets_dir" <<'SQL'
SET log_statement = 'none';
SET password_encryption = 'scram-sha-256';
\set migrator_file :secrets_dir '/db-migrator-password'
\set app_file :secrets_dir '/db-app-password'
\set worker_file :secrets_dir '/db-worker-password'
\set backup_file :secrets_dir '/db-backup-password'
\set migrator_pw `tr -d '\r\n' < :'migrator_file'`
\set app_pw `tr -d '\r\n' < :'app_file'`
\set worker_pw `tr -d '\r\n' < :'worker_file'`
\set backup_pw `tr -d '\r\n' < :'backup_file'`

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s PASSWORD %L',
              r.name, r.conn_limit, r.pw)
FROM (VALUES ('fos_migrator', 5, :'migrator_pw'),
             ('fos_app', 15, :'app_pw'),
             ('fos_worker', 12, :'worker_pw'),
             ('fos_backup', 3, :'backup_pw')) AS r(name, conn_limit, pw)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) \gexec

SELECT format('ALTER ROLE %I PASSWORD %L', r.name, r.pw)
FROM (VALUES ('fos_migrator', :'migrator_pw'), ('fos_app', :'app_pw'),
             ('fos_worker', :'worker_pw'), ('fos_backup', :'backup_pw')) AS r(name, pw) \gexec
ALTER ROLE fos_backup SET default_transaction_read_only = on;

SELECT format('CREATE DATABASE %I OWNER fos_migrator TEMPLATE template0 ENCODING %L', :'db_name', 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec

SELECT format('ALTER DATABASE %I OWNER TO fos_migrator', :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO fos_app, fos_worker', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO fos_backup', :'db_name') \gexec
SELECT format('ALTER DATABASE %I SET timezone TO %L', :'db_name', 'UTC') \gexec
SQL

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "${POSTGRES_USER:-postgres}" --dbname "$db_name" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO fos_migrator;
GRANT USAGE ON SCHEMA public TO fos_app, fos_worker, fos_backup;
SQL

echo "financialos-init: done"
