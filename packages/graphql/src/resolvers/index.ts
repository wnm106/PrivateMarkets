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
import { experienceResolvers } from './experience';
import { statementTemplateResolvers } from './statement-template';
import { displayLayoutResolvers } from './display-layout';
import { calculationResolvers } from './calculation';
import { reconciliationResolvers } from './reconciliation';
import { entityResolutionResolvers } from './entity-resolution';

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
    ...experienceResolvers.Query,
    ...displayLayoutResolvers.Query,
    ...calculationResolvers.Query,
    ...reconciliationResolvers.Query,
    // Only attributeRegister/domainTemplates are declared in the schema today.
    // The rest of metadataResolvers.Query (derivedAttributes, evaluateDerivedAttribute,
    // evaluateDerivedAttributesBatch) depends on the derived-attributes migration
    // (supabase/migrations/00011_derived_attributes.sql) which hasn't been applied yet,
    // and isn't exposed in typeDefs.ts, so it's intentionally left out here.
    attributeRegister: metadataResolvers.Query.attributeRegister,
    domainTemplates: metadataResolvers.Query.domainTemplates,
    previewStatementTemplate: statementTemplateResolvers.Query.previewStatementTemplate,
    matchRules: entityResolutionResolvers.Query.matchRules,
    mergeCandidates: entityResolutionResolvers.Query.mergeCandidates,
    mergePreview: entityResolutionResolvers.Query.mergePreview,
    entityGraph: entityResolutionResolvers.Query.entityGraph,
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
    ...displayLayoutResolvers.Mutation,
    ...calculationResolvers.Mutation,
    ...reconciliationResolvers.Mutation,
    updateAttributeDefinition: metadataResolvers.Mutation.updateAttributeDefinition,
    deleteAttribute: metadataResolvers.Mutation.deleteAttribute,
    applyStatementTemplate: statementTemplateResolvers.Mutation.applyStatementTemplate,
    mergeEntities: entityResolutionResolvers.Mutation.mergeEntities,
    updateMatchRule: entityResolutionResolvers.Mutation.updateMatchRule,
    createMatchRule: entityResolutionResolvers.Mutation.createMatchRule,
  },
  
  Subscription: {},
  
  Entity: {
    ...entityResolvers.Entity,
    ...calculationResolvers.Entity,
  },
  Template: statementTemplateResolvers.Template,
  DataConnection: dataConnectionResolvers.DataConnection,
  ComplianceRule: complianceResolvers.ComplianceRule,
  ComplianceEvaluationRun: complianceResolvers.ComplianceEvaluationRun,
  AttributeDefinition: referenceListResolvers.AttributeDefinition,
};
