/**
 * Import Map Orchestrator
 * Coordinates data parsing, field mapping, validation, and import execution
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { parseData, ParsedData } from './data-parsers';
import { recommendFieldMappings, MappingRecommendation, FieldMapping } from './field-mapper';
import { validateIdentifierMappings, validateIdentifierValues, IdentifierValidationResult } from './identifier-validator';
import { generateImportPlan, validateImportPlan, planToBatches, ImportPlan, ImportBatch } from './relationship-analyzer';

export interface ImportMap {
  id?: string;
  name: string;
  description?: string;
  sourceFormat: 'xlsx' | 'csv' | 'json' | 'html' | 'xml';
  sourceData: Buffer | string;
  domainMappings: DomainImportMapping[];
  options?: ImportOptions;
}

export interface DomainImportMapping {
  domainCode: string;
  templateCode?: string;
  fieldMappings: FieldMapping[];
  relationshipMappings?: RelationshipMapping[];
}

export interface RelationshipMapping {
  relationshipCode: string;
  parentDomainCode: string;
  childDomainCode: string;
  parentKeyField: string;
  childKeyField: string;
}

export interface ImportOptions {
  dryRun?: boolean;
  batchSize?: number;
  skipValidation?: boolean;
  continueOnError?: boolean;
}

export interface ImportMapAnalysis {
  parsedData: ParsedData;
  recommendations: MappingRecommendation[];
  identifierValidations: IdentifierValidationResult[];
  importPlan?: ImportPlan;
  importBatches?: ImportBatch[];
  overallValidation: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
}

export interface ImportExecutionResult {
  success: boolean;
  importMapId: string;
  executionId: string;
  results: DomainImportResult[];
  summary: {
    totalDomains: number;
    successfulDomains: number;
    failedDomains: number;
    totalRecords: number;
    successfulRecords: number;
    failedRecords: number;
    duration: number;
  };
  errors: string[];
}

export interface DomainImportResult {
  domainCode: string;
  success: boolean;
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsFailed: number;
  errors: string[];
  duration: number;
}

/**
 * Analyze an import map without executing it
 */
export async function analyzeImportMap(
  importMap: ImportMap,
  supabase: SupabaseClient
): Promise<ImportMapAnalysis> {
  const startTime = Date.now();

  // 1. Parse the source data
  const parsedData = await parseData(
    importMap.sourceData,
    importMap.sourceFormat,
    importMap.options
  );

  // 2. Generate field mapping recommendations for each domain
  const recommendations: MappingRecommendation[] = [];
  for (const domainMapping of importMap.domainMappings) {
    const recommendation = await recommendFieldMappings(
      parsedData.fields,
      domainMapping.domainCode,
      supabase,
      {
        templateCode: domainMapping.templateCode,
        existingMappings: domainMapping.fieldMappings,
      }
    );
    recommendations.push(recommendation);
  }

  // 3. Validate identifier mappings
  const identifierValidations: IdentifierValidationResult[] = [];
  for (const domainMapping of importMap.domainMappings) {
    const recommendation = recommendations.find(r => r.domainCode === domainMapping.domainCode);
    if (recommendation) {
      const validation = await validateIdentifierMappings(
        domainMapping.domainCode,
        recommendation.mappings,
        supabase
      );
      identifierValidations.push(validation);
    }
  }

  // 4. Generate import plan if multiple domains
  let importPlan: ImportPlan | undefined;
  let importBatches: ImportBatch[] | undefined;

  if (importMap.domainMappings.length > 1) {
    const domainCodes = importMap.domainMappings.map(d => d.domainCode);
    importPlan = await generateImportPlan(domainCodes, supabase);
    importBatches = planToBatches(importPlan);
  }

  // 5. Overall validation
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Collect identifier validation errors
  for (const validation of identifierValidations) {
    allErrors.push(...validation.criticalErrors);
    allWarnings.push(...validation.warnings);
  }

  // Validate import plan if present
  if (importPlan) {
    const planValidation = validateImportPlan(importPlan);
    allErrors.push(...planValidation.errors);
    allWarnings.push(...planValidation.warnings);
  }

  // Check for unmapped required fields
  for (const recommendation of recommendations) {
    if (recommendation.unmappedTargetAttributes.length > 0) {
      allWarnings.push(
        `Domain ${recommendation.domainCode}: ${recommendation.unmappedTargetAttributes.length} target attribute(s) not mapped`
      );
    }
  }

  const overallValidation = {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };

  return {
    parsedData,
    recommendations,
    identifierValidations,
    importPlan,
    importBatches,
    overallValidation,
  };
}

/**
 * Execute an import map
 */
