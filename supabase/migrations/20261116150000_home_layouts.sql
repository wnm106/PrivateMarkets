-- Home page: what one person chose to see, and the two personal feeds it reads.
--
-- A layout row only records where a person differs from the default for their
-- role. NULL hidden_modules means "use the default for my permissions". NULL
-- pinned_places means "every place I can open". A person with no row gets the
-- default, so most people never have one.
--
-- The layout is kept per client, because the same person can work for more
-- than one client and the things they watch differ.
--
-- home_activity and home_brief read the assistant's tables for the caller only.
-- They do not need the assistant to be turned on: following something is enough
-- to see its changes on the home page.

CREATE TABLE IF NOT EXISTS ops.home_layouts (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    hidden_modules TEXT[],
    pinned_places TEXT[],
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, client_id),
    CONSTRAINT home_layouts_hidden_size CHECK (hidden_modules IS NULL OR cardinality(hidden_modules) <= 20),
    CONSTRAINT home_layouts_pinned_size CHECK (pinned_places IS NULL OR cardinality(pinned_places) <= 40)
);

ALTER TABLE ops.home_layouts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.home_layouts IS
    'Where one person''s home page differs from the default for their role. Reached only through the home_* functions.';

-- The one client this session works in, or NULL when it sees none or several.
-- The home page still renders with defaults when this is NULL. Only saving
-- needs a single client.
CREATE OR REPLACE FUNCTION ops.home_client()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to see your home page' USING ERRCODE = '42501';
    END IF;
    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
    IF v_clients IS NULL OR cardinality(v_clients) <> 1 THEN
        RETURN NULL;
    END IF;
    IF NOT tenancy.has_permission(v_clients[1], 'entity.read') THEN
        RETURN NULL;
    END IF;
    RETURN v_clients[1];
END;
$$;

CREATE OR REPLACE FUNCTION public.home_layout_get()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.home_client();
    v_row ops.home_layouts;
BEGIN
    IF v_client IS NOT NULL THEN
        SELECT * INTO v_row FROM ops.home_layouts
        WHERE user_id = auth.uid() AND client_id = v_client;
    END IF;
    RETURN jsonb_build_object(
        'client_id', v_client,
        'can_save', v_client IS NOT NULL,
        'hidden_modules', to_jsonb(v_row.hidden_modules),
        'pinned_places', to_jsonb(v_row.pinned_places),
        'updated_at', v_row.updated_at
    );
END;
$$;

-- NULL for either list returns it to the default.
CREATE OR REPLACE FUNCTION public.home_layout_save(
    p_hidden_modules TEXT[],
    p_pinned_places TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.home_client();
    v_value TEXT;
BEGIN
    IF v_client IS NULL THEN
        RAISE EXCEPTION 'Choose one client before changing your home page. Your layout is kept per client.'
            USING ERRCODE = '22023';
    END IF;
    IF p_hidden_modules IS NOT NULL THEN
        IF cardinality(p_hidden_modules) > 20 THEN
            RAISE EXCEPTION 'Too many hidden sections' USING ERRCODE = '22023';
        END IF;
        FOREACH v_value IN ARRAY p_hidden_modules LOOP
            IF v_value IS NULL OR v_value !~ '^[a-z][a-z0-9_-]{0,39}$' THEN
                RAISE EXCEPTION 'A section name is not valid' USING ERRCODE = '22023';
            END IF;
        END LOOP;
    END IF;
    IF p_pinned_places IS NOT NULL THEN
        IF cardinality(p_pinned_places) > 40 THEN
            RAISE EXCEPTION 'Pin 40 places or fewer' USING ERRCODE = '22023';
        END IF;
        FOREACH v_value IN ARRAY p_pinned_places LOOP
            IF v_value IS NULL OR v_value !~ '^[a-z][a-z0-9:/_-]{0,119}$' THEN
                RAISE EXCEPTION 'A pinned place is not valid' USING ERRCODE = '22023';
            END IF;
        END LOOP;
    END IF;

    INSERT INTO ops.home_layouts (user_id, client_id, hidden_modules, pinned_places)
    VALUES (
        auth.uid(), v_client,
        (SELECT array_agg(DISTINCT h) FROM unnest(p_hidden_modules) AS h),
        p_pinned_places
    )
    ON CONFLICT (user_id, client_id) DO UPDATE
        SET hidden_modules = EXCLUDED.hidden_modules,
            pinned_places = EXCLUDED.pinned_places,
            updated_at = NOW();

    RETURN public.home_layout_get();
END;
$$;

-- Recent changes to what the caller follows, whether or not a brief has
-- already reported them. Entity events are limited to records the caller can
-- read. Feed and kind events carry no entity values.
CREATE OR REPLACE FUNCTION public.home_activity(p_days INTEGER DEFAULT 14, p_limit INTEGER DEFAULT 20)
RETURNS SETOF JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID := ops.home_client();
BEGIN
    IF v_client IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'subject_type', e.subject_type,
        'subject_id', e.subject_id,
        'subject_code', e.subject_code,
        'summary', e.summary,
        'occurred_at', e.occurred_at,
        'follow_label', m.label,
        'delivery', m.delivery
    )
    FROM ops.activity_events AS e
    CROSS JOIN LATERAL (
        SELECT f.label, f.delivery
        FROM ops.assistant_follows AS f
        WHERE f.user_id = auth.uid()
          AND f.client_id = v_client
          AND (
              (f.subject_type = 'KIND' AND f.subject_code = e.kind)
              OR (f.subject_type = e.subject_type AND f.subject_id IS NOT NULL AND f.subject_id = e.subject_id)
          )
        ORDER BY (f.delivery = 'IMMEDIATE') DESC, f.created_at
        LIMIT 1
    ) AS m
    WHERE e.client_id = v_client
      AND e.occurred_at >= NOW() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
      AND (
          e.subject_type <> 'ENTITY'
          OR e.subject_id IN (SELECT tenancy.readable_entity_ids())
      )
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;

