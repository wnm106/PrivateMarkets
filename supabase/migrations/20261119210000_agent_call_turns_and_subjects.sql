-- Group model calls by turn, conversation and subject.
--
-- One chat reply, one narrative section or one workflow step can make
-- several model calls (one for each tool round). Each call keeps its own audit row,
-- because each has its own thinking, latency and outcome. These columns let
-- usage add them back up:
--
--   turn_id          one user request: a chat reply, a section, a step
--   conversation_id  the chat thread the turn belongs to
--   subject_*        what the work was about: a document, a narrative run,
--                    a workflow run, a feed, a fund
--
-- The harness writes them into metadata. These columns are generated from it, so
-- the record_agent_call signature does not change, and rows already written
-- with a conversationId are grouped too.

ALTER TABLE ops.agent_calls
    ADD COLUMN IF NOT EXISTS turn_id TEXT
        GENERATED ALWAYS AS (NULLIF(left(metadata->>'turnId', 120), '')) STORED,
    ADD COLUMN IF NOT EXISTS conversation_id TEXT
        GENERATED ALWAYS AS (NULLIF(left(metadata->>'conversationId', 120), '')) STORED,
    ADD COLUMN IF NOT EXISTS subject_type TEXT
        GENERATED ALWAYS AS (NULLIF(left(metadata->>'subjectType', 60), '')) STORED,
    ADD COLUMN IF NOT EXISTS subject_id TEXT
        GENERATED ALWAYS AS (NULLIF(left(metadata->>'subjectId', 200), '')) STORED,
    ADD COLUMN IF NOT EXISTS subject_label TEXT
        GENERATED ALWAYS AS (NULLIF(left(metadata->>'subjectLabel', 300), '')) STORED;

