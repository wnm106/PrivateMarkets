# Meridian MDM Architecture Guide

## Overview

Meridian MDM implements a bi-temporal Entity-Attribute-Value (EAV) architecture designed specifically for private markets investment data management. This document explains the core architectural concepts and design decisions.

## Core Concepts

### Bi-temporal Model

The system tracks two independent time dimensions for every data point:

1. **Valid Time (Assertion Time)**
   - When the data was true in reality
   - Example: A NAV value valid from 2024-01-01 to 2024-01-31
   - Fields: `valid_from`, `valid_to`

2. **System Time (System Time)**
   - When the data was recorded in the system
   - Example: We learned about the NAV on 2024-02-05
   - Fields: `system_from`, `system_to`

This dual-time model enables:
- **Point-in-time queries**: "What was the NAV as of Jan 15?"
- **Knowledge queries**: "When did we first learn about the NAV correction?"
- **Audit trails**: Complete history of all changes
- **Temporal corrections**: Fix historical data without losing audit trail

### Entity-Attribute-Value (EAV) Model

Instead of traditional wide tables, we use EAV:

```
Entity: FUND-001
  ├── Attribute: NAV = 1000000 (from Bloomberg)
  ├── Attribute: NAV_DATE = 2024-01-31 (from Bloomberg)
  ├── Attribute: AUM = 500000000 (from Allvue)
  └── Attribute: MANAGER = "John Doe" (from Manual)
```

Benefits:
- **Flexibility**: Add new attributes without schema changes
- **Polymorphism**: Different entities can have different attributes
- **Source tracking**: Each value tracks its source
- **Temporal granularity**: Each attribute can have independent timelines

### Golden Record Resolution

When multiple sources provide values for the same attribute:

```
Entity: FUND-001, Attribute: NAV
  ├── Bloomberg: 1,000,000 (precedence 10)
  ├── Allvue: 1,005,000 (precedence 40)
  └── Manual: 1,002,000 (precedence 90)
  
Golden Record: 1,000,000 (Bloomberg wins by precedence)
```

Resolution logic:
1. Template defines attribute precedence rules
2. Source registry provides default rankings
3. Manual overrides can supersede automatic resolution
4. All competing values stored for audit

## Schema Architecture

### 1. Metadata Registry

Defines the structure of the MDM system:

```sql
domain_types              -- FUND, ISSUER, DEAL, SECURITY, PRICE, POSITION
attribute_register        -- Attribute definitions with types and validation
domain_templates          -- Template configurations per domain
template_attribute_assignments  -- Which attributes belong to templates
reference_lists           -- Enumerated values
```

### 2. Entity Instances

Tracks master entities and source data:

```sql
master_entities           -- Core entity registry
source_registry           -- Vendor feed configurations
feed_lineage              -- Feed ingestion tracking
source_attribute_values   -- Source-provided values (staging)
```

### 3. Golden Master

The bi-temporal EAV ledger:

```sql
entity_attribute_values   -- Golden records with bi-temporal tracking
```

Key fields:
- `entity_id`, `attribute_id`, `source_id`
- `golden_value` (resolved value)
- `valid_from`, `valid_to` (valid time)
- `system_from`, `system_to` (system time)
- `precedence_rank`, `competing_values`

### 4. Positions

A position is a `POSITION` entity in `master_entities`. Quantity, cost, and market value are attributes on the golden ledger. The fund and the security are relationships. There is no separate position table.

### 5. Data Quality

Rule engine and exception tracking:

```sql
dq_rules                  -- Rule definitions
dq_exceptions             -- Exception instances
```

### 6. Read Projections

Generic denormalized view for CQRS:

```sql
entity_master             -- Generic entity view with attributes and relationships as JSONB
```

The `entity_master` view aggregates:
- Entity metadata from `master_entities`
- All attributes as a JSONB object (keyed by attribute code)
- Parent relationships as a JSONB array
- Child relationships as a JSONB array

This single view serves all entity types, eliminating the need for domain-specific views.

### 7. Entity Relationships

Tracks parent-child and cross-reference relationships between entities:

```sql
entity_relationships      -- Parent-child relationships with bi-temporal tracking
relationship_types        -- Registry of allowed relationship types
```

Key features:
- **Bi-temporal**: Relationships have valid_time and system_time like attributes
- **Typed**: Each relationship has a type (e.g., ISSUER_OF, HELD_BY) and code
- **Primary flag**: Distinguish primary vs secondary relationships
- **Domain-agnostic**: Any entity can relate to any other entity

