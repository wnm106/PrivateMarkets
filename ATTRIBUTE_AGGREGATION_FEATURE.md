# Attribute Aggregation & Precision Feature

## Overview
This implementation adds aggregation behavior and numeric precision controls to attributes in the tapestr.ai MDM system.

## Features Implemented

### 1. Aggregation Types
Attributes now support the following aggregation behaviors:

- **NONE** (default) - No aggregation, single-row value used as-is
- **MIN** - Minimum value across rows (works for NUMBER and STRING)
- **MAX** - Maximum value across rows (works for NUMBER and STRING)
- **SUM** - Sum of values (numeric types only)
- **AVG** - Simple average (numeric types only)
- **WEIGHTED_AVG** - Weighted average using another attribute as weight (numeric only)

### 2. Weighted Average Support
For `WEIGHTED_AVG` aggregation, you can specify a weight attribute:
- The weight attribute must be numeric (NUMBER, INTEGER, DECIMAL, CURRENCY, PERCENTAGE)
- The weighted attribute itself must also be numeric
- Example: Aggregating "price" weighted by "quantity"

### 3. Numeric Precision
Attributes now have a `numeric_precision` field:
- Specifies the number of decimal places to display
- NULL = use default display
- 0 = integer display
- 2 = typical currency
- 4 = rates/percentages
- Any non-negative integer is valid

## Database Changes

### Migration: `00016_attribute_aggregation_and_precision.sql`

**New Columns:**
```sql
aggregation_type VARCHAR(20) DEFAULT 'NONE'
weight_attribute_code VARCHAR(100)
numeric_precision INTEGER
```

**Constraints:**
- `aggregation_type` must be one of: NONE, MIN, MAX, SUM, AVG, WEIGHTED_AVG
- `numeric_precision` must be non-negative if set
- `weight_attribute_code` must reference a valid attribute_code (foreign key)

**Validation Trigger:**
- Ensures WEIGHTED_AVG has a weight attribute
- Validates weight attribute is numeric
- Validates SUM/AVG are only used with numeric data types
- Automatically clears weight_attribute_code when not using WEIGHTED_AVG

**Public View Updated:**
- `public.attribute_register` now includes the three new columns

## GraphQL Changes

### Schema Updates
The `AttributeDefinition` type now includes:
```graphql
aggregationType: String
weightAttributeCode: String
numericPrecision: Int
```

### Resolver Updates
**File:** `packages/graphql/src/resolvers/metadata.ts`

- `mapAttributeDefinition()` now maps the new fields
- `UpdateAttributeDefinitionInput` interface includes the new fields
- `updateAttributeDefinition` mutation handles the new fields

## Frontend Changes

### Admin Attributes Page
**File:** `apps/web/app/admin/attributes/page.tsx`

**New Columns in Table:**
- **Aggregation** - Shows aggregation type with visual badges
  - WEIGHTED_AVG shows in yellow with weight attribute code
  - Other types show in blue
- **Precision** - Shows numeric precision with "X decimals" badge

**Edit Mode:**
- Aggregation dropdown with all options
- Conditional weight attribute input (appears when WEIGHTED_AVG is selected)
- Numeric precision number input (min=0)

**GraphQL Query Updated:**
- `ATTRIBUTE_REGISTER_QUERY` now fetches the three new fields
- `UPDATE_ATTRIBUTE_DEFINITION_MUTATION` returns the new fields

## Usage Examples

### Example 1: Currency Aggregation
```sql
UPDATE attribute_register
SET aggregation_type = 'SUM', numeric_precision = 2
WHERE attribute_code = 'TOTAL_AUM';
```

### Example 2: Weighted Average Price
```sql
UPDATE attribute_register
SET aggregation_type = 'WEIGHTED_AVG',
    weight_attribute_code = 'QUANTITY',
    numeric_precision = 4
WHERE attribute_code = 'WEIGHTED_AVG_PRICE';
```

### Example 3: Text Aggregation
```sql
UPDATE attribute_register
SET aggregation_type = 'MAX'
WHERE attribute_code = 'ISSUER_RATING';
```

### Example 4: Percentage Display
```sql
UPDATE attribute_register
SET numeric_precision = 4
WHERE data_type = 'PERCENTAGE';
```

## Validation Rules

1. **WEIGHTED_AVG Requirements:**
   - Must have `weight_attribute_code` set
   - Weight attribute must be numeric
   - Weighted attribute itself must be numeric

2. **SUM/AVG Requirements:**
   - Attribute data_type must be numeric (NUMBER, INTEGER, DECIMAL, CURRENCY, PERCENTAGE)

3. **MIN/MAX:**
   - Works for both numeric and text (STRING) types
   - No additional validation needed

4. **Precision:**
   - Must be non-negative if set
   - NULL means use default display

## Testing Checklist

- [ ] Create attribute with aggregation_type = 'SUM'
- [ ] Create attribute with aggregation_type = 'WEIGHTED_AVG' and weight attribute
- [ ] Try to set WEIGHTED_AVG without weight attribute (should fail)
- [ ] Try to set SUM on STRING type (should fail)
- [ ] Set numeric_precision = 2 on CURRENCY attribute
- [ ] Edit existing attribute and change aggregation type
- [ ] Verify weight attribute dropdown only shows numeric attributes
- [ ] Check admin UI displays aggregation badges correctly
- [ ] Verify precision badges show correct decimal count

## Future Enhancements

Potential additions for future iterations:

1. **Aggregation in Queries:**
   - Implement actual aggregation logic in entity queries
   - Support GROUP BY with aggregation functions
   - Display aggregated rows in lists/reports

2. **UI Enhancements:**
   - Weight attribute dropdown (currently text input)
   - Bulk edit for aggregation settings
   - Visual indicator for aggregated vs non-aggregated attributes

3. **Advanced Aggregations:**
   - MEDIAN
   - COUNT
   - COUNT_DISTINCT
   - FIRST/LAST (for time-series data)

4. **Precision Formatting:**
   - Apply precision in display components
   - Support for thousand separators
   - Currency symbol formatting

## Migration Notes

**To apply this migration:**
```bash
cd meridian-mdm
supabase db push
```

Or manually run:
```bash
psql -U <user> -d <database> -f supabase/migrations/00016_attribute_aggregation_and_precision.sql
```

**Backward Compatibility:**
- All new columns have defaults (NONE, NULL, NULL)
- Existing attributes will continue to work without changes
- No breaking changes to existing APIs

## Files Modified

1. `supabase/migrations/00016_attribute_aggregation_and_precision.sql` (new)
2. `packages/graphql/src/resolvers/metadata.ts`
3. `apps/web/lib/graphql.ts`
4. `apps/web/app/admin/attributes/page.tsx`

## Summary

This implementation provides a complete foundation for attribute aggregation and precision control across the tapestr.ai MDM system. The database layer enforces validation rules, the GraphQL API exposes the new fields, and the admin UI allows easy configuration and visualization.
