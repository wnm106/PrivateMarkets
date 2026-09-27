/**
 * Entity Identifier Validation System
 * Ensures required entity identifiers are properly mapped before import
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { FieldMapping } from './field-mapper';

export interface IdentifierValidation {
  domainCode: string;
  identifierCode: string;
  identifierName: string;
  isPrimary: boolean;
  attributeCodes: string[];
  mappedAttributes: string[];
  unmappedAttributes: string[];
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface IdentifierValidationResult {
  domainCode: string;
  validations: IdentifierValidation[];
  hasPrimaryIdentifier: boolean;
  allIdentifiersValid: boolean;
  criticalErrors: string[];
  warnings: string[];
}

/**
 * Validate that entity identifiers are properly mapped
 */
export async function validateIdentifierMappings(
  domainCode: string,
  mappings: FieldMapping[],
  supabase: SupabaseClient
): Promise<IdentifierValidationResult> {
  // Fetch identifier definitions for this domain
  const identifierDefinitions = await fetchIdentifierDefinitions(domainCode, supabase);

  const validations: IdentifierValidation[] = [];
  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  // Map target attributes for quick lookup
  const mappedTargetAttributes = new Set(mappings.map(m => m.targetAttribute));

  // Validate each identifier definition
  for (const identifier of identifierDefinitions) {
    const mappedAttributes = identifier.attributeCodes.filter(code => 
      mappedTargetAttributes.has(code)
    );
    const unmappedAttributes = identifier.attributeCodes.filter(code => 
      !mappedTargetAttributes.has(code)
    );

    // An identifier is valid if ALL its component attributes are mapped
    const isValid = unmappedAttributes.length === 0;

    const errors: string[] = [];
    const identifierWarnings: string[] = [];

    if (!isValid) {
      if (identifier.isPrimary) {
        errors.push(
          `Primary identifier "${identifier.identifierName}" is incomplete. ` +
          `Missing attributes: ${unmappedAttributes.join(', ')}`
        );
      } else {
        identifierWarnings.push(
          `Secondary identifier "${identifier.identifierName}" is incomplete. ` +
          `Missing attributes: ${unmappedAttributes.join(', ')}`
        );
      }
    }

    // Check for composite identifiers (multiple attributes)
    if (identifier.attributeCodes.length > 1 && mappedAttributes.length > 0 && mappedAttributes.length < identifier.attributeCodes.length) {
      identifierWarnings.push(
        `Composite identifier "${identifier.identifierName}" is partially mapped. ` +
        `Mapped: ${mappedAttributes.join(', ')}. Missing: ${unmappedAttributes.join(', ')}`
      );
    }

    validations.push({
      domainCode,
      identifierCode: identifier.identifierCode,
      identifierName: identifier.identifierName,
      isPrimary: identifier.isPrimary,
      attributeCodes: identifier.attributeCodes,
      mappedAttributes,
      unmappedAttributes,
      isValid,
      errors,
      warnings: identifierWarnings,
    });

    // Collect errors and warnings
    criticalErrors.push(...errors);
    warnings.push(...identifierWarnings);
  }

  // Check if at least one primary identifier is fully mapped
  const primaryIdentifiers = validations.filter(v => v.isPrimary);
  const hasPrimaryIdentifier = primaryIdentifiers.some(v => v.isValid);

  if (!hasPrimaryIdentifier && primaryIdentifiers.length > 0) {
    criticalErrors.push(
      `No primary identifier is fully mapped for domain "${domainCode}". ` +
      `At least one primary identifier must be complete before import.`
    );
  }

  // Check if no identifiers are defined at all
  if (identifierDefinitions.length === 0) {
    warnings.push(
      `No identifier definitions found for domain "${domainCode}". ` +
      `Consider defining entity identifiers to ensure data integrity.`
    );
  }

  const allIdentifiersValid = validations.every(v => v.isValid);

  return {
    domainCode,
    validations,
    hasPrimaryIdentifier,
    allIdentifiersValid,
    criticalErrors,
    warnings,
  };
}

/**
 * Fetch identifier definitions for a domain
 */
async function fetchIdentifierDefinitions(
  domainCode: string,
  supabase: SupabaseClient
): Promise<{ identifierCode: string; identifierName: string; attributeCodes: string[]; isPrimary: boolean }[]> {
  const { data, error } = await supabase
    .from('entity_identifier_definitions')
    .select('identifier_code, identifier_name, attribute_codes, is_primary')
    .eq('domain_code', domainCode)
    .eq('is_active', true)
    .order('is_primary', { ascending: false });

  if (error) throw error;

  return (data || []).map((id: any) => ({
    identifierCode: id.identifier_code,
    identifierName: id.identifier_name,
    attributeCodes: id.attribute_codes,
    isPrimary: id.is_primary,
  }));
}

