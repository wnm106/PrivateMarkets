-- Reconciliation notes on a fund close.
--
-- A reconciliation workflow ends by writing up what it found: what ties, what
-- does not and why, and the actions that follow. The notes are kept on the
-- period's close record, so they sit beside the decisions and the sign-off and
-- carry the same history as every other value.
--
--   CLOSE_REC_NOTES     the write-up, in Markdown
--   CLOSE_REC_OUTCOME   one line the platform reads from the reconciliation
--                       itself when the notes are saved: breaks, open items,
--                       whether cash ties. Not written by the author.

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
    ('CLOSE_REC_NOTES', 'Reconciliation Notes', 'STRING', 'What the reconciliation found and the actions that follow, in Markdown. Replaced each time notes are saved; earlier versions stay in history.', 'FUND_CLOSE', 'Close', 6),
    ('CLOSE_REC_OUTCOME', 'Outcome When Notes Were Saved', 'STRING', 'Where the reconciliation stood when the notes were saved: breaks, undecided items, and whether cash ties. Read from the reconciliation, not written by the author.', 'FUND_CLOSE', 'Close', 7)
) AS v(code, name, dtype, descr, dom, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'FUND_CLOSE_STANDARD'
WHERE a.attribute_code IN ('CLOSE_REC_NOTES', 'CLOSE_REC_OUTCOME')
ON CONFLICT (template_id, attribute_id) DO NOTHING;
