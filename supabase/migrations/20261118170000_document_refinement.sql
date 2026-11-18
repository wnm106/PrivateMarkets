-- Refinement: passages with little language get a description and topics, and
-- search uses topics and sections to bring the right passages forward.
--
-- A table of lenders and amounts has no sentence to embed, so a question about
-- "who the lenders are" passes it by. Three additions fix that:
--
--   topics   A template lists the subjects its documents cover (lenders,
--            pricing, fees), each with a short description. Topics cut across
--            sections: lenders appear in the preamble, a schedule and the
--            signature pages.
--   refine   The chunker marks a passage that is mostly names and numbers as
--            thin. A model then writes one sentence saying what it holds and
--            picks its topics. The sentence is embedded and word-indexed with
--            the passage. It is never the citation: chunks.text stays the
--            document's own words. A person can correct either, and what a
--            person set is kept.
--   routes   Each topic and top section of a published template has a vector.
--            A search compares the question with them and adds the passages of
--            the closest topic and section as a third ranked list. It is a
--            boost, not a filter: everything else is still searched.
--
-- Reading a file again now keeps the vector, description and topics of every
-- passage whose words and place did not change, so nothing is embedded twice.

ALTER TABLE docs.templates ADD COLUMN IF NOT EXISTS topics JSONB NOT NULL DEFAULT '[]';
COMMENT ON COLUMN docs.templates.topics IS '[{code, title, description}] The subjects documents of this type cover.';

ALTER TABLE docs.chunks
    ADD COLUMN IF NOT EXISTS thin BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS summary TEXT,
    ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS refined_by VARCHAR(10) CHECK (refined_by IN ('MODEL', 'MANUAL'));

COMMENT ON COLUMN docs.chunks.thin IS 'Mostly names and numbers: a table, a signature block, a list. Its words alone embed poorly.';
COMMENT ON COLUMN docs.chunks.summary IS 'One sentence saying what the passage holds. Written by a model or a person. Never quoted as the document.';
COMMENT ON COLUMN docs.chunks.refined_by IS 'Who wrote summary and topics. MANUAL is kept when the document is refined or read again.';

DROP INDEX IF EXISTS docs.chunks_tsv;
ALTER TABLE docs.chunks DROP COLUMN IF EXISTS tsv;
ALTER TABLE docs.chunks ADD COLUMN tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', heading_path || ' ' || COALESCE(summary, '')), 'A') || setweight(to_tsvector('english', text), 'B')
) STORED;
CREATE INDEX IF NOT EXISTS chunks_tsv ON docs.chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_to_refine ON docs.chunks (document_id, seq) WHERE thin AND refined_by IS NULL;

CREATE TABLE IF NOT EXISTS docs.template_routes (
    template_id UUID NOT NULL REFERENCES docs.templates(id) ON DELETE CASCADE,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('TOPIC', 'SECTION')),
    code VARCHAR(100) NOT NULL,
    embedding extensions.vector(1024) NOT NULL,
    PRIMARY KEY (template_id, kind, code)
);
ALTER TABLE docs.template_routes ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE docs.template_routes IS 'A vector for each topic and top section of a template, which a search question is compared with.';

