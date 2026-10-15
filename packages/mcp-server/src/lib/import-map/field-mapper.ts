/**
 * AI-Assisted Field Mapping Recommendation System
 * Maps incoming data fields to MDM entity attributes using semantic similarity and heuristics
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { ParsedField } from './data-parsers';

export interface FieldMapping {
  sourceField: string;
  targetAttribute: string;
  confidence: number;
  mappingType: 'exact' | 'semantic' | 'pattern' | 'manual';
  notes?: string;
}

export interface MappingRecommendation {
  domainCode: string;
  templateCode?: string;
  mappings: FieldMapping[];
  unmappedSourceFields: string[];
  unmappedTargetAttributes: string[];
  identifierMappings: FieldMapping[];
  warnings: string[];
}

export interface AttributeMetadata {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description?: string;
  isRequired: boolean;
  referenceDomainCode?: string;
  listValues?: string[];
  aliasLabels?: string[];
}

/**
 * Generate field mapping recommendations for a data source
 */
export async function recommendFieldMappings(
  sourceFields: ParsedField[],
  targetDomainCode: string,
  supabase: SupabaseClient,
  options?: {
    templateCode?: string;
    existingMappings?: FieldMapping[];
  }
): Promise<MappingRecommendation> {
  // Fetch target attribute metadata
  const targetAttributes = await fetchTargetAttributes(
    targetDomainCode,
    options?.templateCode,
    supabase
  );

  // Fetch identifier definitions for this domain
  const identifiers = await fetchIdentifierDefinitions(targetDomainCode, supabase);

  // Generate mappings
  const mappings: FieldMapping[] = [];
  const unmappedSourceFields = new Set(sourceFields.map(f => f.name));
  const unmappedTargetAttributes = new Set(targetAttributes.map(a => a.attributeCode));

  // Use existing mappings if provided
  if (options?.existingMappings) {
    for (const mapping of options.existingMappings) {
      mappings.push(mapping);
      unmappedSourceFields.delete(mapping.sourceField);
      unmappedTargetAttributes.delete(mapping.targetAttribute);
    }
  }

  // Generate new mappings for unmapped fields
  const unmappedSourceFieldObjects = sourceFields.filter(f => unmappedSourceFields.has(f.name));
  const unmappedTargetAttributeObjects = targetAttributes.filter(a => unmappedTargetAttributes.has(a.attributeCode));

  for (const sourceField of unmappedSourceFieldObjects) {
    const bestMatch = findBestMatch(sourceField, unmappedTargetAttributeObjects);
    
    if (bestMatch && bestMatch.confidence >= 0.6) {
      mappings.push(bestMatch.mapping);
      unmappedSourceFields.delete(sourceField.name);
      unmappedTargetAttributes.delete(bestMatch.mapping.targetAttribute);
    }
  }

  // Identify identifier mappings
  const identifierMappings = identifyIdentifierMappings(mappings, identifiers, sourceFields);

  // Generate warnings
  const warnings = generateWarnings(
    mappings,
    identifiers,
    unmappedTargetAttributes,
    targetAttributes
  );

  return {
    domainCode: targetDomainCode,
    templateCode: options?.templateCode,
    mappings,
    unmappedSourceFields: Array.from(unmappedSourceFields),
    unmappedTargetAttributes: Array.from(unmappedTargetAttributes),
    identifierMappings,
    warnings,
  };
}

/**
 * Fetch target attributes for a domain/template
 */
