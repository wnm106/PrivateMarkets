-- Document content: the words of a document, kept in tagged sections and
-- searchable by meaning.
--
-- Load data turns a file into a table of values. This keeps the rest: the
-- clauses of an agreement, split where the document splits them, each tied to
-- the records the document is about.
--
--   docs.document_types     the kinds of document (credit agreement, side letter)
--   docs.templates          the sections a kind of document is expected to have.
--                           Versioned: a draft is edited, then published.
--   docs.documents          one row per distinct file per client, with its full text
--   docs.document_entities  the records a document is about, each with a role
--   docs.sections           the document's own headings, each matched to a template section
--   docs.chunks             a clause or definition: the exact words, where they sit
--                           in the document, tags, and a vector
--
-- A chunk's text is always cut from documents.body by its offsets, so a citation
-- is the document's own words. Offsets count characters of body; the reader
-- replaces characters outside the basic plane so that JavaScript and Postgres
-- count the same.
--
-- Tags are plain strings. Those with a prefix are set by the system:
--   type:CREDIT_AGREEMENT   the document type
--   section:NEGATIVE_COVENANTS  the template section, and its parent
--   kind:definition         what the chunk is
--   term:applicable margin  the term a definition defines
-- Anything else is a tag a person put on the document or the template section.
--
-- Direct access to the tables is denied. The functions below own every read
-- and write, as with feeds and jobs. A person sees their client's documents.
-- document.manage lets them add documents and change templates.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS docs;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('documents', 'documents', FALSE, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Objects live under the client's own folder: documents/<client id>/<document id>/<file name>.
DROP POLICY IF EXISTS "Document files readable by client members" ON storage.objects;
CREATE POLICY "Document files readable by client members" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] IN (SELECT c::text FROM tenancy.current_client_ids() AS c)
    );

DROP POLICY IF EXISTS "Document files added by document managers" ON storage.objects;
CREATE POLICY "Document files added by document managers" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] IN (SELECT c::text FROM tenancy.current_client_ids() AS c)
        AND tenancy.has_permission(((storage.foldername(name))[1])::uuid, 'document.manage')
    );

DROP POLICY IF EXISTS "Document files removed by document managers" ON storage.objects;
CREATE POLICY "Document files removed by document managers" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] IN (SELECT c::text FROM tenancy.current_client_ids() AS c)
        AND tenancy.has_permission(((storage.foldername(name))[1])::uuid, 'document.manage')
    );

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS docs.document_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL is a type every client can use.
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    type_code VARCHAR(100) NOT NULL,
    type_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_types_client_code
    ON docs.document_types (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), type_code);

