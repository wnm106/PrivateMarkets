-- A file loaded through Load data is also kept as a searchable document.
--
-- Load data turns a file into values; Documents keeps its words. Until now the
-- same file had to be added to each by hand. The intake workflow indexes the
-- file it is loading: the original when its text can be read, otherwise a text
-- rendering of the tables that were read from it. The document it became is
-- kept on the file, so the two stay paired.
--
-- Three shared document types cover what Load data receives.
--
-- Safe to run again.

ALTER TABLE entity_instances.import_instances
    ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES docs.documents(id) ON DELETE SET NULL;
ALTER TABLE entity_instances.import_instances
    ADD COLUMN IF NOT EXISTS document_note TEXT;

COMMENT ON COLUMN entity_instances.import_instances.document_id IS
    'The searchable document this file was indexed as. NULL until it is indexed, or when it could not be.';
COMMENT ON COLUMN entity_instances.import_instances.document_note IS
    'What was indexed (the original, or the tables read from it), or why it could not be.';

INSERT INTO docs.document_types (client_id, type_code, type_name, description) VALUES
    (NULL, 'FINANCIAL_STATEMENT', 'Financial statement', 'A company''s income statement, balance sheet or cash flow statement for one or more periods.'),
    (NULL, 'NAV_STATEMENT', 'NAV statement', 'A fund''s net asset value statement from its administrator.'),
    (NULL, 'DATA_FILE', 'Data file', 'A table of records received as a file: positions, issuers, transactions.')
ON CONFLICT DO NOTHING;