-- ---------------------------------------------------------------------------
-- Tags now include topics
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION docs.refresh_chunk_tags(p_document_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
DECLARE
    v_doc docs.documents;
    v_base TEXT[];
BEGIN
    SELECT * INTO v_doc FROM docs.documents WHERE id = p_document_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT v_doc.tags || ARRAY['type:' || ty.type_code] INTO v_base
    FROM docs.document_types AS ty WHERE ty.id = v_doc.type_id;

    WITH tpl AS (
        SELECT e ->> 'code' AS code,
               ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'tags', '[]'::jsonb))) AS tags
        FROM docs.templates AS t, jsonb_array_elements(t.sections) AS e
        WHERE t.id = v_doc.template_id
    ),
    sec AS (
        SELECT s.id,
               array_remove(ARRAY['section:' || s.template_section_code, 'section:' || p.template_section_code], NULL)
                   || COALESCE(ts.tags, '{}') || COALESCE(tp.tags, '{}') AS tags
        FROM docs.sections AS s
        LEFT JOIN docs.sections AS p ON p.document_id = s.document_id AND p.seq = s.parent_seq
        LEFT JOIN tpl AS ts ON ts.code = s.template_section_code
        LEFT JOIN tpl AS tp ON tp.code = p.template_section_code
        WHERE s.document_id = p_document_id
    )
    UPDATE docs.chunks AS c
       SET tags = (
           SELECT COALESCE(array_agg(DISTINCT t ORDER BY t), '{}')
           FROM unnest(
               c.own_tags || v_base
               || COALESCE((SELECT sec.tags FROM sec WHERE sec.id = c.section_id), '{}')
               || ARRAY(SELECT 'topic:' || lower(topic) FROM unnest(c.topics) AS topic)
           ) AS t
           WHERE t IS NOT NULL AND t <> ''
       )
     WHERE c.document_id = p_document_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Templates carry topics
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.document_template_save(UUID, UUID, UUID, JSONB, TEXT, UUID[]);

-- p_id NULL starts a new draft. p_topics NULL leaves the topics as they are.
CREATE OR REPLACE FUNCTION public.document_template_save(
    p_id UUID,
    p_type_id UUID,
    p_client_id UUID,
    p_sections JSONB,
    p_notes TEXT,
    p_source_document_ids UUID[],
    p_topics JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.templates;
    v_type docs.document_types;
BEGIN
    IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' THEN
        RAISE EXCEPTION 'Sections must be a list' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_sections) AS e
        WHERE NULLIF(btrim(COALESCE(e ->> 'code', '')), '') IS NULL OR NULLIF(btrim(COALESCE(e ->> 'title', '')), '') IS NULL
    ) THEN
        RAISE EXCEPTION 'Every section needs a code and a title' USING ERRCODE = '22023';
    END IF;
    IF (SELECT COUNT(*) <> COUNT(DISTINCT e ->> 'code') FROM jsonb_array_elements(p_sections) AS e) THEN
        RAISE EXCEPTION 'Two sections share a code' USING ERRCODE = '22023';
    END IF;
    IF p_topics IS NOT NULL THEN
        IF jsonb_typeof(p_topics) <> 'array' THEN
            RAISE EXCEPTION 'Topics must be a list' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_topics) AS e
            WHERE NULLIF(btrim(COALESCE(e ->> 'code', '')), '') IS NULL OR NULLIF(btrim(COALESCE(e ->> 'title', '')), '') IS NULL
        ) OR (SELECT COUNT(*) <> COUNT(DISTINCT e ->> 'code') FROM jsonb_array_elements(p_topics) AS e) THEN
            RAISE EXCEPTION 'Every topic needs its own code and a title' USING ERRCODE = '22023';
        END IF;
    END IF;

    IF p_id IS NULL THEN
        SELECT * INTO v_type FROM docs.document_types WHERE id = p_type_id;
        IF NOT FOUND OR NOT docs.can_read(v_type.client_id) THEN
            RAISE EXCEPTION 'Document type was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT docs.can_manage(p_client_id) THEN
            RAISE EXCEPTION 'You cannot change templates for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO docs.templates (client_id, type_id, version, sections, topics, notes, source_document_ids, created_by)
        VALUES (
            p_client_id, p_type_id,
            COALESCE((SELECT MAX(version) FROM docs.templates WHERE type_id = p_type_id AND client_id IS NOT DISTINCT FROM p_client_id), 0) + 1,
            p_sections, COALESCE(p_topics, '[]'::jsonb), NULLIF(btrim(COALESCE(p_notes, '')), ''), COALESCE(p_source_document_ids, '{}'), auth.uid()
        )
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM docs.templates WHERE id = p_id;
        IF NOT FOUND OR NOT docs.can_read(v_row.client_id) THEN
            RAISE EXCEPTION 'Template was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT docs.can_manage(v_row.client_id) THEN
            RAISE EXCEPTION 'You cannot change this template' USING ERRCODE = '42501';
        END IF;
        IF v_row.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'A published template is not changed. Start a new draft from it.' USING ERRCODE = '22023';
        END IF;
        UPDATE docs.templates
           SET sections = p_sections,
               topics = COALESCE(p_topics, topics),
               notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
               source_document_ids = COALESCE(p_source_document_ids, source_document_ids),
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;
    RETURN to_jsonb(v_row);
