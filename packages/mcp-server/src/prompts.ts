/**
 * MCP Prompts — guided workflows for agents building compliance rules
 * and exploring the data model.
 */

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required?: boolean }[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'build_compliance_rule',
    description: 'Guided workflow for building a compliance rule from natural language. Walks through anchor, base, rollup path, grouping, numerator/denominator, limits, and conditions.',
    arguments: [
      { name: 'ruleDescription', description: 'Natural language description of the rule (e.g. "No fund > 5% NAV in single issuer")', required: false },
    ],
  },
  {
    name: 'explore_data_model',
    description: 'Guides an agent through exploring the Tapestr.ai data model: domains, attributes, relationships, and templates.',
    arguments: [
      { name: 'goal', description: 'What you are trying to accomplish (e.g. "build a concentration rule")', required: false },
    ],
  },
  {
    name: 'interpret_compliance_results',
    description: 'Helps interpret compliance evaluation results and breaches. Explains statuses and suggests next steps.',
    arguments: [
      { name: 'runId', description: 'The evaluation run ID to interpret', required: false },
    ],
  },
  {
    name: 'design_entity',
    description: 'Guided workflow for designing a new entity type (e.g. company financials, cap structure, collateral tapes). Walks through identifying standard attributes, relationships to existing entities, and unique identifiers.',
    arguments: [
      { name: 'entityDescription', description: 'Description of the entity type to design (e.g. "company financial statements", "capital structure", "collateral loan tape")', required: false },
    ],
  },
];

export function getPromptMessages(name: string, args: Record<string, string> = {}): PromptMessage[] {
  switch (name) {
    case 'build_compliance_rule': return buildComplianceRulePrompt(args);
    case 'explore_data_model': return exploreDataModelPrompt(args);
    case 'interpret_compliance_results': return interpretComplianceResultsPrompt(args);
    case 'design_entity': return designEntityPrompt(args);
    default: throw new Error(`Unknown prompt: ${name}`);
  }
}

function buildComplianceRulePrompt(args: Record<string, string>): PromptMessage[] {
  const ruleDesc = args.ruleDescription || '(no description provided)';
  return [
    {
      role: 'user',
      content: { type: 'text', text: `I need to create a compliance rule. Here's what I want:\n\n${ruleDesc}\n\nPlease help me build this rule step by step. Before creating anything, ask me about any missing information.` },
    },
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: `I'll help you build this compliance rule. Let me first understand the concepts and your data model.

## Step 1: Read the Compliance Guide
→ Read resource: \`tapestrai://model/compliance-guide\`

## Step 2: Discover Your Data Model
→ Read \`tapestrai://model/relationships\` (available rollup paths)
→ Read \`tapestrai://model/attributes\` (available attribute codes)
→ Or use tools: \`get_relationship_types\`, \`get_attribute_metadata\`

## Step 3: Key Questions to Answer

### 3a. Anchor Domain
**What entity is this rule "about"?** (FUND, ISSUER, SECURITY, etc.)

### 3b. Base Domain & Rollup Path
**What entities' data gets aggregated?**
- Anchor IS the entity measured → empty rollup path (single-record)
- Aggregate child entities → specify relationship hop(s)
  - e.g. FUND → POSITION via POSITION_FUND (direction: DOWN)

### 3c. Grouping (optional)
**Sub-group results?** e.g. "per issuer" → groupByPath hops to SECURITY, groupByAttributeCode = ISSUER

### 3d. Numerator
**What attribute? What aggregation?** (SUM, COUNT, AVG, MAX, MIN)

### 3e. Denominator
**For ratio/percentage rules:** Same attribute? Different? Constant?
- denominatorScope: ROLLUP, ANCHOR, or UNIVERSE

### 3f. Limits
**LEQ** (upper) or **GEQ** (lower)? Soft and hard threshold values?

### 3g. Conditions (optional)
**Eligibility filters?** e.g. "only active positions"

## Step 4: Create
1. \`create_compliance_rule\` → rule identity
2. \`create_compliance_rule_version\` → logic
3. \`create_compliance_scope_assignment\` → if needed
4. \`evaluate_compliance_rule\` → verify

**Please provide missing details, or tell me to make reasonable assumptions. I'll verify relationship types and attribute codes exist before creating anything.**`,
      },
    },
  ];
}
function exploreDataModelPrompt(args: Record<string, string>): PromptMessage[] {
  const goal = args.goal || 'understand the data model';
  return [
    { role: 'user', content: { type: 'text', text: `I need to explore the Tapestr.ai data model. My goal is: ${goal}\n\nWhat should I look at first?` } },
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: `Here's a structured approach to explore the data model:

## 1. Overview
→ Read \`tapestrai://model/overview\` — domains, entities, attributes, relationships

## 2. Domain Types
→ Read \`tapestrai://model/domains\` or call \`list_entities\`
Shows: FUND, ISSUER, SECURITY, POSITION, etc.

## 3. Attributes
→ Read \`tapestrai://model/attributes\` or call \`get_attribute_metadata\`
Shows: MARKET_VALUE, NAV, INDUSTRY, etc. with types and descriptions

## 4. Relationships
→ Read \`tapestrai://model/relationships\` or call \`get_relationship_types\`
Shows: FUND→POSITION, SECURITY→ISSUER, etc.

## 5. Templates
→ Read \`tapestrai://template/{CODE}\` for specific templates
Shows which attributes are expected for each entity type

## 6. Ask a question
→ Call \`query_data\`. grain "value" counts and filters prevailing field values and their sources across every record. grain "entity" does the same for whole records.
→ Call \`get_entity\` or \`get_field_lineage\` only when the question is about one record.

**For "${goal}", start with steps 1-4, then step 6. If building a compliance rule, also read \`tapestrai://model/compliance-guide\`.**`,
      },
    },
  ];
}
function interpretComplianceResultsPrompt(args: Record<string, string>): PromptMessage[] {
  const runId = args.runId || '(no run ID provided)';
  return [
    { role: 'user', content: { type: 'text', text: `I have compliance evaluation results. Run ID: ${runId}\n\nWhat do the results mean?` } },
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: `Let me help interpret the compliance results.

## Step 1: Get the Run Summary
Call \`list_compliance_breaches\` with the runId to see:
- resultCount: how many entities evaluated
- breachCount: how many breached limits

## Step 2: Breach Statuses
- **COMPLIANT**: Within both soft and hard limits
- **SOFT_BREACH**: Exceeded soft limit (warning)
- **HARD_BREACH**: Exceeded hard limit (violation)
- **NO_DATA**: No data available

## Step 3: Examine Details
Call \`list_compliance_breaches\` to see:
- anchorEntityId: which entity breached
- computedValue: the actual ratio/value
- softLimitValue / hardLimitValue: thresholds
- breachAmount: how much exceeded
- numeratorValue / denominatorValue: ratio components
- groupByValue: grouping key (e.g. issuer, industry)

## Step 4: Interpret
Concentration rule (e.g. "no fund > 5% in one issuer"):
- computedValue=7.2 → 7.2% of NAV in that issuer
- hardLimitValue=5 → limit is 5%
- breachAmount=2.2 → exceeded by 2.2pp

Exposure rule (e.g. "fund NAV <= $500M"):
- computedValue=600000000 → $600M exposure
- hardLimitValue=500000000 → cap is $500M
- breachAmount=100000000 → $100M over

## Step 5: Actions
- **SOFT_BREACH**: Monitor, rebalance soon
- **HARD_BREACH**: Immediate action — rebalance, divest, or exempt
- **NO_DATA**: Check entity data is loaded

**Want me to fetch breach details for run ${runId}?**`,
      },
    },
  ];
}

