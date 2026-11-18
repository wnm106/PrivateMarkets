-- An audit row for every model call.
--
-- Chat, narratives, workflow agents, reconciliation insights, statement
-- reading, and feed intake all go through one harness. Each call records who
-- asked, which client it was for, which model ran, the token counts, the
-- cost, and the model's thinking. The row is append-only. People read it
-- through agent_usage, which stays inside the clients their session can see.

CREATE TABLE IF NOT EXISTS ops.agent_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE SET NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    feature TEXT NOT NULL,
    activity TEXT NOT NULL,
    agent TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    thinking_tokens INTEGER NOT NULL DEFAULT 0 CHECK (thinking_tokens >= 0),
    cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    cost_usd NUMERIC(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    price_input_per_million NUMERIC(12, 6),
    price_output_per_million NUMERIC(12, 6),
    price_thinking_per_million NUMERIC(12, 6),
    thinking TEXT,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    error TEXT,
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_calls_client_created ON ops.agent_calls (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_calls_user_created ON ops.agent_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_calls_feature_created ON ops.agent_calls (feature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_calls_agent_created ON ops.agent_calls (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_calls_model_created ON ops.agent_calls (model, created_at DESC);

COMMENT ON TABLE ops.agent_calls IS
    'One row per model call: the user, the client, the feature, the model, token counts, cost, and thinking. Append-only.';

-- Nobody edits an audit row.
-- The audit itself never changes. A deleted client or user may clear the
-- foreign key, which is the only update this allows.
CREATE OR REPLACE FUNCTION ops.agent_calls_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'client_id' - 'user_id' = to_jsonb(OLD) - 'client_id' - 'user_id'
       AND (NEW.client_id IS NULL OR NEW.client_id = OLD.client_id)
       AND (NEW.user_id IS NULL OR NEW.user_id = OLD.user_id)
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'agent_calls is an audit log and cannot be changed';
END;
$$;

DROP TRIGGER IF EXISTS agent_calls_no_change ON ops.agent_calls;
CREATE TRIGGER agent_calls_no_change
    BEFORE UPDATE OR DELETE ON ops.agent_calls
    FOR EACH ROW EXECUTE FUNCTION ops.agent_calls_immutable();

ALTER TABLE ops.agent_calls ENABLE ROW LEVEL SECURITY;

-- A tenant admin reviewing one client sees that client. Otherwise an admin
-- sees every client, and a member sees the clients on their session.
CREATE OR REPLACE FUNCTION ops.agent_call_visible(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN tenancy.active_impersonation_client_id() IS NOT NULL THEN p_client_id = tenancy.active_impersonation_client_id()
        WHEN tenancy.is_tenant_admin() THEN TRUE
        WHEN p_client_id IS NULL THEN FALSE
        ELSE p_client_id IN (SELECT tenancy.current_client_ids())
    END;
$$;

CREATE OR REPLACE FUNCTION public.record_agent_call(
    p_client_id UUID,
    p_user_id UUID,
    p_feature TEXT,
    p_activity TEXT,
    p_agent TEXT,
    p_provider TEXT,
    p_model TEXT,
    p_input_tokens INTEGER,
    p_output_tokens INTEGER,
    p_thinking_tokens INTEGER,
    p_cached_input_tokens INTEGER,
    p_cache_write_tokens INTEGER,
    p_total_tokens INTEGER,
    p_cost_usd NUMERIC,
    p_price_input_per_million NUMERIC,
    p_price_output_per_million NUMERIC,
    p_price_thinking_per_million NUMERIC,
    p_thinking TEXT,
    p_status TEXT,
    p_error TEXT,
    p_latency_ms INTEGER,
    p_metadata JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_service BOOLEAN := ops.is_service_role();
    v_user UUID := p_user_id;
    v_client UUID := p_client_id;
    v_id UUID;
BEGIN
    IF NOT v_service THEN
        IF auth.uid() IS NULL THEN
            RAISE EXCEPTION 'Sign in before recording a model call';
        END IF;
        -- A signed-in caller can only audit their own calls.
        v_user := auth.uid();
    END IF;

    IF v_client IS NULL AND v_user IS NOT NULL THEN
        IF NOT v_service THEN
            SELECT c INTO v_client FROM tenancy.current_client_ids() AS c LIMIT 1;
        ELSE
            SELECT cu.client_id INTO v_client
            FROM tenancy.client_users cu
            JOIN tenancy.clients client ON client.id = cu.client_id
            WHERE cu.user_id = v_user AND cu.is_active IS TRUE AND client.is_active IS TRUE
            ORDER BY client.is_internal, cu.created_at
            LIMIT 1;
        END IF;
    END IF;

    IF NOT v_service AND v_client IS NOT NULL AND v_client NOT IN (SELECT tenancy.current_client_ids()) THEN
        RAISE EXCEPTION 'That client is not available in this session';
    END IF;

    INSERT INTO ops.agent_calls (
        client_id, user_id, feature, activity, agent, provider, model,
        input_tokens, output_tokens, thinking_tokens, cached_input_tokens, cache_write_tokens, total_tokens,
        cost_usd, price_input_per_million, price_output_per_million, price_thinking_per_million,
        thinking, status, error, latency_ms, metadata
    ) VALUES (
        v_client,
        v_user,
        left(COALESCE(NULLIF(btrim(p_feature), ''), 'unspecified'), 120),
        left(COALESCE(NULLIF(btrim(p_activity), ''), NULLIF(btrim(p_feature), ''), 'unspecified'), 120),
        NULLIF(left(btrim(COALESCE(p_agent, '')), 200), ''),
        left(COALESCE(NULLIF(btrim(p_provider), ''), 'unknown'), 40),
        left(COALESCE(NULLIF(btrim(p_model), ''), 'unknown'), 120),
        GREATEST(COALESCE(p_input_tokens, 0), 0),
        GREATEST(COALESCE(p_output_tokens, 0), 0),
        GREATEST(COALESCE(p_thinking_tokens, 0), 0),
        GREATEST(COALESCE(p_cached_input_tokens, 0), 0),
        GREATEST(COALESCE(p_cache_write_tokens, 0), 0),
        GREATEST(COALESCE(p_total_tokens, 0), 0),
        GREATEST(COALESCE(p_cost_usd, 0), 0),
        p_price_input_per_million,
        p_price_output_per_million,
        p_price_thinking_per_million,
        NULLIF(left(COALESCE(p_thinking, ''), 200000), ''),
        CASE WHEN p_status = 'error' THEN 'error' ELSE 'ok' END,
        NULLIF(left(COALESCE(p_error, ''), 2000), ''),
        CASE WHEN p_latency_ms IS NULL OR p_latency_ms < 0 THEN NULL ELSE p_latency_ms END,
        COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_agent_call IS
    'Appends one model-call audit row. Service role may name the user and client. A signed-in caller is recorded as themselves, on a client their session can see.';

CREATE OR REPLACE FUNCTION public.agent_usage(
    p_days INTEGER DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_feature TEXT DEFAULT NULL,
    p_agent TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_model TEXT DEFAULT NULL
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
    ),
    totals AS (
        SELECT count(*) AS calls,
               COALESCE(sum(input_tokens), 0) AS input_tokens,
               COALESCE(sum(output_tokens), 0) AS output_tokens,
               COALESCE(sum(thinking_tokens), 0) AS thinking_tokens,
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd,
               count(*) FILTER (WHERE status = 'error') AS errors
        FROM matched
    ),
    by_feature AS (
        SELECT feature AS key, count(*) AS calls, COALESCE(sum(total_tokens), 0) AS total_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched GROUP BY feature
    ),
    by_agent AS (
        SELECT COALESCE(agent, 'Unnamed') AS key, feature, count(*) AS calls,
               COALESCE(sum(total_tokens), 0) AS total_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched GROUP BY agent, feature
    ),
    by_user AS (
        SELECT user_id, min(user_label) AS label, count(*) AS calls,
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
               COALESCE(sum(total_tokens), 0) AS total_tokens,
               COALESCE(sum(cost_usd), 0) AS cost_usd
        FROM matched
        GROUP BY 1
    ),
    recent AS (
        SELECT * FROM matched ORDER BY created_at DESC LIMIT 80
    )
    SELECT jsonb_build_object(
        'from', v_from,
        'to', v_to,
        'totals', (SELECT jsonb_build_object(
            'calls', calls,
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
            'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', user_id, 'label', label) ORDER BY label)
                               FROM (SELECT DISTINCT user_id, user_label AS label FROM visible) u), '[]'::jsonb)
        ),
        'byFeature', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'calls', calls, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, key) FROM by_feature), '[]'::jsonb),
        'byAgent', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'feature', feature, 'calls', calls, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, key) FROM by_agent), '[]'::jsonb),
        'byUser', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'userId', user_id, 'label', label, 'calls', calls, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, label) FROM by_user), '[]'::jsonb),
        'byModel', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'provider', provider, 'calls', calls,
            'inputTokens', input_tokens, 'outputTokens', output_tokens, 'thinkingTokens', thinking_tokens,
            'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY cost_usd DESC, key) FROM by_model), '[]'::jsonb),
        'byDay', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'day', day, 'calls', calls, 'totalTokens', total_tokens, 'costUsd', cost_usd::float8
        ) ORDER BY day) FROM by_day), '[]'::jsonb),
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
    'Token use and cost for the clients this session can see, over a period, with breakdowns by feature, agent, user, model, and day.';

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

COMMENT ON FUNCTION public.agent_call IS
    'One model call, including its thinking, when this session can see that client.';

REVOKE ALL ON FUNCTION ops.agent_call_visible(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_agent_call(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, INTEGER, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_agent_call(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, INTEGER, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.agent_usage(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_usage(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.agent_call(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_call(UUID) TO authenticated, service_role;

REVOKE ALL ON TABLE ops.agent_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE ops.agent_calls TO service_role;
