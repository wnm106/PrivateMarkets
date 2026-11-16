-- Syndicate status for deals that had none.
--
-- The syndicate page inferred a status from the deal stage when the attribute
-- was blank: closed when the deal is closed, launched in closing, otherwise not
-- launched. That inference is now stored, with the same source and start date
-- as the deal's stage, so the page reads the attribute and nothing else.

INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value,
    valid_from, valid_to, precedence_rank, metadata
)
SELECT d.id, status_attr.id, stage.source_id,
       CASE stage.golden_value
           WHEN 'CLOSED' THEN 'CLOSED'
           WHEN 'CLOSING' THEN 'LAUNCHED'
           ELSE 'NOT_LAUNCHED'
       END,
       stage.valid_from, DATE '9999-12-31', 100,
       '{"backfill":"syndicate_status_from_stage"}'::jsonb
FROM entity_instances.master_entities d
JOIN metadata_register.attribute_register status_attr ON status_attr.attribute_code = 'SYNDICATE_STATUS'
JOIN metadata_register.attribute_register stage_attr ON stage_attr.attribute_code = 'DEAL_STAGE'
JOIN LATERAL (
    SELECT eav.source_id, eav.golden_value, eav.valid_from
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = d.id
      AND eav.attribute_id = stage_attr.id
      AND eav.system_to = golden_master.open_system_to()
      AND eav.valid_to = DATE '9999-12-31'
    ORDER BY (eav.source_id = eav.golden_source_id) DESC NULLS LAST, eav.valid_from DESC
    LIMIT 1
) stage ON TRUE
WHERE d.domain_code = 'DEAL'
  AND d.is_active IS NOT FALSE
  AND NOT EXISTS (
      SELECT 1
      FROM golden_master.entity_attribute_values eav
      WHERE eav.entity_id = d.id
        AND eav.attribute_id = status_attr.id
        AND eav.system_to = golden_master.open_system_to()
        AND eav.valid_to = DATE '9999-12-31'
  );
