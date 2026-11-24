/**
 * How the platform stores things, for the Surface Builder's reviewer. The
 * catalog lists what exists; this says which mechanism a new concept belongs
 * in, so the reviewer models records as entities and rules as engine rows
 * instead of reaching for a JSON attribute.
 *
 * Keep it in step with docs/GUARDRAILS.md and the migrations it names. It names
 * mechanisms (tables, functions), never a client, rule or entity by its code.
 */
export const PLATFORM_MODEL = `
ENTITIES AND ATTRIBUTES
- Every record is an entity (entity_instances.master_entities) of an entity type (metadata_register.domain_types). A new kind of record is a new entity type, added as a seed record.
- Values are attributes (metadata_register.attribute_register) on an entity type. Each value is bi-temporal (valid from/to and known from/to), keeps its sources, and has a golden value chosen by precedence. A person's edit is a manual value written through the golden write path, with history and audit.
- So: anything a person edits one value at a time, a rule reads, or someone right-clicks to see sources should be its own attribute on an entity, not a key inside a JSON value. A JSON attribute is for an opaque payload no one edits or queries field by field.
- A time-varying attribute replaces a "per-year override" map: a value valid for one year is that year's value.
- Derived values are calculated attributes or a query; they are never stored or edited.

RELATIONSHIPS
- Entities link through relationship types (metadata_register.relationship_types: a parent entity type and a child entity type). Each link (entity_instances.entity_relationships) has valid from/to dates. A hierarchy of entities of one type (a client and its sleeves) is a relationship to the same type.
- When a value belongs to a pair of things (a target for one fund at one taxonomy node), make the pair an entity of its own linked to both, so the value is an attribute with history; do not hide it in relationship metadata.

REFERENCE LISTS AND TAXONOMIES
- Allowed values are reference lists (metadata_register.reference_lists and reference_list_values). A multi-level classification (Category > Asset Class > Strategy) is either reference lists with parent links, or an entity type with a parent relationship when its nodes carry their own attributes or targets.

COMPLIANCE (one interpreter)
- A rule is a compliance.rules row, versioned in compliance.rule_versions (what it measures, how it groups, its base entity type) with conditions in compliance.rule_conditions.
- Which funds a rule covers: compliance.rule_scope_assignments (include or exclude, optionally cascading to children).
- A fund's own limit: compliance.rule_thresholds (soft and hard limit, optional group value or rank band, valid from/to). A sleeve-specific limit or a Hard vs Soft severity is a threshold row, not a new column.
- compliance.evaluate_rule interprets every rule. compliance.deal_score_plans decides which rules a deal is scored on and for which funds. Capacity reads the evaluator (compliance.deal_capacity_observations) and is solved in packages/graphql/src/lib/compliance-capacity.ts. A surface calls these; it never re-implements a rule, a limit check or capacity.
- A rule kind the evaluator cannot express yet is an evaluator extension (a migration to compliance.evaluate_rule), driven by rule metadata, not code that names the rule.

CALCULATIONS
- Every calculation has one home: a database function, a calculated attribute, or one shared module. The surface and the assistant both read it there. Name the home for each calculation the prototype does in the browser.

WRITES AND WORKFLOWS
- Seed records (entity types, attributes, relationship types, lists, rules) go in supabase/seed; migrations change schema and functions only.
- An agent proposes, a person approves, a fixed step applies. Agents read with read-only tools and never write directly.
`.trim();
