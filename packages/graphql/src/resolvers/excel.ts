import { Context } from '../context';
import { fetchAttributeSearch } from '../lib/attribute-search';
import type { AttributeSearchHit } from '../lib/semantic-aliases';
import { resolveTapRequests, type TapRequest } from '../lib/tap';
import { planTapOverrides, submitTapOverrides, type TapOverrideRequest } from '../lib/tap-override';

/** Queries the Excel add-in calls (docs/EXCEL_ADDIN.md). Every read runs as the signed-in caller. */

function requireUser(context: Context) {
  if (!context.user) throw new Error('Not authenticated');
}

function mapAttributeHit(hit: AttributeSearchHit) {
  return {
    attributeCode: hit.attribute_code,
    attributeName: hit.attribute_name,
    description: hit.description,
    dataType: hit.data_type,
    domainCode: hit.domain_code,
    referenceDomainCode: hit.reference_domain_code,
    matchedAlias: hit.matched_alias,
    match: hit.match.toUpperCase(),
  };
}

export const excelResolvers = {
  Query: {
    searchAttributes: async (_: unknown, args: { query: string; limit?: number }, context: Context) => {
      requireUser(context);
      const found = await fetchAttributeSearch(context.supabase, args.query, args.limit);
      return {
        attributes: found.attributes.map(mapAttributeHit),
        entityNames: found.entityNames.map(mapAttributeHit),
        entityTypes: found.entityTypes.map((hit) => ({
          domainCode: hit.domain_code,
          domainName: hit.domain_name,
          matchedAlias: hit.matched_alias,
        })),
      };
    },

    tapValues: async (
      _: unknown,
      args: { requests: TapRequest[]; knowledgeDate?: string | null },
      context: Context,
    ) => {
      requireUser(context);
      return resolveTapRequests(context.supabase as never, args.requests || [], args.knowledgeDate);
    },

    tapOverridePreview: async (_: unknown, args: { overrides: TapOverrideRequest[] }, context: Context) => {
      requireUser(context);
      return planTapOverrides(context.supabase, args.overrides || []);
    },
  },

  Mutation: {
    submitTapOverrides: async (
      _: unknown,
      args: { overrides: TapOverrideRequest[]; reason: string },
      context: Context,
    ) => {
      requireUser(context);
      return submitTapOverrides(context.supabase, args.overrides || [], args.reason, context.user?.id ?? null);
    },
  },
};
