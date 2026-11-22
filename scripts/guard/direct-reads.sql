-- Database functions that read the entity attribute tables directly instead of
-- through the shared readers (docs/PROVISIONAL_RECORDS.md). A read is FROM or
-- JOIN on the table; DELETE FROM is a write and is left out. Writes go through
-- the loader and the golden write functions and are not counted here.
WITH fns AS (
    SELECT n.nspname || '.' || p.proname AS fn,
           regexp_replace(p.prosrc, 'DELETE\s+FROM', 'DELETE ', 'gi') AS src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'extensions', 'auth', 'storage', 'vault')
      AND n.nspname NOT LIKE 'pg\_%'
      AND l.lanname IN ('sql', 'plpgsql')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
)
SELECT DISTINCT fns.fn AS function_name, lower(m[1]) AS table_name
FROM fns,
     regexp_matches(fns.src, '\m(?:FROM|JOIN)\s+(?:golden_master\.|entity_instances\.)?(entity_attribute_values|entity_relationships|master_entities)\M', 'gi') AS m
ORDER BY 1, 2;
