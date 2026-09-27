# Database Schema (Supabase) - Additional Tables

## entity_relationships
Entity relationships.

```sql
id UUID PRIMARY KEY
parent_entity_id UUID NOT NULL
child_entity_id UUID NOT NULL
relationship_type TEXT NOT NULL
relationship_code TEXT NOT NULL
is_primary BOOLEAN DEFAULT false
valid_from DATE NOT NULL
valid_to DATE
metadata JSONB
created_at TIMESTAMP DEFAULT NOW()
created_by TEXT
```

## relationship_types
Relationship type definitions.

```sql
id UUID PRIMARY KEY
relationship_code TEXT NOT NULL
relationship_name TEXT NOT NULL
parent_domain_code TEXT
child_domain_code TEXT
description TEXT
is_active BOOLEAN DEFAULT true
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## intersection_master
Intersection instances (composite entities).

```sql
id UUID PRIMARY KEY
intersection_id UUID NOT NULL
intersection_code TEXT NOT NULL
intersection_type_code TEXT NOT NULL
intersection_type_name TEXT NOT NULL
members JSONB NOT NULL
attributes JSONB
valid_from DATE NOT NULL
valid_to DATE NOT NULL
metadata JSONB
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## intersection_types
Intersection type definitions.

```sql
id UUID PRIMARY KEY
intersection_code TEXT NOT NULL
intersection_name TEXT NOT NULL
description TEXT
is_active BOOLEAN DEFAULT true
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
```

## intersection_type_members
Intersection type member definitions.

```sql
id UUID PRIMARY KEY
intersection_type_id UUID NOT NULL
domain_code TEXT NOT NULL
member_role TEXT NOT NULL
is_required BOOLEAN DEFAULT true
display_order INT
created_at TIMESTAMP DEFAULT NOW()
```

## dq_rules
Data quality rules.

```sql
id UUID PRIMARY KEY
rule_code TEXT NOT NULL
rule_name TEXT NOT NULL
domain_code TEXT
attribute_id UUID
rule_type TEXT NOT NULL
severity TEXT NOT NULL
rule_expression TEXT NOT NULL
rule_description TEXT
threshold_value FLOAT
is_active BOOLEAN DEFAULT true
auto_remediate BOOLEAN DEFAULT false
metadata JSONB
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## dq_exceptions
Data quality exceptions.

```sql
id UUID PRIMARY KEY
rule_id UUID NOT NULL
entity_id UUID NOT NULL
exception_type TEXT NOT NULL
exception_message TEXT NOT NULL
expected_value TEXT
actual_value TEXT
status TEXT NOT NULL
resolved_at TIMESTAMP
resolved_by TEXT
metadata JSONB
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
```

## Other Tables
- domain_types: Domain type definitions
- domain_templates: Entity templates per domain
- entity_identifier_definitions: Entity identifier definitions (match keys)