-- Precedence rule tables were created without grants, so the API role
-- cannot read or write them. Match the other metadata catalog tables:
-- any signed-in user can read, tenant admins can change them.

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.precedence_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.precedence_rule_conditions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.precedence_rule_chain TO authenticated;

GRANT SELECT ON metadata_register.precedence_rules TO service_role;
GRANT SELECT ON metadata_register.precedence_rule_conditions TO service_role;
GRANT SELECT ON metadata_register.precedence_rule_chain TO service_role;

ALTER TABLE metadata_register.precedence_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.precedence_rule_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.precedence_rule_chain ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS precedence_rules_select_authenticated ON metadata_register.precedence_rules;
DROP POLICY IF EXISTS precedence_rules_write_tenant_admin ON metadata_register.precedence_rules;
CREATE POLICY precedence_rules_select_authenticated ON metadata_register.precedence_rules
  FOR SELECT TO authenticated USING (true);
CREATE POLICY precedence_rules_write_tenant_admin ON metadata_register.precedence_rules
  FOR ALL TO authenticated
  USING (tenancy.is_tenant_admin())
  WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS precedence_rule_conditions_select_authenticated ON metadata_register.precedence_rule_conditions;
DROP POLICY IF EXISTS precedence_rule_conditions_write_tenant_admin ON metadata_register.precedence_rule_conditions;
CREATE POLICY precedence_rule_conditions_select_authenticated ON metadata_register.precedence_rule_conditions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY precedence_rule_conditions_write_tenant_admin ON metadata_register.precedence_rule_conditions
  FOR ALL TO authenticated
  USING (tenancy.is_tenant_admin())
  WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS precedence_rule_chain_select_authenticated ON metadata_register.precedence_rule_chain;
DROP POLICY IF EXISTS precedence_rule_chain_write_tenant_admin ON metadata_register.precedence_rule_chain;
CREATE POLICY precedence_rule_chain_select_authenticated ON metadata_register.precedence_rule_chain
  FOR SELECT TO authenticated USING (true);
CREATE POLICY precedence_rule_chain_write_tenant_admin ON metadata_register.precedence_rule_chain
  FOR ALL TO authenticated
  USING (tenancy.is_tenant_admin())
  WITH CHECK (tenancy.is_tenant_admin());