END;
$$;

-- What a template's routes are built from, and how many it has.
CREATE OR REPLACE FUNCTION public.document_template_route_labels(p_template_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT jsonb_build_object(
        'template_id', t.id,
        'topics', t.topics,
        'sections', COALESCE((
            SELECT jsonb_agg(e) FROM jsonb_array_elements(t.sections) AS e WHERE NULLIF(e ->> 'parentCode', '') IS NULL
        ), '[]'::jsonb),
        'route_count', (SELECT COUNT(*) FROM docs.template_routes AS r WHERE r.template_id = t.id)
    )
    FROM docs.templates AS t
    WHERE t.id = p_template_id AND docs.can_read(t.client_id);
$$;

-- Replaces a template's routes. p_rows is [{"kind", "code", "embedding": "[...]"}].
CREATE OR REPLACE FUNCTION public.document_template_routes_save(p_template_id UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, extensions, pg_temp
AS $$
DECLARE
    v_row docs.templates;
    v_count INTEGER;
BEGIN
    SELECT * INTO v_row FROM docs.templates WHERE id = p_template_id;
    IF NOT FOUND OR NOT docs.can_read(v_row.client_id) THEN
        RAISE EXCEPTION 'Template was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot change this template' USING ERRCODE = '42501';
    END IF;
    DELETE FROM docs.template_routes WHERE template_id = p_template_id;
    INSERT INTO docs.template_routes (template_id, kind, code, embedding)
    SELECT p_template_id, r.kind, r.code, (r.embedding)::extensions.vector(1024)
    FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(kind TEXT, code TEXT, embedding TEXT)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Storing content: marks thin passages, keeps what did not change
-- ---------------------------------------------------------------------------

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
    v_embedded INTEGER;
BEGIN
    SELECT * INTO v_doc FROM docs.documents WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;

    -- Set the old chunks aside so their vectors and descriptions can be carried over.
    UPDATE docs.chunks SET seq = -seq, section_id = NULL WHERE document_id = p_id;
    DELETE FROM docs.sections WHERE document_id = p_id;

    INSERT INTO docs.sections (document_id, seq, parent_seq, level, number, heading, char_start, char_end)
    SELECT p_id, s.seq, s."parentSeq", s.level, NULLIF(s.number, ''), s.heading, s."charStart", s."charEnd"
    FROM jsonb_to_recordset(COALESCE(p_sections, '[]'::jsonb))
        AS s(seq INTEGER, "parentSeq" INTEGER, level INTEGER, number TEXT, heading TEXT, "charStart" INTEGER, "charEnd" INTEGER);

    INSERT INTO docs.chunks (document_id, client_id, section_id, seq, kind, text, char_start, char_end, locator, own_tags, thin)
    SELECT p_id, v_doc.client_id, sec.id, c.seq, COALESCE(c.kind, 'CLAUSE'),
           substr(p_body, c."charStart" + 1, c."charEnd" - c."charStart"),
           c."charStart", c."charEnd", COALESCE(c.locator, '{}'::jsonb),
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(c.tags)), '{}'),
           COALESCE(c.thin, FALSE)
    FROM jsonb_to_recordset(COALESCE(p_chunks, '[]'::jsonb))
        AS c(seq INTEGER, "sectionSeq" INTEGER, kind TEXT, "charStart" INTEGER, "charEnd" INTEGER, locator JSONB, tags JSONB, thin BOOLEAN)
    LEFT JOIN docs.sections AS sec ON sec.document_id = p_id AND sec.seq = c."sectionSeq"
    WHERE c."charEnd" > c."charStart";
    GET DIAGNOSTICS v_count = ROW_COUNT;

    PERFORM docs.refresh_chunk_headings(p_id);

    -- The same words in the same place under the same headings: nothing to redo.
    UPDATE docs.chunks AS fresh
       SET embedding = old.embedding,
           embedding_model = old.embedding_model,
           summary = old.summary,
           topics = old.topics,
           refined_by = old.refined_by
      FROM docs.chunks AS old
     WHERE fresh.document_id = p_id AND fresh.seq > 0
       AND old.document_id = p_id AND old.seq < 0
       AND old.char_start = fresh.char_start AND old.char_end = fresh.char_end
       AND old.text = fresh.text AND old.heading_path = fresh.heading_path;
    DELETE FROM docs.chunks WHERE document_id = p_id AND seq < 0;

    SELECT COUNT(*) INTO v_embedded FROM docs.chunks WHERE document_id = p_id AND embedding IS NOT NULL;
    UPDATE docs.documents
       SET body = p_body,
           format = p_format,
           page_count = p_page_count,
           title = CASE WHEN title = file_name AND NULLIF(btrim(COALESCE(p_title, '')), '') IS NOT NULL THEN left(btrim(p_title), 500) ELSE title END,
           chunk_count = v_count,
           embedded_count = v_embedded,
           template_id = NULL,
           updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_doc;

    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN jsonb_build_object('chunks', v_count, 'kept', v_embedded, 'title', v_doc.title);
