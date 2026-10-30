import { ToolRegistry } from '../lib/tool-registry';
import { CHAT_ANSWER_GUIDE } from '../lib/chat-answer';
import { lessonFromRow, lessonMatches } from '../lib/chat-lessons';
import { shapeModelMap } from '../lib/model-map';
import { ToolDefinition } from '../lib/types';
import {
  runDataQueries,
  summarizeResultsForLLM,
  validateDataQueries,
  type DataQuerySpec,
} from '@tapestrai/graphql/src/lib/data-query-engine';

export const QUERY_DATA_GUIDE = `

## Asking questions about the data
Answer counts, lists, filters, groups, and weighted figures with query_data. Do not add up list_entities pages, get_entity, or get_field_lineage and present that as a total. Those tools see one page or one record.

When the question is about records and how they relate — exposure by fund, positions by industry, investors in a deal, a weighted average — call get_model_map once. domainCode is the type you start from. toDomain is the type the answer has to reach, however many relationships away. The map returns the shortest path across the whole graph, not a two-step neighborhood. Copy that path's lookups in order. A lookup after the first sets from to the previous alias. A relationship marked repeats (a fund and its parent funds) is walked with path recursive, not one lookup per level. Do not also call list_domain_types, get_template_metadata, and get_relationship_types for that question. Do not invent codes. A REFERENCE attribute is a link. Do not sample it and treat a blank as proof the relationship is missing; follow the relationship named in readAs.

query_data takes one JSON object in "query" (or an array of up to five).

grain "value" — one row per prevailing field value, across every entity type unless you set domainCode. Use this when the question is about a source, a field, or how many values. Fields: domain_code, entity_code, entity_name, entity_id, attribute_code, attribute_name, value, numeric_value, source_code, source_name, valid_from, received_at. People say source names ("Manual Entry"), so filter source_name unless they used a code. Operators: eq neq gt gte lt lte in nin contains startsWith between isNull notNull. Aggregations: COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX. SUM and AVG apply only to numeric_value.

For a single number, use metrics and no groupBy. groupBy is the breakdown. valueCount and entityCount are complete. When truncated is true, rows is only a sample — do not add the sample up. If a source filter returns 0, group by source_name with no filter and match the name the user used.

grain "entity" — one row per record. start is DOMAIN (every record of domainCode) or CONTEXT (the record in entityId or entityCode). Copy lookups from get_model_map paths. Direction UP moves from the child to the parent; DOWN moves from the parent to the child. The map's hops already use the direction of the stored links. To continue past a lookup, the next lookup sets from to the earlier alias.

A field is an attribute code on the entity you are querying, "<alias>.<ATTRIBUTE_CODE>" on a lookup, or "<alias>.entity_name" / "<alias>.entity_code". Those fields work in filters, groupBy, orderBy, select, and metrics. Filters are AND-ed. Operators: eq neq gt gte lt lte in nin contains startsWith between isNull notNull.

groupBy is the breakdown, one row per combination. For a single total, use metrics and no groupBy. Metrics: SUM AVG MIN MAX COUNT COUNT_DISTINCT WEIGHTED_AVG. WEIGHTED_AVG needs field and weightField. Use the attribute's weight from the map when it has one; otherwise weight by the amount the user means, such as MARKET_VALUE. A group's weight in a total is that group's sum divided by the sum of the metric across the groups. Return the sums and compute each share in the answer.

Read every record back with readAs. A composite identifier has several parts. Show each part. For a position that is fund + security + trade date, a row or a group shows the fund name, the security name, and the trade date — not the position code alone, and not a blank fund or security reference. If a looked-up column is null on every row, swap that lookup's direction once and query again before saying the link is empty.

The directions in these examples are a shape. Replace relationship codes and directions with the ones get_model_map returned.

Exposure by fund and industry is one query. groupBy is both dimensions and the metric is the same SUM on every row. The fund total is the sum of its industry rows. Do not add a second query that only counts positions by industry.
{"grain":"entity","key":"exposure","start":"DOMAIN","domainCode":"POSITION","lookups":[{"alias":"fund","direction":"UP","relationshipCode":"POSITION_FUND","domainCode":"FUND"},{"alias":"sec","direction":"UP","relationshipCode":"POSITION_SECURITY","domainCode":"SECURITY"},{"alias":"iss","from":"sec","direction":"UP","relationshipCode":"SECURITY_ISSUER","domainCode":"ISSUER"}],"groupBy":["fund.entity_name","iss.INDUSTRY"],"metrics":[{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"}],"orderBy":[{"field":"exposure","dir":"desc"}]}

Weighted yield for one fund:
{"grain":"entity","key":"yield","start":"DOMAIN","domainCode":"POSITION","lookups":[{"alias":"fund","direction":"UP","relationshipCode":"POSITION_FUND","domainCode":"FUND"}],"filters":[{"field":"fund.entity_name","op":"eq","value":"the fund the user named"}],"metrics":[{"alias":"wavg_yield","agg":"WEIGHTED_AVG","field":"YIELD","weightField":"MARKET_VALUE"},{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"}]}

Value-grain examples:
{"grain":"value","filters":[{"field":"source_name","op":"eq","value":"Manual Entry"}],"metrics":[{"alias":"fields","agg":"COUNT"},{"alias":"records","agg":"COUNT_DISTINCT","field":"entity_id"}]}
{"grain":"value","filters":[{"field":"source_name","op":"eq","value":"Manual Entry"}],"groupBy":["domain_code","attribute_name"],"metrics":[{"alias":"fields","agg":"COUNT"}]}

matchedEntities is the complete count. When truncated is true, rows are a page; do not add the page up. summaryOverAllMatched covers every matched record.

When the user corrects how a phrase should be read, call save_lesson with the phrase, the reading, the query shape, and the answer shape, then answer that way. A block titled Lessons that match this question overrides a more general example. Do not save a lesson the user did not just teach.
${CHAT_ANSWER_GUIDE}`;

