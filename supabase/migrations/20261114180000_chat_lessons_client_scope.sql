-- Chat lessons belong to a client.
--
-- A lesson is text the assistant reads as part of its instructions. The table
-- had no owner and its UPDATE policy was USING (true), so a signed-in user at
-- one client could write or rewrite instructions the assistant then followed
-- for every other client. Each lesson now carries the client it was taught in,
-- and every policy checks it.
--
-- Every statement here is safe to repeat.

ALTER TABLE public.chat_lessons
    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE;

-- Lessons taught so far came from the default client, so it keeps them.
UPDATE public.chat_lessons
   SET client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
 WHERE client_id IS NULL;

-- A lesson with no owner would be invisible under the policies below; remove
-- any that could not be assigned rather than leave rows nobody can see.
DELETE FROM public.chat_lessons WHERE client_id IS NULL;

ALTER TABLE public.chat_lessons ALTER COLUMN client_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_lessons_client_active
    ON public.chat_lessons(client_id) WHERE is_active;

-- The assistant saves a lesson without naming a client. Fill it from the
-- session: the impersonated client in support mode, else the caller's own.
CREATE OR REPLACE FUNCTION public.chat_lessons_set_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, tenancy, pg_temp
AS $$
BEGIN
    IF NEW.client_id IS NULL THEN
        SELECT c INTO NEW.client_id FROM tenancy.current_client_ids() AS c LIMIT 1;
    END IF;
    IF NEW.client_id IS NULL THEN
        RAISE EXCEPTION 'Choose a client before saving a lesson.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_lessons_set_client ON public.chat_lessons;
CREATE TRIGGER chat_lessons_set_client
    BEFORE INSERT ON public.chat_lessons
    FOR EACH ROW EXECUTE FUNCTION public.chat_lessons_set_client();

-- The owner of a lesson never changes.
CREATE OR REPLACE FUNCTION public.chat_lessons_keep_client()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.client_id := OLD.client_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_lessons_keep_client ON public.chat_lessons;
CREATE TRIGGER chat_lessons_keep_client
    BEFORE UPDATE ON public.chat_lessons
    FOR EACH ROW EXECUTE FUNCTION public.chat_lessons_keep_client();

DROP POLICY IF EXISTS "Chat lessons readable by authenticated" ON public.chat_lessons;
CREATE POLICY "Chat lessons readable by authenticated" ON public.chat_lessons
    FOR SELECT TO authenticated
    USING (is_active AND client_id IN (SELECT tenancy.current_client_ids()));

DROP POLICY IF EXISTS "Chat lessons insertable by authenticated" ON public.chat_lessons;
CREATE POLICY "Chat lessons insertable by authenticated" ON public.chat_lessons
    FOR INSERT TO authenticated
    WITH CHECK (created_by = auth.uid() AND client_id IN (SELECT tenancy.current_client_ids()));

DROP POLICY IF EXISTS "Chat lessons updatable by authenticated" ON public.chat_lessons;
CREATE POLICY "Chat lessons updatable by authenticated" ON public.chat_lessons
    FOR UPDATE TO authenticated
    USING (client_id IN (SELECT tenancy.current_client_ids()))
    WITH CHECK (client_id IN (SELECT tenancy.current_client_ids()));

COMMENT ON COLUMN public.chat_lessons.client_id IS
    'Client the lesson was taught in. Only that client''s users read or change it.';