CREATE TABLE IF NOT EXISTS docs.templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL is a template every client's documents of this type fall back to.
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    type_id UUID NOT NULL REFERENCES docs.document_types(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
    -- [{code, title, parentCode, aliases[], tags[], guidance, required, order, seenIn}]
    sections JSONB NOT NULL DEFAULT '[]',
    -- The documents the sections were first drawn from.
    source_document_ids UUID[] NOT NULL DEFAULT '{}',
    notes TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS templates_type_client_version
    ON docs.templates (type_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

CREATE TABLE IF NOT EXISTS docs.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    type_id UUID NOT NULL REFERENCES docs.document_types(id),
    template_id UUID REFERENCES docs.templates(id) ON DELETE SET NULL,
    title VARCHAR(500) NOT NULL,
    file_name VARCHAR(500) NOT NULL,
    media_type VARCHAR(200),
    size_bytes BIGINT,
    sha256 CHAR(64) NOT NULL,
    storage_path TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED', 'PROCESSING', 'READY', 'FAILED')),
    -- What processing is doing now: READING, TAGGING or EMBEDDING.
    stage VARCHAR(20),
    message TEXT,
    document_date DATE,
    tags TEXT[] NOT NULL DEFAULT '{}',
    format VARCHAR(20),
    page_count INTEGER,
    body TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    embedded_count INTEGER NOT NULL DEFAULT 0,
    embedding_model VARCHAR(100),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE (client_id, sha256)
);

CREATE INDEX IF NOT EXISTS documents_client_created ON docs.documents (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_type ON docs.documents (type_id);

CREATE TABLE IF NOT EXISTS docs.document_entities (
    document_id UUID NOT NULL REFERENCES docs.documents(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    -- What the record is to the document: borrower, lender, fund, subject.
    role VARCHAR(100) NOT NULL DEFAULT 'SUBJECT',
    PRIMARY KEY (document_id, entity_id, role)
);

CREATE INDEX IF NOT EXISTS document_entities_entity ON docs.document_entities (entity_id);

CREATE TABLE IF NOT EXISTS docs.sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES docs.documents(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    parent_seq INTEGER,
    level INTEGER NOT NULL,
    number VARCHAR(50),
    heading TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    template_section_code VARCHAR(100),
    -- How the template section was chosen. MANUAL is a person's choice and is kept when the document is tagged again.
    match_method VARCHAR(20) CHECK (match_method IN ('EXACT', 'ALIAS', 'SIMILAR', 'EMBEDDING', 'MANUAL')),
    match_score NUMERIC(5, 4),
    UNIQUE (document_id, seq)
);

CREATE TABLE IF NOT EXISTS docs.chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES docs.documents(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    section_id UUID REFERENCES docs.sections(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'CLAUSE' CHECK (kind IN ('CLAUSE', 'DEFINITION', 'TABLE', 'FRONT')),
    -- The exact words, cut from documents.body at char_start..char_end.
    text TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    -- Where the words sit in the original file: page, clause label, heading path, offsets in the source.
    locator JSONB NOT NULL DEFAULT '{}',
    -- Tags that belong to the chunk itself (kind:, term:).
    own_tags TEXT[] NOT NULL DEFAULT '{}',
    -- Every tag that applies: own, the document's, the section's. Kept by docs.refresh_chunk_tags.
    tags TEXT[] NOT NULL DEFAULT '{}',
    embedding extensions.vector(1024),
    embedding_model VARCHAR(100),
    tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    UNIQUE (document_id, seq)
);

CREATE INDEX IF NOT EXISTS chunks_tags ON docs.chunks USING GIN (tags);
CREATE INDEX IF NOT EXISTS chunks_tsv ON docs.chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding ON docs.chunks USING hnsw (embedding extensions.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_pending ON docs.chunks (document_id, seq) WHERE embedding IS NULL;

ALTER TABLE docs.document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.document_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.chunks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE docs.documents IS 'One row per distinct file per client. body is the whole text; chunks are cut from it.';
COMMENT ON TABLE docs.chunks IS 'A clause or definition: its exact words, where they sit, its tags and its vector.';
COMMENT ON COLUMN docs.chunks.embedding IS 'NULL until the chunk has been embedded. Keyword search works before that.';

INSERT INTO docs.document_types (client_id, type_code, type_name, description) VALUES
    (NULL, 'CREDIT_AGREEMENT', 'Credit agreement', 'A loan or credit facility agreement between a borrower and its lenders.'),
    (NULL, 'LIMITED_PARTNERSHIP_AGREEMENT', 'Limited partnership agreement', 'The agreement that governs a fund and its partners.'),
    (NULL, 'SIDE_LETTER', 'Side letter', 'Terms agreed with one investor alongside the fund agreement.'),
    (NULL, 'SUBSCRIPTION_AGREEMENT', 'Subscription agreement', 'An investor''s commitment to a fund.'),
    (NULL, 'OFFERING_MEMORANDUM', 'Offering memorandum', 'The document a fund or issuer is marketed with.'),
    (NULL, 'OTHER', 'Other document', 'A document of no listed kind.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('document.manage', 'Add and remove documents, link them to records, and change document templates')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'document.manage'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- A shared row (no client) is everyone's to read and a tenant admin's to change.
CREATE OR REPLACE FUNCTION docs.can_read(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT p_client_id IS NULL OR ops.can_see(p_client_id);
$$;

CREATE OR REPLACE FUNCTION docs.can_manage(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN p_client_id IS NULL THEN tenancy.is_tenant_admin()
        ELSE tenancy.has_permission(p_client_id, 'document.manage')
    END;
$$;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION docs.type_json(p_row docs.document_types)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(p_row) || jsonb_build_object(
        'document_count', (SELECT COUNT(*) FROM docs.documents AS d WHERE d.type_id = p_row.id AND ops.can_see(d.client_id)),
        'published_template', (
            SELECT jsonb_build_object('id', t.id, 'version', t.version, 'client_id', t.client_id)
            FROM docs.templates AS t
            WHERE t.type_id = p_row.id AND t.status = 'PUBLISHED' AND docs.can_read(t.client_id)
            ORDER BY (t.client_id IS NULL), t.version DESC
            LIMIT 1
        )
    );
$$;

-- A document as a list shows it: no body.
CREATE OR REPLACE FUNCTION docs.document_json(p_row docs.documents)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, entity_instances, pg_temp
AS $$
    SELECT (to_jsonb(p_row) - 'body') || jsonb_build_object(
        'char_count', COALESCE(length(p_row.body), 0),
        'type_code', ty.type_code,
        'type_name', ty.type_name,
        'template_version', (SELECT t.version FROM docs.templates AS t WHERE t.id = p_row.template_id),
        'entities', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'entity_id', e.id, 'entity_name', e.entity_name, 'entity_code', e.entity_code,
                'domain_code', e.domain_code, 'role', de.role
            ) ORDER BY de.role, e.entity_name)
            FROM docs.document_entities AS de
            JOIN entity_instances.master_entities AS e ON e.id = de.entity_id
            WHERE de.document_id = p_row.id
        ), '[]'::jsonb)
    )
    FROM docs.document_types AS ty
    WHERE ty.id = p_row.type_id;
$$;

-- The template a document of this type and client is tagged with: the client's own
-- published one, else the shared one.
CREATE OR REPLACE FUNCTION docs.current_template(p_type_id UUID, p_client_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    SELECT t.id
    FROM docs.templates AS t
    WHERE t.type_id = p_type_id AND t.status = 'PUBLISHED'
      AND (t.client_id = p_client_id OR t.client_id IS NULL)
    ORDER BY (t.client_id IS NULL), t.version DESC
    LIMIT 1;
$$;

-- Rebuilds chunks.tags for one document from the chunk's own tags, the
-- document's tags and type, and the template section of its heading and the
-- heading above it.
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
           FROM unnest(c.own_tags || v_base || COALESCE((SELECT sec.tags FROM sec WHERE sec.id = c.section_id), '{}')) AS t
           WHERE t IS NOT NULL AND t <> ''
       )
     WHERE c.document_id = p_document_id;
END;
$$;

-- Lower-cased, trimmed, de-duplicated tags. A person cannot set a system tag.
CREATE OR REPLACE FUNCTION docs.clean_tags(p_tags TEXT[])
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(array_agg(DISTINCT t ORDER BY t), '{}')
    FROM (SELECT lower(btrim(x)) AS t FROM unnest(COALESCE(p_tags, '{}')) AS x) AS cleaned
    WHERE t <> '' AND length(t) <= 80 AND t !~ '^(type|section|kind|term):';
$$;

-- Replaces a document's record links. p_links is [{"entityId", "role"}].
CREATE OR REPLACE FUNCTION docs.set_entities(p_document_id UUID, p_client_id UUID, p_links JSONB)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, entity_instances, pg_temp
AS $$
BEGIN
    DELETE FROM docs.document_entities WHERE document_id = p_document_id;
    INSERT INTO docs.document_entities (document_id, entity_id, role)
    SELECT DISTINCT p_document_id, e.id,
           COALESCE(NULLIF(upper(regexp_replace(btrim(COALESCE(link ->> 'role', '')), '[^A-Za-z0-9]+', '_', 'g')), ''), 'SUBJECT')
    FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS link
    JOIN entity_instances.master_entities AS e
      ON e.id = NULLIF(link ->> 'entityId', '')::uuid AND e.client_id = p_client_id;
END;
$$;

-- Puts a document on the job queue. One open run per document.
CREATE OR REPLACE FUNCTION docs.queue_processing(p_document_id UUID, p_client_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, pg_temp
AS $$
DECLARE
    v_key TEXT := 'document:' || p_document_id::text;
    v_run_id UUID;
BEGIN
    INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key, requested_by)
    VALUES (p_client_id, 'document.process', jsonb_build_object('documentId', p_document_id), 5, v_key, auth.uid())
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING id INTO v_run_id;
    IF v_run_id IS NULL THEN
        SELECT id INTO v_run_id FROM ops.job_runs WHERE dedupe_key = v_key AND status IN ('QUEUED', 'RUNNING');
    END IF;
    RETURN v_run_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Document types
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.document_types_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT docs.type_json(ty)
    FROM docs.document_types AS ty
    WHERE docs.can_read(ty.client_id)
    ORDER BY ty.type_name;
$$;

CREATE OR REPLACE FUNCTION public.document_type_save(
    p_id UUID,
    p_client_id UUID,
    p_type_code TEXT,
    p_type_name TEXT,
    p_description TEXT,
    p_is_active BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.document_types;
    v_code TEXT := upper(regexp_replace(btrim(COALESCE(p_type_code, '')), '[^A-Za-z0-9]+', '_', 'g'));
BEGIN
    IF NULLIF(btrim(COALESCE(p_type_name, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A name is required' USING ERRCODE = '22023';
    END IF;
    IF p_id IS NULL THEN
        IF v_code = '' THEN
            RAISE EXCEPTION 'A code is required' USING ERRCODE = '22023';
        END IF;
        IF NOT docs.can_manage(p_client_id) THEN
            RAISE EXCEPTION 'You cannot manage documents for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO docs.document_types (client_id, type_code, type_name, description, is_active, created_by)
        VALUES (p_client_id, v_code, btrim(p_type_name), NULLIF(btrim(COALESCE(p_description, '')), ''), COALESCE(p_is_active, TRUE), auth.uid())
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM docs.document_types WHERE id = p_id;
        IF NOT FOUND OR NOT docs.can_read(v_row.client_id) THEN
            RAISE EXCEPTION 'Document type was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT docs.can_manage(v_row.client_id) THEN
            RAISE EXCEPTION 'You cannot change this document type' USING ERRCODE = '42501';
        END IF;
        UPDATE docs.document_types
           SET type_name = btrim(p_type_name),
               description = NULLIF(btrim(COALESCE(p_description, '')), ''),
               is_active = COALESCE(p_is_active, TRUE),
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;
    RETURN docs.type_json(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.document_templates_list(p_type_id UUID DEFAULT NULL)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(t) || jsonb_build_object('type_code', ty.type_code, 'type_name', ty.type_name)
    FROM docs.templates AS t
    JOIN docs.document_types AS ty ON ty.id = t.type_id
    WHERE docs.can_read(t.client_id)
      AND (p_type_id IS NULL OR t.type_id = p_type_id)
    ORDER BY ty.type_name, t.version DESC;
$$;

-- p_id NULL starts a new draft, numbered after the latest version. Only a draft can be changed.
CREATE OR REPLACE FUNCTION public.document_template_save(
    p_id UUID,
    p_type_id UUID,
    p_client_id UUID,
    p_sections JSONB,
    p_notes TEXT,
    p_source_document_ids UUID[]
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

    IF p_id IS NULL THEN
        SELECT * INTO v_type FROM docs.document_types WHERE id = p_type_id;
        IF NOT FOUND OR NOT docs.can_read(v_type.client_id) THEN
            RAISE EXCEPTION 'Document type was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT docs.can_manage(p_client_id) THEN
            RAISE EXCEPTION 'You cannot change templates for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO docs.templates (client_id, type_id, version, sections, notes, source_document_ids, created_by)
        VALUES (
            p_client_id, p_type_id,
            COALESCE((SELECT MAX(version) FROM docs.templates WHERE type_id = p_type_id AND client_id IS NOT DISTINCT FROM p_client_id), 0) + 1,
            p_sections, NULLIF(btrim(COALESCE(p_notes, '')), ''), COALESCE(p_source_document_ids, '{}'), auth.uid()
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
               notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
               source_document_ids = COALESCE(p_source_document_ids, source_document_ids),
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;
    RETURN to_jsonb(v_row);
END;
$$;

-- Publishing retires the version it replaces. Documents keep the template they
-- were tagged with until they are tagged again.
CREATE OR REPLACE FUNCTION public.document_template_publish(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.templates;
BEGIN
    SELECT * INTO v_row FROM docs.templates WHERE id = p_id;
    IF NOT FOUND OR NOT docs.can_read(v_row.client_id) THEN
        RAISE EXCEPTION 'Template was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot change this template' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Only a draft can be published' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_row.sections) = 0 THEN
        RAISE EXCEPTION 'Add at least one section before publishing' USING ERRCODE = '22023';
    END IF;
    UPDATE docs.templates SET status = 'RETIRED', updated_at = NOW()
     WHERE type_id = v_row.type_id AND client_id IS NOT DISTINCT FROM v_row.client_id AND status = 'PUBLISHED';
    UPDATE docs.templates SET status = 'PUBLISHED', published_at = NOW(), updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;
    RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.document_template_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.templates;
BEGIN
    SELECT * INTO v_row FROM docs.templates WHERE id = p_id;
    IF NOT FOUND OR NOT docs.can_read(v_row.client_id) THEN
        RETURN FALSE;
    END IF;
    IF NOT docs.can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot change this template' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Only a draft can be deleted' USING ERRCODE = '22023';
    END IF;
    DELETE FROM docs.templates WHERE id = p_id;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.documents_list(
    p_type_id UUID DEFAULT NULL,
    p_entity_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT docs.document_json(d)
    FROM docs.documents AS d
    WHERE ops.can_see(d.client_id)
      AND (p_type_id IS NULL OR d.type_id = p_type_id)
      AND (p_entity_id IS NULL OR EXISTS (
          SELECT 1 FROM docs.document_entities AS de WHERE de.document_id = d.id AND de.entity_id = p_entity_id
      ))
    ORDER BY d.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

-- One document with its headings.
CREATE OR REPLACE FUNCTION public.document_get(p_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT docs.document_json(d) || jsonb_build_object(
        'sections', COALESCE((
            SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object(
                'chunk_count', (SELECT COUNT(*) FROM docs.chunks AS c WHERE c.section_id = s.id)
            ) ORDER BY s.seq)
            FROM docs.sections AS s WHERE s.document_id = d.id
        ), '[]'::jsonb)
    )
    FROM docs.documents AS d
    WHERE d.id = p_id AND ops.can_see(d.client_id);
$$;

-- Records a new file and queues it. The same file for the same client returns
-- the document that already holds it, with "duplicate": true.
CREATE OR REPLACE FUNCTION public.document_create(
    p_id UUID,
    p_client_id UUID,
    p_type_id UUID,
    p_title TEXT,
    p_file_name TEXT,
    p_media_type TEXT,
    p_size_bytes BIGINT,
    p_sha256 TEXT,
    p_storage_path TEXT,
    p_document_date DATE,
    p_tags TEXT[],
    p_entity_links JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.documents;
    v_type docs.document_types;
BEGIN
    IF NOT docs.can_manage(p_client_id) OR p_client_id IS NULL THEN
        RAISE EXCEPTION 'You cannot add documents for this client' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_type FROM docs.document_types WHERE id = p_type_id AND is_active;
    IF NOT FOUND OR NOT (v_type.client_id IS NULL OR v_type.client_id = p_client_id) THEN
        RAISE EXCEPTION 'Choose a document type' USING ERRCODE = '22023';
    END IF;
    IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'The file hash is missing' USING ERRCODE = '22023';
    END IF;
    -- The path must be inside the client's own folder.
    IF p_storage_path IS NULL OR split_part(p_storage_path, '/', 1) <> p_client_id::text THEN
        RAISE EXCEPTION 'The file is not in this client''s folder' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row FROM docs.documents WHERE client_id = p_client_id AND sha256 = p_sha256;
    IF FOUND THEN
        RETURN docs.document_json(v_row) || jsonb_build_object('duplicate', TRUE);
    END IF;

    INSERT INTO docs.documents (
        id, client_id, type_id, title, file_name, media_type, size_bytes, sha256, storage_path,
        document_date, tags, created_by
    ) VALUES (
        COALESCE(p_id, gen_random_uuid()), p_client_id, p_type_id,
        COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), p_file_name),
        p_file_name, p_media_type, p_size_bytes, p_sha256, p_storage_path,
        p_document_date, docs.clean_tags(p_tags), auth.uid()
    )
    RETURNING * INTO v_row;

    PERFORM docs.set_entities(v_row.id, p_client_id, p_entity_links);
    PERFORM docs.queue_processing(v_row.id, p_client_id);
    RETURN docs.document_json(v_row) || jsonb_build_object('duplicate', FALSE);
END;
$$;

-- A NULL argument leaves that part as it is.
CREATE OR REPLACE FUNCTION public.document_update(
    p_id UUID,
    p_title TEXT,
    p_type_id UUID,
    p_document_date DATE,
    p_clear_date BOOLEAN,
    p_tags TEXT[],
    p_entity_links JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.documents;
    v_type docs.document_types;
BEGIN
    SELECT * INTO v_row FROM docs.documents WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot change documents for this client' USING ERRCODE = '42501';
    END IF;
    IF p_type_id IS NOT NULL AND p_type_id <> v_row.type_id THEN
        SELECT * INTO v_type FROM docs.document_types WHERE id = p_type_id AND is_active;
        IF NOT FOUND OR NOT (v_type.client_id IS NULL OR v_type.client_id = v_row.client_id) THEN
            RAISE EXCEPTION 'Choose a document type' USING ERRCODE = '22023';
        END IF;
    END IF;

    UPDATE docs.documents
       SET title = COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), title),
           type_id = COALESCE(p_type_id, type_id),
           -- A different type has different sections, so the old matches no longer apply.
           template_id = CASE WHEN p_type_id IS NOT NULL AND p_type_id <> type_id THEN NULL ELSE template_id END,
           document_date = CASE WHEN COALESCE(p_clear_date, FALSE) THEN NULL ELSE COALESCE(p_document_date, document_date) END,
           tags = CASE WHEN p_tags IS NULL THEN tags ELSE docs.clean_tags(p_tags) END,
           updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;

    IF p_type_id IS NOT NULL AND v_row.template_id IS NULL THEN
        UPDATE docs.sections SET template_section_code = NULL, match_method = NULL, match_score = NULL
         WHERE document_id = p_id;
    END IF;
    IF p_entity_links IS NOT NULL THEN
        PERFORM docs.set_entities(p_id, v_row.client_id, p_entity_links);
    END IF;
    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN docs.document_json(v_row);
END;
$$;

-- Returns the stored file's path so the caller can remove the file too.
CREATE OR REPLACE FUNCTION public.document_delete(p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.documents;
BEGIN
    SELECT * INTO v_row FROM docs.documents WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RETURN NULL;
    END IF;
    IF NOT docs.can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot remove documents for this client' USING ERRCODE = '42501';
    END IF;
    DELETE FROM docs.documents WHERE id = p_id;
    RETURN v_row.storage_path;
END;
$$;

-- Reads the file again from the start.
CREATE OR REPLACE FUNCTION public.document_reprocess(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_row docs.documents;
BEGIN
    SELECT * INTO v_row FROM docs.documents WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot change documents for this client' USING ERRCODE = '42501';
    END IF;
    UPDATE docs.documents SET status = 'RECEIVED', stage = NULL, message = NULL, updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;
    PERFORM docs.queue_processing(p_id, v_row.client_id);
    RETURN docs.document_json(v_row);
END;
$$;

-- A person's choice of template section for one heading. An empty code clears it.
CREATE OR REPLACE FUNCTION public.document_section_assign(p_section_id UUID, p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_section docs.sections;
    v_doc docs.documents;
    v_code TEXT := NULLIF(btrim(COALESCE(p_code, '')), '');
BEGIN
    SELECT * INTO v_section FROM docs.sections WHERE id = p_section_id;
    IF FOUND THEN
        SELECT * INTO v_doc FROM docs.documents WHERE id = v_section.document_id;
    END IF;
    IF v_doc.id IS NULL OR NOT ops.can_see(v_doc.client_id) THEN
        RAISE EXCEPTION 'Section was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_doc.client_id) THEN
        RAISE EXCEPTION 'You cannot change documents for this client' USING ERRCODE = '42501';
    END IF;
    IF v_code IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM docs.templates AS t, jsonb_array_elements(t.sections) AS e
        WHERE t.id = v_doc.template_id AND e ->> 'code' = v_code
    ) THEN
        RAISE EXCEPTION 'That section is not in the document''s template' USING ERRCODE = '22023';
    END IF;
    UPDATE docs.sections
       SET template_section_code = v_code,
           match_method = CASE WHEN v_code IS NULL THEN NULL ELSE 'MANUAL' END,
           match_score = NULL
     WHERE id = p_section_id
    RETURNING * INTO v_section;
    PERFORM docs.refresh_chunk_tags(v_doc.id);
    RETURN to_jsonb(v_section);
END;
$$;

-- Records which template section each heading matched. p_matches is
-- [{"seq", "code", "method", "score"}]. Headings a person assigned are left alone.
CREATE OR REPLACE FUNCTION public.document_apply_tagging(p_id UUID, p_template_id UUID, p_matches JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_doc docs.documents;
    v_template docs.templates;
BEGIN
    SELECT * INTO v_doc FROM docs.documents WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_doc.client_id) THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_doc.client_id) THEN
        RAISE EXCEPTION 'You cannot change documents for this client' USING ERRCODE = '42501';
    END IF;
    IF p_template_id IS NOT NULL THEN
        SELECT * INTO v_template FROM docs.templates WHERE id = p_template_id;
        IF NOT FOUND OR v_template.type_id <> v_doc.type_id
           OR NOT (v_template.client_id IS NULL OR v_template.client_id = v_doc.client_id) THEN
            RAISE EXCEPTION 'That template is not for this document' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- A different template: a person's earlier choices named sections of the old one.
    IF v_doc.template_id IS DISTINCT FROM p_template_id THEN
        UPDATE docs.sections AS s
           SET template_section_code = NULL, match_method = NULL, match_score = NULL
         WHERE s.document_id = p_id
           AND (s.match_method IS DISTINCT FROM 'MANUAL' OR p_template_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(v_template.sections) AS e WHERE e ->> 'code' = s.template_section_code
           ));
    ELSE
        UPDATE docs.sections SET template_section_code = NULL, match_method = NULL, match_score = NULL
         WHERE document_id = p_id AND match_method IS DISTINCT FROM 'MANUAL';
    END IF;

    UPDATE docs.sections AS s
       SET template_section_code = m.code, match_method = m.method, match_score = m.score
      FROM jsonb_to_recordset(COALESCE(p_matches, '[]'::jsonb)) AS m(seq INTEGER, code TEXT, method TEXT, score NUMERIC)
     WHERE s.document_id = p_id AND s.seq = m.seq AND s.match_method IS DISTINCT FROM 'MANUAL'
       AND m.code IS NOT NULL;

    UPDATE docs.documents SET template_id = p_template_id, updated_at = NOW() WHERE id = p_id RETURNING * INTO v_doc;
    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN docs.document_json(v_doc);
END;
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
        'tags', c.tags, 'embedded', c.embedding IS NOT NULL
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

-- A stretch of the document's text, at most 20,000 characters, for showing a citation in place.
CREATE OR REPLACE FUNCTION public.document_text(p_id UUID, p_start INTEGER, p_end INTEGER)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT jsonb_build_object(
        'start', GREATEST(COALESCE(p_start, 0), 0),
        'length', length(d.body),
        'text', substr(
            d.body,
            GREATEST(COALESCE(p_start, 0), 0) + 1,
            LEAST(GREATEST(COALESCE(p_end, 0) - GREATEST(COALESCE(p_start, 0), 0), 0), 20000)
        )
    )
    FROM docs.documents AS d
    WHERE d.id = p_id AND ops.can_see(d.client_id);
$$;

-- Every tag on the caller's chunks, with how many chunks carry it.
CREATE OR REPLACE FUNCTION public.document_tags_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
    SELECT jsonb_build_object('tag', t.tag, 'chunks', COUNT(*))
    FROM docs.chunks AS c
    JOIN docs.documents AS d ON d.id = c.document_id
    CROSS JOIN LATERAL unnest(c.tags) AS t(tag)
    WHERE ops.can_see(d.client_id) AND t.tag !~ '^term:'
    GROUP BY t.tag
    ORDER BY COUNT(*) DESC, t.tag
    LIMIT 500;
$$;

-- Search by meaning and by words together. p_embedding is the query's vector
-- written as '[0.1,0.2,...]'; without it only the words are used. Both lists
-- are ranked and joined by reciprocal rank, so a chunk found both ways comes first.
-- p_tags must all be present on a chunk.
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
        SELECT d.id
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
    fused AS (
        SELECT COALESCE(m.id, w.id) AS id,
               COALESCE(1.0 / (60 + m.rnk), 0) + COALESCE(1.0 / (60 + w.rnk), 0) AS score,
               m.similarity, m.rnk AS meaning_rank, w.rnk AS word_rank
        FROM by_meaning AS m
        FULL JOIN by_words AS w ON w.id = m.id
    )
    SELECT jsonb_build_object(
        'chunk_id', c.id, 'document_id', d.id, 'document_title', d.title, 'document_date', d.document_date,
        'type_code', ty.type_code, 'type_name', ty.type_name,
        'section_id', s.id, 'section_number', s.number, 'section_heading', s.heading,
        'parent_heading', p.heading, 'template_section_code', COALESCE(s.template_section_code, p.template_section_code),
        'kind', c.kind, 'text', c.text, 'char_start', c.char_start, 'char_end', c.char_end,
        'locator', c.locator, 'tags', c.tags,
        'score', round(f.score::numeric, 6), 'similarity', round(f.similarity::numeric, 4),
        'meaning_rank', f.meaning_rank, 'word_rank', f.word_rank,
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
-- Processing. Service role only: the worker and the ingest script.
-- ---------------------------------------------------------------------------

-- What the reader needs: the file, the type, and the template to tag against.
CREATE OR REPLACE FUNCTION public.document_job_context(p_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    SELECT (to_jsonb(d) - 'body') || jsonb_build_object(
        'type_code', ty.type_code,
        'has_body', d.body IS NOT NULL,
        'current_template', (
            SELECT jsonb_build_object('id', t.id, 'sections', t.sections)
            FROM docs.templates AS t WHERE t.id = docs.current_template(d.type_id, d.client_id)
        )
    )
    FROM docs.documents AS d
    JOIN docs.document_types AS ty ON ty.id = d.type_id
    WHERE d.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.document_set_status(p_id UUID, p_status TEXT, p_stage TEXT, p_message TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    UPDATE docs.documents
       SET status = p_status, stage = p_stage, message = p_message, updated_at = NOW(),
           processed_at = CASE WHEN p_status = 'READY' THEN NOW() ELSE processed_at END
     WHERE id = p_id;
$$;

-- Replaces a document's text, headings and chunks in one transaction.
--   p_sections [{"seq","parentSeq","level","number","heading","charStart","charEnd"}]
--   p_chunks   [{"seq","sectionSeq","kind","charStart","charEnd","locator","tags"}]
-- Chunk text is cut from p_body here, so it can never differ from the document.
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

    PERFORM docs.refresh_chunk_tags(p_id);
    RETURN jsonb_build_object('chunks', v_count, 'title', v_doc.title);
END;
$$;

-- The next chunks with no vector, with the heading path that is embedded along with the words.
CREATE OR REPLACE FUNCTION public.document_chunks_pending(p_id UUID, p_limit INTEGER DEFAULT 64)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'text', c.text,
        'path', concat_ws(' > ', d.title, p.heading, s.heading)
    )
    FROM docs.chunks AS c
    JOIN docs.documents AS d ON d.id = c.document_id
    LEFT JOIN docs.sections AS s ON s.id = c.section_id
    LEFT JOIN docs.sections AS p ON p.document_id = s.document_id AND p.seq = s.parent_seq
    WHERE c.document_id = p_id AND c.embedding IS NULL
    ORDER BY c.seq
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 64), 1), 256);
$$;

-- Saves vectors. p_rows is [{"id", "embedding": "[...]"}]. Returns how many chunks still wait.
CREATE OR REPLACE FUNCTION public.document_chunks_embedded(p_id UUID, p_model TEXT, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, extensions, pg_temp
AS $$
DECLARE
    v_left INTEGER;
BEGIN
    UPDATE docs.chunks AS c
       SET embedding = (r.embedding)::extensions.vector(1024), embedding_model = p_model
      FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(id UUID, embedding TEXT)
     WHERE c.id = r.id AND c.document_id = p_id;

    SELECT COUNT(*) INTO v_left FROM docs.chunks WHERE document_id = p_id AND embedding IS NULL;
    UPDATE docs.documents
       SET embedded_count = chunk_count - v_left, embedding_model = p_model, updated_at = NOW()
     WHERE id = p_id;
    RETURN v_left;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA docs FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA docs FROM PUBLIC;

REVOKE ALL ON FUNCTION public.document_job_context(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.document_set_status(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.document_store_content(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.document_chunks_pending(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.document_chunks_embedded(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.document_set_status(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.document_store_content(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.document_chunks_pending(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.document_chunks_embedded(UUID, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.document_types_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_type_save(UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_templates_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_template_save(UUID, UUID, UUID, JSONB, TEXT, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_template_publish(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_template_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.documents_list(UUID, UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_create(UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, DATE, TEXT[], JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_update(UUID, TEXT, UUID, DATE, BOOLEAN, TEXT[], JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_reprocess(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_section_assign(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_apply_tagging(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_chunks_list(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_text(UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_tags_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.document_search(TEXT, TEXT, TEXT[], UUID[], TEXT[], UUID[], INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_types_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_type_save(UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_templates_list(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_template_save(UUID, UUID, UUID, JSONB, TEXT, UUID[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_template_publish(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_template_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.documents_list(UUID, UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_get(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_create(UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, DATE, TEXT[], JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_update(UUID, TEXT, UUID, DATE, BOOLEAN, TEXT[], JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_reprocess(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_section_assign(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_apply_tagging(UUID, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_chunks_list(UUID, UUID, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_text(UUID, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_tags_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_search(TEXT, TEXT, TEXT[], UUID[], TEXT[], UUID[], INTEGER) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
