-- Migration: Chat History (per-user assistant conversations)
-- Description: Adds `public.chat_conversations` and `public.chat_messages` so each
--              user can keep multiple assistant threads and revisit them.
--
-- Ownership model: a conversation belongs to exactly one auth user (chosen so
-- tenant admins in support mode never see another user's private assistant
-- history). Every policy is therefore keyed on `created_by = auth.uid()`.
--
-- Scope note: `tool_context` is recorded per conversation so history can be
-- grouped/filtered by where it was started, but thread identity deliberately
-- excludes it: the chat panel mints a conversation once and keeps using it as
-- the page changes, which avoids silently forking a thread on navigation.

-- ============================================================
-- 1. Conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL DEFAULT 'New chat',
    -- Last page/domain/entity the thread was used from, for context hints in history.
    tool_context VARCHAR(50),
    page_context VARCHAR(200),
    domain_code VARCHAR(50),
    entity_id UUID,
    -- Denormalised for cheap history listing without a per-conversation count query.
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_owner_recent
    ON public.chat_conversations(created_by, last_message_at DESC NULLS LAST, created_at DESC);

COMMENT ON TABLE public.chat_conversations IS 'Per-user assistant threads. Private to the owning auth user.';
COMMENT ON COLUMN public.chat_conversations.title IS 'Derived from the first user message; may be renamed by the owner.';
COMMENT ON COLUMN public.chat_conversations.message_count IS 'Denormalised message count, maintained by trigger on chat_messages.';
COMMENT ON COLUMN public.chat_conversations.tool_context IS 'Tool context profile the thread was last used from (mcp-server context profile name).';

-- ============================================================
-- 2. Messages
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    -- Tool names invoked while producing an assistant turn (no argument payloads).
    tool_calls JSONB,
    model VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
    ON public.chat_messages(conversation_id, created_at);

COMMENT ON TABLE public.chat_messages IS 'Individual turns within a chat_conversations thread.';
COMMENT ON COLUMN public.chat_messages.tool_calls IS 'Array of { name, args } for tool calls made while producing this turn.';

-- ============================================================
-- 3. Triggers: touch conversation + maintain message_count
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_chat_conversation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_conversations_updated_at ON public.chat_conversations;
CREATE TRIGGER trg_chat_conversations_updated_at
    BEFORE UPDATE ON public.chat_conversations
    FOR EACH ROW EXECUTE FUNCTION public.touch_chat_conversation();

-- Keeps message_count / last_message_at accurate without extra round trips.
CREATE OR REPLACE FUNCTION public.sync_chat_conversation_stats()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.chat_conversations
        SET message_count = message_count + 1,
            last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
            updated_at = NOW()
        WHERE id = NEW.conversation_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE public.chat_conversations
        SET message_count = GREATEST(message_count - 1, 0),
            updated_at = NOW()
        WHERE id = OLD.conversation_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_messages_stats ON public.chat_messages;
CREATE TRIGGER trg_chat_messages_stats
    AFTER INSERT OR DELETE ON public.chat_messages
    FOR EACH ROW EXECUTE FUNCTION public.sync_chat_conversation_stats();

-- ============================================================
-- 4. Row Level Security — strictly owner-scoped
-- ============================================================
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Chat conversations readable by owner" ON public.chat_conversations;
CREATE POLICY "Chat conversations readable by owner" ON public.chat_conversations
    FOR SELECT TO authenticated USING (created_by = auth.uid());

DROP POLICY IF EXISTS "Chat conversations insertable by owner" ON public.chat_conversations;
CREATE POLICY "Chat conversations insertable by owner" ON public.chat_conversations
    FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Chat conversations updatable by owner" ON public.chat_conversations;
CREATE POLICY "Chat conversations updatable by owner" ON public.chat_conversations
    FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Chat conversations deletable by owner" ON public.chat_conversations;
CREATE POLICY "Chat conversations deletable by owner" ON public.chat_conversations
    FOR DELETE TO authenticated USING (created_by = auth.uid());

-- Messages inherit ownership from their conversation (no direct owner column).
DROP POLICY IF EXISTS "Chat messages readable via owned conversation" ON public.chat_messages;
CREATE POLICY "Chat messages readable via owned conversation" ON public.chat_messages
    FOR SELECT TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.chat_conversations c
            WHERE c.id = chat_messages.conversation_id AND c.created_by = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Chat messages insertable via owned conversation" ON public.chat_messages;
CREATE POLICY "Chat messages insertable via owned conversation" ON public.chat_messages
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chat_conversations c
            WHERE c.id = chat_messages.conversation_id AND c.created_by = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Chat messages deletable via owned conversation" ON public.chat_messages;
CREATE POLICY "Chat messages deletable via owned conversation" ON public.chat_messages
    FOR DELETE TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.chat_conversations c
            WHERE c.id = chat_messages.conversation_id AND c.created_by = auth.uid()
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversations TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_messages TO authenticated;
