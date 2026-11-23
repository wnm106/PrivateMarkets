-- Filing tables and lists again when a document's topics change.
--
-- A thin passage is described, and filed under topics, when the document is
-- first read. The topics come from the type's published template. For a new
-- type there is no template yet, so the passages get a description and no
-- topics, and publishing a template afterwards did not go back for them. The
-- same happens when a later version of a template changes its topics.
--
-- document_refile clears what the model wrote for a document and queues the
-- document, so the worker describes those passages again against the topics the
-- document has now. What a person wrote is left alone. Nothing else is read or
-- embedded again.

CREATE OR REPLACE FUNCTION public.document_refile(p_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = docs, ops, tenancy, pg_temp
AS $$
DECLARE
    v_doc docs.documents;
    v_count INTEGER;
BEGIN
    SELECT * INTO v_doc FROM docs.documents WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_doc.client_id) THEN
        RAISE EXCEPTION 'Document was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT docs.can_manage(v_doc.client_id) THEN
        RAISE EXCEPTION 'You cannot change documents for this client' USING ERRCODE = '42501';
    END IF;

    -- The description stays until the new one is written, so search keeps working meanwhile.
    UPDATE docs.chunks
       SET refined_by = NULL
     WHERE document_id = p_id AND thin AND refined_by = 'MODEL';
    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count > 0 THEN
        UPDATE docs.documents
           SET status = 'PROCESSING', stage = 'REFINING', message = NULL, updated_at = NOW()
         WHERE id = p_id;
        PERFORM docs.queue_processing(p_id, v_doc.client_id);
    END IF;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.document_refile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_refile(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