END;
$$;

-- ---------------------------------------------------------------------------
-- Refining
-- ---------------------------------------------------------------------------

-- Thin passages nobody has described yet, each with the end of the passage
-- before it, and the topics to choose from. Service role only.
CREATE OR REPLACE FUNCTION public.document_chunks_to_refine(p_id UUID, p_limit INTEGER DEFAULT 40)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    SELECT jsonb_build_object(
        'title', d.title,
        'type_name', ty.type_name,
        'topics', COALESCE((SELECT t.topics FROM docs.templates AS t WHERE t.id = d.template_id), '[]'::jsonb),
        'waiting', (SELECT COUNT(*) FROM docs.chunks AS c WHERE c.document_id = d.id AND c.thin AND c.refined_by IS NULL),
        'chunks', COALESCE((
            SELECT jsonb_agg(row ORDER BY (row ->> 'seq')::int)
            FROM (
                SELECT jsonb_build_object(
                    'id', c.id, 'seq', c.seq, 'kind', c.kind, 'text', left(c.text, 6000), 'path', c.heading_path,
                    'before', (SELECT right(b.text, 500) FROM docs.chunks AS b WHERE b.document_id = c.document_id AND b.seq = c.seq - 1)
                ) AS row
                FROM docs.chunks AS c
                WHERE c.document_id = d.id AND c.thin AND c.refined_by IS NULL
                ORDER BY c.seq
                LIMIT LEAST(GREATEST(COALESCE(p_limit, 40), 1), 200)
            ) AS picked
        ), '[]'::jsonb)
    )
    FROM docs.documents AS d
    JOIN docs.document_types AS ty ON ty.id = d.type_id
    WHERE d.id = p_id;
$$;

-- Saves what the model wrote. p_rows is [{"id", "summary", "topics": [...]}].
-- A passage a person has described is left alone. The vector is cleared, since
-- the description is embedded with the words.
CREATE OR REPLACE FUNCTION public.document_chunks_refined(p_id UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE docs.chunks AS c
       SET summary = NULLIF(btrim(COALESCE(r.summary, '')), ''),
           topics = COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(r.topics, '[]'::jsonb))), '{}'),
           refined_by = 'MODEL',
           embedding = NULL,
           embedding_model = NULL
      FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(id UUID, summary TEXT, topics JSONB)
     WHERE c.id = r.id AND c.document_id = p_id AND c.refined_by IS DISTINCT FROM 'MANUAL';
    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE docs.documents
       SET embedded_count = (SELECT COUNT(*) FROM docs.chunks WHERE document_id = p_id AND embedding IS NOT NULL), updated_at = NOW()
     WHERE id = p_id;
    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN v_count;
