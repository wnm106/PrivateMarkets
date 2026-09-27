# Bi-temporal Data Model

## Overview

Meridian MDM uses a **bi-temporal** data model to track both *when data was true in reality* (valid time) and *when we learned about it* (system time). This is essential for financial master data where corrections, restatements, and delayed reporting are common.

## Two Time Dimensions

### Valid Time (Assertion Time)
- **Question answered**: "When was this data true in reality?"
- **Fields**: `valid_from`, `valid_to`
- **Example**: A NAV of $1,000,000 was valid from 2024-01-01 to 2024-01-31
- **Use cases**:
  - Point-in-time reporting ("What was the NAV on Jan 15?")
  - Historical analysis ("Show me the NAV trend over Q1")
  - Restatements ("The Jan 31 NAV was actually $1,005,000")

### System Time (Transaction Time)
- **Question answered**: "When did we record/learn about this data?"
- **Fields**: `system_from`, `system_to`
- **Example**: We recorded the Jan 31 NAV on Feb 5, 2024
- **Use cases**:
  - Audit trails ("When did we first learn about the NAV correction?")
  - Knowledge queries ("What did we believe on Feb 1?")
  - Compliance ("Prove when this data was entered")

## Bi-temporal Record Structure

Every data point in the `golden_master.entity_attribute_values` table has:

```sql
-- The data
entity_id          -- Which entity (e.g., FUND-001)
attribute_id       -- Which attribute (e.g., NAV)
golden_value       -- The resolved value
source_id          -- Which source provided this value

-- Valid time (when it was true)
valid_from         -- Start of validity period
valid_to           -- End of validity period (9999-12-31 = current)

-- System time (when we recorded it)
system_from        -- When this record was created
system_to          -- When this record was superseded (9999-12-31 = current)
```

## Query Patterns

### Current Values (As of Today)
```sql
SELECT *
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_id = '...'
  AND valid_to = '9999-12-31'           -- Currently valid
  AND system_to = '9999-12-31 23:59:59'; -- Latest knowledge
```

### Point-in-Time (Valid Time)
```sql
-- What was the NAV on Jan 15, 2024?
SELECT golden_value
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_code = 'NAV'
  AND valid_from <= '2024-01-15'
  AND valid_to >= '2024-01-15'
  AND system_to = '9999-12-31 23:59:59';
```

### Knowledge Query (System Time)
```sql
-- What did we believe on Feb 1, 2024?
SELECT golden_value, valid_from, valid_to
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_code = 'NAV'
  AND system_from <= '2024-02-01'
  AND system_to >= '2024-02-01';
```

### Full History
```sql
-- Show all changes to NAV over time
SELECT 
  golden_value,
  valid_from,
  valid_to,
  system_from,
  system_to,
  source_id
FROM golden_master.entity_attribute_values
WHERE entity_id = '...'
  AND attribute_code = 'NAV'
ORDER BY system_from, valid_from;
```

## Bi-temporal Operations

### Insert New Value
```sql
-- Close current record
UPDATE entity_attribute_values
SET system_to = NOW()
WHERE entity_id = '...'
  AND attribute_id = '...'
  AND valid_to = '9999-12-31'
  AND system_to = '9999-12-31 23:59:59';

-- Insert new record
INSERT INTO entity_attribute_values (...)
VALUES (..., valid_from := '2024-02-01', ...);
```

### Correct Historical Data (Valid Time Split)
```sql
-- Use the split_valid_time function
SELECT golden_master.split_valid_time(
  p_eav_id := '...',
  p_split_date := '2024-01-15',
  p_new_value := '1005000',
  p_source_id := '...'
);
```

This creates two records:
1. Original value: valid_from to 2024-01-14
2. Corrected value: 2024-01-15 to valid_to

### Retract Data
```sql
-- Mark as no longer valid
UPDATE entity_attribute_values
SET valid_to = '2024-01-31',
    system_to = NOW()
WHERE id = '...';
```

## Indexing Strategy

Bi-temporal queries require specialized indexes:

```sql
-- GiST indexes for range queries
CREATE INDEX idx_eav_valid_time ON entity_attribute_values 
  USING gist (valid_from, valid_to);

CREATE INDEX idx_eav_system_time ON entity_attribute_values 
  USING gist (system_from, system_to);

-- Partial indexes for current records
CREATE INDEX idx_eav_current ON entity_attribute_values (entity_id, attribute_id)
  WHERE valid_to = '9999-12-31' 
    AND system_to = '9999-12-31 23:59:59';
```

## Use Cases in Private Markets

### NAV Restatement
A fund administrator discovers the Jan 31 NAV was calculated incorrectly:

1. **Original record**: NAV = $1,000,000, valid 2024-01-31, system_from 2024-02-05
2. **Correction**: NAV = $1,005,000, valid 2024-01-31, system_from 2024-02-10

Query: "What was the NAV on Jan 31?"
- As of Feb 5: $1,000,000
- As of Feb 10: $1,005,000

### Delayed Trade Reporting
A trade executed on Jan 15 but wasn't reported until Jan 20:

1. **Record**: Trade date = 2024-01-15, system_from = 2024-01-20

Query: "What trades did we know about on Jan 18?"
- Answer: None (trade not yet recorded)

Query: "What trades were valid on Jan 18?"
- Answer: The Jan 15 trade

### Multi-Source Reconciliation
Bloomberg reports price = $100 on Feb 1, DealCloud reports $101 on Feb 2:

1. **Bloomberg record**: price = $100, valid 2024-02-01, system_from 2024-02-01
2. **DealCloud record**: price = $101, valid 2024-02-01, system_from 2024-02-02

Query: "What was the price on Feb 1?"
- As of Feb 1: $100 (Bloomberg)
- As of Feb 2: $101 (DealCloud, higher precedence)

## Benefits

1. **Auditability**: Complete history of all changes
2. **Accuracy**: Point-in-time queries for reporting
3. **Compliance**: Prove what was known when
4. **Flexibility**: Correct historical data without losing audit trail
5. **Transparency**: See all competing source values

## Implementation Notes

- All timestamps use UTC
- Dates use ISO 8601 format (YYYY-MM-DD)
- "Current" records have `valid_to = '9999-12-31'` and `system_to = '9999-12-31 23:59:59'`
- Never delete records; always close with `system_to = NOW()`
- Use database functions for bi-temporal operations to ensure consistency
- Index strategically for common query patterns

## References

- [Architecture Guide](./ARCHITECTURE.md)
- [API Documentation](./API.md)
- [PostgreSQL Temporal Features](https://www.postgresql.org/docs/current/functions-datetime.html)
