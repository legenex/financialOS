-- Hand-written: integrity triggers that Drizzle cannot express.
-- Custom SQLSTATEs (class FS) let the application map these errors:
--   FS001 append-only table, FS002 posted ledger data is immutable,
--   FS003 journal entry does not balance, FS004 source record is immutable,
--   FS005 posted journal entry has too few lines.

-- updated_at maintenance -------------------------------------------------------
CREATE OR REPLACE FUNCTION fos_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION financialos_install_updated_at_triggers() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  installed integer := 0;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tr
      JOIN pg_class cl ON cl.oid = tr.tgrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = t.table_name AND tr.tgname = 'fos_touch_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER fos_touch_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION fos_touch_updated_at()',
        t.table_name
      );
      installed := installed + 1;
    END IF;
  END LOOP;
  RETURN installed;
END
$$;
--> statement-breakpoint
SELECT financialos_install_updated_at_triggers();
--> statement-breakpoint

-- audit_events: append-only ------------------------------------------------------
CREATE OR REPLACE FUNCTION fos_reject_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financialos: % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'FS001';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fos_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION fos_reject_append_only_change();
--> statement-breakpoint

-- journal_entries: immutable once posted ------------------------------------------
CREATE OR REPLACE FUNCTION fos_journal_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reversal_columns text[] := ARRAY['status', 'reversed_by_entry_id', 'reversed_at', 'reversal_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'financialos: journal entry % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'FS002';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'reversed' THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'financialos: journal entry % is reversed and immutable', OLD.id
        USING ERRCODE = 'FS002';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'posted'
  IF NEW.status NOT IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'financialos: journal entry % is posted; status can only change to reversed', OLD.id
      USING ERRCODE = 'FS002';
  END IF;
  IF (to_jsonb(NEW) - reversal_columns) IS DISTINCT FROM (to_jsonb(OLD) - reversal_columns) THEN
    RAISE EXCEPTION 'financialos: journal entry % is posted; only reversal links may change', OLD.id
      USING ERRCODE = 'FS002';
  END IF;
  IF OLD.reversed_by_entry_id IS NOT NULL
     AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id THEN
    RAISE EXCEPTION 'financialos: journal entry % already has a reversal', OLD.id
      USING ERRCODE = 'FS002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_guard
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fos_journal_entries_guard();
--> statement-breakpoint

-- journal_lines: lines of posted entries cannot change -----------------------------
CREATE OR REPLACE FUNCTION fos_journal_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO entry_status FROM journal_entries WHERE id = OLD.entry_id;
    IF entry_status IS NOT NULL AND entry_status <> 'draft' THEN
      RAISE EXCEPTION 'financialos: lines of % journal entry % cannot change', entry_status, OLD.entry_id
        USING ERRCODE = 'FS002';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO entry_status FROM journal_entries WHERE id = NEW.entry_id FOR SHARE;
    IF entry_status IS NOT NULL AND entry_status <> 'draft' THEN
      RAISE EXCEPTION 'financialos: lines of % journal entry % cannot change', entry_status, NEW.entry_id
        USING ERRCODE = 'FS002';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION fos_journal_lines_guard();
--> statement-breakpoint

-- journal_lines: every entry balances per currency at commit ------------------------
CREATE OR REPLACE FUNCTION fos_journal_entry_assert_balanced(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  unbalanced text;
BEGIN
  SELECT currency INTO unbalanced
  FROM journal_lines
  WHERE entry_id = target
  GROUP BY currency
  HAVING sum(amount) <> 0
  ORDER BY currency
  LIMIT 1;
  IF unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'financialos: journal entry % does not balance in %', target, unbalanced
      USING ERRCODE = 'FS003';
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fos_journal_lines_check_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM fos_journal_entry_assert_balanced(OLD.entry_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM fos_journal_entry_assert_balanced(NEW.entry_id);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fos_journal_lines_check_balance();
--> statement-breakpoint

-- journal_entries: a posted entry has at least two lines at commit -------------------
CREATE OR REPLACE FUNCTION fos_journal_entries_check_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  line_count integer;
BEGIN
  SELECT status INTO current_status FROM journal_entries WHERE id = NEW.id;
  IF current_status IS NULL OR current_status = 'draft' THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO line_count FROM journal_lines WHERE entry_id = NEW.id;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'financialos: posted journal entry % needs at least two lines', NEW.id
      USING ERRCODE = 'FS005';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_have_lines
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fos_journal_entries_check_lines();
--> statement-breakpoint

-- source_records: immutable except last_seen_at / superseded_by / deleted_upstream_at --
CREATE OR REPLACE FUNCTION fos_source_records_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable_columns text[] := ARRAY['last_seen_at', 'superseded_by', 'deleted_upstream_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financialos: source record % is immutable and cannot be deleted', OLD.id
      USING ERRCODE = 'FS004';
  END IF;
  IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns) THEN
    RAISE EXCEPTION 'financialos: source record % is immutable; only last_seen_at, superseded_by and deleted_upstream_at may change', OLD.id
      USING ERRCODE = 'FS004';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER source_records_guard
  BEFORE UPDATE OR DELETE ON source_records
  FOR EACH ROW EXECUTE FUNCTION fos_source_records_guard();
--> statement-breakpoint
CREATE TRIGGER source_records_no_truncate
  BEFORE TRUNCATE ON source_records
  FOR EACH STATEMENT EXECUTE FUNCTION fos_reject_append_only_change();
--> statement-breakpoint

-- classifications: versions are append-only apart from the is_current flag -------------
CREATE OR REPLACE FUNCTION fos_classifications_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financialos: classification versions cannot be deleted'
      USING ERRCODE = 'FS001';
  END IF;
  IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current') THEN
    RAISE EXCEPTION 'financialos: classification version % is immutable; create a new version', OLD.id
      USING ERRCODE = 'FS001';
  END IF;
  IF NEW.is_current AND NOT OLD.is_current THEN
    RAISE EXCEPTION 'financialos: an old classification version cannot become current again; create a new version'
      USING ERRCODE = 'FS001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER classifications_guard
  BEFORE UPDATE OR DELETE ON classifications
  FOR EACH ROW EXECUTE FUNCTION fos_classifications_guard();