async function fetchTargetAttributes(
  domainCode: string,
  templateCode: string | undefined,
  supabase: SupabaseClient
): Promise<AttributeMetadata[]> {
  let query = supabase
    .from('attribute_register')
    .select(`
      id,
      attribute_code,
      attribute_name,
      data_type,
      description,
      is_required,
      reference_domain_code,
      list_values
    `)
    .eq('reference_domain_code', domainCode);

  // If template specified, only get attributes assigned to that template
  if (templateCode) {
    const { data: template } = await supabase
      .from('domain_templates')
      .select('id, template_attribute_assignments(attribute_id)')
      .eq('template_code', templateCode)
      .single();

    if (template) {
      const attributeIds = template.template_attribute_assignments.map(
        (ta: any) => ta.attribute_id
      );
      query = query.in('id', attributeIds);
    }
  }

  const { data, error } = await query;

  if (error) throw error;

  const aliasLabels = await loadAliasLabels(supabase, (data || []).map((attr: any) => attr.id));

  return (data || []).map((attr: any) => ({
    attributeCode: attr.attribute_code,
    attributeName: attr.attribute_name,
    dataType: attr.data_type,
    description: attr.description,
    isRequired: attr.is_required,
    referenceDomainCode: attr.reference_domain_code,
    listValues: attr.list_values,
    aliasLabels: aliasLabels.get(attr.id) || [],
  }));
}

async function loadAliasLabels(supabase: SupabaseClient, attributeIds: string[]): Promise<Map<string, string[]>> {
  const labels = new Map<string, string[]>();
  const ids = attributeIds.filter(Boolean);
  if (ids.length === 0) return labels;
  const { data, error } = await supabase
    .from('attribute_aliases')
    .select('attribute_id, alias_label, is_active')
    .eq('is_active', true)
    .in('attribute_id', ids);
  if (error) return labels;
  for (const alias of data || []) {
    const list = labels.get(alias.attribute_id) || [];
    list.push(alias.alias_label);
    labels.set(alias.attribute_id, list);
  }
  return labels;
}

function matchesStoredAlias(sourceName: string, aliasLabels?: string[]): boolean {
  if (!aliasLabels?.length) return false;
  const source = normalizeFieldName(sourceName);
  return aliasLabels.some((alias) => normalizeFieldName(alias) === source);
}

/**
 * Fetch identifier definitions for a domain
 */
async function fetchIdentifierDefinitions(
  domainCode: string,
  supabase: SupabaseClient
): Promise<{ identifierCode: string; attributeCodes: string[]; isPrimary: boolean }[]> {
  const { data, error } = await supabase
    .from('entity_identifier_definitions')
    .select('identifier_code, attribute_codes, is_primary')
    .eq('domain_code', domainCode)
    .eq('is_active', true);

  if (error) throw error;

  return (data || []).map((id: any) => ({
    identifierCode: id.identifier_code,
    attributeCodes: id.attribute_codes,
    isPrimary: id.is_primary,
  }));
}

/**
 * Find best matching target attribute for a source field
 */
function findBestMatch(
  sourceField: ParsedField,
  targetAttributes: AttributeMetadata[]
): { mapping: FieldMapping; confidence: number } | null {
  let bestMatch: { mapping: FieldMapping; confidence: number } | null = null;

  for (const targetAttr of targetAttributes) {
    const confidence = calculateMappingConfidence(sourceField, targetAttr);
    
    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        mapping: {
          sourceField: sourceField.name,
          targetAttribute: targetAttr.attributeCode,
          confidence,
          mappingType: determineMappingType(sourceField, targetAttr),
          notes: generateMappingNotes(sourceField, targetAttr, confidence),
        },
        confidence,
      };
    }
  }

  return bestMatch;
}

/**
 * Calculate confidence score for a potential mapping
 */
