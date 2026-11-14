/**
 * What an external chat client needs in order to answer a large analytical request
 * (a portfolio review, an LP briefing, a credit committee pack) from this server.
 *
 * Three pieces, one source of truth:
 *   NARRATIVE_COMPOSE_GUIDE   the full method, served as the resource tapestrai://model/narrative-guide
 *   SERVER_INSTRUCTIONS       the short orientation every client receives on connect
 *   the prompts               compose_narrative and portfolio_review start the method in one click
 *
 * The in-app runner follows the same rules (see narrative-spec DEFAULT_RULES), so a
 * report composed in the app and one composed by an outside client read alike.
 */
import { BLOCK_FORMAT_DOC, DEFAULT_RULES } from '@tapestrai/graphql/src/lib/narrative-spec';
import { QUERY_DATA_GUIDE_CORE } from '../tools/query-data';

export const NARRATIVE_COMPOSE_GUIDE = `# Composing a narrative or large analytical report

A request like "prepare the PM for an LP meeting with a full portfolio review" is not one query. It is a set of sections, each with its own evidence. Do not try to answer it in one pass from memory or from a single query. Work section by section, keep every figure traceable to a tool result, and say plainly what is missing.

## 1. Settle the scope first (ask only what is missing)
- Which record is the report about? Resolve it to an entity code with list_entities or find_sample_entities. Entity type = the record's domain (FUND, ISSUER, ...).
- What is the as-of date? If the request has a placeholder such as [AS-OF DATE] and the user has not given one, ask once. Never assume today.
- Comparison dates (inception, one year ago, last quarter) are supplied by the narrative template, or you choose them and state them.

## 2. Use a saved narrative when one fits
Call list_narratives with the entity type. A narrative is a saved blueprint: ordered sections, each with instructions, data queries, comparison dates, derived measures, screens, scenarios, and the output blocks it expects. If one matches the request, follow it. Its sections are the structure of your answer; do not invent a different outline.

**Check for an existing report first.** A run takes minutes and costs model spend, and a finished run is shared with everyone who can see the record. Call list_narrative_runs(narrativeCode, entityCode, asOfDate). If a published run exists for that record and date, or a recent one, show it with get_narrative_run: say who made it, when, and its as-of date, and present its report and data gaps. Offer a fresh run only if the user asks to refresh, the as-of date differs, or the report is stale (a week or more old). Publish a run with publish_narrative_run only when the user asks to share it.

Otherwise run it like this:
1. get_narrative(narrativeCode) to read the blueprint, the rules, and the run order.
2. start_narrative_run(narrativeCode, entityCode, asOfDate, params). Keep the runId.
3. For each section, in the returned order (dependencies first):
   a. run_narrative_section_data(runId, sectionKey). It returns the evidence (rows at every comparison date, derived measures, computed screens and scenarios, and a list under mustDisclose of what is missing).
   b. If the section has research and the narrative allows external search, search the web yourself for the queries given and keep the source, publisher, and publication date of each item. If external search is not allowed, do not search and say sentiment was not researched.
   c. If the section is agentic, fill gaps with tools: get_model_map to find the fields, query_data for counts and groupings, analyze_rows for measures, screens and scenarios, compare_asof for the same figure at several dates, get_data_coverage to find out whether a field is not defined or just not loaded.
   d. Compose the section as blocks (format below). Lead with the key insight, then the data.
   e. save_narrative_section(runId, sectionKey, blocks, sources). Read the verification it returns. If it lists figures it could not trace, fix those figures (use the evidence value, or say data not available) and save again.
   f. Sections with a batch (for example borrower-by-borrower) return one batch at a time: call run_narrative_section_data with batchIndex 0, 1, 2 and save each.
4. finish_narrative_run(runId). It assembles the report, aggregates sources and verification, and lists any section still missing.
5. Review it before you present it: get_review_brief(runId), read the report as an independent reviewer who did not write it, follow the instructions in the brief, and save what you find with save_run_review(runId, issues). Quote the exact words of every issue. This catches what the figure check cannot: a status nobody recorded, an action described as underway, one section saying data is unavailable while another quotes it, a value read from a different record that shares a name. Fix high-severity issues (save_narrative_section again, then finish_narrative_run) or tell the user plainly what you found.
Then present the assembled report to the user, section by section. The run is stored and appears on the record's page in the app.

## 3. When no narrative fits, plan one
Decompose the request into sections that mirror the request's own outline. For each, decide the data it needs, then:
- get_model_map(domainCode, toDomain) before any question that crosses entity types. Copy its lookup paths; do not invent relationship or attribute codes.
- get_data_coverage(domainCode) to see which fields exist and how many records have a value, before promising a metric.
- query_data for counts, lists, groupings and weighted figures. It sees the whole book, unlike list_entities.
- analyze_rows for anything that needs arithmetic or a rule applied to every row: derived measures (cushion %), screens (flag every borrower with cushion under 15%), and scenarios (rate shock, two largest names stop paying).
- compare_asof for movement over time.
If the plan is reusable, offer to save it with save_narrative so the whole team gets it on the record page. Saving needs the tenant-admin role; if it is refused, give the user the sections as text.

## 4. Data rules (non-negotiable)
${DEFAULT_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}
- Do arithmetic in tools, not in your head. A figure you computed yourself will be flagged by verification. Use analyze_rows measures and scenarios, quote the result, and state the assumptions that went in.
- A name is not an identifier. Several records can share a name (an issuer created twice by different imports, for example). Identify a record by entity_code or entity_id and follow relationships with query_data lookups; if a tool warns that names repeat, never combine or compare those records' values as if they were one.
- A tool that returns an error, an empty column, or truncated rows is telling you what you may not claim. Report it under what is missing. Do not add up a truncated sample.
- The golden record is the value chosen from competing sources. Use get_field_lineage when the user asks where a number came from.
- evaluate_compliance_rule runs a rule and stores an evaluation run. Use it for status at a date; do not call it repeatedly for the same rule and date.
- Searching the web sends text to a third party. Search only when the narrative allows it, and describe a company by name only as the section's queries do.

## 5. Output standard
- Lead every section with its key insight in one or two sentences, then the evidence.
- Tables and scorecards for exposures and borrowers; prose for the story and the "why". Suggest a chart where a picture beats a table: NAV bridge (waterfall), composition over time (stacked), covenant headroom (heatmap), risk-rating migration.
- Every metric carries its as-of date. Where comparison dates exist, show them side by side.
- Every weakness is paired with a mitigant or an action. Name problems before the reader has to ask.
- Close with: Data gaps and assumptions (everything under mustDisclose, plus anything you could not find), and Sources (title, publisher, publication date, link).
- The executive summary is written last from the finished sections, even though it is shown first.
- Long reports are delivered section by section; do not stop with a section half written.

## 6. Block format (for save_narrative_section)
${BLOCK_FORMAT_DOC}

## 7. Check before you present
- Every section has its blocks and a saved result, or is listed as missing.
- No figure appears that is not in a tool result, a computed screen or scenario, or a dated source.
- Every "data not available" is real: you looked with get_data_coverage or the tools.
- Screens and scenarios you quote match the tool output exactly, including the assumptions.
`;