const VALUE_FIELDS = new Set([
  'domain_code', 'entity_code', 'entity_name', 'entity_id',
  'attribute_code', 'attribute_name', 'value', 'numeric_value',
  'source_code', 'source_name', 'valid_from', 'received_at',
]);

const AGGS = new Set(['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX']);

export function parseQueryInput(input: unknown): unknown {
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error('query is required');
    return JSON.parse(text);
  }
  return input;
}

export function queryGrain(query: any): 'entity' | 'value' {
  if (query?.grain === 'value' || query?.grain === 'entity') return query.grain;
  if (query?.start === 'CONTEXT' || query?.start === 'DOMAIN') return 'entity';
  throw new Error('Set grain to "value" (one row per field) or "entity" (one row per record, with start).');
}

/** Pulls domain and attribute equality into the scan, and checks the value-query shape. */
export function valueRequest(query: any, asOfDate?: string): Record<string, unknown> {
  const filters: any[] = [];
  let domainCode = query.domainCode ? String(query.domainCode) : undefined;
  const attributeCodes = new Set<string>(
    Array.isArray(query.attributeCodes) ? query.attributeCodes.map((code: unknown) => String(code)) : []
  );

  for (const filter of query.filters || []) {
    if (!filter?.field || !filter?.op) throw new Error('Each filter needs field and op');
    if (!VALUE_FIELDS.has(filter.field)) throw new Error(`Unknown field: ${filter.field}`);
    if (!domainCode && filter.field === 'domain_code' && filter.op === 'eq' && filter.value) {
      domainCode = String(filter.value);
      continue;
    }
    if (filter.field === 'attribute_code' && filter.op === 'eq' && filter.value) {
      attributeCodes.add(String(filter.value));
      continue;
    }
    if (filter.field === 'attribute_code' && filter.op === 'in' && Array.isArray(filter.value)) {
      filter.value.forEach((code: unknown) => attributeCodes.add(String(code)));
      continue;
    }
    filters.push(filter);
  }

  for (const field of query.groupBy || []) {
    if (!VALUE_FIELDS.has(field)) throw new Error(`Unknown field: ${field}`);
  }
  for (const field of query.select || []) {
    if (!VALUE_FIELDS.has(field)) throw new Error(`Unknown field: ${field}`);
  }
  for (const metric of query.metrics || []) {
    const agg = String(metric?.agg || '').toUpperCase();
    if (!AGGS.has(agg)) throw new Error(`Unsupported aggregation: ${metric?.agg}`);
    if (agg !== 'COUNT' && !metric?.field) throw new Error(`${agg} needs a field`);
    if (metric?.field && !VALUE_FIELDS.has(metric.field)) throw new Error(`Unknown field: ${metric.field}`);
    if ((agg === 'SUM' || agg === 'AVG') && metric.field !== 'numeric_value') {
      throw new Error(`${agg} only applies to numeric_value`);
    }
  }

  return {
    domainCode: domainCode || null,
    attributeCodes: attributeCodes.size ? [...attributeCodes] : null,
    asOfDate: query.asOfDate || asOfDate || null,
    filters,
    groupBy: query.groupBy || [],
    metrics: query.metrics || [],
    select: query.select || [],
    orderBy: query.orderBy || [],
    limit: query.limit,
  };
}

