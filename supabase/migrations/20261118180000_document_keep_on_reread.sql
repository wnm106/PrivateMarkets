-- Two corrections to 20261118170000.
--
-- 1. Reading a file again keeps what did not change, as it was meant to.
--
-- document_store_content sets the old chunks aside (a negative seq, no section)
-- and carries their vector, description and topics over to new chunks with the
-- same words, place and heading path. But refresh_chunk_headings rewrote the
-- heading path of every chunk of the document, the ones set aside included, and
-- theirs came out empty. Nothing matched, so every passage was embedded again
-- and a person's descriptions were lost. It now leaves the set-aside chunks alone.

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
     WHERE c.document_id = p_document_id AND c.seq > 0;
$$;

-- 2. The closest top section counts for less in search: 0.2 of a full vote, down
-- from 0.4. A question is always closest to some section, right or not, and at
-- 0.4 a wrong one lifted its passages over the right answer ("governing law"
-- brought the representations forward). A topic keeps 0.75: only the passages a
-- model or a person filed under it carry it. The function is otherwise unchanged.
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
                   + COALESCE(0.75 / (60 + t.rnk), 0) + COALESCE(0.2 / (60 + s.rnk), 0) AS score,
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

NOTIFY pgrst, 'reload schema';
