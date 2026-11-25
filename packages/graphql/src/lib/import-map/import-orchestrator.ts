/**
 * Import Map Orchestrator
 * Coordinates data parsing, field mapping, validation, and import execution
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { parseData, ParsedData } from './data-parsers';
import { saveEntityAliases, takeIdentityTargets } from '../semantic-aliases';
import { recommendFieldMappings, MappingRecommendation, FieldMapping } from './field-mapper';
import { validateIdentifierMappings, validateIdentifierValues, IdentifierValidationResult } from './identifier-validator';
import { generateImportPlan, validateImportPlan, planToBatches, ImportPlan, ImportBatch } from './relationship-analyzer';
import { writeGoldenValue } from '../golden-write';
import { DbError } from '../db-result';
import { RequiredParentError, loadRequiredParentRules, requiredParentMessage, unmetRequiredParents } from '../required-parents';

export interface ImportMap {
  id?: string;
  name: string;
  description?: string;
  sourceFormat: 'xlsx' | 'csv' | 'json' | 'html' | 'xml' | 'pdf' | 'auto';
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
  // Parsing options (passed to data parsers)
  sheetName?: string;
  delimiter?: string;
  tableSelector?: string;
  rootElement?: string;
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
  const parseOptions = importMap.options
    ? {
        sheetName: importMap.options.sheetName,
        delimiter: importMap.options.delimiter,
        tableSelector: importMap.options.tableSelector,
        rootElement: importMap.options.rootElement,
      }
    : undefined;
  
  const parsedData = await parseData(
    importMap.sourceData,
    importMap.sourceFormat,
    parseOptions
  );

  const domainMappings: DomainImportMapping[] = importMap.domainMappings.length > 0
    ? importMap.domainMappings
    : (parsedData.suggestedDomains || []).map((domainCode) => ({ domainCode, fieldMappings: [] }));

  // 2. Generate field mapping recommendations for each domain
  const recommendations: MappingRecommendation[] = [];
  for (const domainMapping of domainMappings) {
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
  for (const domainMapping of domainMappings) {
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

  if (domainMappings.length > 1) {
    const domainCodes = domainMappings.map(d => d.domainCode);
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
 * Execute an import map into one client.
 *
 * clientId is the client the records belong to. Codes are unique per client, so
 * every create carries it and every lookup by code reads only that client's
 * records. The caller resolves it (resolveEntityClientId, or the MCP session's
 * one client); the importer never guesses it.
 */
