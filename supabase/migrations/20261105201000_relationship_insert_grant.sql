-- The public view is security_invoker, so an insert runs as the caller.
-- Authenticated could insert the view and not the table, and the pair was saved
-- with no links. Match the privileges already granted on the view.

GRANT INSERT, UPDATE ON entity_instances.entity_relationships TO authenticated;
