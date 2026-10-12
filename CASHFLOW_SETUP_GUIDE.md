# Cash Flow Entity Type - Setup Guide

## What Was Created

### 1. MCP Server Tools (6 new admin tools)
Added to `packages/mcp-server/src/tools/domain-tools.ts`:
- `create_domain_type` - Create a new domain
- `create_attribute` - Create attribute definitions
- `create_template` - Create entity templates
- `assign_attribute_to_template` - Link attributes to templates
- `create_entity_identifier` - Define unique identifiers (single or composite)
- `create_relationship_type` - Define parent-child relationships

### 2. Database Migration
`supabase/migrations/00017_add_cashflow_entity_type.sql`:
- **Domain:** CASH_FLOW
- **Template:** STANDARD_CASHFLOW
- **Attributes:** CASHFLOW_DATE, CASHFLOW_TYPE, CURRENCY, AMOUNT, PAYMENT_STATUS
- **Composite Identifier:** CF_COMPOSITE = [CASHFLOW_DATE, CASHFLOW_TYPE, CURRENCY]
- **Relationship:** POSITION → CASH_FLOW (ONE_TO_MANY)

### 3. Schema Updates
- Added CASH_FLOW to DomainType enum in GraphQL schema
- Updated cursor rules documentation

## How to Use

### Option 1: Run the Migration
```bash
cd supabase && supabase db push
```

### Option 2: Use MCP Tools
```javascript
await mcp.callTool('create_entity_identifier', {
  domainCode: 'CASH_FLOW',
  identifierCode: 'CF_COMPOSITE',
  identifierName: 'Date+Type+Currency',
  attributeCodes: ['CASHFLOW_DATE', 'CASHFLOW_TYPE', 'CURRENCY'],
  isPrimary: true
});
```

### Creating Cash Flow Entities
```javascript
const cashflow = await mcp.callTool('create_entity', {
  entityCode: 'CF-001',
  entityName: 'Q4 Dividend Payment',
  domainCode: 'CASH_FLOW',
  templateCode: 'STANDARD_CASHFLOW',
  attributes: {
    CASHFLOW_DATE: '2026-12-15',
    CASHFLOW_TYPE: 'DIVIDEND',
    CURRENCY: 'USD',
    AMOUNT: 50000
  }
});
```

## Files Modified
1. `packages/mcp-server/src/tools/domain-tools.ts` - 6 new admin tools
2. `supabase/migrations/00017_add_cashflow_entity_type.sql` - Database migration
3. `packages/graphql/src/schema/typeDefs.ts` - CASH_FLOW in DomainType enum
4. `.cursor/rules/` - Documentation updates