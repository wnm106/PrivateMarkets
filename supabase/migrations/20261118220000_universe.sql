-- A person's universe: the records that are theirs to care about.
--
-- Two things already say which records matter to a person:
--   ops.assistant_follows    what they asked to hear about (they choose);
--   ops.responsibilities     what they must act on (an administrator chooses).
-- Neither was used to narrow anything. This migration puts the two together.
--
-- A record is in a person's universe when
--   * they follow it, or follow a record above it "with the records under it";
--   * they are responsible for it, or for a record above it whose assignment
--     covers the records under it, as themselves or through a role they hold;
--   * they are responsible for its domain.
--
-- Being in a universe grants nothing and routes nothing. It decides what a
-- person is shown first: the home page can be narrowed to it, and the digest
-- brief now covers it, so being responsible for a fund is enough to hear about
-- the fund and its positions without also following each one.
--
-- Two limits, both deliberate:
--   * Notes sent right away still come only from a record followed directly.
--     Those are queued when the change is written, by a match on the record
--     itself. Records reached through a parent or a responsibility arrive in
--     the digest.
--   * The digest looks back 14 days for records reached that way, so a person
--     newly made responsible for a fund is not sent its whole history.
--
-- Review routing is unchanged. Following a record never makes someone a reviewer.
--
-- Safe to run again.

-- ---------------------------------------------------------------------------
-- Following a record and the records under it
-- ---------------------------------------------------------------------------

ALTER TABLE ops.assistant_follows ADD COLUMN IF NOT EXISTS include_children BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN ops.assistant_follows.include_children IS
    'For a record: also the records under it, such as a fund''s positions. Applies to the digest and to the person''s universe.';

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
        'include_children', f.include_children,
        'created_at', f.created_at
    )
    FROM ops.assistant_follows AS f
    WHERE f.user_id = auth.uid() AND f.client_id = v_client
    ORDER BY f.created_at, f.id;
END;
$$;