export async function executeImportMap(
  importMap: ImportMap,
  supabase: SupabaseClient,
  clientId: string,
  userId?: string
): Promise<ImportExecutionResult> {
  if (!clientId) throw new Error('Choose the client these records are for before importing.');
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
        clientId,
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
  clientId: string,
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

    // The parents this entity type must have. A row that cannot be linked to one is not created.
    const requiredParents = await loadRequiredParentRules(supabase, domainCode);
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
        const identity = takeIdentityTargets(attributes);

        // Generate entity code from identifier attributes
        const entityCode = generateEntityCode(domainCode, identity.attributes, mappings);
        const entityName = identity.entityName || identity.attributes['name'] || entityCode;

        // Check if the entity already exists in this client. Another client may use the same code.
        const existing = await findEntityByCode(supabase, clientId, domainCode, entityCode);

        if (existing) {
          // Update existing entity
          await updateEntityAttributes(existing.id, identity.attributes, supabase, userId);
          await saveEntityAliases(supabase, existing.id, identity.aliases);
          recordsUpdated++;
        } else {
          // Find the row's parents before anything is written, so a row with no required
          // parent is refused instead of leaving a record with nothing above it.
          const parents = await resolveRecordParents(record, relationshipMappings || [], supabase, clientId);
          const unmet = unmetRequiredParents(requiredParents, parents.map((parent) => parent.domainCode), identity.attributes);
          if (unmet.length) {
            throw new RequiredParentError(`${entityCode} was not created. ${requiredParentMessage(domainCode, unmet)} Map a column to it, and load it first.`, unmet);
          }

          // Create new entity
          const { data: entity, error: entityError } = await supabase
            .from('master_entities')
            .insert({
              entity_code: entityCode,
              entity_name: entityName,
              domain_code: domainCode,
              client_id: clientId,
              created_by: userId,
            })
            .select()
            .single();

          if (entityError) throw entityError;

          // Insert attributes
          await insertEntityAttributes(entity.id, identity.attributes, supabase, userId);
          await saveEntityAliases(supabase, entity.id, identity.aliases);

          // Insert relationships if defined
          await insertEntityRelationships(entity.id, parents, supabase);

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
 * Insert entity attributes with reference list normalization
 */
async function insertEntityAttributes(
  entityId: string,
  attributes: Record<string, any>,
  supabase: SupabaseClient,
  userId?: string
): Promise<{ normalized: number; unmapped: string[] }> {
  let normalizedCount = 0;
  const unmappedValues: string[] = [];

  // Pre-fetch attribute metadata including reference list codes
  const attrCodes = Object.keys(attributes);
  const { data: attrDefs, error: attrError } = await supabase
    .from('attribute_register')
    .select('attribute_code, id, default_precedence_rank, reference_list_code, data_type')
    .in('attribute_code', attrCodes);
  if (attrError) throw attrError;

  const attrMap = new Map((attrDefs || []).map((a: any) => [a.attribute_code, a]));

  const { data: source, error: sourceError } = await supabase
    .schema('entity_instances')
    .from('source_registry')
    .select('id')
    .eq('source_code', 'IMPORT')
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!source?.id) throw new Error('The IMPORT source is not registered.');

  for (const [attrCode, rawValue] of Object.entries(attributes)) {
    const attr = attrMap.get(attrCode);
    if (!attr) continue;

    let value = rawValue;

    // Normalize value against reference list if the attribute has one
    if (attr.reference_list_code && typeof rawValue === 'string' && rawValue.trim()) {
      const { data: normResult, error: normError } = await supabase
        .rpc('normalize_reference_value', {
          p_list_code: attr.reference_list_code,
          p_input_value: rawValue,
        });

      if (!normError && normResult) {
        const result = typeof normResult === 'string' ? JSON.parse(normResult) : normResult;
        if (result.normalized && result.canonical_code) {
          value = result.canonical_code;
          normalizedCount++;
        } else if (!result.normalized) {
          unmappedValues.push(`${attrCode}: "${rawValue}" → ${result.message || 'no match'}`);
          // Still insert the original value - it will be flagged for review
        }
      }
    }

    // A refused write must fail the record, not count it as created.
    const { error: insertError } = await supabase.from('entity_attribute_values').insert({
      entity_id: entityId,
      attribute_id: attr.id,
      source_id: source.id,
      golden_value: typeof value === 'string' ? value : null,
      golden_value_numeric: typeof value === 'number' ? value : null,
      golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
      valid_from: new Date().toISOString().split('T')[0],
      precedence_rank: attr.default_precedence_rank,
      created_by: userId,
    });
    if (insertError) throw insertError;
  }

  return { normalized: normalizedCount, unmapped: unmappedValues };
}

/**
 * Update entity attributes (bi-temporal) with reference list normalization
 */
export async function updateEntityAttributes(
  entityId: string,
  attributes: Record<string, any>,
  supabase: SupabaseClient,
  userId?: string
): Promise<{ normalized: number; unmapped: string[] }> {
  let normalizedCount = 0;
  const unmappedValues: string[] = [];

  // Pre-fetch attribute metadata including reference list codes
  const attrCodes = Object.keys(attributes);
  const { data: attrDefs, error: attrError } = await supabase
    .from('attribute_register')
    .select('attribute_code, id, default_precedence_rank, reference_list_code')
    .in('attribute_code', attrCodes);
  if (attrError) throw attrError;

  const attrMap = new Map((attrDefs || []).map((a: any) => [a.attribute_code, a]));

  const { data: source, error: sourceError } = await supabase
    .schema('entity_instances')
    .from('source_registry')
    .select('id')
    .eq('source_code', 'IMPORT')
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!source?.id) throw new Error('The IMPORT source is not registered.');

  for (const [attrCode, rawValue] of Object.entries(attributes)) {
    const attr = attrMap.get(attrCode);
    if (!attr) continue;

    let value = rawValue;

    // Normalize value against reference list if the attribute has one
    if (attr.reference_list_code && typeof rawValue === 'string' && rawValue.trim()) {
      const { data: normResult, error: normError } = await supabase
        .rpc('normalize_reference_value', {
          p_list_code: attr.reference_list_code,
          p_input_value: rawValue,
        });

      if (!normError && normResult) {
        const result = typeof normResult === 'string' ? JSON.parse(normResult) : normResult;
        if (result.normalized && result.canonical_code) {
          value = result.canonical_code;
          normalizedCount++;
        } else if (!result.normalized) {
          unmappedValues.push(`${attrCode}: "${rawValue}" → ${result.message || 'no match'}`);
        }
      }
    }

    // The imported value from today until this source's next later value; earlier dates
    // keep theirs. A refused write throws, so the record fails instead of counting as updated.
    await writeGoldenValue(supabase, {
      entityId,
      attributeId: attr.id,
      sourceId: source.id,
      validFrom: new Date().toISOString().split('T')[0],
      value: {
        golden_value: typeof value === 'string' ? value : null,
        golden_value_numeric: typeof value === 'number' ? value : null,
        golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
        precedence_rank: attr.default_precedence_rank,
      },
    });
  }

  return { normalized: normalizedCount, unmapped: unmappedValues };
}

