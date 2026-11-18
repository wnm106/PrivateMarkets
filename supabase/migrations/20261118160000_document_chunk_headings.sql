-- Word search over a chunk now sees the headings above it.
--
-- The clauses under "7.1 Financial Condition Covenants" set ratios and never
-- say "financial covenants" themselves, so a search for those words passed
-- them by. Each chunk now keeps its heading path, and the path counts for more
-- than the body when ranking by words. Search by meaning already had the path.

ALTER TABLE docs.chunks ADD COLUMN IF NOT EXISTS heading_path TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS docs.chunks_tsv;
ALTER TABLE docs.chunks DROP COLUMN IF EXISTS tsv;
ALTER TABLE docs.chunks ADD COLUMN tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', heading_path), 'A') || setweight(to_tsvector('english', text), 'B')
) STORED;
CREATE INDEX IF NOT EXISTS chunks_tsv ON docs.chunks USING GIN (tsv);

COMMENT ON COLUMN docs.chunks.heading_path IS 'The headings above the chunk, outermost first. Kept by docs.refresh_chunk_headings.';

CREATE OR REPLACE FUNCTION docs.refresh_chunk_headings(p_document_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    UPDATE docs.chunks AS c
       SET heading_path = COALESCE((
           SELECT concat_ws(' > ', p.heading, s.heading)
           FROM docs.sections AS s
           LEFT JOIN docs.sections AS p ON p.document_id = s.document_id AND p.seq = s.parent_seq
           WHERE s.id = c.section_id
       ), '')
     WHERE c.document_id = p_document_id;
$$;

REVOKE ALL ON FUNCTION docs.refresh_chunk_headings(UUID) FROM PUBLIC;

-- As before, and sets each chunk's heading path once the chunks are in.
CREATE OR REPLACE FUNCTION public.document_store_content(
    p_id UUID,
    p_body TEXT,
    p_format TEXT,
    p_page_count INTEGER,
    p_title TEXT,
    p_sections JSONB,
    p_chunks JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
DECLARE
    v_doc docs.documents;
    v_count INTEGER;
BEGIN
    SELECT * INTO v_doc FROM docs.documents WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM docs.chunks WHERE document_id = p_id;
    DELETE FROM docs.sections WHERE document_id = p_id;

    INSERT INTO docs.sections (document_id, seq, parent_seq, level, number, heading, char_start, char_end)
    SELECT p_id, s.seq, s."parentSeq", s.level, NULLIF(s.number, ''), s.heading, s."charStart", s."charEnd"
    FROM jsonb_to_recordset(COALESCE(p_sections, '[]'::jsonb))
        AS s(seq INTEGER, "parentSeq" INTEGER, level INTEGER, number TEXT, heading TEXT, "charStart" INTEGER, "charEnd" INTEGER);

    INSERT INTO docs.chunks (document_id, client_id, section_id, seq, kind, text, char_start, char_end, locator, own_tags)
    SELECT p_id, v_doc.client_id, sec.id, c.seq, COALESCE(c.kind, 'CLAUSE'),
           substr(p_body, c."charStart" + 1, c."charEnd" - c."charStart"),
           c."charStart", c."charEnd", COALESCE(c.locator, '{}'::jsonb),
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(c.tags)), '{}')
    FROM jsonb_to_recordset(COALESCE(p_chunks, '[]'::jsonb))
        AS c(seq INTEGER, "sectionSeq" INTEGER, kind TEXT, "charStart" INTEGER, "charEnd" INTEGER, locator JSONB, tags JSONB)
    LEFT JOIN docs.sections AS sec ON sec.document_id = p_id AND sec.seq = c."sectionSeq"
    WHERE c."charEnd" > c."charStart";
    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE docs.documents
       SET body = p_body,
           format = p_format,
           page_count = p_page_count,
           title = CASE WHEN title = file_name AND NULLIF(btrim(COALESCE(p_title, '')), '') IS NOT NULL THEN left(btrim(p_title), 500) ELSE title END,
           chunk_count = v_count,
           embedded_count = 0,
           embedding_model = NULL,
           template_id = NULL,
           updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_doc;

    PERFORM docs.refresh_chunk_headings(p_id);
    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN jsonb_build_object('chunks', v_count, 'title', v_doc.title);
END;
$$;

-- Documents already read.
SELECT docs.refresh_chunk_headings(d.id) FROM docs.documents AS d;

NOTIFY pgrst, 'reload schema';
