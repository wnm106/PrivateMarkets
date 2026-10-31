# Meridian MDM API Documentation

## GraphQL API

The Meridian MDM GraphQL API provides a flexible interface for querying and managing master data with full bi-temporal support.

## Endpoint

```
Production: https://api.meridian-mdm.com/graphql
Development: http://localhost:4000/graphql
```

## Authentication

All requests require authentication via Bearer token:

```bash
curl -X POST https://api.meridian-mdm.com/graphql \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ entities(filter: { domainCode: \"FUND\" }) { edges { node { id entityName } } } }"}'
```

## Schema Overview

### Domain Types

```graphql
enum DomainType {
  FUND
  ISSUER
  DEAL
  SECURITY
  PRICE
  POSITION
}
```

### Core Types

Funds, issuers, securities, deals, positions, and prices are all `Entity` records. The domain is `domainCode`. Attribute values live in `attributes`, keyed by attribute code. Related entities live in `parentRelationships` and `childRelationships`.

```graphql
type Entity {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  domainName: String!
  templateCode: String
  templateName: String
  description: String
  isActive: Boolean!
  attributes: JSONObject!
  parentRelationships: [EntityRelationship!]!
  childRelationships: [EntityRelationship!]!
  lineage: [FieldLineage!]
  metadata: JSONObject
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

### Temporal Types

```graphql
type TemporalValue {
  value: String
  validFrom: Date!
  validTo: Date!
  systemFrom: DateTime!
  systemTo: DateTime!
  source: String!
  isOverride: Boolean!
}

type FieldLineage {
  attributeCode: String!
  attributeName: String!
  currentValue: String
  competingValues: [SourceValue!]!
  resolutionRule: String
}