-- Says whether one of the caller's own follows also covers the records under it. Only a record can.
CREATE OR REPLACE FUNCTION public.assistant_follow_children(p_id UUID, p_include BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_row ops.assistant_follows;
BEGIN
    SELECT * INTO v_row FROM ops.assistant_follows WHERE id = p_id AND user_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That follow was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.subject_type <> 'ENTITY' THEN
        RAISE EXCEPTION 'Only a followed record has records under it' USING ERRCODE = '22023';
    END IF;
    UPDATE ops.assistant_follows SET include_children = COALESCE(p_include, FALSE) WHERE id = p_id RETURNING * INTO v_row;
    RETURN jsonb_build_object(
        'id', v_row.id,
        'subject_type', v_row.subject_type,
        'subject_id', v_row.subject_id,
        'subject_code', v_row.subject_code,
        'label', v_row.label,
        'delivery', v_row.delivery,
        'include_children', v_row.include_children,
        'created_at', v_row.created_at
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- The universe
-- ---------------------------------------------------------------------------

-- Whether a responsibility row names this person: as themselves, or through a role they hold in the client.
CREATE OR REPLACE FUNCTION ops.responsibility_held_by(p_client_id UUID, p_user_id UUID, p_row_user UUID, p_row_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT p_user_id IS NOT NULL AND (
        p_row_user = p_user_id
        OR (p_row_role IS NOT NULL AND EXISTS (
            SELECT 1
            FROM tenancy.user_roles AS ur
            JOIN tenancy.roles AS ro ON ro.id = ur.role_id
            WHERE ur.client_id = p_client_id AND ur.user_id = p_user_id AND ro.role_code = p_row_role
        ))
    );
$$;

-- Whether a person has a universe at all in a client. Asked first, so a person
-- with neither follows nor responsibilities costs nothing more.
CREATE OR REPLACE FUNCTION ops.has_universe(p_user_id UUID, p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM ops.assistant_follows AS f
        WHERE f.user_id = p_user_id AND f.client_id = p_client_id AND f.subject_type = 'ENTITY'
    ) OR EXISTS (
        SELECT 1 FROM ops.responsibilities AS r
        WHERE r.client_id = p_client_id AND ops.responsibility_held_by(p_client_id, p_user_id, r.user_id, r.role_code)
    );
$$;

-- Whether a record is in a person's universe. See the top of this file.
CREATE OR REPLACE FUNCTION ops.in_universe(p_user_id UUID, p_client_id UUID, p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
    SELECT p_user_id IS NOT NULL AND p_entity_id IS NOT NULL AND (
        EXISTS (
            SELECT 1
            FROM ops.responsibility_lineage(p_entity_id) AS l
            WHERE EXISTS (
                SELECT 1 FROM ops.assistant_follows AS f
                WHERE f.user_id = p_user_id AND f.client_id = p_client_id
                  AND f.subject_type = 'ENTITY' AND f.subject_id = l.entity_id
                  AND (l.depth = 0 OR f.include_children)
            ) OR EXISTS (
                SELECT 1 FROM ops.responsibilities AS r
                WHERE r.client_id = p_client_id AND r.subject_type = 'ENTITY' AND r.entity_id = l.entity_id
                  AND (l.depth = 0 OR r.include_children)
                  AND ops.responsibility_held_by(p_client_id, p_user_id, r.user_id, r.role_code)
            )
        )
        OR EXISTS (
            SELECT 1
            FROM entity_instances.master_entities AS me
            JOIN ops.responsibilities AS r
              ON r.client_id = p_client_id AND r.subject_type = 'DOMAIN' AND upper(r.domain_code) = upper(me.domain_code)
            WHERE me.id = p_entity_id AND me.client_id = p_client_id
              AND ops.responsibility_held_by(p_client_id, p_user_id, r.user_id, r.role_code)
        )
    );
$$;

-- Whether a domain is one the person is responsible for. For a change that creates a record, which has no record yet.
CREATE OR REPLACE FUNCTION ops.domain_in_universe(p_user_id UUID, p_client_id UUID, p_domain_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT btrim(COALESCE(p_domain_code, '')) <> '' AND EXISTS (
        SELECT 1 FROM ops.responsibilities AS r
        WHERE r.client_id = p_client_id AND r.subject_type = 'DOMAIN' AND upper(r.domain_code) = upper(btrim(p_domain_code))
          AND ops.responsibility_held_by(p_client_id, p_user_id, r.user_id, r.role_code)
    );
$$;

-- A text that is a record id, or NULL. A proposal is written by a model, so its ids are not trusted to be ids.
CREATE OR REPLACE FUNCTION ops.as_uuid(p_text TEXT)
RETURNS UUID
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::uuid END;
$$;

-- ---------------------------------------------------------------------------
-- The digest covers the universe
-- ---------------------------------------------------------------------------

-- As before, with one more way in for the digest: a change to a record in the
-- person's universe, in the last 14 days.
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
      AND (
          (
              p_delivery = 'IMMEDIATE' AND p_user_id = ANY (e.recipients)
              -- A notice about a review that has since been decided is no longer news.
              AND (e.subject_type <> 'REVIEW' OR EXISTS (
                  SELECT 1 FROM ops.workflow_reviews AS q WHERE q.id = e.subject_id AND q.status = 'OPEN'
              ))
          )
          OR EXISTS (
              SELECT 1 FROM ops.assistant_follows AS f
              WHERE f.user_id = p_user_id
                AND f.client_id = p_client_id
                AND f.delivery = p_delivery
                AND (
                    (f.subject_type = 'KIND' AND f.subject_code = e.kind)
                    OR (f.subject_type = e.subject_type AND f.subject_id IS NOT NULL AND f.subject_id = e.subject_id)
                )
          )
          OR (
              p_delivery = 'DIGEST'
              AND e.subject_type = 'ENTITY'
              AND e.occurred_at > NOW() - INTERVAL '14 days'
              AND ops.has_universe(p_user_id, p_client_id)
              AND ops.in_universe(p_user_id, p_client_id, e.subject_id)
          )
      );
$$;

-- ---------------------------------------------------------------------------
-- Reads, for the caller
-- ---------------------------------------------------------------------------

-- What the caller's universe is made of, across the clients on their session.
CREATE OR REPLACE FUNCTION public.universe_summary()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    WITH mine AS (
        SELECT r.subject_type, r.domain_code
        FROM ops.responsibilities AS r
        WHERE auth.uid() IS NOT NULL
          AND r.client_id IN (SELECT tenancy.current_client_ids())
          AND ops.responsibility_held_by(r.client_id, auth.uid(), r.user_id, r.role_code)
    ), followed AS (
        SELECT f.id
        FROM ops.assistant_follows AS f
        WHERE f.user_id = auth.uid() AND f.subject_type = 'ENTITY'
          AND f.client_id IN (SELECT tenancy.current_client_ids())
    )
    SELECT jsonb_build_object(
        'followed', (SELECT count(*) FROM followed),
        'responsible_records', (SELECT count(*) FROM mine WHERE subject_type = 'ENTITY'),
        'responsible_domains', COALESCE((SELECT jsonb_agg(DISTINCT domain_code ORDER BY domain_code) FROM mine WHERE subject_type = 'DOMAIN'), '[]'::jsonb),
        'has_any', EXISTS (SELECT 1 FROM followed) OR EXISTS (SELECT 1 FROM mine)
    );
$$;

-- The records among these that are in the caller's universe. One they cannot read is left out.
CREATE OR REPLACE FUNCTION public.universe_entities(p_entity_ids UUID[])
RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
    SELECT COALESCE(array_agg(me.id), '{}')
    FROM entity_instances.master_entities AS me
    WHERE me.id = ANY (COALESCE(p_entity_ids, '{}'))
      AND me.client_id IN (SELECT tenancy.current_client_ids())
      AND me.id IN (SELECT tenancy.readable_entity_ids())
      AND ops.in_universe(auth.uid(), me.client_id, me.id);
$$;

-- The open reviews that are the caller's business: assigned to them, or
-- proposing a change to a record or a domain in their universe.
CREATE OR REPLACE FUNCTION public.universe_review_ids()
RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT COALESCE(array_agg(q.id), '{}')
    FROM ops.workflow_reviews AS q
    WHERE auth.uid() IS NOT NULL
      AND q.status = 'OPEN'
      AND ops.workflow_can_see(q.client_id)
      AND (
          (
              (cardinality(q.assigned_users) > 0 OR cardinality(q.assigned_roles) > 0)
              AND ops.workflow_review_assigned(q.client_id, auth.uid(), q.assigned_users, q.assigned_roles)
          )
          OR (
              ops.has_universe(auth.uid(), q.client_id)
              AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.proposal -> 'items') = 'array' THEN q.proposal -> 'items' ELSE '[]'::jsonb END) AS i
                  WHERE ops.in_universe(auth.uid(), q.client_id, COALESCE(ops.as_uuid(i -> 'target' ->> 'entityId'), ops.as_uuid(i -> 'args' ->> 'entityId')))
                     OR ops.domain_in_universe(auth.uid(), q.client_id, COALESCE(i -> 'target' ->> 'domainCode', i -> 'args' ->> 'domainCode'))
              )
          )
      );
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.responsibility_held_by(UUID, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.has_universe(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.in_universe(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.domain_in_universe(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_pending(UUID, UUID, TEXT) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.assistant_follows_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_follow_children(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.universe_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.universe_entities(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.universe_review_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_follows_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assistant_follow_children(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.universe_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.universe_entities(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.universe_review_ids() TO authenticated;

NOTIFY pgrst, 'reload schema';
