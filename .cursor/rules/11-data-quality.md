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
| COMPLETENESS | Required data exists | Not a rule: mark the attribute required. Availability reports it. |
| VALIDITY | Value format or range | `CURRENCY NOT IN ('USD', 'EUR', 'GBP')` |
| CONSISTENCY | Cross-field logic | `MATURITY_DATE <= ISSUANCE_DATE` |
| TIMELINESS | Dates against the as-of date | `DEAL_DATE > CURRENT_DATE` |
| UNIQUENESS | Prevent duplicates | `duplicate_count > 1` |

## DQ Severity Levels

| Level | Action Required | Example |
|-------|----------------|---------|
| CRITICAL | Immediate | Core entity missing |
| HIGH | Within 24h | Key attribute incomplete |
| MEDIUM | Within 7 days | Optional attribute missing |
| LOW | Iterate | Formatting issue |

## Rule Expression Syntax

`rule_expression` describes the exception. A record fails when it meets every condition joined by AND, or every condition of any one group when groups are joined by OR. A record that meets no group passes.

A blank value meets no condition about its value: `MARKET_CAP < 0` is not met by a blank market cap, and neither is `MARKET_CAP >= 0`. Whether a field must be present is the attribute's required flag, measured under availability. Test a blank only when a rule needs it, with `ATTRIBUTE IS NULL`, usually beside another condition. Conditions are compiled by `data_quality.compile_rule_expression`; supported forms are `IS [NOT] NULL`, comparisons with a number, a date, `CURRENT_DATE` or another attribute, `[NOT] IN (...)`, `~` and `!~` with a quoted pattern, and `IS [NOT] UNDER`.

```sql
-- Out of range
MARKET_CAP < 0
AMORT_PERCENT_OF_ORIGINAL < -100 OR AMORT_PERCENT_OF_ORIGINAL > 100

-- Value not in the allowed set
PAYMENT_STATUS NOT IN ('EXPECTED', 'RECEIVED', 'PAID')

-- Format
ISIN !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'

-- One field against another
CALL_END_DATE < CALL_DATE

-- Needed only when another field says so
IS_DEFAULTED NOT IN ('false') AND DEFAULT_DATE IS NULL
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