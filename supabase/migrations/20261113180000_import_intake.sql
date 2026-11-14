-- One queue for every file. An upload records how it was read (a local parser,
-- LlamaParse, Azure, or the model), why, and every table found in it, so the
-- user can switch tables later without reading the file again.

ALTER TABLE entity_instances.import_instances
    ADD COLUMN IF NOT EXISTS intake_method VARCHAR(40),
    ADD COLUMN IF NOT EXISTS intake_note TEXT,
    ADD COLUMN IF NOT EXISTS intake_profile JSONB,
    ADD COLUMN IF NOT EXISTS tables JSONB,
    ADD COLUMN IF NOT EXISTS table_id VARCHAR(100);

COMMENT ON COLUMN entity_instances.import_instances.intake_method IS
    'How the file was read: tabular, json, llamaparse, azure_layout, agent, or local.';
COMMENT ON COLUMN entity_instances.import_instances.intake_profile IS
    'What the document looked like (format, pages, text per page, table share) and why that reader was chosen.';
COMMENT ON COLUMN entity_instances.import_instances.tables IS
    'Every table found in a multi-table file or a document: [{id, name, headers, rows}]. parsed_rows holds the chosen one.';
COMMENT ON COLUMN entity_instances.import_instances.table_id IS
    'The id of the table in `tables` that is currently being loaded.';
