-- Reading a file again carries its vectors over in batches.
--
-- 20261118180000 copied every kept vector back inside document_store_content.
-- Each copy is an insert into the vector index, and a few hundred of them in
-- one call ran past the statement timeout, so the whole read was cancelled.
--
-- What is worth keeping now goes to a side table with no vector index. The
-- new chunks are stored without vectors, which is quick. Descriptions and
-- topics come back at once. Vectors come back a batch at a time through
-- document_restore_kept, which the reader calls until none are left.

CREATE TABLE IF NOT EXISTS docs.chunk_carry (
    document_id UUID NOT NULL REFERENCES docs.documents(id) ON DELETE CASCADE,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    text_hash CHAR(32) NOT NULL,
    heading_path TEXT NOT NULL,
    embedding extensions.vector(1024),
    embedding_model VARCHAR(100),
    summary TEXT,
    topics TEXT[] NOT NULL DEFAULT '{}',
    refined_by VARCHAR(10),
    PRIMARY KEY (document_id, char_start, char_end)
);
ALTER TABLE docs.chunk_carry ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE docs.chunk_carry IS 'What a document''s passages had before it was read again, held until the new passages have taken it back. Empty otherwise.';

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
    v_kept INTEGER;
BEGIN
    SELECT * INTO v_doc FROM docs.documents WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;

    -- Keep what took work to make: vectors, and descriptions and topics.
    DELETE FROM docs.chunk_carry WHERE document_id = p_id;
    INSERT INTO docs.chunk_carry (document_id, char_start, char_end, text_hash, heading_path, embedding, embedding_model, summary, topics, refined_by)
    SELECT c.document_id, c.char_start, c.char_end, md5(c.text), c.heading_path, c.embedding, c.embedding_model, c.summary, c.topics, c.refined_by
    FROM docs.chunks AS c
    WHERE c.document_id = p_id AND (c.embedding IS NOT NULL OR c.refined_by IS NOT NULL)
    ON CONFLICT DO NOTHING;

    DELETE FROM docs.chunks WHERE document_id = p_id;
    DELETE FROM docs.sections WHERE document_id = p_id;

    INSERT INTO docs.sections (document_id, seq, parent_seq, level, number, heading, char_start, char_end)
    SELECT p_id, s.seq, s."parentSeq", s.level, NULLIF(s.number, ''), s.heading, s."charStart", s."charEnd"
    FROM jsonb_to_recordset(COALESCE(p_sections, '[]'::jsonb))
        AS s(seq INTEGER, "parentSeq" INTEGER, level INTEGER, number TEXT, heading TEXT, "charStart" INTEGER, "charEnd" INTEGER);

    INSERT INTO docs.chunks (document_id, client_id, section_id, seq, kind, text, char_start, char_end, locator, own_tags, thin, heading_path)
    SELECT p_id, v_doc.client_id, sec.id, c.seq, COALESCE(c.kind, 'CLAUSE'),
           substr(p_body, c."charStart" + 1, c."charEnd" - c."charStart"),
           c."charStart", c."charEnd", COALESCE(c.locator, '{}'::jsonb),
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(c.tags)), '{}'),
           COALESCE(c.thin, FALSE),
           COALESCE(concat_ws(' > ', par.heading, sec.heading), '')
    FROM jsonb_to_recordset(COALESCE(p_chunks, '[]'::jsonb))
        AS c(seq INTEGER, "sectionSeq" INTEGER, kind TEXT, "charStart" INTEGER, "charEnd" INTEGER, locator JSONB, tags JSONB, thin BOOLEAN)
    LEFT JOIN docs.sections AS sec ON sec.document_id = p_id AND sec.seq = c."sectionSeq"
    LEFT JOIN docs.sections AS par ON par.document_id = p_id AND par.seq = sec.parent_seq
    WHERE c."charEnd" > c."charStart";
    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- Descriptions and topics come back now. Vectors follow through document_restore_kept.
    UPDATE docs.chunks AS fresh
       SET summary = k.summary, topics = k.topics, refined_by = k.refined_by
      FROM docs.chunk_carry AS k
     WHERE fresh.document_id = p_id AND k.document_id = p_id AND k.refined_by IS NOT NULL
       AND k.char_start = fresh.char_start AND k.char_end = fresh.char_end
       AND k.text_hash = md5(fresh.text) AND k.heading_path = fresh.heading_path;

    SELECT COUNT(*) INTO v_kept
    FROM docs.chunks AS fresh
    JOIN docs.chunk_carry AS k ON k.document_id = fresh.document_id
     AND k.char_start = fresh.char_start AND k.char_end = fresh.char_end
     AND k.text_hash = md5(fresh.text) AND k.heading_path = fresh.heading_path
    WHERE fresh.document_id = p_id AND k.embedding IS NOT NULL;

    UPDATE docs.documents
       SET body = p_body,
           format = p_format,
           page_count = p_page_count,
           title = CASE WHEN title = file_name AND NULLIF(btrim(COALESCE(p_title, '')), '') IS NOT NULL THEN left(btrim(p_title), 500) ELSE title END,
           chunk_count = v_count,
           embedded_count = 0,
           template_id = NULL,
           updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_doc;

    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN jsonb_build_object('chunks', v_count, 'kept', v_kept, 'title', v_doc.title);
END;
$$;

-- Gives up to p_limit passages their old vector back. Returns how many still
-- wait. At zero the held copies are cleared. Service role only.
CREATE OR REPLACE FUNCTION public.document_restore_kept(p_id UUID, p_limit INTEGER DEFAULT 150)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, extensions, pg_temp
AS $$
DECLARE
    v_left INTEGER;
BEGIN
    WITH batch AS (
        SELECT fresh.id, k.embedding, k.embedding_model
        FROM docs.chunks AS fresh
        JOIN docs.chunk_carry AS k ON k.document_id = fresh.document_id
         AND k.char_start = fresh.char_start AND k.char_end = fresh.char_end
         AND k.text_hash = md5(fresh.text) AND k.heading_path = fresh.heading_path
        WHERE fresh.document_id = p_id AND fresh.embedding IS NULL AND k.embedding IS NOT NULL
          -- A description written since the vector was made changes what is embedded.
          AND fresh.summary IS NOT DISTINCT FROM k.summary
        ORDER BY fresh.seq
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 150), 1), 500)
    )
    UPDATE docs.chunks AS c
       SET embedding = b.embedding, embedding_model = b.embedding_model
      FROM batch AS b
     WHERE c.id = b.id;

    SELECT COUNT(*) INTO v_left
    FROM docs.chunks AS fresh
    JOIN docs.chunk_carry AS k ON k.document_id = fresh.document_id
     AND k.char_start = fresh.char_start AND k.char_end = fresh.char_end
     AND k.text_hash = md5(fresh.text) AND k.heading_path = fresh.heading_path
    WHERE fresh.document_id = p_id AND fresh.embedding IS NULL AND k.embedding IS NOT NULL
      AND fresh.summary IS NOT DISTINCT FROM k.summary;

    IF v_left = 0 THEN
        DELETE FROM docs.chunk_carry WHERE document_id = p_id;
    END IF;
    UPDATE docs.documents
       SET embedded_count = (SELECT COUNT(*) FROM docs.chunks WHERE document_id = p_id AND embedding IS NOT NULL), updated_at = NOW()
     WHERE id = p_id;
    RETURN v_left;
END;
$$;

REVOKE ALL ON FUNCTION public.document_restore_kept(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_restore_kept(UUID, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
