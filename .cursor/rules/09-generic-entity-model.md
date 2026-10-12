# Generic Entity Model (GEM)

## Concept

The **Generic Entity Model (GEM)** is the foundation of Meridian MDM. Instead of having separate tables for each domain (Fund, Issuer, Security, etc.), we use **one generic entity table** (`master_entities`) that stores all entity types.

## Benefits

1. **Consistency**: Same structure for all entity types
2. **Flexibility**: Easy to add new domain types
3. **Reusability**: Shared relationships, attributes, and logic
4. **Simplicity**: Single point of entry for all entity operations

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Master Entities (Generic)                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ id, entity_code, entity_name, domain_code, ...       │   │
│  └───────────────┬──────────────────────────────────────┘   │
│                  │                                           │
│  ┌───────────────┼───────────────┬────────────────┐        │
│  │               │               │                │        │
│  ▼               ▼               ▼                ▼        │
│ Fund Instances  Issuer Instances Security Inst. Deal Inst. │
│  (domain specific)  (domain specific)      (domain specific)│
└─────────────────────────────────────────────────────────────┘
```

## Domain System

Each entity belongs to a **domain**:

| Domain Code | Description | Example Entities |
|-------------|-------------|------------------|
| FUND | Investment fund | Private Equity Fund, Venture Capital Fund |
| ISSUER | Issuer of securities | Corporations, Funds, Governments |
| SECURITY | Financial security | Equity, Debt, Derivative |
| DEAL | Investment deal | Acquisition, Financing, Exit |
| PRICE | Price data | Market price, Navbar price |
| POSITION | Investment position | Direct position, Indirect position |
| CASH_FLOW | Cash flow events | Dividend, Interest, Principal repayment |

## Templates

Entities use **templates** for attribute validation and structure:

```sql
-- Domain Template
domain_templates {
  template_code: "EQUITY_FUND"
  domain_code: "FUND"
  attributes: [name, ticker, inception_date, ...]
}

-- Entity Instance
entity_instances {
  template_code: "EQUITY_FUND"
  attributes: { "name": "Fund X", "ticker": "FX123", ... }
}
```

## Entity Hierarchy

```
Master Entity (Generic)
├── Domain Code: FUND
├── Template: EQUITY_FUND
├── Attributes: {name, ticker, ...}
├── Relationships:
│   ├── Parent: Parent Fund
│   └── Child: Sub-fund
└── Attributes:
    ├── Name (golden value)
    ├── Ticker (golden value)
    └── NAV (golden value with sources)
```

## Querying Generic Entities

### Get All Entities
```typescript
const { data } = await supabase
  .from('entity_master')
  .select('*');
```

### Filter by Domain
```typescript
const { data } = await supabase
  .from('entity_master')
  .select('*')
  .eq('domain_code', 'FUND');
```

### Filter by Template
```typescript
const { data } = await supabase
  .from('entity_master')
  .select('*')
  .eq('template_code', 'EQUITY_FUND');
```

## Entity Life Cycle

1. **Create**: Insert into `master_entities`
2. **Instance**: Insert into `entity_instances` with template
3. **Attributes**: Add to `entity_attribute_values`
4. **Relate**: Create in `entity_relationships`
5. **Deactivate**: Set `is_active = false`

## Best Practices

1. Use `master_entities` for all entity operations
2. Let the resolver handle template lookups
3. Don't query `entity_instances` directly when possible
4. Use `entity_master` view for read operations