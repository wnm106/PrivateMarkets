-- The data quality dashboard skips the "IS NULL OR" blank shortcut again.
--
-- 20261122210000_dq_rules_describe_exceptions made a blank value meet no
-- condition about its value, and patched every function that took the old
-- quick pass ("ATTRIBUTE IS NULL OR ..." passes a record that lacks the
-- attribute) to ask data_quality.rule_passes_when_blank instead.
--
-- Later migrations re-created public.data_quality_dashboard from a copy taken
-- before that patch, so the old shortcut came back: the dashboard counts a
-- blank as passing a rule written "ATTRIBUTE IS NULL OR ...", which now raises
-- an exception on a blank. scripts/db-tests/dq-exception-rules.sql fails on it.
--
-- This runs the same patch again over whatever is live. It changes only
-- functions that still contain the old shape, and only that expression, so a
-- function already fixed is left alone. It is dated after every migration that
-- re-creates the dashboard, so it applies after them on a fresh database too.
DO $shortcut$
DECLARE
  v_fn record;
  v_def text;
  v_new text;
  v_pattern text := '([A-Za-z_][A-Za-z0-9_.]*) ~\* \(''\^'' \|\| ([A-Za-z_][A-Za-z0-9_.]*) \|\| ''\[\[:space:\]\]\+IS\[\[:space:\]\]\+NULL\[\[:space:\]\]\+OR\[\[:space:\]\]''\)';
BEGIN
  FOR v_fn IN
    SELECT p.oid, n.nspname, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'data_quality')
      AND p.prokind = 'f'
      AND p.prosrc ~ v_pattern
  LOOP
    v_def := pg_get_functiondef(v_fn.oid);
    v_new := regexp_replace(v_def, v_pattern, 'data_quality.rule_passes_when_blank(\1, \2)', 'g');
    IF v_new IS DISTINCT FROM v_def THEN
      EXECUTE v_new;
      RAISE NOTICE 'Blank shortcut now asks rule_passes_when_blank in %.%', v_fn.nspname, v_fn.proname;
    END IF;
  END LOOP;
END;
$shortcut$;

NOTIFY pgrst, 'reload schema';