CREATE INDEX IF NOT EXISTS idx_agent_calls_turn ON ops.agent_calls (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_calls_conversation ON ops.agent_calls (conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_calls_subject ON ops.agent_calls (subject_type, subject_id, created_at DESC) WHERE subject_type IS NOT NULL;

COMMENT ON COLUMN ops.agent_calls.turn_id IS 'One user request. Every model call made while answering it shares this id.';
COMMENT ON COLUMN ops.agent_calls.conversation_id IS 'The chat conversation the call was made for.';
COMMENT ON COLUMN ops.agent_calls.subject_type IS 'What the work was about: document, narrative-run, workflow-run, feed, fund, file.';

-- The usage function gains turn, conversation and subject filters and rollups.
DROP FUNCTION IF EXISTS public.agent_usage(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.agent_usage(
    p_days INTEGER DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_feature TEXT DEFAULT NULL,
    p_agent TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_model TEXT DEFAULT NULL,
    p_turn_id TEXT DEFAULT NULL,
    p_conversation_id TEXT DEFAULT NULL,
    p_subject_type TEXT DEFAULT NULL,
    p_subject_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_to TIMESTAMPTZ := COALESCE(p_to, NOW());
    v_from TIMESTAMPTZ := COALESCE(p_from, v_to - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 366)));
    v_feature TEXT := NULLIF(btrim(COALESCE(p_feature, '')), '');
    v_agent TEXT := NULLIF(btrim(COALESCE(p_agent, '')), '');
    v_model TEXT := NULLIF(btrim(COALESCE(p_model, '')), '');
    v_turn TEXT := NULLIF(btrim(COALESCE(p_turn_id, '')), '');
    v_conversation TEXT := NULLIF(btrim(COALESCE(p_conversation_id, '')), '');
    v_subject_type TEXT := NULLIF(btrim(COALESCE(p_subject_type, '')), '');
    v_subject_id TEXT := NULLIF(btrim(COALESCE(p_subject_id, '')), '');
    v_result JSONB;
BEGIN
    IF auth.uid() IS NULL AND NOT ops.is_service_role() THEN
        RAISE EXCEPTION 'Sign in to review agent usage';
    END IF;
    IF v_from > v_to THEN
        RAISE EXCEPTION 'The start of the period is after the end';
    END IF;
    IF v_to - v_from > INTERVAL '366 days' THEN
        RAISE EXCEPTION 'Choose a period of a year or less';
    END IF;

    WITH visible AS (
        SELECT c.*,
               -- A call made outside any request stands as its own turn.
               COALESCE(c.turn_id, c.id::text) AS turn_key,
               COALESCE(pr.display_name, u.email, 'System') AS user_label,
               cl.client_name
        FROM ops.agent_calls c
        LEFT JOIN tenancy.profiles pr ON pr.id = c.user_id
        LEFT JOIN auth.users u ON u.id = c.user_id
        LEFT JOIN tenancy.clients cl ON cl.id = c.client_id
        WHERE c.created_at >= v_from
          AND c.created_at < v_to
          AND ops.agent_call_visible(c.client_id)
    ),
    matched AS (
        SELECT * FROM visible
        WHERE (v_feature IS NULL OR feature = v_feature)
          AND (v_agent IS NULL OR agent = v_agent)
          AND (p_user_id IS NULL OR user_id = p_user_id)
          AND (v_model IS NULL OR model = v_model)
          AND (v_turn IS NULL OR turn_key = v_turn)
          AND (v_conversation IS NULL OR conversation_id = v_conversation)
          AND (v_subject_type IS NULL OR subject_type = v_subject_type)
          AND (v_subject_id IS NULL OR subject_id = v_subject_id)
    ),
    totals AS (
        SELECT count(*) AS calls,
               count(DISTINCT turn_key) AS turns,
               COALESCE(sum(input_tokens), 0) AS input_tokens,
               COALESCE(sum(output_tokens), 0) AS output_tokens,
               COALESCE(sum(thinking_tokens), 0) AS thinking_tokens,
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd,
               count(*) FILTER (WHERE status = 'error') AS errors
        FROM matched
    ),
    by_feature AS (
        SELECT feature AS key, count(*) AS calls, count(DISTINCT turn_key) AS turns,
               COALESCE(sum(total_tokens), 0) AS total_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched GROUP BY feature
    ),
    by_agent AS (
        SELECT COALESCE(agent, 'Unnamed') AS key, feature, count(*) AS calls, count(DISTINCT turn_key) AS turns,
               COALESCE(sum(total_tokens), 0) AS total_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched GROUP BY agent, feature
    ),
    by_user AS (
        SELECT user_id, min(user_label) AS label, count(*) AS calls, count(DISTINCT turn_key) AS turns,
               COALESCE(sum(total_tokens), 0) AS total_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched GROUP BY user_id
    ),
    by_model AS (
        SELECT model AS key, min(provider) AS provider, count(*) AS calls,
               COALESCE(sum(input_tokens), 0) AS input_tokens,
               COALESCE(sum(output_tokens), 0) AS output_tokens,
               COALESCE(sum(thinking_tokens), 0) AS thinking_tokens,
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched GROUP BY model
    ),
    by_day AS (
        SELECT (created_at AT TIME ZONE 'America/New_York')::date AS day,
               count(*) AS calls,
               count(DISTINCT turn_key) AS turns,
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched
        GROUP BY 1
    ),
    by_turn AS (
        SELECT turn_key AS key,
               min(created_at) AS started_at,
               max(created_at) AS ended_at,
               min(user_label) AS user_label,
               min(client_name) AS client_name,
               -- The first call names the turn. Nested calls may carry a narrower activity.
               (array_agg(feature ORDER BY created_at))[1] AS feature,
               (array_agg(activity ORDER BY created_at))[1] AS activity,
               (array_agg(agent ORDER BY created_at))[1] AS agent,
               max(conversation_id) AS conversation_id,
               max(subject_type) AS subject_type,
               max(subject_id) AS subject_id,
               max(subject_label) AS subject_label,
               array_agg(DISTINCT model ORDER BY model) AS models,
               count(*) AS calls,
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(thinking_tokens), 0) AS thinking_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd,
               COALESCE(sum(latency_ms), 0) AS latency_ms,
               count(*) FILTER (WHERE status = 'error') AS errors
        FROM matched
        GROUP BY turn_key
        ORDER BY min(created_at) DESC
        LIMIT 120
    ),
    by_conversation AS (
        SELECT m.conversation_id AS key,
               min(conv.title) AS title,
               min(m.user_label) AS user_label,
               min(m.created_at) AS started_at,
               max(m.created_at) AS last_at,
               count(*) AS calls,
               count(DISTINCT m.turn_key) AS turns,
               COALESCE(sum(m.total_tokens), 0) AS total_tokens,
               COALESCE(sum(m.cost_usd), 0) AS cost_usd
        FROM matched m
        LEFT JOIN public.chat_conversations conv ON conv.id::text = m.conversation_id
        WHERE m.conversation_id IS NOT NULL
        GROUP BY m.conversation_id
        ORDER BY max(m.created_at) DESC
        LIMIT 120
    ),
    by_subject AS (
        SELECT subject_type AS type,
               subject_id AS key,
               max(subject_label) AS label,
               min(feature) AS feature,
               min(created_at) AS started_at,
               max(created_at) AS last_at,
               count(*) AS calls,
               count(DISTINCT turn_key) AS turns,
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched
        WHERE subject_type IS NOT NULL
        GROUP BY subject_type, subject_id
        ORDER BY sum(cost_usd) DESC, max(created_at) DESC
        LIMIT 120
    ),
    recent AS (
        SELECT * FROM matched ORDER BY created_at DESC LIMIT 80
    )
    SELECT jsonb_build_object(
        'from', v_from,
        'to', v_to,
        'totals', (SELECT jsonb_build_object(
            'calls', calls,
            'turns', turns,
            'inputTokens', input_tokens,
            'outputTokens', output_tokens,
            'thinkingTokens', thinking_tokens,
            'totalTokens', total_tokens,
            'costUsd', cost_usd::float8,
            'errors', errors
        ) FROM totals),
        'facets', jsonb_build_object(
            'features', COALESCE((SELECT jsonb_agg(DISTINCT feature ORDER BY feature) FROM visible), '[]'::jsonb),
            'agents', COALESCE((SELECT jsonb_agg(DISTINCT agent ORDER BY agent) FROM visible WHERE agent IS NOT NULL), '[]'::jsonb),
            'models', COALESCE((SELECT jsonb_agg(DISTINCT model ORDER BY model) FROM visible), '[]'::jsonb),
            'subjectTypes', COALESCE((SELECT jsonb_agg(DISTINCT subject_type ORDER BY subject_type) FROM visible WHERE subject_type IS NOT NULL), '[]'::jsonb),
            'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', user_id, 'label', label) ORDER BY label)
                               FROM (SELECT DISTINCT user_id, user_label AS label FROM visible) u), '[]'::jsonb)
        ),
        'byFeature', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'calls', calls, 'turns', turns, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, key) FROM by_feature), '[]'::jsonb),
        'byAgent', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'feature', feature, 'calls', calls, 'turns', turns, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, key) FROM by_agent), '[]'::jsonb),
        'byUser', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'userId', user_id, 'label', label, 'calls', calls, 'turns', turns, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, label) FROM by_user), '[]'::jsonb),
        'byModel', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'provider', provider, 'calls', calls,
            'inputTokens', input_tokens, 'outputTokens', output_tokens, 'thinkingTokens', thinking_tokens,
            'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, key) FROM by_model), '[]'::jsonb),
        'byDay', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'day', day, 'calls', calls, 'turns', turns, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY day) FROM by_day), '[]'::jsonb),
        'byTurn', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key,
            'startedAt', started_at,
            'endedAt', ended_at,
            'userLabel', user_label,
            'clientName', client_name,
            'feature', feature,
            'activity', activity,
            'agent', agent,
            'conversationId', conversation_id,
            'subjectType', subject_type,
            'subjectId', subject_id,
            'subjectLabel', subject_label,
            'models', to_jsonb(models),
            'calls', calls,
            'totalTokens', total_tokens,
            'thinkingTokens', thinking_tokens,
            'costUsd', cost_usd::float8,
            'latencyMs', latency_ms,
            'errors', errors
        ) ORDER BY started_at DESC) FROM by_turn), '[]'::jsonb),
        'byConversation', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'title', title, 'userLabel', user_label, 'startedAt', started_at, 'lastAt', last_at,
            'calls', calls, 'turns', turns, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY last_at DESC) FROM by_conversation), '[]'::jsonb),
        'bySubject', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'type', type, 'key', key, 'label', label, 'feature', feature, 'startedAt', started_at, 'lastAt', last_at,
            'calls', calls, 'turns', turns, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, last_at DESC) FROM by_subject), '[]'::jsonb),
        'calls', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', id,
            'createdAt', created_at,
            'clientId', client_id,
            'clientName', client_name,
            'userId', user_id,
            'userLabel', user_label,
            'feature', feature,
            'activity', activity,
            'agent', agent,
            'provider', provider,
            'model', model,
            'turnId', turn_key,
            'conversationId', conversation_id,
            'subjectType', subject_type,
            'subjectId', subject_id,
            'subjectLabel', subject_label,
            'inputTokens', input_tokens,
            'outputTokens', output_tokens,
            'thinkingTokens', thinking_tokens,
            'totalTokens', total_tokens,
            'costUsd', cost_usd::float8,
            'status', status,
            'error', error,
            'latencyMs', latency_ms,
            'hasThinking', thinking IS NOT NULL AND thinking <> '',
            'thinkingPreview', CASE WHEN thinking IS NULL OR thinking = '' THEN NULL ELSE left(thinking, 500) END
        ) ORDER BY created_at DESC) FROM recent), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.agent_usage IS
    'Token use and cost for the clients this session can see, over a period, with breakdowns by feature, agent, user, model, day, turn, conversation and subject.';