function entitySpec(query: any, index: number): DataQuerySpec {
  const spec: DataQuerySpec = {
    ...query,
    key: query.key || `q${index + 1}`,
    start: query.start,
  };
  const problems = validateDataQueries([spec]);
  if (problems.length) throw new Error(problems.join('; '));
  return spec;
}

const queryData: ToolDefinition = {
  name: 'query_data',
  description:
    'Answer counts, lists, filters, groups, and weighted figures across records or sources. Do not add up list_entities, get_entity, or get_field_lineage; those are one page or one record. For a question that crosses entity types, call get_model_map first and copy its paths lookups; do not invent relationship or attribute codes, and do not treat a blank REFERENCE attribute as a missing link. Pass query as one JSON object or an array of up to five. grain "value" is one row per prevailing field. Its fields are domain_code, entity_code, entity_name, entity_id, attribute_code, attribute_name, value, numeric_value, source_code, source_name, valid_from, received_at. Filter source_name with the name a person says (Manual Entry). Operators: eq neq gt gte lt lte in nin contains startsWith between isNull notNull. Aggregations: COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX. SUM and AVG only on numeric_value. grain "entity" is one row per record. start is DOMAIN or CONTEXT. CONTEXT requires entityId or entityCode. lookups follow relationships from get_model_map. filters, groupBy, orderBy, select, and metrics accept an attribute code or "<alias>.<ATTRIBUTE>" such as fund.entity_name or iss.INDUSTRY. Metrics also include WEIGHTED_AVG, which needs field and weightField. Group by the identifier parts in readAs, so a position is returned as its fund, security, and trade date. When truncated is true, rows are a sample; do not add them up. Example: {"grain":"entity","key":"exposure","start":"DOMAIN","domainCode":"POSITION","lookups":[{"alias":"fund","direction":"UP","relationshipCode":"POSITION_FUND","domainCode":"FUND"}],"groupBy":["fund.entity_name"],"metrics":[{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"}]}.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'JSON object, or an array of up to five. grain is "value" or "entity". The tool description has the fields, operators, and examples.',
      },
      asOfDate: { type: 'string', description: 'Valid-time date YYYY-MM-DD. Defaults to today.' },
      entityId: { type: 'string', description: 'Context record for grain "entity" and start CONTEXT.' },
      entityCode: { type: 'string', description: 'Context record code, instead of entityId.' },
    },
    required: ['query'],
  },
  execute: async (args, supabase) => {
    let parsed: unknown;
    try {
      parsed = parseQueryInput(args.query);
    } catch (error: any) {
      return { error: `Could not parse query: ${error.message}` };
    }
    const queries = Array.isArray(parsed) ? parsed : [parsed];
    if (queries.length === 0) return { error: 'query is required' };
    if (queries.length > 5) return { error: 'Send at most 5 queries at a time' };

    const results: any[] = [];
    for (let index = 0; index < queries.length; index++) {
      const query = queries[index];
      try {
        const grain = queryGrain(query);
        if (grain === 'value') {
          const request = valueRequest(query, args.asOfDate);
          const { data, error } = await supabase.rpc('query_values', { p_request: request });
          if (error) throw new Error(error.message);
          results.push(data);
        } else {
          const spec = entitySpec(query, index);
          const response = await runDataQueries(supabase, [spec], {
            entityId: args.entityId || query.entityId,
            entityCode: args.entityCode || query.entityCode,
            asOfDate: args.asOfDate || query.asOfDate,
            params: query.params,
          });
          results.push({
            grain: 'entity',
            note: 'matchedEntities is every matching record. When truncated is true, rows is a sample; do not add the sample up.',
            ...summarizeResultsForLLM(response, Math.min(Number(query.limit) || 40, 80)),
          });
        }
      } catch (error: any) {
        results.push({ error: error.message || String(error) });
      }
    }
    return queries.length === 1 ? results[0] : { results };
  },
};

