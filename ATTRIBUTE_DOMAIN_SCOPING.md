# Attribute Domain Scoping - Implementation Summary

## Problem
Attributes were not appearing on the Entity Management page (`/admin/entities/[domainCode]`) because the filtering logic was too restrictive. The system only showed attributes that were already assigned to templates in that domain, creating a circular dependency: you couldn't see attributes to assign them to templates because they weren't assigned yet.

## Root Cause
The database schema didn't have a direct way to link attributes to their owning domain (entity type). Attributes were only associated with domains through template assignments, but the intended workflow is:
1. Create attributes for a domain (entity type)
2. Templates pick subsets of those attributes

## Solution
Added a `domain_code` field to the `attribute_register` table to directly link attributes to their owning domain.

## Changes Made

### 1. Database Migration (`supabase/migrations/00048_attribute_domain_scoping.sql`)
- Added `domain_code` column to `metadata_register.attribute_register` table
- Created index for faster domain-based queries
- Updated `get_attributes_with_aggregation()` RPC function to:
  - Include `domain_code` in the returned JSON
  - Filter by `domain_code` when `p_domain_code` parameter is provided
  - Return attributes where `domain_code` matches OR is NULL (for backward compatibility)

### 2. GraphQL Schema (`packages/graphql/src/schema/typeDefs.ts`)
- Added `domainCode: String` field to `AttributeDefinition` type
- Added `domainCode: String` field to `CreateAttributeInput` input type

### 3. GraphQL Resolvers (`packages/graphql/src/resolvers/metadata.ts`)
- Updated `attributeRegister` query to filter by `domain_code` (owning domain) instead of `reference_domain_code`
- Updated `mapAttributeDefinition()` to include `domainCode` field
- Updated `createAttribute` mutation to accept and store `domainCode`
- Updated `CreateAttributeInput` interface to include `domainCode`

### 4. Entity Resolver (`packages/graphql/src/resolvers/entity.ts`)
- Updated `createAttribute` mutation to include `domain_code` in insert statement

### 5. Frontend GraphQL Query (`apps/web/lib/graphql.ts`)
- Updated `ATTRIBUTE_REGISTER_QUERY` to fetch `domainCode` field

### 6. Entity Type Detail Page (`apps/web/app/admin/entities/[domainCode]/page.tsx`)
- Updated `loadData()` to pass `domainCode` parameter when fetching attributes
- Updated `handleCreateAttribute()` to auto-set `domainCode` to current domain
- Simplified filtering logic: attributes are now pre-filtered by domain from the query
- Added sorting: attributes assigned to templates appear first
- Updated `Attribute` interface to include `domainCode` field

## How It Works Now

1. **Creating Attributes**: When you create an attribute from an entity type page (e.g., `/admin/entities/FUND`), it automatically gets `domain_code = 'FUND'`

2. **Viewing Attributes**: The entity type page now fetches only attributes where `domain_code` matches the current domain, so you see all attributes for that entity type

3. **Template Assignment**: Templates can still pick subsets of these attributes via `template_attribute_assignments`

4. **Backward Compatibility**: Attributes with `domain_code = NULL` are still visible (treated as global/shared attributes)

## Migration Steps

To apply these changes to your database:

```bash
# Run the migration
cd supabase/migrations
# Apply 00048_attribute_domain_scoping.sql to your Supabase database
```

The migration will:
- Add the `domain_code` column
- Update the RPC function
- Notify PostgREST to reload the schema cache

## Testing

1. Navigate to `/admin/entities/FUND` (or any entity type)
2. Click "+ Attribute" to create a new attribute
3. The attribute should appear in the list immediately
4. The attribute should have `domain_code = 'FUND'` in the database
5. Create a template and assign the attribute to it
6. The attribute should still appear in the list (now marked as "in use")

## Future Enhancements

- Add UI to move attributes between domains
- Add bulk operations to set domain_code on existing attributes
- Add validation to prevent assigning attributes from wrong domains to templates
- Show domain badge on attributes in global views