type SourceValue {
  source: String!
  value: String
  precedenceRank: Int!
  validFrom: Date!
  validTo: Date!
  confidenceScore: Float
}
```

## Queries

### List Funds

`funds` is `entities` filtered to `domainCode: FUND`. The same query with another domain code lists issuers, securities, deals, or positions.

```graphql
query ListFunds(
  $filter: EntityFilter
  $pagination: PaginationInput
  $asOfDate: Date
) {
  funds(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
    edges {
      node {
        id
        entityCode
        entityName
        attributes
      }
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
    totalCount
  }
}
```

### Get Entity by ID

```graphql
query GetEntity($id: ID!, $asOfDate: Date) {
  entity(id: $id, asOfDate: $asOfDate) {
    id
    entityCode
    entityName
    domainCode
    attributes
    parentRelationships {
      parentEntityCode
      parentDomainCode
      relationshipCode
    }
  }
}
```

### Get Field Lineage

```graphql
query GetFieldLineage($entityId: ID!, $asOfDate: Date) {
  fieldLineage(entityId: $entityId, asOfDate: $asOfDate) {
    attributeCode
    attributeName
    currentValue
    competingValues {
      source
      value
      precedenceRank
      validFrom
      validTo
      confidenceScore
    }
    resolutionRule
  }
}
```

### Get Temporal History

```graphql
query GetTemporalHistory(
  $entityId: ID!
  $attributeCode: String!
  $fromDate: Date!
  $toDate: Date!
) {
  temporalHistory(
    entityId: $entityId
    attributeCode: $attributeCode
    fromDate: $fromDate
    toDate: $toDate
  ) {
    value
    validFrom
    validTo
    systemFrom
    systemTo
    source
    isOverride
  }
}
```

### List DQ Exceptions

```graphql
query ListDQExceptions(
  $filter: DQExceptionFilter
  $pagination: PaginationInput
) {
  dqExceptions(filter: $filter, pagination: $pagination) {
    edges {
      node {
        id
        ruleCode
        ruleName
        entityCode
        entityName
        attributeName
        exceptionMessage
        severity
        status
        detectedAt
        assignedTo
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

## Mutations

### Create Entity

```graphql
mutation CreateEntity($input: CreateEntityInput!) {
  createEntity(input: $input) {
    entity {
      id
      entityCode
      entityName
      domainCode
    }
    errors {
      field
      message
    }
  }
}

input CreateEntityInput {
  entityCode: String!
  entityName: String!
  domainCode: String!
  templateCode: String
  description: String
  attributes: JSONObject!
}
```

### Update Attribute

```graphql
mutation UpdateFundAttribute($input: UpdateAttributeInput!) {
  updateAttribute(input: $input) {
    success
    goldenValueId
    errors {
      field
      message
    }
  }
}

input UpdateAttributeInput {
  entityId: ID!
  attributeCode: String!
  value: String!
  validFrom: Date!
  sourceId: ID!
  isOverride: Boolean
  overrideReason: String
}
```

### Split Valid Time

```graphql
mutation SplitValidTime($input: SplitValidTimeInput!) {
  splitValidTime(input: $input) {
    success
    newEavId
    errors {
      field
      message
    }
  }
}

input SplitValidTimeInput {
  eavId: ID!
  splitDate: Date!
  newValue: String!
  sourceId: ID!
  overrideReason: String
}
```

### Submit Manual Override

```graphql
mutation SubmitManualOverride($input: ManualOverrideInput!) {
  submitManualOverride(input: $input) {
    success
    goldenValueId
    errors {
      field
      message
    }
  }
}

input ManualOverrideInput {
  entityId: ID!
  attributeCode: String!
  value: String!
  validFrom: Date!
  overrideReason: String!
}
```

### Resolve DQ Exception

```graphql
mutation ResolveDQException($input: ResolveDQExceptionInput!) {
  resolveDQException(input: $input) {
    success
    errors {
      field
      message
    }
  }
}

input ResolveDQExceptionInput {
  exceptionId: ID!
  status: DQExceptionStatus!
  resolutionNotes: String
}

enum DQExceptionStatus {
  OPEN
  IN_REVIEW
  RESOLVED
  WAIVED
  FALSE_POSITIVE
}
```

## Subscriptions

### Entity Updated

```graphql
subscription OnEntityUpdated($entityId: ID) {
  entityUpdated(entityId: $entityId) {
    id
    entityCode
    entityName
    domainCode
    updatedAt
  }
}
```

### DQ Exception Created

```graphql
subscription OnDQExceptionCreated {
  dqExceptionCreated {
    id
    ruleCode
    entityCode
    attributeName
    exceptionMessage
    severity
    detectedAt
  }
}
```

## Filter Types

### EntityFilter

```graphql
input EntityFilter {
  domainCode: String
  templateCode: String
  entityCode: String
  entityName: String
  isActive: Boolean
  attributes: JSONObject
}

input StringFilter {
  equals: String
  contains: String
  startsWith: String
  in: [String!]
}

input FloatRangeFilter {
  gte: Float
  lte: Float
  gt: Float
  lt: Float
}

input DateRangeFilter {
  gte: Date
  lte: Date
}
```

## Pagination

```graphql
input PaginationInput {
  first: Int
  after: String
  last: Int
  before: String
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

## Error Handling

All mutations return a result type with errors:

```graphql
type MutationResult {
  success: Boolean!
  errors: [MutationError!]!
}

type MutationError {
  field: String
  message: String!
  code: String!
}
```

Common error codes:
- `VALIDATION_ERROR`: Input validation failed
- `NOT_FOUND`: Entity not found
- `UNAUTHORIZED`: Insufficient permissions
- `CONFLICT`: Concurrent modification detected
- `DQ_VIOLATION`: Data quality rule violation

## Rate Limiting

API requests are rate limited:
- 1000 requests per minute per user
- 10000 requests per hour per user

Rate limit headers:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 995
X-RateLimit-Reset: 1640995200
```

## Examples

### Complete Fund Query with Lineage

```graphql
query CompleteEntityQuery {
  entity(id: "fund-123") {
    id
    entityCode
    entityName
    domainCode
    attributes

    lineage {
      attributeCode
      currentValue
      competingValues {
        source
        value
        precedenceRank
      }
    }
  }
}
```

### Temporal Analysis

```graphql
query TemporalAnalysis {
  # Get NAV history for Q1 2024
  temporalHistory(
    entityId: "fund-123"
    attributeCode: "NAV"
    fromDate: "2024-01-01"
    toDate: "2024-03-31"
  ) {
    value
    validFrom
    validTo
    source
  }
  
  # Positions are entities. Fund and security links are relationships.
  positions(asOfDate: "2024-03-31") {
    edges {
      node {
        entityCode
        entityName
        attributes
        parentRelationships {
          parentDomainCode
          parentEntityCode
          relationshipCode
        }
      }
    }
  }
}
```

### DQ Exception Resolution Workflow

```graphql
# 1. List open exceptions
query ListOpenExceptions {
  dqExceptions(
    filter: { status: { equals: OPEN } }
    pagination: { first: 10 }
  ) {
    edges {
      node {
        id
        ruleName
        entityCode
        exceptionMessage
        severity
      }
    }
  }
}

# 2. Get entity details
query GetEntityDetails($entityId: ID!) {
  entity(id: $entityId) {
    entityCode
    entityName
    domainCode
    attributes
    lineage {
      attributeCode
      competingValues {
        source
        value
      }
    }
  }
}

# 3. Submit override
mutation SubmitOverride {
  submitManualOverride(
    input: {
      entityId: "fund-123"
      attributeCode: "NAV"
      value: "1005000"
      validFrom: "2024-01-31"
      overrideReason: "Corrected per audit confirmation"
    }
  ) {
    success
    goldenValueId
  }
}

# 4. Resolve exception
mutation ResolveException {
  resolveDQException(
    input: {
      exceptionId: "exc-456"
      status: RESOLVED
      resolutionNotes: "NAV corrected via manual override"
    }
  ) {
    success
  }
}
```

## SDK Usage

### TypeScript Client

```typescript
import { GraphQLClient } from 'graphql-request';

const client = new GraphQLClient('https://api.meridian-mdm.com/graphql', {
  headers: {
    authorization: `Bearer ${token}`
  }
});

// Query funds
const { funds } = await client.request(`
  query {
    funds(filter: { isActive: { equals: true } }) {
      edges {
        node {
          id
          entityCode
          entityName
          nav
        }
      }
    }
  }
`);

// Update attribute
const { updateAttribute } = await client.request(`
  mutation UpdateNav($input: UpdateAttributeInput!) {
    updateAttribute(input: $input) {
      success
      goldenValueId
    }
  }
`, {
  input: {
    entityId: 'fund-123',
    attributeCode: 'NAV',
    value: '1005000',
    validFrom: '2024-01-31',
    sourceId: 'source-manual'
  }
});
```

## Assistant (Chat) API

The assistant is served by Next.js route handlers under `/api/chat`. It requires a
Supabase session token in `Authorization: Bearer <access_token>` for history; the
reporting modules already send this via `authHeaders()`.

### POST /api/chat

Sends a turn and records it against a per-user conversation.

```json
{
  "messages": [{ "role": "user", "text": "What funds changed this week?" }],
  "toolContext": "entity-explorer",
  "context": { "page": "funds", "domainCode": "FUND" },
  "conversationId": "optional-uuid-to-append-to"
}
```

Response:

```json
{
  "text": "…",
  "toolCalls": [{ "name": "list_entities", "args": {} }],
  "conversationId": "8d1fb2b2-…",
  "conversation": { "id": "8d1fb2b2-…", "title": "What funds changed this week?", "message_count": 2 }
}
```

Notes:
- The server creates the conversation on the first turn when `conversationId` is
  omitted, and titles it from the first user message.
- When a conversation already has stored turns, its history is authoritative over
  the request's `messages`, so a late response cannot overwrite newer thread state.
- Anonymous callers still get a reply; nothing is persisted.
- **Tool calls run as the calling user.** Every tool query is issued with the
  caller's token, so tenancy and row level security restrict what the assistant can
  read. A user with no tenant membership sees "0" rather than system-wide totals.
  This is also required operationally: the data schemas grant `USAGE` to the
  `authenticated` role but not to `service_role`, and the security-invoker views
  (`public.entity_master` → `read_projections.entity_master`) are refused for the
  service role before RLS is consulted. Never run the tool registry with the
  service-role key.

### Standalone MCP server (stdio)

`packages/mcp-server/src/server.ts` exposes the same tools over stdio for external
MCP clients (Claude Desktop, VS Code). A stdio process has no HTTP request, so it
cannot discover the caller and must be *given* an identity:

```bash
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
TAPESTRAI_MCP_ACCESS_TOKEN=<signed-in user access token>
```

Every tool and resource query is issued with that token, so the server is subject
to the same tenancy/RLS rules as the web app.

> **Do not put the service-role key here.** The data schemas grant `USAGE` to
> `authenticated` only, so a service-role (or anon) token fails on the
> security-invoker views with `permission denied for view entity_master` before RLS
> is consulted. The server detects a service-role token or a missing token at
> startup, logs how to fix it, and returns an explanatory error instead of an
> opaque failure.

Access tokens expire. When the configured token ages out, calls start failing --
supply a fresh user token and restart the server.

### Conversation history

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/chat/conversations` | List the caller's threads, most recent first (`?limit=`, max 200) |
| `POST` | `/api/chat/conversations` | Create an empty thread |
| `GET` | `/api/chat/conversations/:id` | Thread plus all messages |
| `PATCH` | `/api/chat/conversations/:id` | Rename (`{ "title": "…" }`) |
| `DELETE` | `/api/chat/conversations/:id` | Delete the thread and its messages |

All five return `401` without a valid session. Conversations are private to their
owner: row level security is keyed on `created_by = auth.uid()`, and messages are
reachable only through a conversation the caller owns. A non-owner receives `404`
rather than a permission error.

### Attachments

A turn may carry reference files -- screenshots to design against, or sample
HTML/Markdown/JSON to imitate.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat/attachments` | Multipart upload (`file`, optional `conversationId`) |
| `GET` | `/api/chat/attachments/:id` | Owner-only download |

Uploads are capped at 5 MB per file, and `POST /api/chat` accepts at most six
`attachmentIds` per turn. When no `conversationId` is supplied the upload creates
the thread and returns it, so the caller can attach its first file before it has
ever sent a message.

`attachmentIds` are only inlined when they belong to the conversation being
appended to *and* are still unbound; the ids are stamped with the resulting
message so the file stays with the turn it was sent with. Images are passed as
Gemini `inlineData` so the model actually sees the pixels; text-like files are
inlined as a fenced block; other binaries are named so the model knows they were
supplied and can ask for their contents. Once a turn is answered, the transcript
endpoint folds attachments onto their stored message.

Because only unbound ids are inlined, `attachmentIds` must all reference a single
thread. Uploading a batch in parallel against a thread that does not exist yet is
the way to get this wrong: the uploads race to create the thread, and the ids
that land in the loser are silently dropped. Establish the thread with the first
file, then upload the rest against it.

### Designing from chat

The primary chat panel doubles as the report designer's assistant, so there is a
single chat surface in the app. When a designer is open it publishes its draft to
`lib/designer-bridge.ts`; the panel reads that for context and promotes itself to
the `report-designer` tool profile. Assistant replies containing a JSON block
shaped like a proposal render as a card with an **Apply to draft** button.

Applying is deliberately two-step and never automatic: the chat *proposes*, a
human clicks Apply to merge it into the draft, then Save to persist. No MCP tool
can write a dashboard -- an assistant that can persist HTML on its own is a real
risk. The designer subscribes to proposals rather than polling for them, so a
backgrounded tab cannot strand one.

### Schema

`public.chat_conversations` (owner, title, last-known context, denormalised
`message_count` / `last_message_at`), `public.chat_messages` (role, content,
`tool_calls`, model) and `public.chat_message_attachments` (file metadata plus the
owning `message_id`). A trigger maintains the denormalised counts; deleting a
conversation cascades to its messages and attachments. Objects live in the private
`chat-attachments` bucket under an owner-prefixed path; because storage does not
participate in the cascade, `DELETE /api/chat/conversations/:id` removes them
explicitly before the rows go. See
`supabase/migrations/20261012000000_chat_history.sql` and
`supabase/migrations/20261012010000_chat_attachments.sql`.

## Best Practices

1. **Use projections**: Only request fields you need
2. **Paginate large queries**: Use cursor-based pagination
3. **Cache appropriately**: Respect cache headers
4. **Handle errors gracefully**: Check for mutation errors
5. **Use subscriptions wisely**: Only subscribe to needed updates
6. **Batch operations**: Use mutations for multiple updates
7. **Specify temporal context**: Always provide `asOfDate` when relevant

## Support

For API questions or issues:
- GitHub Issues: https://github.com/your-org/meridian-mdm/issues
- Email: api-support@meridian-mdm.com