const getModelMap: ToolDefinition = {
  name: 'get_model_map',
  description:
    'Attributes, identifiers, and relationships for one entity type, with a lookup path to every type it can reach. Call this before a question that filters, groups, weights, or reads across related records. domainCode is where you start, such as DEAL. toDomain is the far type, such as INVESTOR, at any number of steps (deal to security to position to fund to investor). path is the lookups to copy, in order. readAs is how to label each record: a composite identifier is shown as each of its parts, and a REFERENCE part is read through its relationship (a position is the fund, the security, and the trade date). A relationship with repeats is a hierarchy; walk it with path recursive. Omit domainCode for the relationship index only.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: {
        type: 'string',
        description: 'Entity type to start from, such as DEAL or POSITION. Omit for relationships and identifiers only.',
      },
      toDomain: {
        type: 'string',
        description: 'Entity type the question needs to reach, any number of relationships away. Example: INVESTOR when domainCode is DEAL.',
      },
    },
  },
  execute: async (args, supabase) => {
    const [relationships, identifiers, counts] = await Promise.all([
      supabase
        .from('relationship_types')
        .select('relationship_code, relationship_name, parent_domain_code, child_domain_code, cardinality, composite_key')
        .eq('is_active', true),
      supabase
        .from('entity_identifier_definitions')
        .select('domain_code, identifier_code, identifier_name, attribute_codes, is_primary, description')
        .eq('is_active', true),
      supabase.rpc('relationship_link_counts'),
    ]);
    if (relationships.error) throw new Error(relationships.error.message);
    if (identifiers.error) throw new Error(identifiers.error.message);

    const focus = args.domainCode ? String(args.domainCode) : null;
    const toDomain = args.toDomain ? String(args.toDomain) : null;
    const linkCounts = counts.error ? [] : (counts.data || []);
    let attributes: any[] = [];
    if (focus) {
      const preview = shapeModelMap({
        focus,
        toDomain,
        attributes: [],
        relationships: relationships.data || [],
        identifiers: [],
        linkCounts,
      }) as { domains?: Array<{ domainCode: string }> };
      const domains = preview.domains?.map((domain) => domain.domainCode) || [focus.toUpperCase()];
      const attributeRows = await supabase
        .from('attribute_register')
        .select('domain_code, attribute_code, attribute_name, data_type, reference_domain_code, aggregation_type, weight_attribute_code')
        .in('domain_code', domains);
      if (attributeRows.error) throw new Error(attributeRows.error.message);
      attributes = attributeRows.data || [];
    }

    return shapeModelMap({
      focus,
      toDomain,
      attributes,
      relationships: relationships.data || [],
      identifiers: identifiers.data || [],
      linkCounts,
    });
  },
};

const saveLesson: ToolDefinition = {
  name: 'save_lesson',
  description:
    'Remember how a phrase should be read, queried, and answered. Call this when the user corrects a reading or states what a phrase means. phrase is the words they use. reading is the meaning, including the reading to avoid. queryShape is the query_data JSON. answerShape is how to present it, including groupBy when the rows nest. Do not save a lesson the user did not just teach.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      phrase: { type: 'string', description: 'The words the user uses, such as "exposure by fund and industry".' },
      reading: { type: 'string', description: 'What the phrase means, and what it does not mean.' },
      queryShape: { type: 'string', description: 'The query_data JSON to run for this phrase.' },
      answerShape: { type: 'string', description: 'How to present the result, including groupBy for a nested breakdown.' },
    },
    required: ['phrase', 'reading', 'queryShape', 'answerShape'],
  },
  execute: async (args, supabase) => {
    const phrase = String(args.phrase || '').trim().slice(0, 160);
    const reading = String(args.reading || '').trim().slice(0, 800);
    const queryShape = String(args.queryShape || '').trim().slice(0, 2000);
    const answerShape = String(args.answerShape || '').trim().slice(0, 800);
    if (!phrase || !reading || !queryShape || !answerShape) {
      return { error: 'phrase, reading, queryShape, and answerShape are required' };
    }
    const { data, error } = await supabase
      .from('chat_lessons')
      .select('id, phrases, reading, query_shape, answer_shape')
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    const prior = (data || []).map(lessonFromRow).find((lesson) => lessonMatches(phrase, lesson));
    if (prior?.id) {
      const phrases = Array.from(new Set([...prior.phrases, phrase])).slice(0, 8);
      const { error: updateError } = await supabase.from('chat_lessons').update({
        phrases,
        reading,
        query_shape: queryShape,
        answer_shape: answerShape,
        updated_at: new Date().toISOString(),
      }).eq('id', prior.id);
      if (updateError) throw new Error(updateError.message);
      return { saved: true, updated: true, id: prior.id, phrases };
    }
    const { data: inserted, error: insertError } = await supabase.from('chat_lessons').insert({
      phrases: [phrase],
      reading,
      query_shape: queryShape,
      answer_shape: answerShape,
    }).select('id').single();
    if (insertError) throw new Error(insertError.message);
    return { saved: true, updated: false, id: inserted?.id, phrases: [phrase] };
  },
};

export function registerQueryTools(registry: ToolRegistry): void {
  registry.registerTool(getModelMap);
  registry.registerTool(queryData);
  registry.registerTool(saveLesson);
}
