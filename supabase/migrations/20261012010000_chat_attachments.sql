-- Migration: Chat attachments (screenshots and reference documents)
-- Description: Adds `public.chat_message_attachments` plus a private storage bucket
--              so users can hand the assistant a screenshot or sample HTML to design
--              against. Files are stored per-user and reachable only by their owner.
--
-- Design notes:
--   * The storage object is the source of truth for the bytes; the table holds the
--     metadata and links an upload to the message it was sent with.
--   * `message_id` is nullable so a file can be staged, uploaded and then attached
--     when the turn is sent. An orphaned row (never sent) is harmless and the bytes
--     are quota-bounded by the bucket's file size limit.
--   * Storage object paths are `{auth.uid()}/{uuid}.{ext}`, which is what the
--     storage policies match on -- never trust a client-supplied path.

-- ============================================================
-- 1. Metadata table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_message_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
    -- Null until the turn is sent; set on the user message it accompanied.
    message_id UUID REFERENCES public.chat_messages(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    file_name VARCHAR(300) NOT NULL,
    mime_type VARCHAR(150) NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size > 0),
    storage_path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation
    ON public.chat_message_attachments(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message
    ON public.chat_message_attachments(message_id);

COMMENT ON TABLE public.chat_message_attachments IS 'Files (screenshots, sample HTML) supplied with a chat turn. Private to the uploading user.';
COMMENT ON COLUMN public.chat_message_attachments.storage_path IS 'Object path within the chat-attachments bucket: {auth.uid()}/{uuid}.{ext}';

-- ============================================================
-- 2. Row Level Security -- strictly owner-scoped, like the chat threads
-- ============================================================
ALTER TABLE public.chat_message_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Chat attachments readable by owner" ON public.chat_message_attachments;
CREATE POLICY "Chat attachments readable by owner" ON public.chat_message_attachments
    FOR SELECT TO authenticated USING (uploaded_by = auth.uid());

DROP POLICY IF EXISTS "Chat attachments insertable into owned conversation" ON public.chat_message_attachments;
CREATE POLICY "Chat attachments insertable into owned conversation" ON public.chat_message_attachments
    FOR INSERT TO authenticated
    WITH CHECK (
        uploaded_by = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.chat_conversations c
            WHERE c.id = chat_message_attachments.conversation_id
              AND c.created_by = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Chat attachments updatable by owner" ON public.chat_message_attachments;
CREATE POLICY "Chat attachments updatable by owner" ON public.chat_message_attachments
    FOR UPDATE TO authenticated
    USING (uploaded_by = auth.uid())
    WITH CHECK (uploaded_by = auth.uid());

DROP POLICY IF EXISTS "Chat attachments deletable by owner" ON public.chat_message_attachments;
CREATE POLICY "Chat attachments deletable by owner" ON public.chat_message_attachments
    FOR DELETE TO authenticated USING (uploaded_by = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_message_attachments TO authenticated;

-- ============================================================
-- 3. Private storage bucket
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'chat-attachments',
    'chat-attachments',
    FALSE,
    5242880, -- 5 MB per file: a screenshot or a document, not a data dump
    ARRAY[
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'text/plain', 'text/html', 'text/markdown', 'text/csv',
        'application/json', 'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
)
ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Users may only touch objects under their own {uid}/ prefix.
DROP POLICY IF EXISTS "Chat attachment objects readable by owner" ON storage.objects;
CREATE POLICY "Chat attachment objects readable by owner" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Chat attachment objects insertable by owner" ON storage.objects;
CREATE POLICY "Chat attachment objects insertable by owner" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Chat attachment objects updatable by owner" ON storage.objects;
CREATE POLICY "Chat attachment objects updatable by owner" ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Chat attachment objects deletable by owner" ON storage.objects;
CREATE POLICY "Chat attachment objects deletable by owner" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
