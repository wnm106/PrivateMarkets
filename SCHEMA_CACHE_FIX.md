# Fix for "Could not find the 'aggregation_type' column" Error

## Problem
The aggregation fields (`aggregation_type`, `weight_attribute_code`, `numeric_precision`) were added to the database in migration 00016, but PostgREST's schema cache hasn't been refreshed. This causes the error:
```
Could not find the 'aggregation_type' column of 'attribute_register' in the schema cache
```

## Solution
Apply migration 00024 which:
1. Reloads the PostgREST schema cache
2. Creates RPC functions to bypass the schema cache for aggregation fields

## How to Apply the Migration

### Option 1: Supabase Dashboard SQL Editor (Recommended)
1. Go to https://app.supabase.com/project/yxougybcfuignxydipes/sql
2. Copy the entire contents of `supabase/migrations/00024_reload_schema_cache.sql`
3. Paste it into the SQL Editor
4. Click "Run" or press Ctrl+Enter

### Option 2: Supabase CLI
If you have the database password:
```bash
cd meridian-mdm
npm run db:migrate
```

### Option 3: Restart Supabase Project
This will automatically reload the schema cache:
1. Go to https://app.supabase.com/project/yxougybcfuignxydipes/settings/database
2. Click "Restart database"
3. Wait for the restart to complete

## Verification
After applying the migration, run:
```bash
npx tsx test_supabase_connection.ts
```

You should see:
```
✅ RPC functions are available!
Found X attributes with aggregation fields.
```

## What Changed in the Code

### Backend (packages/graphql/src/resolvers/metadata.ts)
- Modified `attributeRegister` query to use RPC function `get_attributes_with_aggregation()`
- Modified `updateAttributeDefinition` mutation to use RPC function `update_attribute_aggregation()` for aggregation fields
- Both functions bypass the PostgREST schema cache issue

### Database (supabase/migrations/00024_reload_schema_cache.sql)
- Added `NOTIFY pgrst, 'reload schema'` to refresh PostgREST cache
- Created `update_attribute_aggregation()` RPC function for updates
- Created `get_attributes_with_aggregation()` RPC function for reads

## Testing
1. Apply the migration using one of the options above
2. Run the verification script
3. Test the attribute editor in the admin UI:
   - Go to /admin/attributes or /admin/entities/[domainCode]
   - Edit an attribute
   - Change the Aggregation Type dropdown
   - Save the changes
   - The error should no longer occur
