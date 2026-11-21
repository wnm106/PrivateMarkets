-- Database functions whose bodies name a rule, client or entity by its code.
-- The codes are the ones in this database, so nothing is guessed from a naming
-- pattern. Extension functions are left out.
WITH fns AS (
    SELECT n.nspname || '.' || p.proname AS fn, p.prosrc AS src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'extensions', 'auth', 'storage', 'vault')
      AND n.nspname NOT LIKE 'pg\_%'
      AND l.lanname IN ('sql', 'plpgsql')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
),
literals AS (
    SELECT DISTINCT fns.fn, m[1] AS literal
    FROM fns, regexp_matches(fns.src, '''([^'']{3,120})''', 'g') AS m
),
codes AS (
    SELECT 'rule' AS kind, rule_code::TEXT AS code FROM compliance.rules
    UNION SELECT 'client', client_code::TEXT FROM tenancy.clients
    UNION SELECT 'entity', entity_code::TEXT FROM entity_instances.master_entities
)
SELECT c.kind, l.fn AS function_name, l.literal AS code
FROM literals l
JOIN codes c ON c.code = l.literal
ORDER BY 1, 2, 3;