END;
$$;

-- A person's description and topics for one passage. Kept from then on. The
-- passage is embedded again by the worker.
CREATE OR REPLACE FUNCTION public.document_chunk_refine(p_chunk_id UUID, p_summary TEXT, p_topics TEXT[])
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_chunk docs.chunks;
    v_doc docs.documents;
    v_topics TEXT[];
BEGIN
    SELECT * INTO v_chunk FROM docs.chunks WHERE id = p_chunk_id;
    IF FOUND THEN
        SELECT * INTO v_doc FROM docs.documents WHERE id = v_chunk.document_id;
    END IF;
    IF v_doc.id IS NULL OR NOT ops.can_see(v_doc.client_id) THEN
        RAISE EXCEPTION 'Passage was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_doc.client_id) THEN
        RAISE EXCEPTION 'You cannot change documents for this client' USING ERRCODE = '42501';
    END IF;
    -- Only topics the document's template has.
    SELECT COALESCE(array_agg(DISTINCT e ->> 'code'), '{}') INTO v_topics
    FROM docs.templates AS t, jsonb_array_elements(t.topics) AS e
    WHERE t.id = v_doc.template_id AND e ->> 'code' = ANY (COALESCE(p_topics, '{}'));

    UPDATE docs.chunks
       SET summary = NULLIF(btrim(COALESCE(p_summary, '')), ''),
           topics = COALESCE(v_topics, '{}'),
           refined_by = 'MANUAL',
           embedding = NULL,
           embedding_model = NULL
     WHERE id = p_chunk_id
    RETURNING * INTO v_chunk;

    UPDATE docs.documents
       SET embedded_count = (SELECT COUNT(*) FROM docs.chunks WHERE document_id = v_doc.id AND embedding IS NOT NULL),
           status = 'PROCESSING', stage = 'EMBEDDING', message = NULL, updated_at = NOW()
     WHERE id = v_doc.id;
    PERFORM docs.refresh_chunk_tags(v_doc.id);
    PERFORM docs.queue_processing(v_doc.id, v_doc.client_id);
    RETURN jsonb_build_object('id', v_chunk.id, 'document_id', v_chunk.document_id);
END;
$$;

-- The description is embedded with the words.
CREATE OR REPLACE FUNCTION public.document_chunks_pending(p_id UUID, p_limit INTEGER DEFAULT 64)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'text', c.text, 'summary', c.summary,
        'path', concat_ws(' > ', d.title, NULLIF(c.heading_path, ''))
    )
    FROM docs.chunks AS c
    JOIN docs.documents AS d ON d.id = c.document_id
    WHERE c.document_id = p_id AND c.embedding IS NULL
    ORDER BY c.seq
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 64), 1), 256);
$$;

CREATE OR REPLACE FUNCTION public.document_chunks_list(
    p_document_id UUID,
    p_section_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'document_id', c.document_id, 'section_id', c.section_id, 'seq', c.seq, 'kind', c.kind,
        'text', c.text, 'char_start', c.char_start, 'char_end', c.char_end, 'locator', c.locator,
        'tags', c.tags, 'embedded', c.embedding IS NOT NULL,
        'thin', c.thin, 'summary', c.summary, 'topics', c.topics, 'refined_by', c.refined_by
    )
    FROM docs.chunks AS c
    JOIN docs.documents AS d ON d.id = c.document_id
    WHERE c.document_id = p_document_id AND ops.can_see(d.client_id)
      AND (p_section_id IS NULL OR c.section_id = p_section_id
           OR c.section_id IN (
               SELECT child.id FROM docs.sections AS child
               JOIN docs.sections AS parent ON parent.document_id = child.document_id AND parent.seq = child.parent_seq
               WHERE parent.id = p_section_id
           ))
    ORDER BY c.seq
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

