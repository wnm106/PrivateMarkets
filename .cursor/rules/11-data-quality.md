# Data Quality Framework

## Concept

The **Data Quality (DQ)** framework ensures data accuracy, completeness, and consistency through automated rules and exception management.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Data Quality Flow                         │
│                                                              │
│  ┌──────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │   Data   │    │  DQ Rules   │    │ Exceptions  │        │
│  │  Values  │───▶│  Expressions│───▶│   Track     │        │
│  └──────────┘    └─────────────┘    └─────────────┘        │
│         │                  │                  │             │
│         ▼                  ▼                  ▼             │
│  ┌──────────┐    ┌─────────────┐    �┌─────────────┐        │
│  │ Golden   │    │  Severity   │    │  Resolve    │        │
│  │ Records  │    │  (Critical │    │  & Monitor  │        │
│  └──────────┘    │  High,      │    └─────────────┘        │
│                  │  Medium,    │                            │
│                  │  Low)       │                            │
│                  └─────────────┘                            │
└──────────────────────────────────────────────────────────────┘
```

## DQ Rule Types

| Type | Purpose | Example failure predicate |
|------|---------|---------|
| COMPLETENESS | Ensure required data exists | `name IS NULL` |
| VALIDITY | Validate value format | `currency IS NULL OR currency NOT IN ('USD', 'EUR', 'GBP')` |
| CONSISTENCY | Check cross-field logic | `amount IS NULL OR amount <= 0 OR currency IS NULL` |
| TIMELINESS | Verify data freshness | `updated_at IS NULL OR updated_at <= NOW() - INTERVAL '30 days'` |
| UNIQUENESS | Prevent duplicates | `duplicate_count > 1` |

## DQ Severity Levels

| Level | Action Required | Example |
|-------|----------------|---------|
| CRITICAL | Immediate | Core entity missing |
| HIGH | Within 24h | Key attribute incomplete |
| MEDIUM | Within 7 days | Optional attribute missing |
| LOW | Iterate | Formatting issue |

## Rule Expression Syntax

`rule_expression` is a SQL boolean predicate that is **true for records that fail**. Running it as a `WHERE` clause returns the violation population. A record passes only when the predicate is false. `NULL` does not match, so include `IS NULL` when a missing value is a failure.

```sql
-- Missing value
name IS NULL

-- Value not in the allowed set (missing counts as a failure)
currency IS NULL OR currency NOT IN ('USD', 'EUR', 'GBP')

-- Out of range
price IS NULL OR price < 0
nav IS NULL OR nav NOT BETWEEN 10 AND 100

-- Pattern mismatch
isin IS NULL OR isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'

-- Stale timestamp
updated_at IS NULL OR updated_at <= NOW() - INTERVAL '30 days'

-- Custom failure
CASE WHEN status = 'CLOSED' AND close_date IS NULL THEN true ELSE false END
```

## Creating a DQ Rule

### Step 1: Define the Rule
```typescript
await context.supabase
  .from('dq_rules')
  .insert({
    rule_code: 'FUND_REQUIRED_NAME',
    rule_name: 'Fund Name Required',
    domain_code: 'FUND',
    rule_type: 'COMPLETENESS',
    severity: 'CRITICAL',
    rule_expression: 'name IS NULL',
    rule_description: 'All funds must have a name',
  });
```

### Step 2: Rule is Evaluated
- On entity creation/update
- On attribute value changes
- Scheduled batch evaluation

A record fails when `rule_expression` is true. `data_quality.entities_failing_rule(rule_id)` returns that population.

### Step 3: Exception Created (if needed)
```sql
-- When rule fails, exception is created
INSERT INTO dq_exceptions (
  rule_id, entity_id, exception_type, exception_message
) VALUES (
  'rule_id', 'entity_id', 'MISSING_REQUIRED', 
  'Fund name is required but not provided'
);
```

## Exception Workflow

```
Exception Created
     │
     ├─ Open → In Review → Resolved
     │          │              │
     │          └─ Waived ─────┘
     │
     └─ False Positive → (closed)
```

### Status Values
- **OPEN**: New exception
- **IN_REVIEW**: Being examined
- **RESOLVED**: Fixed
- **WAIVED**: Accepted risk
- **FALSE_POSITIVE**: Rule incorrectly triggered

## Monitoring DQ

### View Open Exceptions
```typescript
const { data } = await context.supabase
  .from('dq_exceptions')
  .select(`
    *,
    dq_rules(rule_name, severity),
    master_entities(entity_code, entity_name)
  `)
  .eq('status', 'OPEN')
  .order('created_at', { ascending: false });
```

### DQ Dashboard Metrics
```sql
-- Count by severity
SELECT severity, COUNT(*) 
FROM dq_exceptions 
WHERE status = 'OPEN'
GROUP BY severity;

-- Count by rule
SELECT dq_rules.rule_name, COUNT(*) as count
FROM dq_exceptions
JOIN dq_rules ON dq_exceptions.rule_id = dq_rules.id
WHERE dq_exceptions.status = 'OPEN'
GROUP BY dq_rules.rule_name
ORDER BY count DESC;
```

## Best Practices

1. **Start with CRITICAL rules** for mandatory fields
2. **Add HIGH severity** for important fields
3. **Use MEDIUM/LOW** for nice-to-have validations
4. **Automate resolution** when possible
5. **Tag exceptions** with metadata for analysis
6. **Review weekly** for patterns

## Troubleshooting

### Problem: Too many exceptions
- Check rule expressions for correctness
- Verify domain_code matches entities
- Consider relaxing thresholds

### Problem: Missing exceptions
- Test rule expression manually
- Check domain_code filter
- Verify attribute_id references

### Problem: False positives
- Add more specific conditions
- Use `AND`/`OR` for complex logic
- Add exception metadata for context