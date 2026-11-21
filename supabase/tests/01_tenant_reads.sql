-- Row visibility: each client reads its own records and nothing of the other
-- client's, and a caller with no login reads nothing.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('01_tenant_reads');

-- ---------------------------------------------------------------- client A analyst
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('A analyst: auth.uid() is the A analyst',
    $$SELECT auth.uid()$$, 'a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('A analyst: current_client_ids is client A only',
    $$SELECT string_agg(c::text, ',') FROM tenancy.current_client_ids() c$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_rows('A analyst reads both A funds',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 2);
SELECT tests.expect_rows('A analyst reads no record of another client',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id <> 'aaaaaaaa-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('A analyst reads the NAV of A-FUND-1',
    $$SELECT 1 FROM golden_master.entity_attribute_values WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.expect_rows('A analyst reads no golden value of client B',
    $$SELECT 1 FROM golden_master.entity_attribute_values v
      WHERE v.entity_id IN ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f2')$$, 0);
SELECT tests.expect_rows('A analyst reads B-FUND-1 through public.master_entities: no rows',
    $$SELECT 1 FROM public.master_entities WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_rows('A analyst sees only client A in tenancy.clients',
    $$SELECT 1 FROM tenancy.clients WHERE id <> 'aaaaaaaa-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('A analyst sees no membership of client B',
    $$SELECT 1 FROM tenancy.client_users WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('A analyst sees no B intersection',
    $$SELECT 1 FROM entity_instances.intersection_instances WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c1'$$, 0);
SELECT tests.expect_denied('A analyst sees no B load batch',
    $$SELECT 1 FROM entity_instances.load_batches WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$);
SELECT tests.expect_denied('A analyst reads no B feed connection',
    $$SELECT 1 FROM ops.connections WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$);
SELECT tests.expect_denied('A analyst cannot read vault secrets',
    $$SELECT 1 FROM vault.decrypted_secrets$$);

-- T18: client-owned rows in tables that used to have a USING (true) read policy.
SELECT tests.expect_rows('T18 A analyst reads no client-B narrative template',
    $$SELECT 1 FROM public.narrative_templates WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('T18 A analyst reads no client-B dashboard template',
    $$SELECT 1 FROM public.dashboard_templates WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('T18 A analyst reads no client-B compliance rule',
    $$SELECT 1 FROM compliance.rules WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('A analyst still reads shared compliance rules',
    $$SELECT 1 FROM compliance.rules WHERE rule_code = 'FUND_FAMILY_NAV_CAP'$$, 1);

-- T17: the parent template is hidden, and so are its children.
SELECT tests.expect_rows('T17 A analyst does not see the B statement template',
    $$SELECT 1 FROM metadata_register.domain_templates WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c7'$$, 0);
SELECT tests.expect_rows('T17 A analyst does not read its sources',
    $$SELECT 1 FROM metadata_register.template_sources WHERE template_id = 'bbbbbbbb-0000-0000-0000-0000000000c7'$$, 0);
SELECT tests.expect_rows('T17 A analyst does not read its sections',
    $$SELECT 1 FROM metadata_register.template_sections WHERE template_id = 'bbbbbbbb-0000-0000-0000-0000000000c7'$$, 0);

-- T4a: client B's compliance data.
SELECT tests.expect_rows('T4a A analyst reads no audit entry for a B order',
    $$SELECT 1 FROM compliance.compliance_audit_log WHERE order_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000a1'$$, 0);
SELECT tests.expect_rows('T4a A analyst reads no B fund limit',
    $$SELECT 1 FROM compliance.rule_thresholds WHERE entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_rows('T4a A analyst reads no result for a B fund',
    $$SELECT 1 FROM compliance.rule_evaluation_results WHERE anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_rows('T4a A analyst reads no run that scored a B fund',
    $$SELECT 1 FROM compliance.rule_evaluation_runs r
      WHERE EXISTS (SELECT 1 FROM compliance.rule_evaluation_results x
                    WHERE x.run_id = r.id AND x.anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1')$$, 0);

-- T10: stored documents under client B's folder.
SELECT tests.expect_rows('T10 A analyst does not list B documents',
    $$SELECT 1 FROM storage.objects WHERE bucket_id = 'documents' AND name LIKE 'bbbbbbbb-0000-0000-0000-000000000001/%'$$, 0);

-- ---------------------------------------------------------------- client B analyst: own data still readable
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('B analyst reads its funds and order',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 3);
SELECT tests.expect_rows('B analyst reads no record of client A',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_value('B analyst reads the NAV of B-FUND-1',
    $$SELECT golden_value FROM golden_master.entity_attribute_values WHERE entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, '987654.321');
SELECT tests.expect_rows('B analyst reads its intersection',
    $$SELECT 1 FROM entity_instances.intersection_instances WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c1'$$, 1);
SELECT tests.expect_rows('B analyst reads its narrative template',
    $$SELECT 1 FROM public.narrative_templates WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 1);
SELECT tests.expect_rows('B analyst reads its compliance rule',
    $$SELECT 1 FROM compliance.rules WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 1);
SELECT tests.expect_rows('B analyst reads its fund limit',
    $$SELECT 1 FROM compliance.rule_thresholds WHERE entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.expect_rows('B analyst reads the result for its fund',
    $$SELECT 1 FROM compliance.rule_evaluation_results WHERE anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.expect_rows('B analyst reads the audit entry for its order',
    $$SELECT 1 FROM compliance.compliance_audit_log WHERE order_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000a1'$$, 1);
SELECT tests.expect_rows('B analyst reads its statement template and its children',
    $$SELECT 1 FROM metadata_register.domain_templates t
      JOIN metadata_register.template_sources s ON s.template_id = t.id
      JOIN metadata_register.template_sections x ON x.template_id = t.id
      WHERE t.id = 'bbbbbbbb-0000-0000-0000-0000000000c7'$$, 1);
SELECT tests.expect_rows('T10 B analyst lists its document',
    $$SELECT 1 FROM storage.objects WHERE bucket_id = 'documents' AND name LIKE 'bbbbbbbb-0000-0000-0000-000000000001/%'$$, 1);

-- The shared catalog stays readable to every member (compared as owner below).
SELECT tests.owner();
CREATE TEMP TABLE shared_catalog ON COMMIT DROP AS
SELECT 'template_attribute_assignments' AS t, count(*) AS n FROM metadata_register.template_attribute_assignments
UNION ALL SELECT 'calc_definitions', count(*) FROM metadata_register.calc_definitions
UNION ALL SELECT 'calc_inputs', count(*) FROM metadata_register.calc_inputs
UNION ALL SELECT 'attribute_aliases', count(*) FROM metadata_register.attribute_aliases
UNION ALL SELECT 'shared attributes', count(*) FROM metadata_register.attribute_register WHERE client_id IS NULL
UNION ALL SELECT 'shared templates', count(*) FROM metadata_register.domain_templates WHERE client_id IS NULL
UNION ALL SELECT 'reference_list_values', count(*) FROM metadata_register.reference_list_values
UNION ALL SELECT 'shared narrative templates', count(*) FROM public.narrative_templates WHERE client_id IS NULL
UNION ALL SELECT 'shared dashboard templates', count(*) FROM public.dashboard_templates WHERE client_id IS NULL
UNION ALL SELECT 'record_experiences', count(*) FROM public.record_experiences;
GRANT SELECT ON shared_catalog TO authenticated;
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('B analyst reads the whole shared catalog (assignments, calcs, aliases, attributes, templates, lists, narratives, dashboards, experiences)',
    $$SELECT 1 FROM shared_catalog c
      WHERE c.n > 0 AND c.n = CASE c.t
        WHEN 'template_attribute_assignments' THEN (SELECT count(*) FROM metadata_register.template_attribute_assignments)
        WHEN 'calc_definitions' THEN (SELECT count(*) FROM metadata_register.calc_definitions)
        WHEN 'calc_inputs' THEN (SELECT count(*) FROM metadata_register.calc_inputs)
        WHEN 'attribute_aliases' THEN (SELECT count(*) FROM metadata_register.attribute_aliases)
        WHEN 'shared attributes' THEN (SELECT count(*) FROM metadata_register.attribute_register WHERE client_id IS NULL)
        WHEN 'shared templates' THEN (SELECT count(*) FROM metadata_register.domain_templates WHERE client_id IS NULL)
        WHEN 'reference_list_values' THEN (SELECT count(*) FROM metadata_register.reference_list_values)
        WHEN 'shared narrative templates' THEN (SELECT count(*) FROM public.narrative_templates WHERE client_id IS NULL)
        WHEN 'shared dashboard templates' THEN (SELECT count(*) FROM public.dashboard_templates WHERE client_id IS NULL)
        WHEN 'record_experiences' THEN (SELECT count(*) FROM public.record_experiences)
      END$$, 10);

-- ---------------------------------------------------------------- signed in, no client
SELECT tests.login('c0000000-0000-0000-0000-00000000000d');
SELECT tests.expect_rows('User with no client reads no client record',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.expect_rows('User with no client reads no golden value',
    $$SELECT 1 FROM golden_master.entity_attribute_values$$, 0);

-- ---------------------------------------------------------------- no login
SELECT tests.anon();
SELECT tests.expect_denied('anon reads no records through public.master_entities',
    $$SELECT 1 FROM public.master_entities$$);
SELECT tests.expect_denied('anon reads no records directly',
    $$SELECT 1 FROM entity_instances.master_entities$$);
SELECT tests.expect_denied('anon reads no golden values',
    $$SELECT 1 FROM golden_master.entity_attribute_values$$);
SELECT tests.expect_denied('anon reads no chat conversations',
    $$SELECT 1 FROM public.chat_conversations$$);
SELECT tests.expect_denied('anon reads no client-owned dashboard template',
    $$SELECT 1 FROM public.dashboard_templates WHERE client_id IS NOT NULL$$);
SELECT tests.expect_denied('anon reads no client-owned narrative template',
    $$SELECT 1 FROM public.narrative_templates WHERE client_id IS NOT NULL$$);
SELECT tests.expect_denied('anon reads no tenancy clients',
    $$SELECT 1 FROM tenancy.clients$$);
SELECT tests.expect_denied('anon lists no stored documents',
    $$SELECT 1 FROM storage.objects WHERE bucket_id = 'documents'$$);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
