import { entityResolvers } from './entity';
import { dataQualityResolvers } from './dataquality';
import { lineageResolvers } from './lineage';
import { metadataResolvers } from './metadata';
import { intersectionResolvers } from './intersection';
import { sourceResolvers } from './source';
import { dataConnectionResolvers } from './dataconnection';
import { importMapResolvers } from './importmap';
import { precedenceResolvers } from './precedence';
import { goldenSourceResolvers } from './goldensource';
import { tenancyResolvers } from './tenancy';
import { complianceResolvers } from './compliance';
import { referenceListResolvers } from './referencelist';
import { reportingResolvers } from './reporting';

export const resolvers = {
  Query: {
    ...entityResolvers.Query,
    ...dataQualityResolvers.Query,
    ...lineageResolvers.Query,
    ...intersectionResolvers.Query,
    ...sourceResolvers.Query,
    ...precedenceResolvers.Query,
    ...goldenSourceResolvers.Query,
    ...dataConnectionResolvers.Query,
    ...importMapResolvers.Query,
    ...tenancyResolvers.Query,
    ...complianceResolvers.Query,
    ...referenceListResolvers.Query,
    ...reportingResolvers.Query,
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
    ...sourceResolvers.Mutation,
    ...precedenceResolvers.Mutation,
    ...goldenSourceResolvers.Mutation,
    ...dataConnectionResolvers.Mutation,
    ...importMapResolvers.Mutation,
    ...tenancyResolvers.Mutation,
    ...complianceResolvers.Mutation,
    ...referenceListResolvers.Mutation,
    ...reportingResolvers.Mutation,
    updateAttributeDefinition: metadataResolvers.Mutation.updateAttributeDefinition,
    deleteAttribute: metadataResolvers.Mutation.deleteAttribute,
  },
  
  Subscription: {},
  
  Entity: entityResolvers.Entity,
  DataConnection: dataConnectionResolvers.DataConnection,
  ComplianceRule: complianceResolvers.ComplianceRule,
  ComplianceEvaluationRun: complianceResolvers.ComplianceEvaluationRun,
  AttributeDefinition: referenceListResolvers.AttributeDefinition,
};
