-- Inbound email for feeds.
--
-- Adds EMAIL to the kinds a connection may be. Each EMAIL connection has its own
-- address, <inbound_token>@<inbound domain>. The token is random, so an address
-- cannot be guessed, and it can be replaced (feed_connection_rotate_address),
-- which stops the old address working at once.
--
-- How a message travels (see docs/FEEDS.md, "Inbound email"):
--
--   1. Cloudflare Email Routing hands the message to the Email Worker in
--      apps/inbound-email. It asks email_inbound_route whether the address is
--      live, the message is small enough and the connection is under its hourly
--      limit, and refuses the message at SMTP time when not.
--   2. The worker records the message (email_inbound_begin), stores the raw
--      message in feed-inbox/<client>/_email/<connection>/raw/<id>.eml and marks
--      it stored (email_inbound_stored), which queues email.screen.
--   3. email.screen (packages/worker/src/email.ts) checks the sender against the
--      connection's allowed senders, checks DKIM aligned with the From domain,
--      keeps only the attachment types the connection allows, scans them when a
--      scanner is set up, and records a verdict (email_inbound_screened).
--      Accepted attachments go to feed-inbox/<client>/_email/<connection>/ and
--      a poll is queued for each active feed on the connection.
--   4. The EMAIL connector lists those attachments, and from there a file is
--      loaded like any other feed file: ledger, saved map, review when it does
--      not fit.
--
-- A message that fails the sender or authentication checks is QUARANTINED. A
-- person with feed.manage can release it (the sender and authentication checks
-- are then skipped, the file type and scan checks are not) or discard it.
-- A message with nothing usable, or with malware, is REJECTED and cannot be released.
--
-- feed_connection_save is the function from 20261114220000_feed_sftp.sql with
-- EMAIL added, and an address token made for an EMAIL connection.

ALTER TABLE ops.connections DROP CONSTRAINT IF EXISTS connections_kind_check;
ALTER TABLE ops.connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('STORAGE', 'HTTP', 'SFTP', 'EMAIL'));

-- The part of the address before the @. Only EMAIL connections have one.
ALTER TABLE ops.connections ADD COLUMN IF NOT EXISTS inbound_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS connections_inbound_token ON ops.connections (inbound_token) WHERE inbound_token IS NOT NULL;

CREATE OR REPLACE FUNCTION ops.new_inbound_token()
RETURNS TEXT
LANGUAGE sql VOLATILE
SET search_path = ops, extensions, pg_temp
AS $$
    -- 96 random bits as 24 hex characters.
    SELECT encode(extensions.gen_random_bytes(12), 'hex');
$$;

