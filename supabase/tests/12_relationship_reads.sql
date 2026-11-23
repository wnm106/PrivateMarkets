-- Relationship reads: a link is readable when both of its records pass
-- tenancy.has_entity_access(id, 'READ'), or both pass it for 'WRITE'. The
-- policy checks a set of records once per query; these checks hold it to the
-- per-record rule, with and without a restricted record. Writes keep their
-- per-row check.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('12_relationship_reads');

-- ---------------------------------------------------------------- links
SELECT tests.owner();
CREATE TABLE tests.rel_links (name text PRIMARY KEY, id uuid NOT NULL, parent uuid NOT NULL, child uuid NOT NULL);
GRANT SELECT ON tests.rel_links TO authenticated, anon;

WITH made AS (
    INSERT INTO entity_instances.entity_relationships
        (parent_entity_id, child_entity_id, relationship_type, relationship_code, valid_from)
    VALUES
        ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'TEST_LINK', 'TEST_LINK', DATE '2020-01-01'),
        ('aaaaaaaa-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'TEST_LINK', 'TEST_LINK', DATE '2020-01-01'),
        ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f2', 'TEST_LINK', 'TEST_LINK', DATE '2020-01-01')
    RETURNING id, parent_entity_id, child_entity_id
)
INSERT INTO tests.rel_links (name, id, parent, child)
SELECT CASE
         WHEN parent_entity_id::text LIKE 'aaaa%' AND child_entity_id::text LIKE 'aaaa%' THEN 'A1_A2'
         WHEN parent_entity_id::text LIKE 'aaaa%' THEN 'A1_B1'
         ELSE 'B1_B2'
       END, id, parent_entity_id, child_entity_id
FROM made;

-- The policy and the per-record rule must agree for whoever is signed in.
CREATE OR REPLACE FUNCTION tests.rel_parity(p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_policy text;
    v_rule text;
BEGIN
    SELECT COALESCE(string_agg(l.name, ',' ORDER BY l.name), '')
      INTO v_policy
      FROM tests.rel_links l
      JOIN entity_instances.entity_relationships r ON r.id = l.id;
    SELECT COALESCE(string_agg(l.name, ',' ORDER BY l.name), '')
      INTO v_rule
      FROM tests.rel_links l
     WHERE (tenancy.has_entity_access(l.parent, 'READ') AND tenancy.has_entity_access(l.child, 'READ'))
        OR (tenancy.has_entity_access(l.parent, 'WRITE') AND tenancy.has_entity_access(l.child, 'WRITE'));
    PERFORM tests.check(p_label, v_policy = v_rule, format('policy: %s / has_entity_access: %s', v_policy, v_rule));
END;
$$;
GRANT EXECUTE ON FUNCTION tests.rel_parity(text) TO authenticated;

-- ---------------------------------------------------------------- no restricted records
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('A analyst reads the A-to-A link only',
    $$SELECT string_agg(l.name, ',' ORDER BY l.name) FROM tests.rel_links l JOIN entity_instances.entity_relationships r ON r.id = l.id$$, 'A1_A2');
SELECT tests.expect_rows('A analyst reads no link that reaches a client-B record',
    $$SELECT 1 FROM entity_instances.entity_relationships r JOIN tests.rel_links l ON l.id = r.id WHERE l.name IN ('A1_B1', 'B1_B2')$$, 0);
SELECT tests.expect_rows('A analyst reads the same links through public.entity_relationships',
    $$SELECT 1 FROM public.entity_relationships r JOIN tests.rel_links l ON l.id = r.id$$, 1);
SELECT tests.rel_parity('A analyst: policy matches has_entity_access');

SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.rel_parity('A admin: policy matches has_entity_access');

SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('B analyst reads the B-to-B link only',
    $$SELECT string_agg(l.name, ',' ORDER BY l.name) FROM tests.rel_links l JOIN entity_instances.entity_relationships r ON r.id = l.id$$, 'B1_B2');
SELECT tests.rel_parity('B analyst: policy matches has_entity_access');

SELECT tests.login('c0000000-0000-0000-0000-00000000000d');
SELECT tests.expect_rows('A user in no client reads no link',
    $$SELECT 1 FROM entity_instances.entity_relationships r JOIN tests.rel_links l ON l.id = r.id$$, 0);

SELECT tests.login('c0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_rows('Staff not simulating a client read no client link',
    $$SELECT 1 FROM entity_instances.entity_relationships r JOIN tests.rel_links l ON l.id = r.id$$, 0);
SELECT tests.rel_parity('Staff: policy matches has_entity_access');

-- ---------------------------------------------------------------- writes keep their check
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('A analyst (read only) cannot add a link between A records',
    $INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_type, relationship_code, valid_from)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'TEST_LINK', 'TEST_LINK', DATE '2020-01-01')$);
SELECT tests.expect_rows('A analyst deletes no link',
    $DELETE FROM entity_instances.entity_relationships r USING tests.rel_links l WHERE r.id = l.id RETURNING 1$, 0);

SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_error('A steward cannot add a link to a client-B record',
    $INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_type, relationship_code, valid_from)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f2', 'bbbbbbbb-0000-0000-0000-0000000000f2', 'TEST_LINK', 'TEST_LINK', DATE '2020-01-01')$);
SELECT tests.expect_ok('A steward adds a link between A records',
    $INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_type, relationship_code, valid_from)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'TEST_LINK', 'TEST_LINK', DATE '2020-01-02')$);
SELECT tests.expect_rows('A steward changes no link that reaches a client-B record',
    $UPDATE entity_instances.entity_relationships r SET metadata = '{"x":1}' FROM tests.rel_links l WHERE r.id = l.id AND l.name = 'A1_B1' RETURNING 1$, 0);

SELECT tests.anon();
SELECT tests.expect_denied('anon reads no link',
    $$SELECT 1 FROM entity_instances.entity_relationships$$);

-- ---------------------------------------------------------------- A-FUND-2 restricted to the A steward
SELECT tests.owner();
INSERT INTO tenancy.entity_grants (client_id, entity_id, grantee_type, user_id, access_level)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'USER',
        'a0000000-0000-0000-0000-00000000000b', 'READ');

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('A analyst without a grant no longer reads the link to the restricted record',
    $$SELECT 1 FROM entity_instances.entity_relationships r JOIN tests.rel_links l ON l.id = r.id$$, 0);
SELECT tests.rel_parity('A analyst, restricted record: policy matches has_entity_access');

SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('A steward with the grant reads the link',
    $$SELECT string_agg(l.name, ',' ORDER BY l.name) FROM tests.rel_links l JOIN entity_instances.entity_relationships r ON r.id = l.id$$, 'A1_A2');
SELECT tests.rel_parity('A steward, restricted record: policy matches has_entity_access');

SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_value('A admin, who manages access, reads the link',
    $$SELECT string_agg(l.name, ',' ORDER BY l.name) FROM tests.rel_links l JOIN entity_instances.entity_relationships r ON r.id = l.id$$, 'A1_A2');
SELECT tests.rel_parity('A admin, restricted record: policy matches has_entity_access');

SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.rel_parity('B analyst, restricted record: policy matches has_entity_access');

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
