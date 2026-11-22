-- Provisional rows are read only where docs/PROVISIONAL_RECORDS.md says.
--
--   held-rows   a function that names a provisional column or table. Each must
--               be listed in provisional-readers.json with a reason.
--   scope-arg   a function that takes p_scope but does not default it to null
--               or does not pass it through entity_instances.scope_for_caller.
--               A scope must never be on by default, or used unchecked.
WITH fns AS (
    SELECT n.nspname || '.' || p.proname AS fn,
           p.prosrc AS src,
           pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'extensions', 'auth', 'storage', 'vault')
      AND n.nspname NOT LIKE 'pg\_%'
      AND l.lanname IN ('sql', 'plpgsql')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
)
SELECT DISTINCT 'held-rows' AS kind, fn AS function_name, '' AS detail
FROM fns
WHERE src ~* '\m(load_batch_links|provisional_scopes|provisional_entity_id|assumed_entity_id|decided_entity_id)\M'
UNION
SELECT 'scope-arg', fn, args
FROM fns
WHERE args ~* '\mp_scope\s+uuid'
  AND fn <> 'entity_instances.scope_for_caller'
  AND (args !~* '\mp_scope\s+uuid\s+DEFAULT\s+NULL'
       OR src !~* 'scope_for_caller\s*\(\s*p_scope\s*\)')
ORDER BY 1, 2;