function calculateMappingConfidence(
  sourceField: ParsedField,
  targetAttr: AttributeMetadata
): number {
  let score = 0;

  // 1. Exact name match (highest confidence)
  const sourceNormalized = normalizeFieldName(sourceField.name);
  const targetNormalized = normalizeFieldName(targetAttr.attributeCode);
  const targetNameNormalized = normalizeFieldName(targetAttr.attributeName);

  if (sourceNormalized === targetNormalized) {
    score += 0.5;
  } else if (sourceNormalized === targetNameNormalized) {
    score += 0.45;
  } else if (matchesStoredAlias(sourceField.name, targetAttr.aliasLabels)) {
    score = Math.max(score, 0.93);
  }

  // 2. Semantic similarity (substring, contains, etc.)
  if (sourceNormalized.includes(targetNormalized) || targetNormalized.includes(sourceNormalized)) {
    score += 0.3;
  }

  // 3. Common abbreviations and synonyms
  const synonymScore = checkSynonyms(sourceField.name, targetAttr.attributeCode);
  score += synonymScore * 0.3;

  // 4. Data type compatibility
  if (isDataTypeCompatible(sourceField.type, targetAttr.dataType)) {
    score += 0.1;
  }

  // 5. Pattern matching (e.g., ISIN, CUSIP, LEI patterns)
  const patternScore = checkIdentifierPatterns(sourceField);
  if (patternScore && targetAttr.attributeCode.toLowerCase().includes(patternScore.toLowerCase())) {
    score += 0.2;
  }

  // 6. List value overlap
  if (targetAttr.listValues && sourceField.uniqueValues) {
    const overlap = calculateListOverlap(sourceField.uniqueValues, targetAttr.listValues);
    score += overlap * 0.15;
  }

  return Math.min(score, 1.0);
}

/**
 * Normalize field name for comparison
 */
function normalizeFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\-\s]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Check for common synonyms and abbreviations
 */
function checkSynonyms(sourceName: string, targetCode: string): number {
  const synonyms: Record<string, string[]> = {
    'name': ['title', 'label', 'description'],
    'code': ['id', 'identifier', 'key', 'symbol'],
    'date': ['dt', 'day', 'timestamp'],
    'value': ['amount', 'price', 'rate', 'quantity'],
    'type': ['kind', 'category', 'class'],
    'status': ['state', 'condition'],
    'country': ['nation', 'domicile'],
    'currency': ['ccy', 'curr'],
    'isin': ['international securities identification number'],
    'cusip': ['committee on uniform securities identification'],
    'lei': ['legal entity identifier'],
  };

  const sourceLower = sourceName.toLowerCase();
  const targetLower = targetCode.toLowerCase();

  for (const [key, values] of Object.entries(synonyms)) {
    if (
      (sourceLower.includes(key) && values.some(v => targetLower.includes(v))) ||
      (targetLower.includes(key) && values.some(v => sourceLower.includes(v)))
    ) {
      return 1;
    }
  }

  return 0;
}

/**
 * Check if data types are compatible
 */
function isDataTypeCompatible(sourceType: string, targetType: string): boolean {
  const typeMap: Record<string, string[]> = {
    'string': ['STRING', 'JSON'],
    'number': ['NUMBER'],
    'date': ['DATE', 'TIMESTAMP'],
    'boolean': ['BOOLEAN'],
  };

  const compatibleTypes = typeMap[sourceType] || [];
  return compatibleTypes.includes(targetType);
}

/**
 * Check for identifier patterns in field names
 */
function checkIdentifierPatterns(field: ParsedField): string {
  const patterns: Record<string, RegExp> = {
    'isin': /\b(isin|international securities)\b/i,
    'cusip': /\b(cusip|committee on uniform)\b/i,
    'sedol': /\b(sedol)\b/i,
    'ticker': /\b(ticker|symbol)\b/i,
    'lei': /\b(lei|legal entity)\b/i,
  };

  for (const [code, pattern] of Object.entries(patterns)) {
    if (pattern.test(field.name)) {
      return code;
    }
  }

  return '';
}

/**
 * Calculate overlap between two lists of values
 */
function calculateListOverlap(sourceValues: any[], targetValues: string[]): number {
  const sourceSet = new Set(sourceValues.map(v => String(v).toLowerCase()));
  const targetSet = new Set(targetValues.map(v => v.toLowerCase()));
  
  let overlap = 0;
  sourceSet.forEach(v => {
    if (targetSet.has(v)) overlap++;
  });

  return overlap / Math.max(sourceSet.size, targetSet.size);
}

