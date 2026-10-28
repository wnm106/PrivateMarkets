import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';
import {
  runDataQueries,
  summarizeResultsForLLM,
  validateDataQueries,
  type DataQuerySpec,
} from '@tapestrai/graphql/src/lib/data-query-engine';

export const QUERY_DATA_GUIDE = `

## Asking questions about the data
Answer counts, lists, filters, and "across the system" questions with query_data. Do not add up list_entities pages, get_entity, or get_field_lineage and present that as a total. Those tools see one page or one record. Attribute and template metadata describe field definitions, not which source supplied a stored value.

Before a domain or attribute code goes into a query, look it up. list_domain_types for entity types, get_template_metadata for the fields on an entity type, search_attributes for a field the user named. Do not invent codes.

query_data takes one JSON object in "query" (or an array of up to five).

grain "value" — one row per prevailing field value, across every entity type unless you set domainCode. Use this when the question is about a source, a field, or how many values. Fields: domain_code, entity_code, entity_name, entity_id, attribute_code, attribute_name, value, numeric_value, source_code, source_name, valid_from, received_at. People say source names ("Manual Entry"), so filter source_name unless they used a code. Operators: eq neq gt gte lt lte in nin contains startsWith between isNull notNull. Aggregations: COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX. SUM and AVG apply only to numeric_value.

For a single number, use metrics and no groupBy. groupBy is the breakdown. valueCount and entityCount are complete. When truncated is true, rows is only a sample — do not add the sample up. If a source filter returns 0, group by source_name with no filter and match the name the user used.

grain "entity" — one row per record. start is DOMAIN or CONTEXT. domainCode limits the entity type; omit it to cover every type. Filters use attribute codes (COUNTRY, LEI), not the value-grain field names. Same metrics. matchedEntities is the complete count.

Examples:
{"grain":"value","filters":[{"field":"source_name","op":"eq","value":"Manual Entry"}],"metrics":[{"alias":"fields","agg":"COUNT"},{"alias":"records","agg":"COUNT_DISTINCT","field":"entity_id"}]}
{"grain":"value","filters":[{"field":"source_name","op":"eq","value":"Manual Entry"}],"groupBy":["domain_code","attribute_name"],"metrics":[{"alias":"fields","agg":"COUNT"}]}
{"grain":"entity","start":"DOMAIN","domainCode":"ISSUER","filters":[{"field":"COUNTRY","op":"eq","value":"US"}],"metrics":[{"alias":"issuers","agg":"COUNT"}]}
`;

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
    'Answer counts, lists, filters, and questions across records or sources. Do not add up list_entities, get_entity, or get_field_lineage; those are one page or one record. Before using a domain or attribute code, look it up: list_domain_types for entity types, get_template_metadata for the fields on an entity type, search_attributes when the user names a field. Do not invent codes. Pass query as one JSON object or an array of up to five. grain "value" is one row per prevailing field, across every entity type unless domainCode is set. Its fields are domain_code, entity_code, entity_name, entity_id, attribute_code, attribute_name, value, numeric_value, source_code, source_name, valid_from, received_at. Filter source_name with the name a person says (Manual Entry) or source_code (MANUAL). Operators: eq neq gt gte lt lte in nin contains startsWith between isNull notNull. Aggregations: COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX. SUM and AVG only on numeric_value. A COUNT metric with no groupBy is the total. groupBy is the breakdown. valueCount and entityCount are complete. When truncated is true, rows are a sample; do not add them up. If a source filter returns 0, group by source_name with no filter. grain "entity" is one row per record. start is DOMAIN or CONTEXT. domainCode is optional. CONTEXT requires entityId or entityCode. Entity filters use attribute codes from the template, such as COUNTRY. matchedEntities is the complete count. Example: {"grain":"value","filters":[{"field":"source_name","op":"eq","value":"Manual Entry"}],"metrics":[{"alias":"fields","agg":"COUNT"}]}. Example: {"grain":"entity","key":"q","start":"DOMAIN","domainCode":"ISSUER","filters":[{"field":"COUNTRY","op":"eq","value":"US"}],"metrics":[{"alias":"issuers","agg":"COUNT"}]}.',
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

export function registerQueryTools(registry: ToolRegistry): void {
  registry.registerTool(queryData);
}