export const SERVER_INSTRUCTIONS = `tapestr.ai is a private-markets master data platform. Records are typed entities (FUND, ISSUER, SECURITY, POSITION, DEAL, ...) with sourced, bi-temporal attribute values and typed relationships. These tools run as the signed-in user, so tenancy limits what you can read.

## Orient before you answer
- Read the resource tapestrai://model/narrative-guide before you answer any request that has several parts, several dates, a report, a briefing, or a review. It is the method; the rest of this note is a summary.
- Never invent an entity type, attribute code, relationship code, or number. Discover them: list_domain_types, get_model_map, get_template_metadata, search_attributes, get_relationship_types, get_data_coverage.
- Questions about a whole book (totals, exposure by X and Y, weighted averages, how many) go to query_data. list_entities, get_entity and get_field_lineage see one page or one record and must not be summed. A result that names the records and omits the amount is unfinished: query again for that field, then analyze_rows for shares and other calculations, before you answer. A facility size is not a stand-in for a missing allocation.

## Large analytical requests (portfolio review, LP briefing, credit review)
1. list_narratives for the record's entity type. If one fits, call list_narrative_runs first: a finished run is shared and costs minutes and model spend, so present a published or recent run for the same record and date with get_narrative_run (say who made it and when). Only if none fits, or the user wants a refresh, run it: get_narrative, start_narrative_run, then per section run_narrative_section_data and save_narrative_section, then finish_narrative_run.
2. If none fits, plan sections that mirror the request, gather evidence with get_model_map, query_data, analyze_rows (derived measures, screens, scenarios), compare_asof, and compose each section yourself. Offer to save the plan with save_narrative.
3. Do arithmetic in analyze_rows, not in your head. Quote computed screens and scenarios exactly.
4. Before you present a report you composed, review it: get_review_brief, read it as an independent reviewer, and save_run_review. Match records by id or relationship, never by name. Use only figures from tool results or dated external sources. Say "data not available" for anything missing, and list gaps and sources at the end.
5. Search the web only for sections that ask for it and only when the narrative allows external search.

## How to ask data questions
${QUERY_DATA_GUIDE_CORE}`;

export interface PromptMessageOut {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export function composeNarrativePrompt(args: Record<string, string>): PromptMessageOut[] {
  const entity = args.entityCode || '(the record the user names)';
  const asOf = args.asOfDate || '(ask the user for the as-of date)';
  const request = args.request || '(the user\'s request)';
  const code = args.narrativeCode;
  return [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Prepare this report for ${entity} as of ${asOf}${code ? ` using the narrative ${code}` : ''}.\n\n${request}`,
      },
    },
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: `I'll build this section by section from the data, not from memory.

First I'll read \`tapestrai://model/narrative-guide\`, then:
${code
    ? `1. \`get_narrative\` for ${code}, then \`start_narrative_run\` for ${entity} as of ${asOf}.`
    : `1. \`list_narratives\` for the record's entity type, then \`list_narrative_runs\`: if a published or recent report already exists for this record and date I'll show it rather than spend a new run. If none fits I'll plan sections that mirror your outline.`}
2. For each section: gather evidence (\`run_narrative_section_data\`, or \`get_model_map\`, \`query_data\`, \`analyze_rows\`, \`compare_asof\`), check coverage with \`get_data_coverage\`, compose it, and save it with \`save_narrative_section\` so every figure is verified against the evidence.
3. \`finish_narrative_run\` to assemble the report, with data gaps and dated sources at the end.

I won't estimate a number the data does not hold; missing items will read "data not available" and be listed. Tell me the as-of date and the record if I don't have them yet.`,
      },
    },
  ];
}
