-- Review notes on a borrower's statement period.
--
-- A borrower financials workflow ends by writing up the quarter: how the
-- business moved, whether each covenant holds, whether the borrower's
-- certificate agrees with our calculation, and the actions that follow. The
-- notes are kept on the quarter's statement, so they sit beside the lines they
-- describe and carry the same history as every other value.
--
--   STATEMENT_REVIEW_NOTES     the write-up, in Markdown
--   STATEMENT_REVIEW_OUTCOME   one line the platform reads from the covenants
--                              and the lines when the notes are saved. Not
--                              written by the author.
--
-- Neither is a statement line: they carry no statementLine rule, so the
-- statement book leaves them out of the grid and the calculations.

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
    ('STATEMENT_REVIEW_NOTES', 'Review Notes', 'STRING', 'The review of the quarter: trends, covenants, certificate differences and the actions that follow, in Markdown. Replaced each time notes are saved; earlier versions stay in history.', 'STATEMENT_PERIOD', 'Period', 90),
    ('STATEMENT_REVIEW_OUTCOME', 'Outcome When Notes Were Saved', 'STRING', 'Where the quarter stood when the notes were saved: covenants past the limit, certificate differences and lines moving sharply. Read from the figures, not written by the author.', 'STATEMENT_PERIOD', 'Period', 91)
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
JOIN metadata_register.domain_templates t ON t.domain_code = 'STATEMENT_PERIOD'
WHERE a.attribute_code IN ('STATEMENT_REVIEW_NOTES', 'STATEMENT_REVIEW_OUTCOME')
ON CONFLICT (template_id, attribute_id) DO NOTHING;