export async function executeImportMap(
  importMap: ImportMap,
  supabase: SupabaseClient,
  userId?: string
): Promise<ImportExecutionResult> {
  const startTime = Date.now();
  const executionId = generateExecutionId();
  const importMapId = importMap.id || generateImportMapId();

  // Analyze first
  const analysis = await analyzeImportMap(importMap, supabase);

  // Check if validation passes
  if (!analysis.overallValidation.isValid && !importMap.options?.skipValidation) {
    return {
      success: false,
      importMapId,
      executionId,
      results: [],
      summary: {
        totalDomains: 0,
        successfulDomains: 0,
        failedDomains: 0,
        totalRecords: 0,
        successfulRecords: 0,
        failedRecords: 0,
        duration: Date.now() - startTime,
      },
      errors: analysis.overallValidation.errors,
    };
  }

  // Determine import order
  const domainOrder = analysis.importPlan?.importOrder || importMap.domainMappings.map(d => d.domainCode);

  // Execute imports in order
  const results: DomainImportResult[] = [];
  const allErrors: string[] = [];
  let totalRecords = 0;
  let successfulRecords = 0;
  let failedRecords = 0;

  for (const domainCode of domainOrder) {
    const domainMapping = importMap.domainMappings.find(d => d.domainCode === domainCode);
    if (!domainMapping) continue;

    const recommendation = analysis.recommendations.find(r => r.domainCode === domainCode);
    if (!recommendation) continue;

    const domainStartTime = Date.now();

    try {
      // Validate identifier values in the data
      if (!importMap.options?.skipValidation) {
        const identifierValidation = await validateIdentifierValues(
          domainCode,
          analysis.parsedData.records,
          recommendation.mappings,
          supabase
        );

        if (!identifierValidation.isValid) {
          allErrors.push(...identifierValidation.errors);
          if (!importMap.options?.continueOnError) {
            results.push({
              domainCode,
              success: false,
              recordsProcessed: 0,
              recordsCreated: 0,
              recordsUpdated: 0,
              recordsFailed: analysis.parsedData.records.length,
              errors: identifierValidation.errors,
              duration: Date.now() - domainStartTime,
            });
            continue;
          }
        }
      }

      // Import records
      const domainResult = await importDomainRecords(
        domainCode,
        analysis.parsedData.records,
        recommendation.mappings,
        domainMapping.relationshipMappings,
        supabase,
        userId,
        importMap.options
      );

      results.push(domainResult);
      totalRecords += domainResult.recordsProcessed;
      successfulRecords += domainResult.recordsCreated + domainResult.recordsUpdated;
      failedRecords += domainResult.recordsFailed;

      if (!domainResult.success) {
        allErrors.push(...domainResult.errors);
      }
    } catch (error: any) {
      const errorMessage = `Failed to import ${domainCode}: ${error.message}`;
      allErrors.push(errorMessage);
      
      results.push({
        domainCode,
        success: false,
        recordsProcessed: 0,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsFailed: analysis.parsedData.records.length,
        errors: [errorMessage],
        duration: Date.now() - domainStartTime,
      });

      if (!importMap.options?.continueOnError) {
        break;
      }
    }
  }

  const successfulDomains = results.filter(r => r.success).length;
  const failedDomains = results.filter(r => !r.success).length;

  return {
    success: failedDomains === 0,
    importMapId,
    executionId,
    results,
    summary: {
      totalDomains: results.length,
      successfulDomains,
      failedDomains,
      totalRecords,
      successfulRecords,
      failedRecords,
      duration: Date.now() - startTime,
    },
    errors: allErrors,
  };
}

/**
 * Import records for a single domain
 */
async function importDomainRecords(
  domainCode: string,
  records: Record<string, any>[],
  mappings: FieldMapping[],
  relationshipMappings: RelationshipMapping[] | undefined,
  supabase: SupabaseClient,
  userId?: string,
  options?: ImportOptions
): Promise<DomainImportResult> {
  const startTime = Date.now();
  let recordsCreated = 0;
  let recordsUpdated = 0;
  let recordsFailed = 0;
  const errors: string[] = [];

  const batchSize = options?.batchSize || 100;

  // Process in batches
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    for (const record of batch) {
      try {
        // Map source fields to target attributes
        const attributes: Record<string, any> = {};
        for (const mapping of mappings) {
          const value = record[mapping.sourceField];
          if (value !== null && value !== undefined && value !== '') {
            attributes[mapping.targetAttribute] = value;
          }
        }

        // Generate entity code from identifier attributes
        const entityCode = generateEntityCode(domainCode, attributes, mappings);
        const entityName = attributes['name'] || attributes['entity_name'] || entityCode;

        // Check if entity already exists
        const { data: existing } = await supabase
          .from('master_entities')
          .select('id')
          .eq('entity_code', entityCode)
          .eq('domain_code', domainCode)
          .maybeSingle();

        if (existing) {
          // Update existing entity
          await updateEntityAttributes(existing.id, attributes, supabase, userId);
          recordsUpdated++;
        } else {
          // Create new entity
          const { data: entity, error: entityError } = await supabase
            .from('master_entities')
            .insert({
              entity_code: entityCode,
              entity_name: entityName,
              domain_code: domainCode,
              created_by: userId,
            })
            .select()
            .single();

          if (entityError) throw entityError;

          // Insert attributes
          await insertEntityAttributes(entity.id, attributes, supabase, userId);

          // Insert relationships if defined
          if (relationshipMappings && relationshipMappings.length > 0) {
            await insertEntityRelationships(entity.id, record, relationshipMappings, supabase);
          }

          recordsCreated++;
        }
      } catch (error: any) {
        recordsFailed++;
        if (options?.continueOnError) {
          errors.push(`Record ${i}: ${error.message}`);
        } else {
          throw error;
        }
      }
    }
  }

  return {
    domainCode,
    success: recordsFailed === 0,
    recordsProcessed: records.length,
    recordsCreated,
    recordsUpdated,
    recordsFailed,
    errors,
    duration: Date.now() - startTime,
  };
}

