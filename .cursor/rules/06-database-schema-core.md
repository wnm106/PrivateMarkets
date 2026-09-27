# Database Schema (Supabase) - Core Tables

## master_entities
Generic entity storage for all domain types.

```sql
id UUID PRIMARY KEY
entity_code TEXT NOT NULL
entity_name TEXT NOT NULL
domain_code TEXT NOT NULL
template_id UUID
description TEXT
is_active BOOLEAN DEFAULT true
attributes JSONB
metadata JSONB
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## entity_instances
Domain-specific entity instances.

```sql
id UUID PRIMARY KEY
entity_id UUID REFERENCES master_entities(id)
domain_code TEXT NOT NULL
template_code TEXT
is_active BOOLEAN DEFAULT true
valid_from DATE
valid_to DATE
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## attribute_register
Attribute definitions.

```sql
id UUID PRIMARY KEY
attribute_code TEXT NOT NULL
attribute_name TEXT NOT NULL
domain_code TEXT
data_type TEXT NOT NULL
description TEXT
unit_of_measure TEXT
is_required BOOLEAN DEFAULT false
is_multi_valued BOOLEAN DEFAULT false
reference_domain_code TEXT
default_precedence_rank INT NOT NULL
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## entity_attribute_values
Attribute values with source tracking.

```sql
id UUID PRIMARY KEY
entity_id UUID NOT NULL
attribute_id UUID NOT NULL
source_id UUID
golden_value TEXT
golden_value_numeric NUMERIC
valid_from DATE NOT NULL
valid_to DATE NOT NULL
system_from TIMESTAMP NOT NULL
system_to TIMESTAMP NOT NULL
precedence_rank INT
is_manual_override BOOLEAN DEFAULT false
resolution_rule_applied TEXT
metadata JSONB
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
created_by TEXT
updated_by TEXT
```

## source_registry
Data source registry.

```sql
id UUID PRIMARY KEY
source_code TEXT NOT NULL
source_name TEXT NOT NULL
source_type TEXT NOT NULL
description TEXT
is_active BOOLEAN DEFAULT true
created_at TIMESTAMP DEFAULT NOW()
```