-- ---------------------------------------------------------------------------
-- Search, with routing
-- ---------------------------------------------------------------------------

-- As before, with a third ranked list. The question's vector is compared with
-- the routes of each template in scope. The passages tagged with the closest
-- topic, and those under the closest top section, are ranked by meaning and
-- joined in at less than full weight. A passage that carries the right topic
-- is found even when neither its words nor its own vector match the question.
CREATE OR REPLACE FUNCTION public.document_search(
    p_query TEXT,
    p_embedding TEXT DEFAULT NULL,
    p_tags TEXT[] DEFAULT NULL,
    p_entity_ids UUID[] DEFAULT NULL,
    p_type_codes TEXT[] DEFAULT NULL,
    p_document_ids UUID[] DEFAULT NULL,
    p_limit INTEGER DEFAULT 10
) RETURNS SETOF JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, entity_instances, extensions, pg_temp
AS $$
DECLARE
    v_vec extensions.vector(1024);
    v_words tsquery;
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
    v_tags TEXT[] := NULLIF(p_tags, '{}');
    v_entities UUID[] := NULLIF(p_entity_ids, '{}');
    v_types TEXT[] := NULLIF(p_type_codes, '{}');
    v_documents UUID[] := NULLIF(p_document_ids, '{}');
BEGIN
    IF NULLIF(btrim(COALESCE(p_embedding, '')), '') IS NOT NULL THEN
        v_vec := p_embedding::extensions.vector(1024);
    END IF;
    -- Any of the words, not all of them: a question has words the clause does not.
    v_words := NULLIF(replace(plainto_tsquery('english', COALESCE(p_query, ''))::text, '&', '|'), '')::tsquery;

    RETURN QUERY
    WITH scope AS (
        SELECT d.id, d.template_id
        FROM docs.documents AS d
        JOIN docs.document_types AS ty ON ty.id = d.type_id
        WHERE ops.can_see(d.client_id)
          AND (v_documents IS NULL OR d.id = ANY (v_documents))
          AND (v_types IS NULL OR ty.type_code = ANY (v_types))
          AND (v_entities IS NULL OR EXISTS (
              SELECT 1 FROM docs.document_entities AS de WHERE de.document_id = d.id AND de.entity_id = ANY (v_entities)
          ))
    ),
    by_meaning AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> v_vec) AS rnk, 1 - (c.embedding <=> v_vec) AS similarity
        FROM docs.chunks AS c
        WHERE v_vec IS NOT NULL AND c.embedding IS NOT NULL
          AND c.document_id IN (SELECT id FROM scope)
          AND (v_tags IS NULL OR c.tags @> v_tags)
        ORDER BY c.embedding <=> v_vec
        LIMIT 60
    ),
    by_words AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, v_words) DESC, c.seq) AS rnk
        FROM docs.chunks AS c
        WHERE v_words IS NOT NULL AND c.tsv @@ v_words
          AND c.document_id IN (SELECT id FROM scope)
          AND (v_tags IS NULL OR c.tags @> v_tags)
        ORDER BY ts_rank_cd(c.tsv, v_words) DESC, c.seq
        LIMIT 60
    ),
    -- The closest topic and the closest top section of each template in scope.
    routes AS (
        SELECT r.template_id, r.kind, r.code,
               ROW_NUMBER() OVER (PARTITION BY r.template_id, r.kind ORDER BY r.embedding <=> v_vec) AS rn
        FROM docs.template_routes AS r
        WHERE v_vec IS NOT NULL AND r.template_id IN (SELECT template_id FROM scope)
    ),
    routed AS (
        SELECT c.id, r.kind, r.code, c.embedding <=> v_vec AS distance
        FROM routes AS r
        JOIN scope AS s ON s.template_id = r.template_id
        JOIN docs.chunks AS c ON c.document_id = s.id
         AND c.tags @> ARRAY[CASE r.kind WHEN 'TOPIC' THEN 'topic:' || lower(r.code) ELSE 'section:' || r.code END]
        WHERE r.rn = 1 AND c.embedding IS NOT NULL
          AND (v_tags IS NULL OR c.tags @> v_tags)
    ),
    by_topic AS (
        SELECT t.id, t.code, ROW_NUMBER() OVER (ORDER BY t.distance) AS rnk
        FROM routed AS t WHERE t.kind = 'TOPIC'
        ORDER BY t.distance
        LIMIT 20
    ),
    by_section AS (
        SELECT t.id, t.code, ROW_NUMBER() OVER (ORDER BY t.distance) AS rnk
        FROM routed AS t WHERE t.kind = 'SECTION'
        ORDER BY t.distance
        LIMIT 20
    ),
    ids AS (
        SELECT id FROM by_meaning UNION SELECT id FROM by_words UNION SELECT id FROM by_topic UNION SELECT id FROM by_section
    ),
    fused AS (
        SELECT i.id,
               COALESCE(1.0 / (60 + m.rnk), 0) + COALESCE(1.0 / (60 + w.rnk), 0)
                   + COALESCE(0.75 / (60 + t.rnk), 0) + COALESCE(0.4 / (60 + s.rnk), 0) AS score,
               m.similarity, m.rnk AS meaning_rank, w.rnk AS word_rank,
               t.code AS topic_route, s.code AS section_route
        FROM ids AS i
        LEFT JOIN by_meaning AS m ON m.id = i.id
        LEFT JOIN by_words AS w ON w.id = i.id
        LEFT JOIN by_topic AS t ON t.id = i.id
        LEFT JOIN by_section AS s ON s.id = i.id
    )
    SELECT jsonb_build_object(
        'chunk_id', c.id, 'document_id', d.id, 'document_title', d.title, 'document_date', d.document_date,
        'type_code', ty.type_code, 'type_name', ty.type_name,
        'section_id', s.id, 'section_number', s.number, 'section_heading', s.heading,
        'parent_heading', p.heading, 'template_section_code', COALESCE(s.template_section_code, p.template_section_code),
        'kind', c.kind, 'text', c.text, 'char_start', c.char_start, 'char_end', c.char_end,
        'locator', c.locator, 'tags', c.tags, 'summary', c.summary,
        'score', round(f.score::numeric, 6), 'similarity', round(f.similarity::numeric, 4),
        'meaning_rank', f.meaning_rank, 'word_rank', f.word_rank,
        'topic_route', f.topic_route, 'section_route', f.section_route,
        'entities', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('entity_id', e.id, 'entity_name', e.entity_name, 'role', de.role) ORDER BY e.entity_name)
            FROM docs.document_entities AS de
            JOIN entity_instances.master_entities AS e ON e.id = de.entity_id
            WHERE de.document_id = d.id
        ), '[]'::jsonb)
    )
    FROM fused AS f
    JOIN docs.chunks AS c ON c.id = f.id
    JOIN docs.documents AS d ON d.id = c.document_id
    JOIN docs.document_types AS ty ON ty.id = d.type_id
    LEFT JOIN docs.sections AS s ON s.id = c.section_id
    LEFT JOIN docs.sections AS p ON p.document_id = s.document_id AND p.seq = s.parent_seq
    ORDER BY f.score DESC, c.seq
    LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.document_chunks_to_refine(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.document_chunks_refined(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_chunks_to_refine(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.document_chunks_refined(UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.document_template_save(UUID, UUID, UUID, JSONB, TEXT, UUID[], JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_template_route_labels(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_template_routes_save(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_chunk_refine(UUID, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_template_save(UUID, UUID, UUID, JSONB, TEXT, UUID[], JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_template_route_labels(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_template_routes_save(UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_chunk_refine(UUID, TEXT, TEXT[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
