-- Load data reads field aliases as the service role.
--
-- 20261119190500_semantic_aliases taught Load data to read the aliases of
-- record types, names and fields when it plans a file's columns, and granted
-- the service role the three alias tables it added. Field aliases already
-- lived in metadata_register.attribute_aliases, which only signed-in users
-- could read, so every upload that needed a fresh column plan failed with
-- "permission denied for table attribute_aliases". This grants the service
-- role what it has on the other alias tables.

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.attribute_aliases TO service_role;
