-- Lessons teach the assistant how a phrase is read, queried, and answered.
-- They are shared by authenticated users. A chat correction is saved here so
-- the next question, in any thread, can load the lesson that matches.

CREATE TABLE IF NOT EXISTS public.chat_lessons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phrases TEXT[] NOT NULL,
    reading TEXT NOT NULL,
    query_shape TEXT NOT NULL,
    answer_shape TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_lessons_active ON public.chat_lessons(is_active) WHERE is_active;

COMMENT ON TABLE public.chat_lessons IS
    'Taught readings. phrases are the words a person uses. reading is the meaning. query_shape and answer_shape are what the assistant should do.';

ALTER TABLE public.chat_lessons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Chat lessons readable by authenticated" ON public.chat_lessons;
CREATE POLICY "Chat lessons readable by authenticated" ON public.chat_lessons
    FOR SELECT TO authenticated USING (is_active);

DROP POLICY IF EXISTS "Chat lessons insertable by authenticated" ON public.chat_lessons;
CREATE POLICY "Chat lessons insertable by authenticated" ON public.chat_lessons
    FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Chat lessons updatable by authenticated" ON public.chat_lessons;
CREATE POLICY "Chat lessons updatable by authenticated" ON public.chat_lessons
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.chat_lessons TO authenticated;

INSERT INTO public.chat_lessons (phrases, reading, query_shape, answer_shape)
SELECT
    ARRAY['exposure by fund and industry', 'exposure by fund by industry'],
    'One exposure amount, the sum of market value, crossed by fund and industry. Each fund is a total. The rows under it are that fund''s industry exposures and they add up to the fund. Share of fund is the industry amount divided by the fund total. A missing industry is Unclassified and still has its dollars. This is not a fund total plus a separate count of positions by industry.',
    '{"grain":"entity","start":"DOMAIN","domainCode":"POSITION","lookups":[{"alias":"fund","direction":"UP","relationshipCode":"POSITION_FUND","domainCode":"FUND"},{"alias":"sec","direction":"UP","relationshipCode":"POSITION_SECURITY","domainCode":"SECURITY"},{"alias":"iss","from":"sec","direction":"UP","relationshipCode":"SECURITY_ISSUER","domainCode":"ISSUER"}],"groupBy":["fund.entity_name","iss.INDUSTRY"],"metrics":[{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"}]}',
    'One table with groupBy Fund and columns Fund, Industry, Exposure, Share of fund. Do not add a second table of position counts.'
WHERE NOT EXISTS (
    SELECT 1 FROM public.chat_lessons
    WHERE phrases @> ARRAY['exposure by fund and industry']
);
