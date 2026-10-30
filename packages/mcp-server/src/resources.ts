/**
 * MCP Resources — expose the data model and compliance rule guide to agents.
 */
import { SupabaseClient } from '@supabase/supabase-js';

export interface ResourceDefinition {
  uri: string;
  name: string;
  mimeType: string;
  description: string;
}

const STATIC_RESOURCES: ResourceDefinition[] = [
  {
    uri: 'tapestrai://model/compliance-guide',
    name: 'Compliance Rules Guide',
    mimeType: 'text/markdown',
    description: 'Comprehensive guide to the compliance rules engine: concepts, rollup model, numerator/denominator, conditions, limits, and concrete examples mapping natural language to technical parameters. Read this BEFORE building a compliance rule.',
  },
  {
    uri: 'tapestrai://model/overview',
    name: 'Data Model Overview',
    mimeType: 'text/markdown',
    description: 'High-level overview of the Tapestr.ai MDM data model: domains, entities, attributes, relationships, templates, and how they connect.',
  },
  {
    uri: 'tapestrai://model/entity-design-guide',
    name: 'Entity Design Guide',
    mimeType: 'text/markdown',
    description: 'Guide for designing new entity types: standard financial attributes, relationship patterns, identifier conventions, and examples for company financials, cap structure, collateral tapes, and more. Read this BEFORE creating a new entity type.',
  },
];

export async function listResources(supabase: SupabaseClient | null): Promise<ResourceDefinition[]> {
  const resources: ResourceDefinition[] = [...STATIC_RESOURCES];

  resources.push(
    { uri: 'tapestrai://model/domains', name: 'Domain Types', mimeType: 'application/json', description: 'Live entity types with names and descriptions. Read this, or call list_domain_types, before using a domain code. Do not invent one.' },
    { uri: 'tapestrai://model/relationships', name: 'Relationship Types', mimeType: 'application/json', description: 'Live relationship codes with parent and child entity types. Read this, or call get_relationship_types, before a path, lookup, or create_relationship.' },
    { uri: 'tapestrai://model/attributes', name: 'Attribute Register', mimeType: 'application/json', description: 'Live fields: code, name, data type, description, unit, and allowed values. This is not which fields sit on an entity type. Read a template resource, or call get_template_metadata, for that.' },
  );

  if (supabase) {
    try {
      const { data: templates } = await supabase
        .from('domain_templates').select('id, template_code, domain_code, template_name').eq('is_active', true);
      for (const t of templates || []) {
        resources.push({
          uri: `tapestrai://template/${t.template_code}`,
          name: `${t.domain_code}: ${t.template_name}`,
          mimeType: 'application/json',
          description: `Template definition for ${t.domain_code} domain.`,
        });
      }
    } catch { /* DB not available */ }
  }
  return resources;
}