CREATE TABLE IF NOT EXISTS ops.inbound_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES ops.connections(id) ON DELETE CASCADE,
    -- The Message-ID header, without angle brackets. Used to ignore a message sent twice.
    message_id TEXT,
    envelope_from TEXT,
    header_from TEXT,
    subject TEXT,
    size_bytes BIGINT,
    -- Where the raw message is in the feed-inbox bucket.
    raw_path TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'RECEIVING'
        CHECK (status IN ('RECEIVING', 'RECEIVED', 'ACCEPTED', 'QUARANTINED', 'REJECTED', 'DISCARDED')),
    reason TEXT,
    -- What the authentication check found: {"dkim": [...], "dkimAligned": "...", "dmarc": "pass", "spf": "..."}.
    auth JSONB,
    -- One entry per attachment: {"name", "size", "mediaType", "sha256", "taken", "reason", "storedAs"}.
    attachments JSONB NOT NULL DEFAULT '[]',
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    screened_at TIMESTAMPTZ,
    -- Set when a person released a quarantined message.
    released_by UUID,
    released_at TIMESTAMPTZ,
    discarded_by UUID,
    discarded_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON ops.inbound_messages (connection_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_messages_client_received ON ops.inbound_messages (client_id, received_at DESC);
CREATE INDEX IF NOT EXISTS inbound_messages_connection_received ON ops.inbound_messages (connection_id, received_at DESC);

ALTER TABLE ops.inbound_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.inbound_messages IS
    'One row per email sent to an EMAIL connection''s address. Reached only through the email_* and inbound_message_* functions.';

-- A connection as a user may see it. The address token only for people who manage feeds.
CREATE OR REPLACE FUNCTION ops.connection_json(p_row ops.connections)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT (to_jsonb(p_row) - 'secret_id' - 'inbound_token')
        || jsonb_build_object(
            'has_secret', p_row.secret_id IS NOT NULL,
            'inbound_token', CASE WHEN ops.can_manage_feeds(p_row.client_id) THEN p_row.inbound_token END
        );
$$;

-- p_secret NULL keeps the stored secret. An empty string removes it.
CREATE OR REPLACE FUNCTION public.feed_connection_save(
    p_id UUID,
    p_client_id UUID,
    p_connection_code TEXT,
    p_connection_name TEXT,
    p_kind TEXT,
    p_config JSONB,
    p_secret TEXT,
    p_is_active BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, vault, pg_temp
AS $$
DECLARE
    v_row ops.connections;
    v_secret_id UUID;
BEGIN
    IF NULLIF(btrim(COALESCE(p_connection_code, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_connection_name, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A code and a name are required' USING ERRCODE = '22023';
    END IF;
    IF p_kind IS NULL OR p_kind NOT IN ('STORAGE', 'HTTP', 'SFTP', 'EMAIL') THEN
        RAISE EXCEPTION 'The connection kind must be STORAGE, HTTP, SFTP, or EMAIL' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        IF NOT ops.can_manage_feeds(p_client_id) THEN
            RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO ops.connections (client_id, connection_code, connection_name, kind, config, is_active, created_by, inbound_token)
        VALUES (
            p_client_id, btrim(p_connection_code), btrim(p_connection_name), p_kind,
            COALESCE(p_config, '{}'::jsonb), COALESCE(p_is_active, TRUE), auth.uid(),
            CASE WHEN p_kind = 'EMAIL' THEN ops.new_inbound_token() END
        )
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM ops.connections WHERE id = p_id;
        IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
            RAISE EXCEPTION 'Connection was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT ops.can_manage_feeds(v_row.client_id) THEN
            RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
        END IF;
        UPDATE ops.connections
           SET connection_code = btrim(p_connection_code),
               connection_name = btrim(p_connection_name),
               kind = p_kind,
               config = COALESCE(p_config, '{}'::jsonb),
               is_active = COALESCE(p_is_active, TRUE),
               -- An EMAIL connection keeps its address. Any other kind has none.
               inbound_token = CASE WHEN p_kind = 'EMAIL' THEN COALESCE(inbound_token, ops.new_inbound_token()) END,
               -- A changed address or sign-in has not been checked yet.
               last_checked_at = NULL, last_check_ok = NULL, last_check_message = NULL,
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;

    IF p_secret IS NOT NULL THEN
        IF p_secret = '' THEN
            IF v_row.secret_id IS NOT NULL THEN
                DELETE FROM vault.secrets WHERE id = v_row.secret_id;
                UPDATE ops.connections SET secret_id = NULL WHERE id = v_row.id RETURNING * INTO v_row;
            END IF;
        ELSIF v_row.secret_id IS NOT NULL THEN
            PERFORM vault.update_secret(v_row.secret_id, p_secret);
        ELSE
            v_secret_id := vault.create_secret(p_secret, 'feed-connection-' || v_row.id::text, 'Feed connection credential');
            UPDATE ops.connections SET secret_id = v_secret_id WHERE id = v_row.id RETURNING * INTO v_row;
        END IF;
    END IF;

    RETURN ops.connection_json(v_row);
END;
$$;

-- Gives an EMAIL connection a new address. The old one is refused from now on.
CREATE OR REPLACE FUNCTION public.feed_connection_rotate_address(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.connections;
BEGIN
    SELECT * INTO v_row FROM ops.connections WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RAISE EXCEPTION 'Connection was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.can_manage_feeds(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
    END IF;
    IF v_row.kind <> 'EMAIL' THEN
        RAISE EXCEPTION 'Only an email connection has an address' USING ERRCODE = '22023';
    END IF;
    UPDATE ops.connections SET inbound_token = ops.new_inbound_token(), updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;
    RETURN ops.connection_json(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Messages, as people see them
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.inbound_message_json(p_row ops.inbound_messages)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT (to_jsonb(p_row) - 'raw_path') || jsonb_build_object(
        'connection_name', (SELECT connection_name FROM ops.connections WHERE id = p_row.connection_id)
    );
$$;

CREATE OR REPLACE FUNCTION public.inbound_messages_list(
    p_connection_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.inbound_message_json(m)
    FROM ops.inbound_messages AS m
    WHERE ops.can_see(m.client_id)
      AND (p_connection_id IS NULL OR m.connection_id = p_connection_id)
    ORDER BY m.received_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

-- Queues the screening job for one message. One open run per message.
CREATE OR REPLACE FUNCTION ops.queue_email_screen(p_message_id UUID, p_client_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_key TEXT := 'email:' || p_message_id::text;
    v_run_id UUID;
BEGIN
    INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key, requested_by)
    VALUES (p_client_id, 'email.screen', jsonb_build_object('messageId', p_message_id), 5, v_key, auth.uid())
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING id INTO v_run_id;
    IF v_run_id IS NULL THEN
        SELECT id INTO v_run_id FROM ops.job_runs WHERE dedupe_key = v_key AND status IN ('QUEUED', 'RUNNING');
    END IF;
    RETURN v_run_id;
END;
$$;

-- Lets a quarantined message through. The sender and authentication checks are
-- skipped when it is screened again. File type and malware checks still apply.
CREATE OR REPLACE FUNCTION public.inbound_message_release(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.inbound_messages;
BEGIN
    SELECT * INTO v_row FROM ops.inbound_messages WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RAISE EXCEPTION 'Message was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.can_manage_feeds(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'QUARANTINED' THEN
        RAISE EXCEPTION 'Only a quarantined message can be released' USING ERRCODE = '22023';
    END IF;
    UPDATE ops.inbound_messages
       SET status = 'RECEIVED', released_by = auth.uid(), released_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;
    PERFORM ops.queue_email_screen(v_row.id, v_row.client_id);
    RETURN ops.inbound_message_json(v_row);
END;
$$;

-- Sets a quarantined message aside for good. It stays in the list as a record.
CREATE OR REPLACE FUNCTION public.inbound_message_discard(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.inbound_messages;
BEGIN
    SELECT * INTO v_row FROM ops.inbound_messages WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RAISE EXCEPTION 'Message was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.can_manage_feeds(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'QUARANTINED' THEN
        RAISE EXCEPTION 'Only a quarantined message can be discarded' USING ERRCODE = '22023';
    END IF;
    UPDATE ops.inbound_messages
       SET status = 'DISCARDED', discarded_by = auth.uid(), discarded_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;
    RETURN ops.inbound_message_json(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Email Worker functions (service_role only)
-- ---------------------------------------------------------------------------

-- Whether a message to this address may be taken. Called before the message is read.
--   OK            take it
--   UNKNOWN       no connection has this address (or it was replaced)
--   PAUSED        the connection or the client is not active
--   TOO_LARGE     larger than the connection allows
--   RATE_LIMITED  the connection has had its hourly number of messages
CREATE OR REPLACE FUNCTION public.email_inbound_route(p_token TEXT, p_size_bytes BIGINT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_connection ops.connections;
    v_max_bytes BIGINT;
    v_per_hour INTEGER;
    v_recent INTEGER;
BEGIN
    SELECT * INTO v_connection FROM ops.connections
     WHERE inbound_token = lower(btrim(COALESCE(p_token, ''))) AND kind = 'EMAIL';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('verdict', 'UNKNOWN');
    END IF;
    IF NOT v_connection.is_active THEN
        RETURN jsonb_build_object('verdict', 'PAUSED');
    END IF;

    v_max_bytes := LEAST(COALESCE(NULLIF(v_connection.config ->> 'maxMessageMb', '')::numeric, 25), 35) * 1024 * 1024;
    IF p_size_bytes IS NOT NULL AND p_size_bytes > v_max_bytes THEN
        RETURN jsonb_build_object('verdict', 'TOO_LARGE', 'maxBytes', v_max_bytes);
    END IF;

    v_per_hour := COALESCE(NULLIF(v_connection.config ->> 'maxPerHour', '')::integer, 30);
    SELECT count(*) INTO v_recent FROM ops.inbound_messages
     WHERE connection_id = v_connection.id AND received_at > NOW() - INTERVAL '1 hour';
    IF v_recent >= v_per_hour THEN
        RETURN jsonb_build_object('verdict', 'RATE_LIMITED', 'perHour', v_per_hour);
    END IF;

    RETURN jsonb_build_object(
        'verdict', 'OK',
        'connectionId', v_connection.id,
        'clientId', v_connection.client_id,
        'maxBytes', v_max_bytes
    );
END;
$$;

-- Records a message before its raw content is stored. Returns its id and where
-- to store it, or duplicate = true for a Message-ID this connection has already had.
CREATE OR REPLACE FUNCTION public.email_inbound_begin(
    p_connection_id UUID,
    p_message_id TEXT,
    p_envelope_from TEXT,
    p_header_from TEXT,
    p_subject TEXT,
    p_size_bytes BIGINT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_connection ops.connections;
    v_row ops.inbound_messages;
    v_message_id TEXT := NULLIF(left(btrim(COALESCE(p_message_id, ''), '<> '), 500), '');
BEGIN
    SELECT * INTO v_connection FROM ops.connections WHERE id = p_connection_id AND kind = 'EMAIL';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Connection was not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO ops.inbound_messages (client_id, connection_id, message_id, envelope_from, header_from, subject, size_bytes)
    VALUES (
        v_connection.client_id, v_connection.id, v_message_id,
        left(p_envelope_from, 320), left(p_header_from, 500), left(p_subject, 500), p_size_bytes
    )
    ON CONFLICT (connection_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        -- A message that never finished storing may be sent again.
        SELECT * INTO v_row FROM ops.inbound_messages
         WHERE connection_id = v_connection.id AND message_id = v_message_id;
        IF v_row.status <> 'RECEIVING' THEN
            RETURN jsonb_build_object('duplicate', TRUE, 'id', v_row.id);
        END IF;
    END IF;

    UPDATE ops.inbound_messages
       SET raw_path = v_connection.client_id::text || '/_email/' || v_connection.id::text || '/raw/' || v_row.id::text || '.eml'
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('duplicate', FALSE, 'id', v_row.id, 'rawPath', v_row.raw_path);
END;
$$;

-- The raw message is stored. Queues the screening job.
CREATE OR REPLACE FUNCTION public.email_inbound_stored(p_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_row ops.inbound_messages;
BEGIN
    UPDATE ops.inbound_messages SET status = 'RECEIVED'
     WHERE id = p_id AND status = 'RECEIVING'
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN ops.queue_email_screen(v_row.id, v_row.client_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Job worker functions (service_role only)
-- ---------------------------------------------------------------------------

-- Everything screening needs: the message and its connection's settings.
CREATE OR REPLACE FUNCTION public.email_message_context(p_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT jsonb_build_object(
        'message', to_jsonb(m),
        'connection', to_jsonb(c) - 'secret_id' - 'inbound_token'
    )
    FROM ops.inbound_messages AS m
    JOIN ops.connections AS c ON c.id = m.connection_id
    WHERE m.id = p_id;
$$;

-- Records the verdict. For an accepted message, queues a poll of each active
-- feed on the connection, with the same key Poll now and the poll schedule use.
CREATE OR REPLACE FUNCTION public.email_inbound_screened(
    p_id UUID,
    p_status TEXT,
    p_reason TEXT,
    p_header_from TEXT,
    p_auth JSONB,
    p_attachments JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_row ops.inbound_messages;
    v_feed ops.feeds;
    v_polls INTEGER := 0;
BEGIN
    IF p_status NOT IN ('ACCEPTED', 'QUARANTINED', 'REJECTED') THEN
        RAISE EXCEPTION 'A message is screened as ACCEPTED, QUARANTINED, or REJECTED' USING ERRCODE = '22023';
    END IF;
    UPDATE ops.inbound_messages
       SET status = p_status,
           reason = left(p_reason, 2000),
           header_from = COALESCE(left(p_header_from, 500), header_from),
           auth = p_auth,
           attachments = COALESCE(p_attachments, '[]'::jsonb),
           screened_at = NOW()
     WHERE id = p_id AND status = 'RECEIVED'
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The message is not waiting to be screened' USING ERRCODE = '22023';
    END IF;

    IF p_status = 'ACCEPTED' THEN
        FOR v_feed IN
            SELECT * FROM ops.feeds WHERE connection_id = v_row.connection_id AND is_active
        LOOP
            INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key)
            VALUES (
                v_feed.client_id, 'feed.poll', jsonb_build_object('feedId', v_feed.id), 1,
                CASE WHEN v_feed.schedule_id IS NOT NULL THEN 'schedule:' || v_feed.schedule_id::text ELSE 'feed:' || v_feed.id::text END
            )
            ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING;
            IF FOUND THEN
                v_polls := v_polls + 1;
            END IF;
        END LOOP;
    END IF;
    RETURN v_polls;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.new_inbound_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.inbound_message_json(ops.inbound_messages) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.queue_email_screen(UUID, UUID) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.email_inbound_route(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_inbound_begin(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_inbound_stored(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_message_context(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_inbound_screened(UUID, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_inbound_route(TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_inbound_begin(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_inbound_stored(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_message_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_inbound_screened(UUID, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.feed_connection_rotate_address(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inbound_messages_list(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inbound_message_release(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inbound_message_discard(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feed_connection_rotate_address(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inbound_messages_list(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inbound_message_release(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inbound_message_discard(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
