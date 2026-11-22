-- A change the assistant held for confirmation runs once.
--
-- The chat holds every call that changes data for the person to confirm
-- (apps/web/lib/held-actions.ts). The hold is a signed token that is good for
-- fifteen minutes; pressing Confirm twice, or replaying the request, would have
-- run the change twice. /api/chat/confirm records the hold here before running
-- it, and a hold already recorded is refused.

CREATE TABLE IF NOT EXISTS public.chat_held_action_uses (
    hold_id UUID PRIMARY KEY,
    user_id UUID NOT NULL DEFAULT auth.uid(),
    client_id UUID NOT NULL,
    tool TEXT NOT NULL,
    used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.chat_held_action_uses IS
    'Each held assistant change that was confirmed, so a confirmation runs once.';

ALTER TABLE public.chat_held_action_uses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_held_action_uses FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.chat_held_action_uses TO authenticated;
GRANT ALL ON public.chat_held_action_uses TO service_role;

-- A person records and sees only their own confirmations, for a client they belong to.
CREATE POLICY "Own held action uses are readable" ON public.chat_held_action_uses
    FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Own held action uses are recorded" ON public.chat_held_action_uses
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND client_id IN (SELECT tenancy.current_client_ids()));
