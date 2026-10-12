-- Migration: Seed default sources with colors
-- Description: Seeds the 7 default sources with their display colors

-- Insert default sources (only if they don't exist)
INSERT INTO entity_instances.source_registry (
    source_code, 
    source_name, 
    source_type, 
    vendor_name, 
    feed_format,
    feed_frequency,
    precedence_rank,
    is_protected,
    metadata
) VALUES 
    ('BLOOMBERG', 'Bloomberg', 'VENDOR', 'Bloomberg LP', 'API', 'DAILY', 10, FALSE, '{"color": "#c2410c"}'::jsonb),
    ('WSO', 'WSO', 'VENDOR', 'Wall Street Oasis', 'API', 'DAILY', 20, FALSE, '{"color": "#6d28d9"}'::jsonb),
    ('DEALCLOUD', 'DealCloud', 'VENDOR', 'DealCloud', 'API', 'DAILY', 30, FALSE, '{"color": "#0369a1"}'::jsonb),
    ('ALLVUE', 'Allvue', 'VENDOR', 'Allvue Systems', 'API', 'DAILY', 40, FALSE, '{"color": "#047857"}'::jsonb),
    ('SPCIQ', 'S&P Capital IQ', 'VENDOR', 'S&P Global', 'API', 'DAILY', 50, FALSE, '{"color": "#be185d"}'::jsonb),
    ('MANUAL', 'Manual Override', 'MANUAL', NULL, NULL, 'ON_DEMAND', 90, TRUE, '{"color": "#b45309"}'::jsonb),
    ('DERIVED', 'Derived', 'CALCULATED', NULL, NULL, 'ON_DEMAND', 100, FALSE, '{"color": "#475569"}'::jsonb)
ON CONFLICT (source_code) DO UPDATE SET
    source_name = EXCLUDED.source_name,
    source_type = EXCLUDED.source_type,
    vendor_name = EXCLUDED.vendor_name,
    feed_format = COALESCE(EXCLUDED.feed_format, entity_instances.source_registry.feed_format),
    feed_frequency = COALESCE(EXCLUDED.feed_frequency, entity_instances.source_registry.feed_frequency),
    precedence_rank = EXCLUDED.precedence_rank,
    is_protected = EXCLUDED.is_protected,
    metadata = EXCLUDED.metadata;
