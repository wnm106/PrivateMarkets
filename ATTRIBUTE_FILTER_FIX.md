# Attribute Filter Fix for Entity Type Admin UI

## Problem
When viewing the CASH_FLOW entity type in the admin UI at `/admin/entities/CASH_FLOW`, the Attributes tab was showing **34 attributes** instead of the expected **5 attributes** that were actually assigned to the STANDARD_CASHFLOW template.

## Root Cause
The filter logic in `apps/web/app/admin/entities/[domainCode]/page.tsx` was incorrectly filtering attributes:

```typescript
// OLD (INCORRECT) LOGIC
const domainAttributes = attributes.filter(a =>
  !a.referenceDomainCode || a.referenceDomainCode === domain.domainCode
);
```

This logic showed:
- ALL attributes that don't have a `referenceDomainCode` (which is most attributes)
- PLUS attributes that reference the current domain

Since most attributes (like CASHFLOW_DATE, AMOUNT, etc.) don't have a `referenceDomainCode`, they all passed the filter, resulting in 34 attributes being displayed.

## Solution
Changed the filter to check which attributes are actually assigned to templates in the current domain:

```typescript
// NEW (CORRECT) LOGIC
const domainAttributes = attributes.filter(a => {
  // Check if this attribute is assigned to any template in this domain
  const isAssignedToDomainTemplate = templates.some(t => 
    t.domainCode === domain.domainCode && 
    t.attributes?.some(attr => attr.attributeId === a.id)
  );
  
  // Also include reference attributes that point to this domain
  const isReferenceToDomain = a.referenceDomainCode === domain.domainCode;
  
  return isAssignedToDomainTemplate || isReferenceToDomain;
});
```

## Changes Made

### 1. Updated Template Interface
Added the `attributes` field to the Template interface to match the GraphQL query response:

```typescript
interface TemplateAttribute {
  attributeId: string;
  attribute: {
    attributeCode: string;
    attributeName: string;
    dataType: string;
  };
  isRequired: boolean;
  precedenceRank: number;
  displayOrder: number;
  displayLabel?: string;
}

interface Template {
  id: string;
  templateCode: string;
  templateName: string;
  domainCode: string;
  description?: string;
  isActive: boolean;
  attributes?: TemplateAttribute[];  // ← Added this field
}
```

### 2. Fixed Attribute Filter
Updated the filter logic to check template assignments instead of just reference domains.

### 3. Added isRequired to RelationshipType
Fixed a pre-existing TypeScript error by adding the missing `isRequired` property:

```typescript
interface RelationshipType {
  // ... other fields
  isRequired?: boolean;  // ← Added this field
}
```

## Verification

After the fix, when you navigate to `/admin/entities/CASH_FLOW`, the Attributes tab should now show only **5 attributes**:

1. **CASHFLOW_DATE** (DATE, required)
2. **CASHFLOW_TYPE** (STRING, required)
3. **CURRENCY** (STRING, required)
4. **AMOUNT** (NUMBER, required)
5. **PAYMENT_STATUS** (STRING, optional)

These are exactly the attributes that were assigned to the STANDARD_CASHFLOW template via the `template_attribute_assignments` table.

## Database Verification

You can verify the correct data exists in the database:

```sql
-- Check template assignments
SELECT 
  t.template_code,
  a.attribute_code,
  a.attribute_name,
  ta.is_required,
  ta.display_order
FROM metadata_register.template_attribute_assignments ta
JOIN metadata_register.domain_templates t ON ta.template_id = t.id
JOIN metadata_register.attribute_register a ON ta.attribute_id = a.id
WHERE t.template_code = 'STANDARD_CASHFLOW'
ORDER BY ta.display_order;
```

Expected result: 5 rows with the attributes listed above.

## Impact

This fix affects all entity types in the admin UI:
- **FUND** - Will show only attributes assigned to FUND templates
- **ISSUER** - Will show only attributes assigned to ISSUER templates
- **SECURITY** - Will show only attributes assigned to SECURITY templates
- **DEAL** - Will show only attributes assigned to DEAL templates
- **POSITION** - Will show only attributes assigned to POSITION templates
- **CASH_FLOW** - Will show only the 5 cash flow attributes
- **PRICE** - Will show only attributes assigned to PRICE templates

This provides a much clearer and more accurate view of which attributes belong to each entity type.