export async function readResource(uri: string, supabase: SupabaseClient | null): Promise<{ mimeType: string; text: string }> {
  if (uri === 'tapestrai://model/compliance-guide') return { mimeType: 'text/markdown', text: COMPLIANCE_GUIDE };
  if (uri === 'tapestrai://model/overview') return { mimeType: 'text/markdown', text: DATA_MODEL_OVERVIEW };
  if (uri === 'tapestrai://model/entity-design-guide') return { mimeType: 'text/markdown', text: ENTITY_DESIGN_GUIDE };

  if (!supabase) throw new Error('Supabase client not initialized.');

  if (uri === 'tapestrai://model/domains') {
    const { data, error } = await supabase.from('domain_types').select('domain_code, domain_name, description, is_active').order('domain_code');
    if (error) throw error;
    return { mimeType: 'application/json', text: JSON.stringify({ domains: data || [] }, null, 2) };
  }
  if (uri === 'tapestrai://model/relationships') {
    const { data, error } = await supabase.from('relationship_types').select('relationship_code, relationship_name, parent_domain_code, child_domain_code, cardinality, description, is_active').eq('is_active', true).order('relationship_code');
    if (error) throw error;
    return { mimeType: 'application/json', text: JSON.stringify({ relationshipTypes: data || [] }, null, 2) };
  }
  if (uri === 'tapestrai://model/attributes') {
    const { data, error } = await supabase.from('attribute_register').select('attribute_code, attribute_name, data_type, description, unit_of_measure, is_required, reference_domain_code, list_values').order('attribute_code');
    if (error) throw error;
    return { mimeType: 'application/json', text: JSON.stringify({ attributes: data || [] }, null, 2) };
  }

  const templateMatch = uri.match(/^tapestrai:\/\/template\/(.+)$/);
  if (templateMatch) {
    const { data: template } = await supabase.from('domain_templates').select(`*, template_attribute_assignments(*, attribute_register(*))`).eq('template_code', templateMatch[1]).single();
    if (!template) throw new Error(`Template not found: ${templateMatch[1]}`);
    return { mimeType: 'application/json', text: JSON.stringify(template, null, 2) };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

const DATA_MODEL_OVERVIEW = `# Tapestr.ai MDM — Data Model Overview

## Core Concepts

Tapestr.ai is a **Master Data Management (MDM)** system for financial data using a
**domain-driven, entity-attribute-value (EAV)** model.

## Domains (Entity Types)

| Domain Code | Description |
|---|---|
| FUND | Investment fund vehicles |
| ISSUER | Companies/entities issuing securities |
| SECURITY | Tradeable financial instruments |
| POSITION | Portfolio positions and holdings |
| DEAL | Investment transactions |
| PRICE | Pricing data points |
| CASH_FLOW | Cash flow events |
| INVESTOR | Fund investors |

Use \`tapestrai://model/domains\` resource or \`list_entities\` tool to discover all domains.

## Entities

An **entity** is a specific instance of a domain (e.g. "Apple Inc." is an ISSUER).
Each entity has: entity_code, entity_name, domain_code, and attribute values.

## Attributes

**Attributes** are typed data fields. Each has:
- \`attribute_code\` — unique identifier (e.g. MARKET_VALUE, INDUSTRY, NAV)
- \`data_type\` — STRING, NUMBER, BOOLEAN, DATE, TIMESTAMP, JSON, or REFERENCE
- \`description\` — what the attribute represents
- \`unit_of_measure\` — optional (e.g. USD, SHARES, PERCENT)

Use \`tapestrai://model/attributes\` resource or \`get_attribute_metadata\` tool.

## Relationships

Entities connect via **typed relationships**:
| Code | Parent → Child | Meaning |
|---|---|---|
| POSITION_FUND | FUND → POSITION | A fund holds many positions |
| POSITION_SECURITY | SECURITY → POSITION | A security has positions across funds |
| SECURITY_ISSUER | ISSUER → SECURITY | An issuer has many securities |
| FUND_PARENT | FUND → FUND | Fund-of-funds hierarchy |
| POSITION_CASHFLOW | POSITION → CASH_FLOW | A position has many cash flows |

Use \`tapestrai://model/relationships\` resource or \`get_relationship_types\` tool.

## Templates

**Templates** define which attributes are expected for entities of a domain.
Use \`tapestrai://template/{CODE}\` resources to see template details.

## Golden Master & Source Data

The value on a record is chosen from its sources. An open Manual Entry wins when one is present. Otherwise the template sequence, the attribute sequence, or the data-source sequence applies. Values are bi-temporal.

The domain table above is a sketch. Read \`tapestrai://model/domains\` or call \`list_domain_types\` for the live list. Do not invent a domain, attribute, template, or relationship code.

## Key Tools for Exploration

1. \`list_domain_types\` — live entity types, names, and descriptions
2. \`get_template_metadata\` — which attributes belong to an entity type
3. \`search_attributes\` — find a field from the words a person used
4. \`get_relationship_types\` — how entity types connect
5. \`query_data\` — counts, filters, and groupings. grain "value" is one row per field and its source. grain "entity" is one row per record
6. \`get_entity\` — one record. \`list_entities\` is one page, not a total
`;
const COMPLIANCE_GUIDE = `# Compliance Rules Engine — Complete Guide

## What Are Compliance Rules?

Compliance rules express **investment/regulatory limit tests**:
- "No fund has more than 5% of NAV in a single issuer"
- "Total fund exposure to any industry must not exceed 25%"
- "Each issuer must have market cap >= $100M"

## Key Concepts

### Anchor Entity
The entity the rule is **"about"** — what gets scored/assigned a result.
- "no fund > 5% in one issuer" → anchor = **FUND**
- "each issuer must have min market cap" → anchor = **ISSUER**

### Base Entities & Rollup Path
Entities whose attributes get **aggregated**. \`base_rollup_path\` walks from anchor to base:
- **Empty** = single-record rule (anchor IS the base)
- **One hop** = e.g. FUND → POSITION (via POSITION_FUND, direction UP, because the position is the parent)
- **Recursive** = e.g. FUND → child FUNDs (via FUND_PARENT, direction DOWN, recursive)

### Group-By Path & Attribute
Optional. Sub-groups base entities by a related entity's attribute.
Example: "per-fund industry concentration" → base=POSITION, group-by hop to SECURITY, groupByAttributeCode=INDUSTRY.

### Numerator & Denominator
| Component | Example |
|---|---|
| numeratorAttributeCode | MARKET_VALUE |
| numeratorAggregation | SUM, COUNT, AVG, MAX, MIN |
| denominatorAttributeCode | MARKET_VALUE, or NAV when the denominator is read on the fund |
| denominatorAggregation | SUM, COUNT, AVG, MAX, MIN, VALUE |
| denominatorScope | ANCHOR_TOTAL (all positions in the fund), SAME_GROUP, CONSTANT |
| denominatorSource | BASE (aggregate positions) or ANCHOR (read the attribute on the fund, for example NAV) |
| denominatorConstantValue | Fixed value (no computation). Omit the denominator entirely for a count or a total exposure. |

Relationship direction follows the registry. POSITION is the parent of FUND and of SECURITY, and SECURITY is the parent of ISSUER. From a fund, positions are direction UP. From a position, the security and then the issuer are direction DOWN.

### Limits
- limitDirection: MAX (breach above) or MIN (breach below)
- softLimitValue: warning threshold, in the result unit
- hardLimitValue: breach threshold, in the result unit
- hardLimitAttributeCode: optional attribute on the fund that supplies the hard limit
- softLimitFactor: when the hard limit comes from the fund, the warning is the hard limit times this factor (0 to 1)
- resultUnit: PERCENTAGE, RATIO, CURRENCY, or COUNT

### Conditions (Eligibility Filters)
- appliesTo: ANCHOR or BASE
- conditionGroup: same group=ANDed, different groups=ORed
- operator: equals, not_equals, gt, gte, lt, lte, in, not_in, is_null, is_not_null

## Natural Language → Technical Examples

### Example 1: "No fund > 5% NAV in single issuer"
\`\`\`
ruleCode: "FUND_ISSUER_CONC_5PCT"
ruleCategory: "CONCENTRATION"
anchorDomainCode: "FUND"
baseDomainCode: "POSITION"
baseRollupPath: [{ relationshipCode: "POSITION_FUND", direction: "UP" }]
groupByPath: [{ relationshipCode: "POSITION_SECURITY", direction: "DOWN" }, { relationshipCode: "SECURITY_ISSUER", direction: "DOWN" }]
groupByAttributeCode: "ISSUER_LEGAL_NAME"
numeratorAttributeCode: "MARKET_VALUE", numeratorAggregation: "SUM"
denominatorAttributeCode: "NAV", denominatorAggregation: "VALUE", denominatorScope: "SAME_GROUP", denominatorSource: "ANCHOR"
limitDirection: "MAX", hardLimitValue: 5, resultUnit: "PERCENTAGE"
\`\`\`

### Example 2: "Each issuer market cap >= $100M"
\`\`\`
ruleCode: "ISSUER_MIN_MARKET_CAP"
ruleCategory: "ELIGIBILITY"
anchorDomainCode: "ISSUER"
baseDomainCode: "ISSUER"
baseRollupPath: []   (single-record)
numeratorAttributeCode: "MARKET_CAP", numeratorAggregation: "VALUE"
limitDirection: "MIN", hardLimitValue: 100000000, resultUnit: "CURRENCY"
\`\`\`

### Example 3: "Fund-of-funds NAV <= $500M"
\`\`\`
ruleCode: "FUND_FAMILY_NAV_CAP"
ruleCategory: "EXPOSURE"
anchorDomainCode: "FUND"
baseDomainCode: "FUND"
baseRollupPath: [{ relationshipCode: "FUND_PARENT", direction: "DOWN", recursive: true }]
numeratorAttributeCode: "NAV", numeratorAggregation: "SUM"
limitDirection: "MAX", hardLimitValue: 500000000, resultUnit: "CURRENCY"
\`\`\`

## Workflow: Building a Rule

1. **Identify anchor**: What entity is this rule "about"?
2. **Identify base**: What entities' data gets aggregated?
3. **Determine rollup path**: How to get from anchor to base?
4. **Determine grouping**: Sub-grouped? By what attribute?
5. **Identify numerator**: What attribute, what aggregation?
6. **Identify denominator**: Same? Different? Constant? What scope?
7. **Set limits**: Upper (MAX) or lower (MIN)? Soft/hard thresholds? Percent, count, or currency?
8. **Consider conditions**: Any eligibility filters?
9. **Create rule** → create_compliance_rule
10. **Create version** → create_compliance_rule_version
11. **Assign scope** if needed → create_compliance_scope_assignment
12. **Evaluate** to verify → evaluate_compliance_rule

## Before Building: Discover Your Data

- Read \`tapestrai://model/relationships\` to find available rollup paths
- Read \`tapestrai://model/attributes\` to find attribute codes for numerator/denominator
- Use \`get_relationship_types\` tool for live relationship data
- Use \`get_attribute_metadata\` tool for live attribute data
`;
const ENTITY_DESIGN_GUIDE = `# Entity Design Guide

This guide helps you design new entity types for the Tapestr.ai MDM system. Rather than prescribing templates, this guide provides principles and frameworks to help you reason about what's appropriate for any entity domain.

## Core Principles

### 1. Understand the Domain First
Before designing attributes, understand:
- **What does this entity represent in the real world?** (a financial instrument, a legal agreement, a physical asset, a transaction, a person, an organization?)
- **What industry standards or regulatory frameworks apply?** (GAAP/IFRS for financials, ISDA for derivatives, UCC for secured transactions, etc.)
- **What data sources will feed this entity?** (Bloomberg, FactSet, internal systems, manual entry, APIs?)
- **How will this entity be used?** (reporting, compliance, analytics, operational workflows?)

### 2. Discover What Already Exists
Before creating new attributes or relationships:
- Read \`tapestrai://model/attributes\` to see what attributes already exist
- Read \`tapestrai://model/relationships\` to understand how entities currently connect
- Read \`tapestrai://model/domains\` to see existing entity types
- Reuse existing attributes where possible (e.g. CURRENCY, MATURITY_DATE, INTEREST_RATE are already defined)

### 3. Reason About Granularity and Cardinality
Ask yourself:
- **Is this entity time-series data?** (changes over time with multiple versions)
  - Examples: financial statements, prices, ratings, positions
  - Needs: temporal attributes (PERIOD_END_DATE, AS_OF_DATE, EFFECTIVE_DATE)
  
- **Is this entity multi-valued per parent?** (many instances per parent entity)
  - Examples: tranches in a deal, loans in a portfolio, covenants in an agreement
  - Needs: parent relationship (DEAL → TRANCHE, DEAL → LOAN)
  
- **Is this entity a singleton per parent?** (one instance per parent)
  - Examples: issuer's legal structure, fund's investment policy
  - Needs: ONE_TO_ONE relationship
  
- **Is this entity a reference/lookup?** (shared across many entities)
  - Examples: currencies, countries, industry classifications, rating agencies
  - Needs: MANY_TO_ONE relationships from entities to the reference

### 4. Think About Identification
Every entity needs a unique identifier. Consider:
- **Natural keys** — Does the entity have an industry-standard identifier?
  - Examples: CUSIP, ISIN, LEI, ticker symbol, loan ID
  - Use these when they exist and are truly unique
  
- **Composite keys** — Does a combination of attributes uniquely identify the entity?
  - Examples: ISSUER + PERIOD_TYPE + PERIOD_END_DATE for financials
  - Use when no single attribute is unique
  
- **System-generated UUIDs** — Use when no natural key exists
  - Examples: internal transactions, custom entities
  - The system generates these automatically

### 5. Design for Your Use Case
Don't over-engineer. Ask:
- **What are the minimum attributes needed to support the primary use case?**
- **What attributes will be queried most often?** (these should be indexed)
- **What attributes are required vs. optional?**
- **What attributes might change over time?** (these need temporal tracking)

## Frameworks for Common Domains

These frameworks provide thinking patterns for common entity categories. They are not prescriptive templates — adapt them to your specific needs.

### Financial Data (Statements, Metrics, Ratios)
**When to use:** Periodic financial data, performance metrics, economic indicators

**Key considerations:**
- Temporal granularity (daily, monthly, quarterly, annual, TTM)
- Reporting standards (GAAP, IFRS, regulatory)
- Restatement tracking (do you need to track revised values?)
- Currency and unit consistency
- Source attribution (where did the data come from?)

**Typical attribute categories:**
- Temporal: period type, period end date, filing date, as-of date
- Financial: revenue, earnings, assets, liabilities, equity, cash flow metrics
- Metadata: currency, source, restated flag, reporting standard

**Typical relationships:**
- ISSUER → FINANCIAL_DATA (ONE_TO_MANY, time-series)
- SECURITY → FINANCIAL_DATA (ONE_TO_MANY, if security-level)

### Structural Data (Tranches, Classes, Series)
**When to use:** Capital structures, securitizations, fund classes, share classes

**Key considerations:**
- Hierarchy and seniority (senior, mezzanine, subordinated, equity)
- Cash flow waterfalls (how are payments distributed?)
- Rights and preferences (dividends, voting, liquidation)
- Conversion features (convertible notes, warrants)

**Typical attribute categories:**
- Identity: name, type, series, class
- Financial: original balance, current balance, interest rate, coupon type
- Temporal: issue date, maturity date, call date
- Status: outstanding, paid off, defaulted, restructured
- Priority: priority rank, subordination level

**Typical relationships:**
- ISSUER → TRANCHE (ONE_TO_MANY)
- DEAL → TRANCHE (ONE_TO_MANY, for securitizations)

### Loan-Level Data (Collateral, Mortgages, Credit Facilities)
**When to use:** ABS, CLOs, RMBS, CMBS, whole loan portfolios, credit facilities

**Key considerations:**
- Loan characteristics (purpose, property type, occupancy)
- Borrower characteristics (credit score, income, employment)
- Performance metrics (LTV, DSCR, delinquency status)
- Payment history (current, 30/60/90 days late, foreclosure)
- Geographic data (property location, MSA, state)

**Typical attribute categories:**
- Identity: loan ID, loan number, pool ID
- Financial: original balance, current balance, interest rate, original term
- Temporal: origination date, maturity date, next payment date
- Performance: LTV ratio, DSCR, credit score, delinquency status
- Property: property type, property location, occupancy type, year built

**Typical relationships:**
- DEAL → LOAN (ONE_TO_MANY, for securitizations)
- ISSUER → LOAN (ONE_TO_MANY, for portfolio loans)

### Legal/Contractual Data (Agreements, Covenants, Guarantees)
**When to use:** Loan agreements, bond indentures, covenants, guarantees, letters of credit

**Key considerations:**
- Legal enforceability and jurisdiction
- Conditional obligations (if X happens, then Y)
- Thresholds and triggers (financial covenants, events of default)
- Amendment and waiver tracking
- Counterparty relationships

**Typical attribute categories:**
- Identity: agreement type, agreement date, effective date, expiration date
- Terms: threshold value, threshold operator, test frequency
- Status: active, breached, waived, amended, expired
- Testing: last test date, last test value, compliance status

**Typical relationships:**
- DEAL → COVENANT (ONE_TO_MANY)
- ISSUER → GUARANTEE (ONE_TO_MANY)

### Transactional Data (Trades, Payments, Cash Flows)
**When to use:** Trade confirmations, payment events, cash flow projections, settlements

**Key considerations:**
- Transaction lifecycle (pending, confirmed, settled, failed)
- Counterparty tracking (who is involved?)
- Settlement mechanics (T+1, T+2, T+3)
- Reconciliation (matching against expectations)
- Audit trail (who approved? when? why?)

**Typical attribute categories:**
- Identity: transaction ID, transaction type, trade date, settlement date
- Financial: amount, currency, price, quantity, accrued interest
- Parties: counterparty, broker, custodian
- Status: pending, confirmed, settled, failed, cancelled

**Typical relationships:**
- POSITION → TRANSACTION (ONE_TO_MANY)
- DEAL → TRANSACTION (ONE_TO_MANY)

### Reference/Lookup Data (Classifications, Ratings, Indices)
**When to use:** Industry classifications, credit ratings, country codes, currency codes, indices

**Key considerations:**
- Standardization (use industry standards: GICS, NAICS, ISO codes)
- Hierarchy (sectors → industries → sub-industries)
- Effective dates (classifications change over time)
- Source attribution (who provided the rating/classification?)

**Typical attribute categories:**
- Identity: code, name, description
- Hierarchy: parent code, level, path
- Temporal: effective date, expiration date
- Metadata: source, rating agency, methodology

**Typical relationships:**
- ISSUER → RATING (ONE_TO_MANY, time-series)
- SECURITY → INDUSTRY_CLASSIFICATION (MANY_TO_ONE)

## Design Workflow

### Step 1: Understand the Domain
- What does this entity represent?
- What industry standards or frameworks apply?
- What data sources will feed this entity?
- How will this entity be used?

### Step 2: Research Standard Attributes
- What attributes are standard for this domain?
- What attributes are required by regulators or industry bodies?
- What attributes do data providers typically supply?
- What attributes will users need for reporting and analysis?

### Step 3: Define the Schema
For each attribute, specify:
- **Attribute code** — UPPERCASE_WITH_UNDERSCORES (e.g. ORIGINAL_BALANCE)
- **Data type** — STRING, NUMBER, DATE, BOOLEAN, JSON
- **Unit of measure** — USD, PERCENT, RATIO, SHARES, or null
- **Description** — Clear, concise explanation of what this represents
- **Required?** — Is this attribute mandatory for every instance?

### Step 4: Define Relationships
- What parent entity does this belong to?
- What is the cardinality? (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_MANY)
- Is the relationship temporal? (does it have valid_from/valid_to?)
- Are there any constraints? (e.g. a loan can only belong to one deal)

### Step 5: Define Identifiers
- What uniquely identifies an instance of this entity?
- Is there an industry-standard identifier? (CUSIP, ISIN, LEI, etc.)
- Do you need a composite key? (combination of attributes)
- Should the system generate UUIDs?

### Step 6: Create the Schema
1. \`create_domain_type\` — Register the new entity type
2. \`create_attribute\` — Create each attribute (reuse existing ones when possible)
3. \`create_template\` — Group attributes into a template for this entity type
4. \`assign_attribute_to_template\` — Link attributes to the template
5. \`create_relationship_type\` — Define relationships to other entities
6. \`create_entity_identifier\` — Define the unique identifier(s)

### Step 7: Validate
- Verify all attributes have proper data types and units
- Confirm relationships connect to valid domains
- Ensure identifiers are truly unique
- Check that the template includes all necessary attributes
- Create sample entities to verify the design works

## Best Practices

1. **Start minimal** — Begin with the attributes needed for the primary use case. You can always add more later.

2. **Reuse existing attributes** — Check \`tapestrai://model/attributes\` before creating new ones.

3. **Use consistent naming** — UPPERCASE_WITH_UNDERSCORES for attributes, PARENT_CHILD for relationships.

4. **Document everything** — Every attribute and relationship should have a clear description.

5. **Think about temporal data** — If the entity changes over time, consider bi-temporal versioning.

6. **Consider cardinality early** — MANY_TO_MANY requires an intersection entity.

7. **Test with sample data** — Create a few sample entities to verify the design.

8. **Be flexible** — Don't force-fit a template if it doesn't match your use case.

## Illustrative Examples

These examples show how the principles above can be applied. They are not prescriptive templates — adapt them to your specific needs.

### Example A: Company Financial Statements
**Domain:** Periodic financial data for issuers

**Reasoning:**
- Time-series data (multiple periods per issuer)
- Standardized by accounting frameworks (GAAP/IFRS)
- Used for compliance, credit analysis, valuation
- Needs temporal attributes (period type, end date)
- Needs financial metrics (revenue, EBITDA, net income)
- Needs metadata (currency, source, filing date)

**Design:**
- Domain: FINANCIAL_STATEMENT
- Key attributes: PERIOD_TYPE, PERIOD_END_DATE, REVENUE, EBITDA, NET_INCOME, TOTAL_ASSETS, CURRENCY, FILING_DATE, SOURCE
- Relationship: ISSUER → FINANCIAL_STATEMENT (ONE_TO_MANY)
- Identifier: Composite (ISSUER_ID + PERIOD_TYPE + PERIOD_END_DATE)

### Example B: Loan-Level Collateral Data
**Domain:** Individual loans backing ABS/CLO securities

**Reasoning:**
- Multi-valued (thousands of loans per deal)
- Highly detailed (borrower, property, performance data)
- Used for risk analysis, cash flow modeling
- Needs loan characteristics (balance, rate, term)
- Needs performance metrics (LTV, delinquency, credit score)
- Needs property details (type, location, value)

**Design:**
- Domain: COLLATERAL_LOAN
- Key attributes: LOAN_ID, ORIGINAL_BALANCE, CURRENT_BALANCE, INTEREST_RATE, ORIGINATION_DATE, MATURITY_DATE, LOAN_STATUS, LTV_RATIO, CREDIT_SCORE, PROPERTY_TYPE, PROPERTY_LOCATION
- Relationship: DEAL → COLLATERAL_LOAN (ONE_TO_MANY)
- Identifier: LOAN_ID (if globally unique) or composite (DEAL_ID + LOAN_ID)

### Example C: Bespoke Entity - ESG Scores
**Domain:** Environmental, social, governance ratings for issuers

**Reasoning:**
- Time-series (scores change over time)
- Multiple rating providers (MSCI, Sustainalytics, S&P)
- Multiple dimensions (E, S, G separately, plus composite)
- Used for compliance, reporting, investment decisions

**Design:**
- Domain: ESG_SCORE
- Key attributes: RATING_AGENCY, RATING_DATE, ENVIRONMENTAL_SCORE, SOCIAL_SCORE, GOVERNANCE_SCORE, COMPOSITE_SCORE, RATING_SCALE, METHODOLOGY_VERSION
- Relationship: ISSUER → ESG_SCORE (ONE_TO_MANY)
- Identifier: Composite (ISSUER_ID + RATING_AGENCY + RATING_DATE)

## Next Steps

After designing your entity type:
1. Read \`tapestrai://model/attributes\` to check for existing attributes you can reuse
2. Read \`tapestrai://model/relationships\` to understand existing relationships
3. Use the \`design_entity\` prompt for guided assistance
4. Create the schema using the MCP tools
5. Test with sample data to validate the design
`;