/**
 * Validate identifier values in the actual data records
 */
export async function validateIdentifierValues(
  domainCode: string,
  records: Record<string, any>[],
  mappings: FieldMapping[],
  supabase: SupabaseClient
): Promise<{
  isValid: boolean;
  errors: string[];
  warnings: string[];
  duplicateIdentifiers: Record<string, number>[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const duplicateIdentifiers: Record<string, number>[] = [];

  // Get identifier definitions
  const identifierDefinitions = await fetchIdentifierDefinitions(domainCode, supabase);
  const primaryIdentifiers = identifierDefinitions.filter(id => id.isPrimary);

  if (primaryIdentifiers.length === 0) {
    warnings.push(`No primary identifier defined for domain "${domainCode}"`);
    return { isValid: true, errors, warnings, duplicateIdentifiers };
  }

  // For each primary identifier, validate values
  for (const identifier of primaryIdentifiers) {
    // Build composite key from mapped attributes
    const identifierValues: Map<string, number> = new Map();

    for (const record of records) {
      const keyParts: string[] = [];
      let hasNullValue = false;

      for (const attrCode of identifier.attributeCodes) {
        const mapping = mappings.find(m => m.targetAttribute === attrCode);
        if (!mapping) {
          hasNullValue = true;
          break;
        }

        const value = record[mapping.sourceField];
        if (value === null || value === undefined || value === '') {
          hasNullValue = true;
          break;
        }

        keyParts.push(String(value));
      }

      if (hasNullValue) {
        continue; // Skip records with null identifier values
      }

      const compositeKey = keyParts.join('|');
      identifierValues.set(compositeKey, (identifierValues.get(compositeKey) || 0) + 1);
    }

    // Check for duplicates
    const duplicates = Array.from(identifierValues.entries())
      .filter(([_, count]) => count > 1)
      .map(([key, count]) => {
        const keyParts = key.split('|');
        const result: Record<string, number> = { count };
        identifier.attributeCodes.forEach((code, idx) => {
          result[code] = keyParts[idx] as any;
        });
        return result;
      });

    if (duplicates.length > 0) {
      duplicateIdentifiers.push(...duplicates);
      errors.push(
        `Found ${duplicates.length} duplicate identifier(s) for "${identifier.identifierName}" in ${domainCode} data`
      );
    }

    // Check for null/empty identifier values
    const nullCount = records.filter(record => {
      return identifier.attributeCodes.some(attrCode => {
        const mapping = mappings.find(m => m.targetAttribute === attrCode);
        if (!mapping) return true;
        const value = record[mapping.sourceField];
        return value === null || value === undefined || value === '';
      });
    }).length;

    if (nullCount > 0) {
      warnings.push(
        `Found ${nullCount} record(s) with null/empty identifier values for "${identifier.identifierName}"`
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    duplicateIdentifiers,
  };
}

/**
 * Get identifier mapping suggestions for a domain
 */
export async function getIdentifierSuggestions(
  domainCode: string,
  supabase: SupabaseClient
): Promise<{
  identifiers: Array<{
    identifierCode: string;
    identifierName: string;
    attributeCodes: string[];
    isPrimary: boolean;
    description?: string;
  }>;
  recommendations: string[];
}> {
  const { data, error } = await supabase
    .from('entity_identifier_definitions')
    .select(`
      identifier_code,
      identifier_name,
      attribute_codes,
      is_primary,
      description
    `)
    .eq('domain_code', domainCode)
    .eq('is_active', true)
    .order('is_primary', { ascending: false });

  if (error) throw error;

  const identifiers = (data || []).map((id: any) => ({
    identifierCode: id.identifier_code,
    identifierName: id.identifier_name,
    attributeCodes: id.attribute_codes,
    isPrimary: id.is_primary,
    description: id.description,
  }));

  const recommendations: string[] = [];

  // Generate recommendations
  const primaryIdentifiers = identifiers.filter(id => id.isPrimary);
  
  if (primaryIdentifiers.length === 0) {
    recommendations.push(
      `No primary identifier defined for ${domainCode}. Consider creating one using unique business keys.`
    );
  } else if (primaryIdentifiers.length > 1) {
    recommendations.push(
      `Multiple primary identifiers defined for ${domainCode}. Consider consolidating to a single primary identifier.`
    );
  }

  // Check for composite identifiers
  const compositeIdentifiers = identifiers.filter(id => id.attributeCodes.length > 1);
  if (compositeIdentifiers.length > 0) {
    recommendations.push(
      `Found ${compositeIdentifiers.length} composite identifier(s). Ensure all component attributes are mapped.`
    );
  }

  return {
    identifiers,
    recommendations,
  };
}
