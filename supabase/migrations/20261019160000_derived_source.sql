-- Calculated attributes are written to the DERIVED source. Some databases only
-- have the display source CALCULATED, so the calc worker raised
-- "DERIVED source is not registered" and never stored a result.

INSERT INTO entity_instances.source_registry (
    source_code,
    source_name,
    source_type,
    feed_frequency,
    precedence_rank,
    is_active,
    is_protected,
    metadata
) VALUES (
    'DERIVED',
    'Calculated Values',
    'CALCULATED',
    'ON_DEMAND',
    100,
    TRUE,
    TRUE,
    '{"color": "#475569"}'::jsonb
)
ON CONFLICT (source_code) DO NOTHING;
