-- Personal assistant: what a person follows, when they want a summary, and the
-- events a summary is written from.
--
-- The job worker already fires schedules. This adds three job types on that
-- same queue:
--   assistant.sweep   one per client, every 15 minutes, created when someone
--                     turns the assistant on. Queues a brief for each person
--                     whose delivery time has passed, and a watch for anyone
--                     with an urgent event still waiting.
--   assistant.brief   one person. Reads what they follow, writes a note into
--                     their briefing chat, and moves their next delivery time.
--   assistant.watch   the same note, for follows marked immediate. Does not
--                     move the digest clock.
--
-- A person sets follows and the delivery preset themselves. They do not need
-- job.manage, and they do not get a cron expression. The 15 minute sweep is
-- the check. The preset is when a summary is sent. Nothing is sent when
-- nothing they follow has changed.
--
-- Briefs run as that person (ops.assume_user), so a lost grant fails the run
-- the same way a data-quality scan does. The sweep and the event writer use
-- the service role and do not read entity values.

CREATE TABLE IF NOT EXISTS ops.activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    kind VARCHAR(40) NOT NULL,
    subject_type VARCHAR(20) NOT NULL,
    subject_id UUID,
    subject_code VARCHAR(100),
    summary TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    actor_id UUID,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_events_client_time
    ON ops.activity_events (client_id, occurred_at, id);

ALTER TABLE ops.activity_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.activity_events IS
    'A short note that something changed. Written when the change is committed. The assistant reads this. It does not scan the attribute ledger.';

CREATE TABLE IF NOT EXISTS ops.assistant_settings (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    preset VARCHAR(32) NOT NULL DEFAULT 'WEEKDAY_MORNING',
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    morning_hour INTEGER NOT NULL DEFAULT 7,
    next_delivery_at TIMESTAMPTZ,
    briefing_conversation_id UUID REFERENCES public.chat_conversations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, client_id),
    CONSTRAINT assistant_settings_preset CHECK (preset IN ('WEEKDAY_MORNING', 'WORKDAY_HOURLY', 'URGENT_ONLY')),
    CONSTRAINT assistant_settings_hour CHECK (morning_hour BETWEEN 0 AND 23)
);

ALTER TABLE ops.assistant_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.assistant_settings IS
    'One delivery clock per person per client. The preset decides when a summary is sent. The sweep decides when the worker looks.';