Example relationships:
- Security → Issuer (ISSUER_OF)
- Position → Fund (HELD_BY)
- Position → Security (POSITION_IN)
- Issuer → Issuer (PARENT_OF)

## Data Flow

### 1. Source Ingestion

```
Vendor Feed → feed_lineage → source_attribute_values
```

1. Feed received and logged in `feed_lineage`
2. Raw values staged in `source_attribute_values`
3. Each value tagged with source, lineage, and valid time

### 2. Golden Record Resolution

```
source_attribute_values → entity_attribute_values (golden_master)
```

1. For each entity-attribute combination:
   - Collect all current source values
   - Apply precedence rules from template
   - Resolve to single golden value
   - Store with competing values for audit

### 3. Read Projection

```
entity_attribute_values + entity_relationships → read_projections.entity_master
```

1. EAV data aggregated as JSONB attributes per entity
2. Relationships aggregated as JSONB arrays (parent + child)
3. Single generic view serves all entity types
4. Optimized for read performance
5. Refreshed on data changes

## Temporal Query Patterns

### Current Values (As of Today)

```sql
SELECT *
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_id = '...'
  AND valid_to = '9999-12-31'
  AND system_to = '9999-12-31 23:59:59';
```

### Point-in-Time Query

```sql
SELECT *
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_id = '...'
  AND valid_from <= '2024-01-15'
  AND valid_to >= '2024-01-15'
  AND system_to = '9999-12-31 23:59:59';
```

### Knowledge Query (When did we know?)

```sql
SELECT system_from, golden_value
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_id = '...'
ORDER BY system_from;
```

### Bi-temporal Split

```sql
-- Split a record at a specific date
SELECT golden_master.split_valid_time(
  p_eav_id := '...',
  p_split_date := '2024-01-15',
  p_new_value := '1005000',
  p_source_id := '...'
);
```

## Source Precedence

### Default Rankings

| Source | Rank | Description |
|--------|------|-------------|
| Bloomberg | 10 | Highest priority market data |
| WSO | 20 | Wall Street Oasis |
| DealCloud | 30 | Deal and transaction data |
| Allvue | 40 | Fund accounting |
| S&P Capital IQ | 50 | Company and security data |
| Internal | 60 | Internal systems |
| Manual | 90 | Manual overrides |
| Calculated | 100 | System-calculated values |

### Template-Specific Overrides

Templates can override default precedence:

```json
{
  "precedence_rules": {
    "NAV": {
      "sources": ["ALLVUE", "BLOOMBERG", "MANUAL"],
      "logic": "ALLVUE takes precedence for fund accounting data"
    }
  }
}
```

## Data Quality Framework

### Rule Types

1. **Completeness**: Required fields must have values
2. **Validity**: Values must conform to format/range constraints
3. **Consistency**: Cross-field validation (e.g., start < end date)
4. **Timeliness**: Data must be fresh enough
5. **Uniqueness**: No duplicate entities

### Severity Levels

- **CRITICAL**: Blocks downstream processes
- **HIGH**: Requires immediate attention
- **MEDIUM**: Should be resolved soon
- **LOW**: Informational

### Exception Workflow

```
OPEN → IN_REVIEW → RESOLVED
                  → WAIVED
                  → FALSE_POSITIVE
```

## Security Model

### Row Level Security (RLS)

All tables have RLS enabled with policies based on user roles:

- **authenticated**: Read access to most tables
- **admin**: Full access
- **steward**: Data governance operations
- **ops**: Operational tasks
- **governance**: Policy and configuration

### Audit Trail

Every change is tracked:
- `created_at`, `created_by`
- `updated_at`, `updated_by`
- `system_from`, `system_to` (bi-temporal)
- `competing_values` (for golden records)

## Performance Considerations

### Indexing Strategy

1. **Temporal indexes**: GiST indexes on valid_time and system_time ranges
2. **Entity indexes**: B-tree on entity_id for EAV lookups
3. **Current record indexes**: Partial indexes on current records
4. **Projection indexes**: Optimized for read patterns

### Partitioning

Large tables can be partitioned by:
- Time (valid_from)
- Domain (domain_code)
- Source (source_id)

### Materialized Views

For complex aggregations:
- Position metrics
- Portfolio summaries
- DQ statistics

## Scalability

### Horizontal Scaling

- **Read replicas**: For read-heavy workloads
- **Connection pooling**: Via Supabase
- **Caching**: Redis for hot data