REVOKE ALL ON FUNCTION public.agent_usage(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_usage(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- One call also reports the turn, conversation and subject it belongs to.
CREATE OR REPLACE FUNCTION public.agent_call(p_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id,
        'createdAt', c.created_at,
        'clientId', c.client_id,
        'clientName', cl.client_name,
        'userId', c.user_id,
        'userLabel', COALESCE(pr.display_name, u.email, 'System'),
        'feature', c.feature,
        'activity', c.activity,
        'agent', c.agent,
        'provider', c.provider,
        'model', c.model,
        'turnId', COALESCE(c.turn_id, c.id::text),
        'conversationId', c.conversation_id,
        'subjectType', c.subject_type,
        'subjectId', c.subject_id,
        'subjectLabel', c.subject_label,
        'inputTokens', c.input_tokens,
        'outputTokens', c.output_tokens,
        'thinkingTokens', c.thinking_tokens,
        'cachedInputTokens', c.cached_input_tokens,
        'totalTokens', c.total_tokens,
        'costUsd', c.cost_usd::float8,
        'priceInputPerMillion', c.price_input_per_million::float8,
        'priceOutputPerMillion', c.price_output_per_million::float8,
        'priceThinkingPerMillion', c.price_thinking_per_million::float8,
        'thinking', c.thinking,
        'status', c.status,
        'error', c.error,
        'latencyMs', c.latency_ms,
        'metadata', c.metadata
    )
    FROM ops.agent_calls c
    LEFT JOIN tenancy.profiles pr ON pr.id = c.user_id
    LEFT JOIN auth.users u ON u.id = c.user_id
    LEFT JOIN tenancy.clients cl ON cl.id = c.client_id
    WHERE c.id = p_id
      AND ops.agent_call_visible(c.client_id);
$$;