function designEntityPrompt(args: Record<string, string>): PromptMessage[] {
  const entityDesc = args.entityDescription || '(no description provided)';
  return [
    {
      role: 'user',
      content: { type: 'text', text: `I need to design a new entity type for the MDM system. Here's what I need:\n\n${entityDesc}\n\nPlease help me design this entity type step by step. Before creating anything, ask me about any missing information and recommend appropriate attributes, relationships, and identifiers based on industry standards and best practices for this domain.` },
    },
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: `I'll help you design this new entity type. Let me first understand your existing data model, then guide you through a discovery-based design process.

## Step 1: Discover Existing Data Model
→ Read \`tapestrai://model/entity-design-guide\` — comprehensive guide with principles and frameworks
→ Read \`tapestrai://model/overview\` — understand current domains and structure
→ Read \`tapestrai://model/domains\` — see existing entity types
→ Read \`tapestrai://model/attributes\` — see what attributes already exist
→ Read \`tapestrai://model/relationships\` — see how entities currently connect

## Step 2: Understand the Domain

### 2a. What is this entity?
**What does it represent in the real world?**
- A financial instrument? A legal agreement? A physical asset? A transaction? A person? An organization?
- What industry standards or regulatory frameworks apply? (GAAP/IFRS, ISDA, UCC, etc.)
- What data sources will feed this entity? (Bloomberg, FactSet, internal systems, APIs?)
- How will this entity be used? (reporting, compliance, analytics, operational workflows?)

### 2b. Granularity & Cardinality
**What is the nature of this entity?**
- **Time-series data?** (changes over time with multiple versions)
  - Needs: temporal attributes (PERIOD_END_DATE, AS_OF_DATE, EFFECTIVE_DATE)
- **Multi-valued per parent?** (many instances per parent entity)
  - Needs: parent relationship (DEAL → TRANCHE, DEAL → LOAN)
- **Singleton per parent?** (one instance per parent)
  - Needs: ONE_TO_ONE relationship
- **Reference/lookup data?** (shared across many entities)
  - Needs: MANY_TO_ONE relationships from entities to the reference

### 2c. Research Standard Attributes
**What attributes are standard for this domain?**
- What attributes are required by regulators or industry bodies?
- What attributes do data providers typically supply for this type of entity?
- What attributes will users need for reporting and analysis?

**Tell me what data points are important for your use case, and I'll help you identify the complete list with proper data types and units.**

### 2d. Relationships to Existing Entities
**How does this entity connect to existing entities?**
- What parent entity does this belong to? (ISSUER, DEAL, SECURITY, FUND, etc.)
- What is the cardinality? (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_MANY)
- Is the relationship temporal? (does it have valid_from/valid_to?)

### 2e. Unique Identifiers
**What uniquely identifies an instance of this entity?**
- **Natural keys** — Industry-standard identifiers? (CUSIP, ISIN, LEI, loan ID)
- **Composite keys** — Combination of attributes? (e.g. ISSUER + PERIOD_TYPE + PERIOD_END_DATE)
- **System-generated UUIDs** — When no natural key exists

## Step 3: Design the Schema

Once I understand the requirements, I'll:
1. Check for existing attributes — reuse where possible
2. Recommend new attributes — with proper data types and units
3. Design relationships — define connections to existing entities
4. Define identifiers — single or composite keys
5. Create the domain, attributes, template, relationships, and identifiers using MCP tools

## Step 4: Validate the Design

After creating the schema, I'll verify everything works and create sample entities to test.

**Please provide details about your entity type, or tell me to make reasonable assumptions based on industry standards. If this is a bespoke entity type, we'll design it from first principles based on your specific requirements.**`,
      },
    },
  ];
}