-- Hand-written: least-privilege grants for the runtime roles.
--
-- The migrator role (fos_migrator in deployments) owns every object and runs this.
-- Roles are created by the deploy scripts with passwords; a role that does not exist is
-- skipped, so this is a no-op on a database without them. `migrate` calls
-- financialos_apply_grants() again after every run (and after pg-boss installs its
-- schema), so objects added later and roles created later are covered.
--
--   app    : SELECT/INSERT/UPDATE on application tables, DELETE only where the API
--            legitimately deletes, INSERT/SELECT only on audit_events, no DDL.
--   worker : like app, but no access at all to owner authentication and device tables.
--   backup : read-only (pg_dump), plus default privileges for future tables.
--   pgboss : app and worker get DML on the pg-boss schema; pg-boss itself is installed
--            by the migrator during `migrate` (boss.start() with migrate: true).
CREATE OR REPLACE FUNCTION financialos_apply_grants(
  app_role text DEFAULT 'fos_app',
  worker_role text DEFAULT 'fos_worker',
  backup_role text DEFAULT 'fos_backup'
) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  t text;
  applied text[] := ARRAY[]::text[];
  has_pgboss boolean := EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss');
  has_drizzle boolean := EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle');
  append_only text[] := ARRAY['audit_events'];
  app_delete text[] := ARRAY[
    'sessions', 'webauthn_challenges', 'recovery_codes', 'login_throttle', 'launch_requests',
    'device_pairings', 'oauth_states', 'oauth_tokens', 'connection_secrets', 'import_templates',
    'outbound_allowlist', 'budget_lines', 'source_record_tags'
  ];
  worker_denied text[] := ARRAY[
    'sessions', 'webauthn_credentials', 'webauthn_challenges', 'recovery_codes', 'owner_account',
    'setup_state', 'devices', 'device_pairings', 'login_throttle', 'launch_requests', 'agent_clients'
  ];
  worker_delete text[] := ARRAY[
    'oauth_states', 'import_rows', 'notifications', 'job_records', 'sync_runs', 'worker_heartbeats'
  ];
  runtime_role text;
BEGIN
  -- Runtime roles (app, worker) ------------------------------------------------------
  FOREACH runtime_role IN ARRAY ARRAY[app_role, worker_role] LOOP
    CONTINUE WHEN runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role);

    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', runtime_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', runtime_role);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', runtime_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);

    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
      IF runtime_role = worker_role AND t = ANY (worker_denied) THEN
        CONTINUE;
      END IF;
      IF t = ANY (append_only) THEN
        EXECUTE format('GRANT SELECT, INSERT ON public.%I TO %I', t, runtime_role);
        CONTINUE;
      END IF;
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO %I', t, runtime_role);
      IF (runtime_role = app_role AND t = ANY (app_delete))
         OR (runtime_role = worker_role AND t = ANY (worker_delete)) THEN
        EXECUTE format('GRANT DELETE ON public.%I TO %I', t, runtime_role);
      END IF;
    END LOOP;

    -- Sequences (audit_events.id). Worker needs them too because it appends audit events.
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', runtime_role);

    IF has_drizzle THEN
      EXECUTE format('GRANT USAGE ON SCHEMA drizzle TO %I', runtime_role);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO %I', runtime_role);
    END IF;

    IF has_pgboss THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA pgboss FROM %I', runtime_role);
      EXECUTE format('GRANT USAGE ON SCHEMA pgboss TO %I', runtime_role);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO %I', runtime_role);
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO %I', runtime_role);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO %I', runtime_role);
    END IF;

    applied := applied || runtime_role;
  END LOOP;

  -- Backup role (read-only) -----------------------------------------------------------
  IF backup_role IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = backup_role) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', backup_role);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', backup_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', backup_role);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', backup_role);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', backup_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %I', backup_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I', backup_role);
    IF has_drizzle THEN
      EXECUTE format('GRANT USAGE ON SCHEMA drizzle TO %I', backup_role);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO %I', backup_role);
      EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO %I', backup_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT SELECT ON TABLES TO %I', backup_role);
    END IF;
    IF has_pgboss THEN
      -- Backups exclude the pgboss schema; usage lets pg_dump inspect it without reading jobs.
      EXECUTE format('GRANT USAGE ON SCHEMA pgboss TO %I', backup_role);
    END IF;
    applied := applied || backup_role;
  END IF;

  RETURN array_to_string(applied, ',');
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION financialos_apply_grants(text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION financialos_install_updated_at_triggers() FROM PUBLIC;
--> statement-breakpoint
SELECT financialos_apply_grants();