### Vertical Scaling

- **Partitioning**: Reduce table sizes
- **Archival**: Move old data to archive tables
- **Compression**: PostgreSQL TOAST for large values

## Monitoring

### Key Metrics

1. **Data freshness**: Time since last feed ingestion
2. **DQ exception rate**: % of records with exceptions
3. **Source coverage**: % of required attributes populated
4. **Query performance**: P95 latency for common queries

### Alerts

- Feed ingestion failures
- Critical DQ exceptions
- Golden record conflicts
- Query performance degradation

## Adding New Entity Types at Runtime

One of the key benefits of this generic architecture is that new entity types can be added without code changes. Here's how:

### Step 1: Define the Domain Type

Insert a new domain type into the metadata registry:

```sql
INSERT INTO metadata_register.domain_types (domain_code, domain_name, description)
VALUES ('COVENANT', 'Covenant', 'Loan covenants and terms');
```

### Step 2: Define Attributes

Add attributes for the new entity type:

```sql
INSERT INTO metadata_register.attribute_register 
  (attribute_code, attribute_name, data_type, description, is_required)
VALUES 
  ('COVENANT_TYPE', 'Covenant Type', 'STRING', 'Type of covenant', TRUE),
  ('THRESHOLD_VALUE', 'Threshold Value', 'NUMBER', 'Covenant threshold', TRUE),
  ('TEST_FREQUENCY', 'Test Frequency', 'STRING', 'How often tested', FALSE);
```

### Step 3: Create a Template

Define a template that groups attributes:

```sql
INSERT INTO metadata_register.domain_templates 
  (template_code, domain_code, template_name, description)
VALUES 
  ('FINANCIAL', 'COVENANT', 'Financial Covenant', 'Financial maintenance covenants');

-- Assign attributes to template
INSERT INTO metadata_register.template_attribute_assignments
  (template_id, attribute_id, is_required, display_order)
VALUES
  ((SELECT id FROM domain_templates WHERE template_code = 'FINANCIAL'),
   (SELECT id FROM attribute_register WHERE attribute_code = 'COVENANT_TYPE'),
   TRUE, 1),
  ((SELECT id FROM domain_templates WHERE template_code = 'FINANCIAL'),
   (SELECT id FROM attribute_register WHERE attribute_code = 'THRESHOLD_VALUE'),
   TRUE, 2);
```

### Step 4: Define Relationships (Optional)

If the new entity type has relationships with existing entities:

```sql
INSERT INTO metadata_register.relationship_types
  (relationship_code, relationship_name, parent_domain_code, child_domain_code)
VALUES
  ('COVENANT_LOAN', 'Covenant for loan', 'COVENANT', 'LOAN');
```

### Step 5: Create Entities via GraphQL

Now you can create entities of the new type using the generic API:

```graphql
mutation {
  createEntity(input: {
    entityCode: "COV-001"
    entityName: "Maintenance Test Q1 2026"
    domainCode: "COVENANT"
    templateCode: "FINANCIAL"
    attributes: {
      COVENANT_TYPE: "Leverage Ratio"
      THRESHOLD_VALUE: 4.5
      TEST_FREQUENCY: "Quarterly"
    }
    parentRelationships: [{
      parentEntityId: "loan-uuid-here"
      relationshipType: "GOVERNS"
      relationshipCode: "COVENANT_LOAN"
      validFrom: "2026-01-01"
    }]
  }) {
    entity {
      id
      entityCode
      attributes
    }
  }
}
```

### Step 6: Query via GraphQL

Query the new entity type using the generic API:

```graphql
query {
  entities(filter: { domainCode: "COVENANT" }) {
    edges {
      node {
        entityCode
        entityName
        attributes
        parentRelationships {
          parentEntityName
          relationshipType
        }
      }
    }
  }
}
```

**No code changes required!** The system automatically handles the new entity type through metadata configuration.

## Future Enhancements

1. **Event sourcing**: Full event log for all changes
2. **Graph relationships**: Entity relationship graph visualization
3. **ML-based DQ**: Anomaly detection for data quality
4. **Automated reconciliation**: Cross-source validation
5. **Real-time streaming**: Kafka for change data capture
6. **Dynamic UI generation**: Auto-generate forms from template metadata

## References

- [Bi-temporal Model](./BI_TEMPORAL.md)
- [API Documentation](./API.md)
- [Deployment Guide](./DEPLOYMENT.md)
