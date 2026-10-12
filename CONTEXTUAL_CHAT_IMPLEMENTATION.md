# Contextual Chat Tools Implementation

## Overview
Successfully refactored the chat system to leverage the MCP (Model Context Protocol) tool registry with contextual tool exposure. The AI assistant now receives different tools based on where the user is in the application, preventing confusion and ensuring focused assistance.

## Changes Made

### 1. Added Category Field to Tool Definitions
**File**: packages/mcp-server/src/lib/types.ts
- Added ToolCategory type with 9 categories: domain-read, domain-write, domain-admin, lineage, override, dq, import, compliance, intersection
- Added category: ToolCategory field to ToolDefinition interface

### 2. Categorized All MCP Tools
Updated all tool definition files to include the category field:

- **domain-tools.ts**: 20 tools categorized as domain-read, domain-write, or domain-admin
- **lineage-tools.ts**: 2 tools categorized as lineage
- **override-tools.ts**: 2 tools categorized as override
- **dq-tools.ts**: 3 tools categorized as dq
- **import-map-tools.ts**: 4 tools categorized as import
- **compliance-tools.ts**: 11 tools categorized as compliance

**Total**: 49 tools now have category assignments

### 3. Created Context Profiles System
**File**: packages/mcp-server/src/lib/context-profiles.ts (NEW)

Defined 7 context profiles:

| Context | Allowed Categories | Use Case |
|---------|-------------------|----------|
| entity-explorer | domain-read, lineage | Browsing entities and relationships |
| entity-admin | domain-read, domain-write, domain-admin, intersection | Creating/editing entity types |
| compliance | domain-read, compliance | Managing compliance rules |
| data-quality | domain-read, dq | Managing DQ rules and exceptions |
| import | domain-read, import | Data import workflows |
| lineage | domain-read, lineage, override | Exploring data provenance |
| general | All categories | Admin users with full access |

Each profile includes:
- Name and description
- Allowed tool categories
- Context-specific system instruction for the AI

### 4. Enhanced ToolRegistry
**File**: packages/mcp-server/src/lib/tool-registry.ts

Added two new methods:
- listTools(context?): Returns tools filtered by context (MCP format)
- listToolsForGemini(context?): Returns tools in Gemini function calling format with automatic JSON Schema conversion

### 5. Refactored Chat API Route
**File**: pps/web/app/api/chat/route.ts

**Before**: Hardcoded tool definitions with manual Supabase queries
**After**: Uses MCP ToolRegistry with context-based filtering

Key changes:
- Imports and initializes ToolRegistry with all tool categories
- Accepts 	oolContext parameter from client
- Filters tools based on context using listToolsForGemini()
- Uses context-specific system instructions from profiles
- Executes tools via 	oolRegistry.executeTool()
- Removed ~200 lines of duplicate tool implementation code

### 6. Updated ChatContext Interface
**File**: pps/web/lib/gemini.ts

Added 	oolContext field to ChatContext interface:
`	ypescript
toolContext?: 'entity-explorer' | 'entity-admin' | 'compliance' | 'data-quality' | 'import' | 'lineage' | 'general'
`

Updated sendGeminiMessage() to pass 	oolContext to the API.

## Usage Example

`	ypescript
// In a page component
<ChatPanel 
  context={{ 
    page: 'entity-list',
    domainCode: 'FUND',
    toolContext: 'entity-explorer' 
  }} 
/>
`

The chat will now:
1. Only expose read-only entity tools and lineage tools
2. Use the entity-explorer system instruction
3. Prevent the AI from creating/modifying entities

## Benefits

1. **Focused Assistance**: AI only sees relevant tools, reducing confusion
2. **Safety**: Users can't accidentally create compliance rules while exploring entities
3. **Better UX**: Contextual system instructions help AI understand user intent
4. **Maintainability**: Single source of truth for tools (MCP registry)
5. **Extensibility**: Easy to add new contexts or modify tool availability
6. **Code Reduction**: Eliminated ~200 lines of duplicate tool code

## Testing

All TypeScript compilation passes:
- ? MCP server compiles without errors
- ? Chat API route compiles without errors
- ? All 49 tools have category assignments
- ? Dev server starts successfully

## Next Steps

To use contextual chat in your pages:

1. Import ChatPanel component
2. Pass appropriate 	oolContext based on the page:
   - Entity list/detail ? entity-explorer
   - Admin pages ? entity-admin
   - Compliance pages ? compliance
   - DQ dashboard ? data-quality
   - Import wizard ? import
   - Lineage views ? lineage
   - General chat ? general

## Documentation

See docs/CONTEXTUAL_CHAT_TOOLS.md for detailed usage guide and examples.