/**
 * Determine mapping type based on matching method
 */
function determineMappingType(sourceField: ParsedField, targetAttr: AttributeMetadata): FieldMapping['mappingType'] {
  const sourceNormalized = normalizeFieldName(sourceField.name);
  const targetNormalized = normalizeFieldName(targetAttr.attributeCode);

  if (sourceNormalized === targetNormalized) {
    return 'exact';
  }

  if (matchesStoredAlias(sourceField.name, targetAttr.aliasLabels)) {
    return 'semantic';
  }

  if (sourceNormalized.includes(targetNormalized) || targetNormalized.includes(sourceNormalized)) {
    return 'pattern';
  }

  return 'semantic';
}

/**
 * Generate notes explaining the mapping
 */
function generateMappingNotes(
  sourceField: ParsedField,
  targetAttr: AttributeMetadata,
  confidence: number
): string {
  const notes: string[] = [];

  if (matchesStoredAlias(sourceField.name, targetAttr.aliasLabels)) {
    notes.push('Matched a stored attribute alias');
  }

  if (confidence >= 0.9) {
    notes.push('High confidence match');
  } else if (confidence >= 0.7) {
    notes.push('Good match');
  } else {
    notes.push('Moderate confidence - review recommended');
  }

  if (sourceField.type !== targetAttr.dataType.toLowerCase()) {
    notes.push(`Type conversion: ${sourceField.type} → ${targetAttr.dataType}`);
  }

  if (targetAttr.isRequired) {
    notes.push('Required field');
  }

  return notes.join('. ');
}

/**
 * Identify which mappings correspond to entity identifiers
 */
function identifyIdentifierMappings(
  mappings: FieldMapping[],
  identifiers: { identifierCode: string; attributeCodes: string[]; isPrimary: boolean }[],
  sourceFields: ParsedField[]
): FieldMapping[] {
  const identifierMappings: FieldMapping[] = [];

  for (const identifier of identifiers) {
    for (const attrCode of identifier.attributeCodes) {
      const mapping = mappings.find(m => m.targetAttribute === attrCode);
      if (mapping) {
        identifierMappings.push({
          ...mapping,
          notes: `${mapping.notes || ''} [Identifier: ${identifier.identifierCode}${identifier.isPrimary ? ' (Primary)' : ''}]`,
        });
      }
    }
  }

  return identifierMappings;
}

/**
 * Generate warnings about the mapping
 */
function generateWarnings(
  mappings: FieldMapping[],
  identifiers: { identifierCode: string; attributeCodes: string[]; isPrimary: boolean }[],
  unmappedTargetAttributes: Set<string>,
  targetAttributes: AttributeMetadata[]
): string[] {
  const warnings: string[] = [];

  // Check for unmapped required attributes
  const mappedTargetCodes = new Set(mappings.map(m => m.targetAttribute));
  for (const attr of targetAttributes) {
    if (attr.isRequired && !mappedTargetCodes.has(attr.attributeCode)) {
      warnings.push(`Required attribute "${attr.attributeName}" (${attr.attributeCode}) is not mapped`);
    }
  }

  // Check for unmapped primary identifiers
  for (const identifier of identifiers) {
    if (identifier.isPrimary) {
      const hasIdentifier = identifier.attributeCodes.some(code => mappedTargetCodes.has(code));
      if (!hasIdentifier) {
        warnings.push(`Primary identifier "${identifier.identifierCode}" is not mapped`);
      }
    }
  }

  // Check for low confidence mappings
  const lowConfidenceMappings = mappings.filter(m => m.confidence < 0.7);
  if (lowConfidenceMappings.length > 0) {
    warnings.push(`${lowConfidenceMappings.length} mapping(s) have low confidence (< 0.7) - review recommended`);
  }

  return warnings;
}