CREATE TABLE IF NOT EXISTS ops.assistant_follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    subject_type VARCHAR(20) NOT NULL,
    subject_id UUID,
    subject_code VARCHAR(100),
    label TEXT NOT NULL,
    delivery VARCHAR(20) NOT NULL DEFAULT 'DIGEST',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT assistant_follows_subject CHECK (
        (subject_type = 'KIND' AND subject_id IS NULL AND subject_code IS NOT NULL)
        OR (subject_type IN ('ENTITY', 'FEED') AND subject_id IS NOT NULL)
    ),
    CONSTRAINT assistant_follows_delivery CHECK (delivery IN ('DIGEST', 'IMMEDIATE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_follows_kind
    ON ops.assistant_follows (user_id, client_id, subject_code)
    WHERE subject_type = 'KIND';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_follows_subject
    ON ops.assistant_follows (user_id, client_id, subject_type, subject_id)
    WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assistant_follows_client
    ON ops.assistant_follows (client_id, delivery);

ALTER TABLE ops.assistant_follows ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.assistant_follows IS
    'What one person asked the assistant to monitor. A kind applies across the client. A record or a feed applies to that subject.';

CREATE TABLE IF NOT EXISTS ops.assistant_receipts (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES ops.activity_events(id) ON DELETE CASCADE,
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, event_id)
);

ALTER TABLE ops.assistant_receipts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.assistant_receipts IS
    'An event already written into this person''s briefing. The digest and an immediate note share it, so the same change is said once.';

-- ---------------------------------------------------------------------------
-- Clock, caller, and the client's sweep schedule
-- ---------------------------------------------------------------------------

-- The next time a summary should be sent, strictly after p_now, in p_timezone.
-- WEEKDAY_MORNING is the next weekday at morning_hour. WORKDAY_HOURLY is the
-- next hour from 08:00 through 18:00 on a weekday. URGENT_ONLY has no digest.
CREATE OR REPLACE FUNCTION ops.assistant_next_delivery(
    p_preset TEXT,
    p_timezone TEXT,
    p_morning_hour INTEGER,
    p_now TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_local TIMESTAMP;
    v_candidate TIMESTAMP;
    v_days INTEGER := 0;
    v_hour INTEGER;
    v_dow INTEGER;
BEGIN
    IF p_preset = 'URGENT_ONLY' THEN
        RETURN NULL;
    END IF;
    v_local := timezone(p_timezone, p_now);

    IF p_preset = 'WEEKDAY_MORNING' THEN
        LOOP
            v_candidate := date_trunc('day', v_local) + make_interval(days => v_days, hours => p_morning_hour);
            IF v_candidate > v_local AND EXTRACT(ISODOW FROM v_candidate) < 6 THEN
                RETURN timezone(p_timezone, v_candidate);
            END IF;
            v_days := v_days + 1;
            EXIT WHEN v_days > 8;
        END LOOP;
        RETURN NULL;
    END IF;

    IF p_preset = 'WORKDAY_HOURLY' THEN
        v_candidate := date_trunc('hour', v_local) + INTERVAL '1 hour';
        v_hour := EXTRACT(HOUR FROM v_candidate);
        v_dow := EXTRACT(ISODOW FROM v_candidate);
        IF v_dow < 6 AND v_hour BETWEEN 8 AND 18 THEN
            RETURN timezone(p_timezone, v_candidate);
        END IF;
        IF v_hour < 8 AND v_dow < 6 THEN
            RETURN timezone(p_timezone, date_trunc('day', v_candidate) + INTERVAL '8 hours');
        END IF;
        v_candidate := date_trunc('day', v_candidate) + INTERVAL '1 day 8 hours';
        WHILE EXTRACT(ISODOW FROM v_candidate) >= 6 LOOP
            v_candidate := v_candidate + INTERVAL '1 day';
        END LOOP;
        RETURN timezone(p_timezone, v_candidate);
    END IF;

    RETURN NULL;
END;
$$;

-- The single client this session is acting in. A person in two clients has two
-- briefs, and assume_user cannot tell them apart, so this session must see one.
CREATE OR REPLACE FUNCTION ops.assistant_client()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to use the assistant' USING ERRCODE = '42501';
    END IF;
    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
    IF v_clients IS NULL OR cardinality(v_clients) = 0 THEN
        RAISE EXCEPTION 'Choose a client before using the assistant' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_clients) > 1 THEN
        RAISE EXCEPTION 'The assistant keeps one brief per client. This session can see more than one client, so it cannot tell which brief is yours.'
            USING ERRCODE = '22023';
    END IF;
    IF NOT tenancy.has_permission(v_clients[1], 'entity.read') THEN
        RAISE EXCEPTION 'You cannot read this client''s records' USING ERRCODE = '42501';
    END IF;
    RETURN v_clients[1];
END;
$$;

-- Queues one open brief or watch for a person. A second queue while the first
-- is still open returns the open run.
CREATE OR REPLACE FUNCTION ops.assistant_queue(
    p_client_id UUID,
    p_user_id UUID,
    p_job_type TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_key TEXT := CASE p_job_type
        WHEN 'assistant.brief' THEN 'assistant-brief:' || p_user_id::text
        WHEN 'assistant.watch' THEN 'assistant-watch:' || p_user_id::text
        ELSE NULL
    END;
    v_run_id UUID;
BEGIN
    IF v_key IS NULL THEN
        RAISE EXCEPTION 'That is not an assistant job' USING ERRCODE = '22023';
    END IF;
    INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key, requested_by)
    VALUES (p_client_id, p_job_type, '{}'::jsonb, 3, v_key, p_user_id)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING id INTO v_run_id;
    -- Null when a run for this person is already queued or running.
    RETURN v_run_id;
END;
$$;

-- Keeps the client's 15 minute sweep in step with whether anyone has the
-- assistant on. The schedule is ordinary job machinery. People do not edit it.
CREATE OR REPLACE FUNCTION ops.assistant_ensure_sweep(p_client_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_active BOOLEAN;
    v_id UUID;
BEGIN
    v_active := EXISTS (
        SELECT 1 FROM ops.assistant_settings WHERE client_id = p_client_id AND is_enabled
    );
    SELECT id INTO v_id
    FROM ops.job_schedules
    WHERE client_id = p_client_id AND schedule_code = 'ASSISTANT_SWEEP';

    IF v_id IS NULL THEN
        IF NOT v_active THEN
            RETURN;
        END IF;
        INSERT INTO ops.job_schedules (
            client_id, schedule_code, schedule_name, job_type, payload, cron_expression,
            timezone, is_active, max_attempts, next_run_at, created_by
        ) VALUES (
            p_client_id, 'ASSISTANT_SWEEP', 'Assistant summaries', 'assistant.sweep', '{}'::jsonb,
            '*/15 * * * *', 'UTC', TRUE, 3, NOW(), auth.uid()
        );
        RETURN;
    END IF;

    UPDATE ops.job_schedules
       SET is_active = v_active,
           next_run_at = CASE
               WHEN v_active AND (NOT is_active OR next_run_at IS NULL) THEN NOW()
               WHEN NOT v_active THEN NULL
               ELSE next_run_at
           END,
           updated_at = NOW()
     WHERE id = v_id;
END;
$$;

-- Events this person has not been told about, limited to follows of one delivery.
CREATE OR REPLACE FUNCTION ops.assistant_pending(
    p_user_id UUID,
    p_client_id UUID,
    p_delivery TEXT
) RETURNS SETOF ops.activity_events
LANGUAGE sql STABLE
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT e.*
    FROM ops.activity_events AS e
    WHERE e.client_id = p_client_id
      AND NOT EXISTS (
          SELECT 1 FROM ops.assistant_receipts AS r
          WHERE r.user_id = p_user_id AND r.event_id = e.id
      )
      AND (
          e.subject_type <> 'ENTITY'
          OR e.subject_id IN (SELECT tenancy.readable_entity_ids())
      )
      AND EXISTS (
          SELECT 1 FROM ops.assistant_follows AS f
          WHERE f.user_id = p_user_id
            AND f.client_id = p_client_id
            AND f.delivery = p_delivery
            AND (
                (f.subject_type = 'KIND' AND f.subject_code = e.kind)
                OR (f.subject_type = e.subject_type AND f.subject_id IS NOT NULL AND f.subject_id = e.subject_id)
            )
      );
$$;

-- ---------------------------------------------------------------------------
-- Writing events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.activity_record(
    p_client_id UUID,
    p_kind TEXT,
    p_subject_type TEXT,
    p_subject_id UUID,
    p_subject_code TEXT,
    p_summary TEXT,
    p_payload JSONB DEFAULT '{}',
    p_actor_id UUID DEFAULT NULL,
    p_occurred_at TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_kind TEXT := upper(btrim(COALESCE(p_kind, '')));
    v_type TEXT := upper(btrim(COALESCE(p_subject_type, '')));
    v_summary TEXT := btrim(COALESCE(p_summary, ''));
    v_id UUID;
    v_user UUID;
BEGIN
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'Activity needs a client' USING ERRCODE = '22023';
    END IF;
    IF v_kind NOT IN ('VALUE_CHANGED', 'FEED_LOADED', 'FEED_NEEDS_REVIEW', 'FEED_FAILED', 'FEED_LATE', 'BREACH_OPENED', 'DQ_EXCEPTION') THEN
        RAISE EXCEPTION 'That activity is not recognized' USING ERRCODE = '22023';
    END IF;
    IF v_type NOT IN ('ENTITY', 'FEED', 'RULE') THEN
        RAISE EXCEPTION 'That subject is not recognized' USING ERRCODE = '22023';
    END IF;
    IF v_summary = '' THEN
        RAISE EXCEPTION 'Activity needs a summary' USING ERRCODE = '22023';
    END IF;

    INSERT INTO ops.activity_events (client_id, kind, subject_type, subject_id, subject_code, summary, payload, actor_id, occurred_at)
    VALUES (
        p_client_id, v_kind, v_type, p_subject_id, NULLIF(btrim(COALESCE(p_subject_code, '')), ''),
        left(v_summary, 500),
        CASE WHEN p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN '{}'::jsonb ELSE p_payload END,
        p_actor_id, COALESCE(p_occurred_at, NOW())
    )
    RETURNING id INTO v_id;

    FOR v_user IN
        SELECT DISTINCT f.user_id
        FROM ops.assistant_follows AS f
        JOIN ops.assistant_settings AS s
          ON s.user_id = f.user_id AND s.client_id = f.client_id AND s.is_enabled
        WHERE f.client_id = p_client_id
          AND f.delivery = 'IMMEDIATE'
          AND (
              (f.subject_type = 'KIND' AND f.subject_code = v_kind)
              OR (f.subject_type = v_type AND f.subject_id IS NOT NULL AND f.subject_id = p_subject_id)
          )
    LOOP
        PERFORM ops.assistant_queue(p_client_id, v_user, 'assistant.watch');
    END LOOP;

    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- What the person sets
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assistant_settings_get()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.assistant_client();
    v_row ops.assistant_settings;
BEGIN
    SELECT * INTO v_row
    FROM ops.assistant_settings
    WHERE user_id = auth.uid() AND client_id = v_client;
    RETURN jsonb_build_object(
        'is_enabled', COALESCE(v_row.is_enabled, FALSE),
        'preset', COALESCE(v_row.preset, 'WEEKDAY_MORNING'),
        'timezone', COALESCE(v_row.timezone, 'UTC'),
        'morning_hour', COALESCE(v_row.morning_hour, 7),
        'next_delivery_at', v_row.next_delivery_at,
        'follow_count', (
            SELECT count(*) FROM ops.assistant_follows
            WHERE user_id = auth.uid() AND client_id = v_client
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.assistant_settings_save(
    p_enabled BOOLEAN,
    p_preset TEXT,
    p_timezone TEXT,
    p_morning_hour INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.assistant_client();
    v_preset TEXT := upper(btrim(COALESCE(p_preset, '')));
    v_zone TEXT := btrim(COALESCE(p_timezone, ''));
    v_hour INTEGER := COALESCE(p_morning_hour, 7);
BEGIN
    IF v_preset NOT IN ('WEEKDAY_MORNING', 'WORKDAY_HOURLY', 'URGENT_ONLY') THEN
        RAISE EXCEPTION 'Choose a weekday morning, an hourly workday, or urgent only' USING ERRCODE = '22023';
    END IF;
    IF v_zone = '' OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_zone) THEN
        RAISE EXCEPTION 'The time zone is not recognized' USING ERRCODE = '22023';
    END IF;
    IF v_hour < 0 OR v_hour > 23 THEN
        RAISE EXCEPTION 'The morning hour must be between 0 and 23' USING ERRCODE = '22023';
    END IF;

    INSERT INTO ops.assistant_settings (
        user_id, client_id, is_enabled, preset, timezone, morning_hour, next_delivery_at
    ) VALUES (
        auth.uid(), v_client, COALESCE(p_enabled, FALSE), v_preset, v_zone, v_hour,
        ops.assistant_next_delivery(v_preset, v_zone, v_hour, NOW())
    )
    ON CONFLICT (user_id, client_id) DO UPDATE
        SET is_enabled = EXCLUDED.is_enabled,
            preset = EXCLUDED.preset,
            timezone = EXCLUDED.timezone,
            morning_hour = EXCLUDED.morning_hour,
            next_delivery_at = EXCLUDED.next_delivery_at,
            updated_at = NOW();

    PERFORM ops.assistant_ensure_sweep(v_client);
    RETURN public.assistant_settings_get();
END;
$$;

CREATE OR REPLACE FUNCTION public.assistant_follows_list()
RETURNS SETOF JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.assistant_client();
BEGIN
    RETURN QUERY
    SELECT jsonb_build_object(
        'id', f.id,
        'subject_type', f.subject_type,
        'subject_id', f.subject_id,
        'subject_code', f.subject_code,
        'label', f.label,
        'delivery', f.delivery,
        'created_at', f.created_at
    )
    FROM ops.assistant_follows AS f
    WHERE f.user_id = auth.uid() AND f.client_id = v_client
    ORDER BY f.created_at, f.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.assistant_follow_save(
    p_subject_type TEXT,
    p_subject_id UUID,
    p_subject_code TEXT,
    p_delivery TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, entity_instances, pg_temp
AS $$
DECLARE
    v_client UUID := ops.assistant_client();
    v_type TEXT := upper(btrim(COALESCE(p_subject_type, '')));
    v_code TEXT := upper(btrim(COALESCE(p_subject_code, '')));
    v_delivery TEXT := upper(btrim(COALESCE(p_delivery, 'DIGEST')));
    v_label TEXT;
    v_row ops.assistant_follows;
BEGIN
    IF v_delivery NOT IN ('DIGEST', 'IMMEDIATE') THEN
        RAISE EXCEPTION 'Choose a digest or an immediate note' USING ERRCODE = '22023';
    END IF;

    IF v_type = 'KIND' THEN
        v_label := CASE v_code
            WHEN 'FEED_LOADED' THEN 'Files that loaded'
            WHEN 'FEED_NEEDS_REVIEW' THEN 'Files waiting for review'
            WHEN 'FEED_FAILED' THEN 'Files that failed'
            WHEN 'FEED_LATE' THEN 'Files that are late'
            ELSE NULL
        END;
        IF v_label IS NULL THEN
            RAISE EXCEPTION 'That is not something the assistant can follow' USING ERRCODE = '22023';
        END IF;
        p_subject_id := NULL;
    ELSIF v_type = 'FEED' THEN
        SELECT f.feed_name INTO v_label
        FROM ops.feeds AS f
        WHERE f.id = p_subject_id AND f.client_id = v_client;
        IF v_label IS NULL THEN
            RAISE EXCEPTION 'That feed was not found' USING ERRCODE = 'P0002';
        END IF;
        v_code := NULL;
    ELSIF v_type = 'ENTITY' THEN
        SELECT me.entity_name INTO v_label
        FROM entity_instances.master_entities AS me
        WHERE me.id = p_subject_id
          AND me.id IN (SELECT tenancy.readable_entity_ids());
        IF v_label IS NULL THEN
            RAISE EXCEPTION 'That record was not found, or you cannot read it' USING ERRCODE = '42501';
        END IF;
        v_code := NULL;
    ELSE
        RAISE EXCEPTION 'Follow a record, a feed, or a kind of change' USING ERRCODE = '22023';
    END IF;

    BEGIN
        INSERT INTO ops.assistant_follows (user_id, client_id, subject_type, subject_id, subject_code, label, delivery)
        VALUES (auth.uid(), v_client, v_type, p_subject_id, NULLIF(v_code, ''), v_label, v_delivery)
        RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'You already follow that' USING ERRCODE = '23505';
    END;

    RETURN jsonb_build_object(
        'id', v_row.id,
        'subject_type', v_row.subject_type,
        'subject_id', v_row.subject_id,
        'subject_code', v_row.subject_code,
        'label', v_row.label,
        'delivery', v_row.delivery,
        'created_at', v_row.created_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.assistant_follow_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.assistant_client();
BEGIN
    DELETE FROM ops.assistant_follows
    WHERE id = p_id AND user_id = auth.uid() AND client_id = v_client;
    RETURN FOUND;
END;
$$;

-- Queues a summary for the caller now. The digest clock stays where it is
-- until that run finishes.
CREATE OR REPLACE FUNCTION public.assistant_brief_now()
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_client UUID := ops.assistant_client();
    v_run UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM ops.assistant_follows
        WHERE user_id = auth.uid() AND client_id = v_client
    ) THEN
        RAISE EXCEPTION 'Follow something first. A summary only includes what you follow.' USING ERRCODE = '22023';
    END IF;
    v_run := ops.assistant_queue(v_client, auth.uid(), 'assistant.brief');
    IF v_run IS NULL THEN
        SELECT id INTO v_run
        FROM ops.job_runs
        WHERE dedupe_key = 'assistant-brief:' || auth.uid()::text
          AND status IN ('QUEUED', 'RUNNING');
    END IF;
    RETURN v_run;
END;
$$;

-- ---------------------------------------------------------------------------
-- What the worker runs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_run_assistant_sweep(
    p_client_id UUID,
    p_now TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_due INTEGER := 0;
    v_queued INTEGER := 0;
    v_watches INTEGER := 0;
    v_user UUID;
    v_run UUID;
BEGIN
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'This job needs a client' USING ERRCODE = '22023';
    END IF;

    FOR v_user IN
        SELECT s.user_id
        FROM ops.assistant_settings AS s
        WHERE s.client_id = p_client_id
          AND s.is_enabled
          AND s.preset <> 'URGENT_ONLY'
          AND (s.next_delivery_at IS NULL OR s.next_delivery_at <= COALESCE(p_now, NOW()))
    LOOP
        v_due := v_due + 1;
        v_run := ops.assistant_queue(p_client_id, v_user, 'assistant.brief');
        IF v_run IS NOT NULL THEN
            v_queued := v_queued + 1;
        END IF;
    END LOOP;

    -- A watch that was missed, or whose run failed, is queued again here.
    FOR v_user IN
        SELECT DISTINCT f.user_id
        FROM ops.assistant_follows AS f
        JOIN ops.assistant_settings AS s
          ON s.user_id = f.user_id AND s.client_id = f.client_id AND s.is_enabled
        WHERE f.client_id = p_client_id
          AND f.delivery = 'IMMEDIATE'
          AND EXISTS (
              SELECT 1
              FROM ops.activity_events AS e
              WHERE e.client_id = p_client_id
                AND NOT EXISTS (
                    SELECT 1 FROM ops.assistant_receipts AS r
                    WHERE r.user_id = f.user_id AND r.event_id = e.id
                )
                AND (
                    (f.subject_type = 'KIND' AND f.subject_code = e.kind)
                    OR (f.subject_type = e.subject_type AND f.subject_id IS NOT NULL AND f.subject_id = e.subject_id)
                )
          )
    LOOP
        v_run := ops.assistant_queue(p_client_id, v_user, 'assistant.watch');
        IF v_run IS NOT NULL THEN
            v_watches := v_watches + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('due', v_due, 'queued', v_queued, 'watches', v_watches);
END;
$$;

CREATE OR REPLACE FUNCTION public.job_run_assistant_collect(
    p_user_id UUID,
    p_client_id UUID,
    p_delivery TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_delivery TEXT := upper(btrim(COALESCE(p_delivery, '')));
    v_events JSONB;
    v_more BOOLEAN;
BEGIN
    IF v_delivery NOT IN ('DIGEST', 'IMMEDIATE') THEN
        RAISE EXCEPTION 'Delivery must be DIGEST or IMMEDIATE' USING ERRCODE = '22023';
    END IF;
    PERFORM ops.assume_user(p_user_id, p_client_id);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', picked.id,
        'kind', picked.kind,
        'summary', picked.summary,
        'occurredAt', picked.occurred_at,
        'subjectType', picked.subject_type,
        'subjectCode', picked.subject_code
    ) ORDER BY picked.occurred_at, picked.id), '[]'::jsonb)
    INTO v_events
    FROM (
        SELECT e.id, e.kind, e.summary, e.occurred_at, e.subject_type, e.subject_code
        FROM ops.assistant_pending(p_user_id, p_client_id, v_delivery) AS e
        ORDER BY e.occurred_at, e.id
        LIMIT 40
    ) AS picked;

    SELECT EXISTS (
        SELECT 1
        FROM ops.assistant_pending(p_user_id, p_client_id, v_delivery)
        OFFSET 40
    ) INTO v_more;

    RETURN jsonb_build_object('events', v_events, 'truncated', COALESCE(v_more, FALSE));
END;
$$;

-- Moves the digest clock. Used when there is nothing to say, and when the
-- person can no longer be assumed, so a failing brief does not queue forever.
CREATE OR REPLACE FUNCTION public.job_run_assistant_advance(
    p_user_id UUID,
    p_client_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    UPDATE ops.assistant_settings
       SET next_delivery_at = ops.assistant_next_delivery(preset, timezone, morning_hour, NOW()),
           updated_at = NOW()
     WHERE user_id = p_user_id AND client_id = p_client_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.job_run_assistant_commit(
    p_user_id UUID,
    p_client_id UUID,
    p_event_ids UUID[],
    p_content TEXT,
    p_advance BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, public, pg_temp
AS $$
DECLARE
    v_content TEXT := btrim(COALESCE(p_content, ''));
    v_ids UUID[];
    v_conversation UUID;
    v_count INTEGER;
BEGIN
    IF v_content = '' THEN
        RAISE EXCEPTION 'A briefing needs text' USING ERRCODE = '22023';
    END IF;
    PERFORM ops.assume_user(p_user_id, p_client_id);

    SELECT array_agg(e.id ORDER BY e.occurred_at, e.id)
    INTO v_ids
    FROM ops.assistant_pending(p_user_id, p_client_id, CASE WHEN COALESCE(p_advance, FALSE) THEN 'DIGEST' ELSE 'IMMEDIATE' END) AS e
    WHERE e.id = ANY (COALESCE(p_event_ids, ARRAY[]::UUID[]));

    v_count := COALESCE(cardinality(v_ids), 0);
    IF v_count = 0 THEN
        IF COALESCE(p_advance, FALSE) THEN
            PERFORM public.job_run_assistant_advance(p_user_id, p_client_id);
        END IF;
        RETURN jsonb_build_object('delivered', FALSE, 'events', 0, 'conversationId', NULL);
    END IF;

    INSERT INTO ops.assistant_receipts (user_id, event_id)
    SELECT p_user_id, event_id FROM unnest(v_ids) AS event_id
    ON CONFLICT DO NOTHING;

    SELECT briefing_conversation_id INTO v_conversation
    FROM ops.assistant_settings
    WHERE user_id = p_user_id AND client_id = p_client_id;

    IF v_conversation IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.chat_conversations
        WHERE id = v_conversation AND created_by = p_user_id
    ) THEN
        INSERT INTO public.chat_conversations (created_by, title, tool_context, page_context)
        VALUES (p_user_id, 'Briefing', 'general', 'assistant')
        RETURNING id INTO v_conversation;
    END IF;

    INSERT INTO ops.assistant_settings (user_id, client_id, briefing_conversation_id)
    VALUES (p_user_id, p_client_id, v_conversation)
    ON CONFLICT (user_id, client_id) DO UPDATE
        SET briefing_conversation_id = EXCLUDED.briefing_conversation_id,
            updated_at = NOW();

    INSERT INTO public.chat_messages (conversation_id, role, content, model)
    VALUES (v_conversation, 'model', left(v_content, 20000), 'assistant');

    IF COALESCE(p_advance, FALSE) THEN
        PERFORM public.job_run_assistant_advance(p_user_id, p_client_id);
    END IF;

    RETURN jsonb_build_object(
        'delivered', TRUE,
        'events', v_count,
        'conversationId', v_conversation
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.assistant_next_delivery(TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_client() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_queue(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_ensure_sweep(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_pending(UUID, UUID, TEXT) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.activity_record(UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_assistant_sweep(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_assistant_collect(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_assistant_advance(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_assistant_commit(UUID, UUID, UUID[], TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_record(UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_assistant_sweep(UUID, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_assistant_collect(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_assistant_advance(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_assistant_commit(UUID, UUID, UUID[], TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.assistant_settings_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_settings_save(BOOLEAN, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_follows_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_follow_save(TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_follow_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_brief_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_settings_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_settings_save(BOOLEAN, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_follows_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_follow_save(TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_follow_delete(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_brief_now() TO authenticated;

COMMENT ON FUNCTION public.activity_record(UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ) IS
    'Records one change and queues an immediate note for people who follow it. Service role only.';
COMMENT ON FUNCTION public.assistant_settings_save(BOOLEAN, TEXT, TEXT, INTEGER) IS
    'Saves whether the assistant is on, and when this person wants a summary. Creates the client sweep when anyone has it on.';

NOTIFY pgrst, 'reload schema';
