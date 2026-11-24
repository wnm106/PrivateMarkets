-- ============================================================
-- Fund reconciliation: the drift threshold is a fund setting
-- ============================================================
--
-- A statement line that moved more than the drift threshold since the prior
-- period, with no flow in the pack that explains it, is a review item and
-- holds certification. The threshold was a choice on the page that nothing
-- kept: two people could see different review queues for one close, and the
-- workflow tools always read 10%.
--
--   FUND_DRIFT_THRESHOLD_PCT    the move, in percent, above which an
--                               unexplained line is drift. Blank is 10.
--
-- The page, the workflow tools and the assistant all read this value
-- (packages/graphql/src/lib/fund-rec-store.ts). Metadata only: no fund is
-- given a value, so every fund keeps the 10% it had.

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       NULL, FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE'
FROM (VALUES
    ('FUND_DRIFT_THRESHOLD_PCT', 'Drift Threshold', 'PERCENTAGE', 'A statement line that moved more than this percent since the prior period, with no flow that explains it, goes to the review queue of the close. Blank is 10.', 'FUND', 'Close', 5)
) AS v(code, name, dtype, descr, dom, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- On every template funds use, as the other close settings are.
INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.domain_code = a.domain_code
WHERE a.attribute_code = 'FUND_DRIFT_THRESHOLD_PCT'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
