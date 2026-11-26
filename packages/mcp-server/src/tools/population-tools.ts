import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';
import { listCertifiedPopulations, loadCertifiedPopulation } from '@tapestrai/graphql/src/lib/population-filters';

/**
 * Certified populations: named definitions of which records count ("active
 * funds", "EU-managed funds") that an administrator has certified. An agent
 * asks for one by code instead of writing its own filter, so everyone gets the
 * same answer to the same question. The conditions are matched in the
 * database by the one condition matcher; nothing is interpreted here.
 */

const USE = 'To use one, put its code in a query_data entity query as "population" together with domainCode set to the population\'s domainCode: {"grain":"entity","start":"DOMAIN","domainCode":"FUND","population":"ACTIVE_FUNDS","metrics":[{"alias":"n","agg":"COUNT"}]}. Its filters, groups and metrics then apply to that population only.';

const listPopulations: ToolDefinition = {
  name: 'list_populations',
  description:
    `The certified populations: named, described definitions of which records count, such as "active funds". When a question names a group of records that a certified population describes, use the population rather than writing your own filter, and say which one you used. Returns each code, name, the entity type it is for (domainCode), what it means, and its definition in words. ${USE} Call this before filtering by a status, region, or type the question treats as a standard group. If none fits, say so and build the filter yourself, and tell the person it is not a certified population.`,
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Only populations for this entity type (from list_domain_types), such as FUND.' },
    },
  },
  execute: async (args, supabase) => {
    const populations = await listCertifiedPopulations(supabase, args.domainCode ? String(args.domainCode) : null);
    return {
      populations: populations.map((p) => ({
        code: p.populationCode,
        name: p.name,
        domainCode: p.domainCode,
        description: p.description,
        definition: p.definition,
        certifiedAt: p.certifiedAt,
      })),
      howToUse: USE,
    };
  },
};

const getPopulation: ToolDefinition = {
  name: 'get_population',
  description:
    'One certified population by code: what it means, its definition in words, the conditions as they are stored, who certified it and the note they left. Use it to explain exactly which records a population includes. To count or list its members, use query_data with "population".',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Population code from list_populations.' } },
    required: ['code'],
  },
  execute: async (args, supabase) => {
    try {
      const p = await loadCertifiedPopulation(supabase, String(args.code || ''));
      return {
        code: p.populationCode,
        name: p.name,
        domainCode: p.domainCode,
        description: p.description,
        definition: p.definition,
        conditions: p.conditions,
        certifiedAt: p.certifiedAt,
        certificationNote: p.certificationNote,
        howToUse: USE,
      };
    } catch (error: any) {
      return { error: error.message || String(error) };
    }
  },
};

export function registerPopulationTools(registry: ToolRegistry): void {
  registry.registerTool(listPopulations);
  registry.registerTool(getPopulation);
}