-- What the caller follows, each with the record's domain (so the page can link
-- to it) and the latest change. A record the caller can no longer read keeps
-- its label but loses its domain and its changes.
CREATE OR REPLACE FUNCTION public.home_follows()
RETURNS SETOF JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
DECLARE
    v_client UUID := ops.home_client();
BEGIN
    IF v_client IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH readable AS (
        SELECT tenancy.readable_entity_ids() AS id
    )
    SELECT jsonb_build_object(
        'id', f.id,
        'subject_type', f.subject_type,
        'subject_id', f.subject_id,
        'subject_code', f.subject_code,
        'label', f.label,
        'delivery', f.delivery,
        'domain_code', d.domain_code,
        'last_summary', last.summary,
        'last_at', last.occurred_at
    )
    FROM ops.assistant_follows AS f
    LEFT JOIN LATERAL (
        SELECT me.domain_code
        FROM entity_instances.master_entities AS me
        WHERE f.subject_type = 'ENTITY'
          AND me.id = f.subject_id
          AND me.id IN (SELECT id FROM readable)
    ) AS d ON TRUE
    LEFT JOIN LATERAL (
        SELECT e.summary, e.occurred_at
        FROM ops.activity_events AS e
        WHERE e.client_id = v_client
          AND (
              (f.subject_type = 'KIND' AND e.kind = f.subject_code)
              OR (f.subject_type = 'FEED' AND e.subject_type = 'FEED' AND e.subject_id = f.subject_id)
              OR (f.subject_type = 'ENTITY' AND d.domain_code IS NOT NULL AND e.subject_type = 'ENTITY' AND e.subject_id = f.subject_id)
          )
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
    ) AS last ON TRUE
    WHERE f.user_id = auth.uid() AND f.client_id = v_client
    ORDER BY last.occurred_at DESC NULLS LAST, f.created_at, f.id;
END;
$$;

-- The caller's assistant settings and the last note in their briefing chat.
CREATE OR REPLACE FUNCTION public.home_brief()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, public, pg_temp
AS $$
DECLARE
    v_client UUID := ops.home_client();
    v_settings ops.assistant_settings;
    v_content TEXT;
    v_delivered_at TIMESTAMPTZ;
BEGIN
    IF v_client IS NULL THEN
        RETURN jsonb_build_object('available', FALSE);
    END IF;
    SELECT * INTO v_settings FROM ops.assistant_settings
    WHERE user_id = auth.uid() AND client_id = v_client;

    IF v_settings.briefing_conversation_id IS NOT NULL THEN
        SELECT m.content, m.created_at INTO v_content, v_delivered_at
        FROM public.chat_messages AS m
        JOIN public.chat_conversations AS c ON c.id = m.conversation_id
        WHERE m.conversation_id = v_settings.briefing_conversation_id
          AND c.created_by = auth.uid()
          AND m.role = 'model'
        ORDER BY m.created_at DESC
        LIMIT 1;
    END IF;

    RETURN jsonb_build_object(
        'available', TRUE,
        'enabled', COALESCE(v_settings.is_enabled, FALSE),
        'preset', COALESCE(v_settings.preset, 'WEEKDAY_MORNING'),
        'next_delivery_at', v_settings.next_delivery_at,
        'conversation_id', v_settings.briefing_conversation_id,
        'content', v_content,
        'delivered_at', v_delivered_at,
        'follow_count', (
            SELECT count(*) FROM ops.assistant_follows
            WHERE user_id = auth.uid() AND client_id = v_client
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION ops.home_client() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.home_layout_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.home_layout_save(TEXT[], TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.home_activity(INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.home_follows() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.home_brief() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.home_layout_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.home_layout_save(TEXT[], TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.home_activity(INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.home_follows() TO authenticated;
GRANT EXECUTE ON FUNCTION public.home_brief() TO authenticated;

COMMENT ON FUNCTION public.home_layout_save(TEXT[], TEXT[]) IS
    'Saves where the caller''s home page differs from their role default, for the one client in the session. NULL returns a list to the default.';
