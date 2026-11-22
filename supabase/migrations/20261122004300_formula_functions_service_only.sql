-- The four formula evaluators from 00011_derived_attributes run SQL the caller passes
-- in (EXECUTE p_formula), as their owner, with no access check. Any signed-in person,
-- of any client, could read every client's data through them over the API, which
-- exposes metadata_register.
--
-- Nothing in the app calls them: the derived-attribute resolvers that would are not
-- in the GraphQL schema. They stay for the service role only.

REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_simple_formula(uuid, text, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_aggregate_formula(uuid, text, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_lookup_formula(uuid, text, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_custom_formula(uuid, text, date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION metadata_register.evaluate_simple_formula(uuid, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION metadata_register.evaluate_aggregate_formula(uuid, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION metadata_register.evaluate_lookup_formula(uuid, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION metadata_register.evaluate_custom_formula(uuid, text, date) TO service_role;

NOTIFY pgrst, 'reload schema';
