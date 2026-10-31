-- Guided assistant skills keep their answer ledger on the conversation so a
-- later turn can refine one decision without replaying the interview.

ALTER TABLE public.chat_conversations
    ADD COLUMN IF NOT EXISTS skill_state JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.chat_conversations.skill_state IS
    'Active guided skill and its answer ledger: skill id, slot statuses, and discovery tools already run.';