/**
 * Insert entity relationships
 */
interface ResolvedParent {
  id: string;
  domainCode: string;
  relationshipCode: string;
}

/** The parent records a row names and that exist, one per relationship mapping. */
async function resolveRecordParents(
  record: Record<string, any>,
  relationshipMappings: RelationshipMapping[],
  supabase: SupabaseClient,
  clientId: string
): Promise<ResolvedParent[]> {
  const parents: ResolvedParent[] = [];
  for (const relMapping of relationshipMappings) {
    const parentKeyValue = record[relMapping.parentKeyField];
    if (!parentKeyValue) continue;

    // Find the parent by key, in the same client as the child.
    const parentEntity = await findEntityByCode(
      supabase,
      clientId,
      relMapping.parentDomainCode,
      `${relMapping.parentDomainCode}-${String(parentKeyValue).toUpperCase()}`
    );

    if (parentEntity) parents.push({ id: parentEntity.id, domainCode: relMapping.parentDomainCode, relationshipCode: relMapping.relationshipCode });
  }
  return parents;
}

/**
 * The record with this code in one client. Codes are unique per client
 * (UNIQUE (client_id, entity_code)), so the client filter is what makes this one row.
 *
 * Not maybeSingle(): for more than one row it answers PGRST116, which ok() reads as
 * "no row", and the importer would then create a duplicate. A failed read throws,
 * and so does a second match.
 */
export async function findEntityByCode(
  supabase: SupabaseClient,
  clientId: string,
  domainCode: string,
  entityCode: string
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('master_entities')
    .select('id')
    .eq('client_id', clientId)
    .eq('entity_code', entityCode)
    .eq('domain_code', domainCode)
    .limit(2);
  if (error) throw new DbError(error.code, error.message || 'The database refused the request.');
  const rows = (data || []) as { id: string }[];
  if (rows.length > 1) throw new Error(`More than one ${domainCode} record has the code ${entityCode} in this client. Nothing was written for it.`);
  return rows[0] ?? null;
}

async function insertEntityRelationships(
  entityId: string,
  parents: ResolvedParent[],
  supabase: SupabaseClient
): Promise<void> {
  for (const parent of parents) {
    const { error: relationshipError } = await supabase.from('entity_relationships').insert({
      parent_entity_id: parent.id,
      child_entity_id: entityId,
      relationship_type: parent.relationshipCode,
      relationship_code: parent.relationshipCode,
      is_primary: true,
      valid_from: new Date().toISOString().split('T')[0],
    });
    if (relationshipError) throw relationshipError;
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
