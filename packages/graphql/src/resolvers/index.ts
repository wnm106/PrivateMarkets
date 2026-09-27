import { entityResolvers } from './entity';
import { dataQualityResolvers } from './dataquality';
import { lineageResolvers } from './lineage';
import { metadataResolvers } from './metadata';
import { intersectionResolvers } from './intersection';
import { sourceResolvers } from './source';
import { dataConnectionResolvers } from './dataconnection';
import { importMapResolvers } from './importmap';

export const resolvers = {
  Query: {
    ...entityResolvers.Query,
    ...dataQualityResolvers.Query,
    ...lineageResolvers.Query,
    ...intersectionResolvers.Query,
    // Import sourceResolvers.Query as needed after schema updates
    // sourceResolvers.Query,
    // dataConnectionResolvers.Query,
    // importMapResolvers.Query,
    // Only attributeRegister/domainTemplates are declared in the schema today.
    // The rest of metadataResolvers.Query (derivedAttributes, evaluateDerivedAttribute,
    // evaluateDerivedAttributesBatch) depends on the derived-attributes migration
    // (supabase/migrations/00011_derived_attributes.sql) which hasn't been applied yet,
    // and isn't exposed in typeDefs.ts, so it's intentionally left out here.
    attributeRegister: metadataResolvers.Query.attributeRegister,
    domainTemplates: metadataResolvers.Query.domainTemplates,
  },
  
  Mutation: {
    ...entityResolvers.Mutation,
    ...dataQualityResolvers.Mutation,
    ...lineageResolvers.Mutation,
    ...intersectionResolvers.Mutation,
    // Import sourceResolvers.Mutation as needed after schema updates
    // sourceResolvers.Mutation,
    // dataConnectionResolvers.Mutation,
    // importMapResolvers.Mutation,
    updateAttributeDefinition: metadataResolvers.Mutation.updateAttributeDefinition,
  },
  
  Subscription: {},
  
  Entity: entityResolvers.Entity,
  // DataConnection: dataConnectionResolvers.DataConnection,
};
