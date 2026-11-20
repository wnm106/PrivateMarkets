-- Search and the assistant follow list use the main entity types: the ones
-- with no parent. A type that sits under another type stays out until someone
-- turns Enabled for Search back on.

UPDATE metadata_register.domain_types AS dt
SET enabled_for_search = top_level.is_main,
    updated_at = NOW()
FROM (
  SELECT
    child.domain_code,
    (
      child.parent_domain_code IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM metadata_register.domain_types AS parent
        WHERE parent.domain_code = child.parent_domain_code
          AND parent.is_active
      )
    ) AS is_main
  FROM metadata_register.domain_types AS child
) AS top_level
WHERE dt.domain_code = top_level.domain_code
  AND dt.enabled_for_search IS DISTINCT FROM top_level.is_main;