/**
 * Generate entity code from identifier attributes
 */
function generateEntityCode(
  domainCode: string,
  attributes: Record<string, any>,
  mappings: FieldMapping[]
): string {
  // Try to use common identifier fields
  const identifierFields = ['isin', 'cusip', 'lei', 'ticker', 'id', 'code'];
  
  for (const field of identifierFields) {
    if (attributes[field]) {
      return `${domainCode}-${String(attributes[field]).toUpperCase()}`;
    }
  }

  // Fallback: use first mapped attribute or generate UUID
  const firstMapping = mappings[0];
  if (firstMapping && attributes[firstMapping.targetAttribute]) {
    return `${domainCode}-${String(attributes[firstMapping.targetAttribute]).substring(0, 20).toUpperCase()}`;
  }

  return `${domainCode}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Insert entity attributes
 */
async function insertEntityAttributes(
  entityId: string,
  attributes: Record<string, any>,
  supabase: SupabaseClient,
  userId?: string
): Promise<void> {
  for (const [attrCode, value] of Object.entries(attributes)) {
    const { data: attr } = await supabase
      .from('attribute_register')
      .select('id, default_precedence_rank')
      .eq('attribute_code', attrCode)
      .single();

    if (attr) {
      const { data: source } = await supabase
        .from('source_registry')
        .select('id')
        .eq('source_code', 'IMPORT')
        .maybeSingle();

      await supabase.from('entity_attribute_values').insert({
        entity_id: entityId,
        attribute_id: attr.id,
        source_id: source?.id,
        golden_value: typeof value === 'string' ? value : null,
        golden_value_numeric: typeof value === 'number' ? value : null,
        golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
        valid_from: new Date().toISOString().split('T')[0],
        precedence_rank: attr.default_precedence_rank,
        created_by: userId,
      });
    }
  }
}

/**
 * Update entity attributes (bi-temporal)
 */
async function updateEntityAttributes(
  entityId: string,
  attributes: Record<string, any>,
  supabase: SupabaseClient,
  userId?: string
): Promise<void> {
  for (const [attrCode, value] of Object.entries(attributes)) {
    const { data: attr } = await supabase
      .from('attribute_register')
      .select('id, default_precedence_rank')
      .eq('attribute_code', attrCode)
      .single();

    if (attr) {
      // Close existing record
      await supabase
        .from('entity_attribute_values')
        .update({
          valid_to: new Date().toISOString().split('T')[0],
          system_to: new Date().toISOString(),
        })
        .eq('entity_id', entityId)
        .eq('attribute_id', attr.id)
        .eq('system_to', '9999-12-31 23:59:59');

      // Insert new record
      const { data: source } = await supabase
        .from('source_registry')
        .select('id')
        .eq('source_code', 'IMPORT')
        .maybeSingle();

      await supabase.from('entity_attribute_values').insert({
        entity_id: entityId,
        attribute_id: attr.id,
        source_id: source?.id,
        golden_value: typeof value === 'string' ? value : null,
        golden_value_numeric: typeof value === 'number' ? value : null,
        golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
        valid_from: new Date().toISOString().split('T')[0],
        precedence_rank: attr.default_precedence_rank,
        created_by: userId,
      });
    }
  }
}

/**
 * Insert entity relationships
 */
async function insertEntityRelationships(
  entityId: string,
  record: Record<string, any>,
  relationshipMappings: RelationshipMapping[],
  supabase: SupabaseClient
): Promise<void> {
  for (const relMapping of relationshipMappings) {
    const parentKeyValue = record[relMapping.parentKeyField];
    if (!parentKeyValue) continue;

    // Find parent entity by key
    const { data: parentEntity } = await supabase
      .from('master_entities')
      .select('id')
      .eq('domain_code', relMapping.parentDomainCode)
      .eq('entity_code', `${relMapping.parentDomainCode}-${String(parentKeyValue).toUpperCase()}`)
      .maybeSingle();

    if (parentEntity) {
      await supabase.from('entity_relationships').insert({
        parent_entity_id: parentEntity.id,
        child_entity_id: entityId,
        relationship_type: relMapping.relationshipCode,
        relationship_code: relMapping.relationshipCode,
        is_primary: true,
        valid_from: new Date().toISOString().split('T')[0],
      });
    }
  }
}

/**
 * Generate unique execution ID
 */
function generateExecutionId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Generate unique import map ID
 */
function generateImportMapId(): string {
  return `imp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}
