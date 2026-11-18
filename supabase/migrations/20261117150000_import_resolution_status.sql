-- A load can stop before writing when one file row matches more than one entity.
-- NEEDS_RESOLUTION keeps that file open until each row is mapped, created, or skipped.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'entity_instances'
      AND rel.relname = 'import_instances'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE entity_instances.import_instances DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE entity_instances.import_instances
  ADD CONSTRAINT import_instances_status_check
  CHECK (status IN ('READY', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'NEEDS_RESOLUTION'));

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'entity_instances'
      AND rel.relname = 'load_sessions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE entity_instances.load_sessions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE entity_instances.load_sessions
  ADD CONSTRAINT load_sessions_status_check
  CHECK (status IN ('EXTRACTING', 'INTERVIEW', 'READY', 'LOADING', 'LOADED', 'FAILED', 'NEEDS_RESOLUTION'));
