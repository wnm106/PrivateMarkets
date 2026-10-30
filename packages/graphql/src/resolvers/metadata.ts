import { FormulaEngine, DerivationContext } from '../lib/formula-engine';
import { SupabaseClient } from '@supabase/supabase-js';
import { Context } from '../context';
import { withClientNames } from './schema-scope';

export const metadataResolvers = {
  Query: {
    /**
     * Get all attributes, optionally filtered by domain
     */
    attributeRegister: async (_: any, args: { domainCode?: string; includeDerived?: boolean }, context: Context) => {
      const { supabase } = context;
      console.log('[attributeRegister] Called with args:', args);
      
      // Use RPC function to bypass PostgREST schema cache for aggregation fields
      const { data, error } = await supabase
        .rpc('get_attributes_with_aggregation', { 
          p_domain_code: null // Get all attributes, we'll filter in the resolver
        });

      console.log('[attributeRegister] RPC result:', { dataLength: data?.length, error: error?.message });

      if (error) {
        console.error('[attributeRegister] RPC error:', error);
        // Fallback to regular query if RPC fails
        let query = supabase
          .from('attribute_register')
          .select('*')
          .order('attribute_code');

        const { data: fallbackData, error: fallbackError } = await query;

        console.log('[attributeRegister] Fallback query result:', { 
          dataLength: fallbackData?.length, 
          error: fallbackError?.message 
        });

        if (fallbackError) {
          console.error('[attributeRegister] Fallback error:', fallbackError);
          throw new Error('Failed to fetch attributes');
        }

        const withChains = await attachPrecedenceMetadata(supabase, fallbackData || []);
        let attributes = withChains.map(mapAttributeDefinition);
        
        // If domainCode is specified, filter to show:
        // 1. Attributes with matching domain_code, OR
        // 2. Attributes with null domain_code (global/shared), OR
        // 3. Attributes assigned to templates in this domain
        if (args.domainCode) {
          // Get all templates for this domain
          const { data: domainTemplates } = await supabase
            .from('domain_templates')
            .select('id')
            .eq('domain_code', args.domainCode);
          
          const templateIds = (domainTemplates || []).map((t: any) => t.id);
          
          // Get all attribute assignments for these templates
          let assignedAttributeIds = new Set<string>();
          if (templateIds.length > 0) {
            const { data: assignments } = await supabase
              .from('template_attribute_assignments')
              .select('attribute_id')
              .in('template_id', templateIds);
            
            assignedAttributeIds = new Set(
              (assignments || []).map((a: any) => a.attribute_id)
            );
          }
          
          attributes = attributes.filter((attr: any) => 
            attr.domainCode === args.domainCode || 
            attr.domainCode === null ||
            assignedAttributeIds.has(attr.id)
          );
        }
        
        return withClientNames(context, attributes);
      }

      // RPC returns JSONB array, parse it
      const allAttributes = Array.isArray(data) ? data : (data ? JSON.parse(data as any) : []);
      
      console.log('[attributeRegister] Parsed attributes count:', allAttributes.length);
      
      // The catalog RPC omits calculated attributes. Merge them back so a visible
      // value such as position market value still appears on the entity.
      let filtered = await withDerivedAttributes(supabase, allAttributes);

      // If domainCode is specified, filter to show:
      // 1. Attributes with matching domain_code, OR
      // 2. Attributes with null domain_code (global/shared), OR
      // 3. Attributes assigned to templates in this domain
      if (args.domainCode) {
        console.log('[attributeRegister] Filtering by domainCode:', args.domainCode);
        
        // Get all templates for this domain
        const { data: domainTemplates, error: templatesError } = await supabase
          .from('domain_templates')
          .select('id')
          .eq('domain_code', args.domainCode);
        
        console.log('[attributeRegister] Templates query result:', { 
          templateCount: domainTemplates?.length, 
          error: templatesError?.message 
        });
        
        const templateIds = (domainTemplates || []).map((t: any) => t.id);
        
        // Get all attribute assignments for these templates
        let assignedAttributeIds = new Set<string>();
        if (templateIds.length > 0) {
          const { data: assignments, error: assignmentsError } = await supabase
            .from('template_attribute_assignments')
            .select('attribute_id')
            .in('template_id', templateIds);
          
          console.log('[attributeRegister] Assignments query result:', { 
            assignmentCount: assignments?.length, 
            error: assignmentsError?.message 
          });
          
          assignedAttributeIds = new Set(
            (assignments || []).map((a: any) => a.attribute_id)
          );
        }
        
        console.log('[attributeRegister] Assigned attribute IDs:', Array.from(assignedAttributeIds));
        console.log('[attributeRegister] Before filtering, attributes count:', filtered.length);
        
        filtered = filtered.filter((attr: any) => {
          const matches = attr.domain_code === args.domainCode || 
            attr.domain_code === null ||
            assignedAttributeIds.has(attr.id);
          if (matches) {
            console.log('[attributeRegister] Attribute matches:', attr.attribute_code, 'domain_code:', attr.domain_code);
          }
          return matches;
        });
        
        console.log('[attributeRegister] After filtering, attributes count:', filtered.length);
      }

      console.log('[attributeRegister] Returning filtered count:', filtered.length);
      const withChains = await attachPrecedenceMetadata(supabase, filtered);
      return withClientNames(context, withChains.map(mapAttributeDefinition));
    },

    attributeSections: async (_: any, args: { domainCode: string }, { supabase }: Context) => {
      const domainCode = String(args.domainCode || '').trim();
      if (!domainCode) return [];
      const { data: domain, error: domainError } = await supabase
        .from('domain_types')
        .select('domain_code, client_id')
        .eq('domain_code', domainCode)
        .maybeSingle();
      if (domainError) throw new Error(domainError.message);
      if (!domain) return [];

      const { data: attributes, error: attributeError } = await supabase
        .from('attribute_register')
        .select('display_section')
        .eq('domain_code', domainCode);
      if (attributeError) throw new Error(attributeError.message);

      const { data: existing, error: existingError } = await supabase
        .from('attribute_sections')
        .select('section_name, display_order')
        .eq('domain_code', domainCode);
      if (existingError) throw new Error(existingError.message);

      const known = new Set((existing || []).map((row) => String(row.section_name || '').toLowerCase()));
      const missing: string[] = [];
      const remember = (raw: string | null | undefined) => {
        const name = String(raw || 'General').trim() || 'General';
        const key = name.toLowerCase();
        if (known.has(key)) return;
        known.add(key);
        missing.push(name);
      };
      remember('General');
      for (const row of attributes || []) remember(row.display_section);

      if (missing.length > 0) {
        let order = (existing || []).reduce((max, row) => Math.max(max, Number(row.display_order) || 0), -10);
        const { error: insertError } = await supabase.from('attribute_sections').insert(
          missing.map((sectionName) => {
            order += 10;
            return {
              domain_code: domainCode,
              section_name: sectionName,
              display_order: order,
              client_id: domain.client_id,
            };
          }),
        );
        if (insertError && !/duplicate|unique/i.test(insertError.message)) {
          console.error('[attributeSections] could not add missing sections:', insertError.message);
        }
      }

      const { data, error } = await supabase
        .from('attribute_sections')
        .select('id, domain_code, section_name, display_order, column_count')
        .eq('domain_code', domainCode)
        .order('display_order', { ascending: true });
      if (error) throw new Error(error.message);
      return (data || []).map(mapAttributeSection);
    },

    domainTemplates: async (_: any, args: { domainCode?: string }, context: Context) => {
      const { supabase } = context;
      let query = supabase
        .from('domain_templates')
        .select('*')
        .order('template_code');

      // Filter by domain if specified
      if (args.domainCode) {
        query = query.eq('domain_code', args.domainCode);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching domain templates:', error);
        throw new Error('Failed to fetch domain templates');
      }

      const templates = data || [];
      if (templates.length === 0) return [];

      // Fetch attribute assignments for all templates in one round-trip so
      // Template.attributes (non-null list) always resolves, even when a
      // template has no attributes assigned yet.
      const templateIds = templates.map((t: any) => t.id);
      const { data: assignments, error: assignmentsError } = await supabase
        .from('template_attribute_assignments')
        .select('*, attribute_register!inner(*)')
        .in('template_id', templateIds);

      if (assignmentsError) {
        console.error('Error fetching template attribute assignments:', assignmentsError);
      }

      const assignmentsByTemplate = new Map<string, any[]>();
      (assignments || []).forEach((a: any) => {
        if (!assignmentsByTemplate.has(a.template_id)) {
          assignmentsByTemplate.set(a.template_id, []);
        }
        assignmentsByTemplate.get(a.template_id)!.push(a);
      });

      const { data: sections } = await supabase
        .from('template_sections')
        .select('id, template_id, section_code, section_name, display_order, description')
        .in('template_id', templateIds);
      const sectionById = new Map<string, any>((sections || []).map((section: any) => [section.id, section]));

      return withClientNames(context, templates.map((t: any) => ({
        id: t.id,
        templateCode: t.template_code,
        domainCode: t.domain_code,
        templateName: t.template_name,
        description: t.description,
        isActive: t.is_active,
        applicabilityRules: t.applicability_rules || {},
        clientId: t.client_id ?? null,
        attributes: (assignmentsByTemplate.get(t.id) || []).map((a: any) => ({
          attributeId: a.attribute_id,
          attribute: mapAttributeDefinition(a.attribute_register),
          isRequired: a.is_required,
          precedenceRank: a.precedence_rank,
          displayOrder: a.display_order,
          displayLabel: a.display_label,
          sectionCode: sectionById.get(a.section_id)?.section_code || null,
          sectionName: sectionById.get(a.section_id)?.section_name || null,
          defaultPrecedenceChain: Array.isArray(a.default_precedence_chain) ? a.default_precedence_chain : [],
          chainVersion: Number.isFinite(Number(a.chain_version)) ? Number(a.chain_version) : 1,
        })),
      })));
    },

    /**
     * Get only derived attributes
     */
    derivedAttributes: async (_: any, __: any, { supabase }: { supabase: SupabaseClient }) => {
      const { data, error } = await supabase
        .from('attribute_register')
        .select('*')
        .eq('is_derived', true)
        .order('attribute_code');

      if (error) {
        console.error('Error fetching derived attributes:', error);
        throw new Error('Failed to fetch derived attributes');
      }

      return (data || []).map(mapAttributeDefinition);
    },

    /**
     * Evaluate a single derived attribute for an entity
     */
    evaluateDerivedAttribute: async (
      _: any,
      args: { entityId: string; attributeCode: string; asOfDate?: string },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      const formulaEngine = new FormulaEngine(supabase);
      const context: DerivationContext = {
        entityId: args.entityId,
        asOfDate: args.asOfDate || new Date().toISOString().split('T')[0],
        supabase,
      };

      try {
        const result = await formulaEngine.evaluateDerivation(args.attributeCode, context);
        if (!result) return null;

        return {
          attributeCode: args.attributeCode,
          value: result.value,
          derivationType: result.derivationType,
          dependencies: result.dependencies,
          evaluatedAt: result.evaluatedAt,
        };
      } catch (error) {
        console.error('Error evaluating derived attribute:', error);
        throw error;
      }
    },

    /**
     * Batch evaluate multiple derived attributes for an entity
     */
    evaluateDerivedAttributesBatch: async (
      _: any,
      args: { entityId: string; attributeCodes: string[]; asOfDate?: string },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      const formulaEngine = new FormulaEngine(supabase);
      const context: DerivationContext = {
        entityId: args.entityId,
        asOfDate: args.asOfDate || new Date().toISOString().split('T')[0],
        supabase,
      };

      try {
        const results = await formulaEngine.evaluateBatch(args.attributeCodes, context);
        return Object.fromEntries(results);
      } catch (error) {
        console.error('Error evaluating derived attributes batch:', error);
        throw error;
      }
    },
  },

  Mutation: {
    /**
     * Create a new attribute (source or derived)
     */
    createAttribute: async (
      _: any,
      args: { input: CreateAttributeInput },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      const { input } = args;

      // Validate derived attribute inputs
      if (input.isDerived) {
        if (!input.derivationType) {
          return {
            attribute: null,
            errors: [{ field: 'derivationType', message: 'Derivation type is required for derived attributes', code: 'VALIDATION_ERROR' }],
          };
        }
        if (!input.derivationFormula) {
          return {
            attribute: null,
            errors: [{ field: 'derivationFormula', message: 'Derivation formula is required for derived attributes', code: 'VALIDATION_ERROR' }],
          };
        }
      }

      const { data, error } = await supabase
        .from('attribute_register')
        .insert({
          attribute_code: input.attributeCode,
          attribute_name: input.attributeName,
          data_type: input.dataType,
          description: input.description,
          unit_of_measure: input.unitOfMeasure,
          is_required: input.isRequired || false,
          is_multi_valued: input.isMultiValued || false,
          reference_domain_code: input.referenceDomainCode,
          domain_code: input.domainCode,
          default_precedence_rank: input.defaultPrecedenceRank || 100,
          is_derived: input.isDerived || false,
          derivation_type: input.derivationType,
          derivation_formula: input.derivationFormula,
          derivation_dependencies: input.derivationDependencies || [],
          formula_language: input.formulaLanguage || 'SQL',
          is_time_varying: input.isTimeVarying || false,
          time_dimension: input.timeDimension || 'NONE',
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating attribute:', error);
        return {
          attribute: null,
          errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }],
        };
      }

      return {
        attribute: mapAttributeDefinition(data),
        errors: [],
      };
    },

    /**
     * Update an existing attribute
     */
    updateAttributeDefinition: async (
      _: any,
      args: { input: UpdateAttributeDefinitionInput },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      try {
        const { input } = args;

        const updateData: any = {
          updated_at: new Date().toISOString(),
        };

        // Only include fields that were provided
        if (input.attributeName !== undefined) updateData.attribute_name = input.attributeName;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.dataType !== undefined) updateData.data_type = input.dataType;
        if (input.unitOfMeasure !== undefined) updateData.unit_of_measure = input.unitOfMeasure;
        if (input.isRequired !== undefined) updateData.is_required = input.isRequired;
        if (input.isMultiValued !== undefined) updateData.is_multi_valued = input.isMultiValued;
        if (input.referenceDomainCode !== undefined) updateData.reference_domain_code = input.referenceDomainCode;
        if (input.domainCode !== undefined) updateData.domain_code = input.domainCode;
        if (input.defaultPrecedenceRank !== undefined) updateData.default_precedence_rank = input.defaultPrecedenceRank;
        if (input.isDerived !== undefined) updateData.is_derived = input.isDerived;
        if (input.derivationType !== undefined) updateData.derivation_type = input.derivationType;
        if (input.derivationFormula !== undefined) updateData.derivation_formula = input.derivationFormula;
        if (input.derivationDependencies !== undefined) updateData.derivation_dependencies = input.derivationDependencies;
        if (input.formulaLanguage !== undefined) updateData.formula_language = input.formulaLanguage;
        
        // Time dimension fields
        if (input.isTimeVarying !== undefined) updateData.is_time_varying = input.isTimeVarying;
        if (input.timeDimension !== undefined) updateData.time_dimension = input.timeDimension;
        
        // Display and validation metadata fields
        if (input.displayFormat !== undefined) updateData.display_format = input.displayFormat;
        if (input.listValues !== undefined) updateData.list_values = input.listValues;
        if (input.validationRules !== undefined) updateData.validation_rules = input.validationRules;
        if (input.defaultValue !== undefined) updateData.default_value = input.defaultValue;
        if (input.displaySection !== undefined) updateData.display_section = input.displaySection;
        if (input.displayGroup !== undefined) updateData.display_group = input.displayGroup;
        if (input.displaySpanColumns !== undefined) {
          const span = boundedSpan(input.displaySpanColumns, 4);
          if (span == null) {
            return {
              success: false,
              attribute: null,
              errors: [{ field: 'displaySpanColumns', message: 'Width must be a whole number from 1 to 4.', code: 'VALIDATION' }],
            };
          }
          updateData.display_span_columns = span;
        }
        if (input.displaySpanRows !== undefined) {
          const span = boundedSpan(input.displaySpanRows, 3);
          if (span == null) {
            return {
              success: false,
              attribute: null,
              errors: [{ field: 'displaySpanRows', message: 'Height must be a whole number from 1 to 3.', code: 'VALIDATION' }],
            };
          }
          updateData.display_span_rows = span;
        }
        if (input.isEditable !== undefined) updateData.is_editable = input.isEditable;
        if (input.isVisible !== undefined) updateData.is_visible = input.isVisible;
        
        // Reference list link
        if (input.referenceListCode !== undefined) updateData.reference_list_code = input.referenceListCode;
        
        // Extract aggregation fields for separate RPC update (bypasses schema cache)
        const aggregationFields = {
          aggregationType: input.aggregationType,
          weightAttributeCode: input.weightAttributeCode,
          numericPrecision: input.numericPrecision,
        };
        const hasAggregationUpdates = input.aggregationType !== undefined || 
                                       input.weightAttributeCode !== undefined || 
                                       input.numericPrecision !== undefined;

        // Update non-aggregation fields using regular Supabase client
        const { data, error } = await supabase
          .from('attribute_register')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) {
          console.error('Error updating attribute:', error);
          return {
            success: false,
            attribute: null,
            errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }],
          };
        }

        if (input.displaySection !== undefined && data?.domain_code) {
          await ensureAttributeSection(supabase, data.domain_code, input.displaySection, data.client_id);
        }

        // Update aggregation fields using RPC function (bypasses schema cache)
        if (hasAggregationUpdates) {
          const { data: rpcData, error: rpcError } = await supabase
            .rpc('update_attribute_aggregation', {
              p_attribute_id: input.id,
              p_aggregation_type: aggregationFields.aggregationType || 'NONE',
              p_weight_attribute_code: aggregationFields.weightAttributeCode || null,
              p_numeric_precision: aggregationFields.numericPrecision ?? null,
            });

          if (rpcError) {
            console.error('Error updating aggregation fields:', rpcError);
            return {
              success: false,
              attribute: null,
              errors: [{ field: 'general', message: rpcError.message, code: 'DATABASE_ERROR' }],
            };
          }

          // Merge the RPC result with the regular update result
          const mergedData = {
            ...data,
            aggregation_type: rpcData?.aggregation_type || aggregationFields.aggregationType || 'NONE',
            weight_attribute_code: rpcData?.weight_attribute_code || aggregationFields.weightAttributeCode,
            numeric_precision: rpcData?.numeric_precision ?? aggregationFields.numericPrecision,
          };

          return {
            success: true,
            attribute: mapAttributeDefinition(mergedData),
            errors: [],
          };
        }

        return {
          success: true,
          attribute: mapAttributeDefinition(data),
          errors: [],
        };
      } catch (err) {
        console.error('Exception in updateAttributeDefinition:', err);
        return {
          success: false,
          attribute: null,
          errors: [{ field: 'general', message: String(err), code: 'EXCEPTION' }],
        };
      }
    },

    /**
     * Delete an attribute (only if not in use)
     */
    deleteAttribute: async (
      _: any,
      args: { id: string },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      // Check if attribute is in use by any template
      const { data: usages, error: usageError } = await supabase
        .from('template_attribute_assignments')
        .select('id')
        .eq('attribute_id', args.id)
        .limit(1);

      if (usageError) {
        return {
          success: false,
          errors: [{ field: 'general', message: usageError.message, code: 'DATABASE_ERROR' }],
        };
      }

      if (usages && usages.length > 0) {
        return {
          success: false,
          errors: [{ field: 'general', message: 'Cannot delete attribute that is in use by templates', code: 'IN_USE' }],
        };
      }

      const { error } = await supabase
        .from('attribute_register')
        .delete()
        .eq('id', args.id);

      if (error) {
        return {
          success: false,
          errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }],
        };
      }

      return { success: true, errors: [] };
    },

    createAttributeSection: async (
      _: any,
      args: { domainCode: string; sectionName: string },
      { supabase }: Context,
    ) => {
      const domainCode = String(args.domainCode || '').trim();
      const sectionName = String(args.sectionName || '').trim();
      if (!domainCode) return sectionError('domainCode', 'Choose an entity type.');
      if (!sectionName) return sectionError('sectionName', 'Enter a section name.');
      const { data: domain, error: domainError } = await supabase
        .from('domain_types')
        .select('client_id')
        .eq('domain_code', domainCode)
        .maybeSingle();
      if (domainError) return sectionError('general', domainError.message);
      if (!domain) return sectionError('domainCode', 'Entity type not found.');
      const duplicate = await sectionNameTaken(supabase, domainCode, sectionName);
      if (duplicate) return sectionError('sectionName', 'That section name is already used for this entity type.');
      const { data: last } = await supabase
        .from('attribute_sections')
        .select('display_order')
        .eq('domain_code', domainCode)
        .order('display_order', { ascending: false })
        .limit(1);
      const displayOrder = (Number(last?.[0]?.display_order) || 0) + 10;
      const { data, error } = await supabase
        .from('attribute_sections')
        .insert({
          domain_code: domainCode,
          section_name: sectionName,
          display_order: displayOrder,
          client_id: domain.client_id,
        })
        .select('id, domain_code, section_name, display_order, column_count')
        .single();
      if (error) return sectionError('general', error.message);
      return { success: true, section: mapAttributeSection(data), sections: null, errors: [] };
    },

    renameAttributeSection: async (
      _: any,
      args: { id: string; sectionName: string },
      { supabase }: Context,
    ) => {
      const sectionName = String(args.sectionName || '').trim();
      if (!sectionName) return sectionError('sectionName', 'Enter a section name.');
      const { data: current, error: readError } = await supabase
        .from('attribute_sections')
        .select('id, domain_code, section_name, display_order, column_count')
        .eq('id', args.id)
        .maybeSingle();
      if (readError) return sectionError('general', readError.message);
      if (!current) return sectionError('id', 'Section not found.');
      if (current.section_name !== sectionName) {
        const duplicate = await sectionNameTaken(supabase, current.domain_code, sectionName, current.id);
        if (duplicate) return sectionError('sectionName', 'That section name is already used for this entity type.');
        const { error: attributeError } = await supabase
          .from('attribute_register')
          .update({ display_section: sectionName, updated_at: new Date().toISOString() })
          .eq('domain_code', current.domain_code)
          .eq('display_section', current.section_name);
        if (attributeError) return sectionError('general', attributeError.message);
        const { error } = await supabase
          .from('attribute_sections')
          .update({ section_name: sectionName, updated_at: new Date().toISOString() })
          .eq('id', current.id);
        if (error) return sectionError('general', error.message);
      }
      return {
        success: true,
        section: mapAttributeSection({ ...current, section_name: sectionName }),
        sections: null,
        errors: [],
      };
    },

    reorderAttributeSections: async (
      _: any,
      args: { domainCode: string; orderedIds: string[] },
      { supabase }: Context,
    ) => {
      const domainCode = String(args.domainCode || '').trim();
      const orderedIds = Array.isArray(args.orderedIds) ? args.orderedIds : [];
      const { data: rows, error: readError } = await supabase
        .from('attribute_sections')
        .select('id')
        .eq('domain_code', domainCode);
      if (readError) return sectionError('general', readError.message);
      const known = new Set((rows || []).map((row) => row.id));
      if (orderedIds.length !== known.size || orderedIds.some((id) => !known.has(id))) {
        return sectionError('orderedIds', 'The section order must include every section for this entity type.');
      }
      const updates = await Promise.all(orderedIds.map((id, index) => (
        supabase
          .from('attribute_sections')
          .update({ display_order: (index + 1) * 10, updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('domain_code', domainCode)
      )));
      const failed = updates.find((result) => result.error);
      if (failed?.error) return sectionError('general', failed.error.message);
      const { data, error } = await supabase
        .from('attribute_sections')
        .select('id, domain_code, section_name, display_order, column_count')
        .eq('domain_code', domainCode)
        .order('display_order', { ascending: true });
      if (error) return sectionError('general', error.message);
      return { success: true, section: null, sections: (data || []).map(mapAttributeSection), errors: [] };
    },

    updateAttributeSection: async (
      _: any,
      args: { id: string; columnCount: number },
      { supabase }: Context,
    ) => {
      const columnCount = boundedSpan(args.columnCount, 4);
      if (columnCount == null) return sectionError('columnCount', 'Column width must be a whole number from 1 to 4.');
      const { data, error } = await supabase
        .from('attribute_sections')
        .update({ column_count: columnCount, updated_at: new Date().toISOString() })
        .eq('id', args.id)
        .select('id, domain_code, section_name, display_order, column_count')
        .maybeSingle();
      if (error) return sectionError('general', error.message);
      if (!data) return sectionError('id', 'Section not found.');
      return { success: true, section: mapAttributeSection(data), sections: null, errors: [] };
    },

    deleteAttributeSection: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data: current, error: readError } = await supabase
        .from('attribute_sections')
        .select('id, domain_code, section_name')
        .eq('id', args.id)
        .maybeSingle();
      if (readError) return sectionError('general', readError.message);
      if (!current) return sectionError('id', 'Section not found.');
      const { count, error: countError } = await supabase
        .from('attribute_register')
        .select('id', { count: 'exact', head: true })
        .eq('domain_code', current.domain_code)
        .eq('display_section', current.section_name);
      if (countError) return sectionError('general', countError.message);
      if ((count || 0) > 0) {
        return sectionError('sectionName', 'Move the attributes out of this section before deleting it.');
      }
      const { error } = await supabase.from('attribute_sections').delete().eq('id', current.id);
      if (error) return sectionError('general', error.message);
      return { success: true, section: null, sections: null, errors: [] };
    },

    reorderSectionAttributes: async (
      _: any,
      args: { domainCode: string; sectionName: string; attributeIds: string[] },
      { supabase }: Context,
    ) => {
      const domainCode = String(args.domainCode || '').trim();
      const sectionName = String(args.sectionName || '').trim() || 'General';
      const attributeIds = Array.isArray(args.attributeIds) ? args.attributeIds.filter(Boolean) : [];
      if (!domainCode) return sectionError('domainCode', 'Choose an entity type.');
      const updates = await Promise.all(attributeIds.map((id, index) => (
        supabase
          .from('attribute_register')
          .update({
            display_section: sectionName,
            display_group: (index + 1) * 10,
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('domain_code', domainCode)
          .select('id')
      )));
      const failed = updates.find((result) => result.error);
      if (failed?.error) return sectionError('general', failed.error.message);
      const updated = updates.reduce((sum, result) => sum + (result.data?.length || 0), 0);
      if (updated !== attributeIds.length) {
        return sectionError('attributeIds', 'One or more attributes are not part of this entity type.');
      }
      await ensureAttributeSection(supabase, domainCode, sectionName);
      return { success: true, section: null, sections: null, errors: [] };
    },
  },
};

function boundedSpan(value: unknown, max: number): number | null {
  const span = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(span) || span < 1 || span > max) return null;
  return span;
}

function mapAttributeSection(row: any) {
  return {
    id: row.id,
    domainCode: row.domain_code,
    sectionName: row.section_name,
    displayOrder: row.display_order || 0,
    columnCount: boundedSpan(row.column_count, 4) ?? 4,
  };
}

function sectionError(field: string, message: string) {
  return { success: false, section: null, sections: null, errors: [{ field, message, code: 'VALIDATION' }] };
}

async function sectionNameTaken(
  supabase: SupabaseClient,
  domainCode: string,
  sectionName: string,
  exceptId?: string,
) {
  const { data, error } = await supabase
    .from('attribute_sections')
    .select('id, section_name')
    .eq('domain_code', domainCode);
  if (error) throw new Error(error.message);
  const key = sectionName.toLowerCase();
  return (data || []).some((row) => row.id !== exceptId && String(row.section_name || '').toLowerCase() === key);
}

async function ensureAttributeSection(
  supabase: SupabaseClient,
  domainCode: string,
  sectionName: string,
  clientId?: string | null,
) {
  const name = String(sectionName || 'General').trim() || 'General';
  if (!domainCode) return;
  const taken = await sectionNameTaken(supabase, domainCode, name);
  if (taken) return;
  let ownerId = clientId;
  if (ownerId === undefined) {
    const { data: domain } = await supabase
      .from('domain_types')
      .select('client_id')
      .eq('domain_code', domainCode)
      .maybeSingle();
    ownerId = domain?.client_id ?? null;
  }
  const { data: last } = await supabase
    .from('attribute_sections')
    .select('display_order')
    .eq('domain_code', domainCode)
    .order('display_order', { ascending: false })
    .limit(1);
  const displayOrder = (Number(last?.[0]?.display_order) || 0) + 10;
  const { error } = await supabase.from('attribute_sections').insert({
    domain_code: domainCode,
    section_name: name,
    display_order: displayOrder,
    client_id: ownerId,
  });
  if (error && !/duplicate|unique/i.test(error.message)) {
    console.error('[ensureAttributeSection]', error.message);
  }
}

/** Calculated attributes are omitted by get_attributes_with_aggregation. */
async function withDerivedAttributes(supabase: SupabaseClient, rows: any[]): Promise<any[]> {
  const { data, error } = await supabase
    .from('attribute_register')
    .select('*')
    .eq('is_derived', true);
  if (error || !data?.length) return rows;
  const seen = new Set(rows.map((row) => row.id || row.attribute_code));
  return [
    ...rows,
    ...data.filter((row) => !seen.has(row.id) && !seen.has(row.attribute_code)),
  ];
}

/**
 * Map database row to GraphQL AttributeDefinition type
 */
function mapAttributeDefinition(row: any) {
  return {
    id: row.id,
    attributeCode: row.attribute_code,
    attributeName: row.attribute_name,
    dataType: row.data_type,
    description: row.description,
    unitOfMeasure: row.unit_of_measure,
    isRequired: row.is_required || false,
    isMultiValued: row.is_multi_valued || false,
    referenceDomainCode: row.reference_domain_code,
    domainCode: row.domain_code,
    defaultPrecedenceRank: row.default_precedence_rank || 100,
    isDerived: row.is_derived || false,
    derivationType: row.derivation_type,
    derivationFormula: row.derivation_formula,
    derivationDependencies: row.derivation_dependencies || [],
    formulaLanguage: row.formula_language || 'SQL',
    // Time dimension fields
    isTimeVarying: row.is_time_varying || false,
    timeDimension: row.time_dimension || 'NONE',
    // Display and validation metadata
    displayFormat: row.display_format,
    listValues: row.list_values || [],
    validationRules: row.validation_rules || {},
    defaultValue: row.default_value,
    displaySection: row.display_section || 'General',
    displayGroup: row.display_group || 0,
    displaySpanColumns: boundedSpan(row.display_span_columns, 4) ?? 1,
    displaySpanRows: boundedSpan(row.display_span_rows, 3) ?? 1,
    isEditable: row.is_editable !== false,
    isVisible: row.is_visible !== false,
    // Reference list link
    referenceListCode: row.reference_list_code || null,
    clientId: row.client_id ?? null,
    // Aggregation and precision
    aggregationType: row.aggregation_type || 'NONE',
    weightAttributeCode: row.weight_attribute_code,
    numericPrecision: row.numeric_precision,
    defaultPrecedenceChain: precedenceChainFromRow(row),
  };
}

function precedenceChainFromRow(row: any): string[] {
  const column = Array.isArray(row.default_precedence_chain) ? row.default_precedence_chain : [];
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata.defaultPrecedenceChain : [];
  const raw = column.length > 0 ? column : (Array.isArray(metadata) ? metadata : []);
  return raw.filter((code: unknown) => typeof code === 'string' && code.length > 0 && code !== 'MANUAL');
}

async function attachPrecedenceMetadata(supabase: SupabaseClient, rows: any[]): Promise<any[]> {
  const missing = rows.filter((row) => row?.id && row.metadata == null);
  if (missing.length === 0) return rows;
  const { data } = await supabase
    .from('attribute_register')
    .select('id, metadata')
    .in('id', missing.map((row) => row.id));
  const byId = new Map((data || []).map((row: any) => [row.id, row.metadata]));
  return rows.map((row) => (
    row.metadata == null ? { ...row, metadata: byId.get(row.id) || {} } : row
  ));
}

/**
 * Input types for mutations
 */
interface CreateAttributeInput {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description?: string;
  unitOfMeasure?: string;
  isRequired?: boolean;
  isMultiValued?: boolean;
  referenceDomainCode?: string;
  domainCode?: string;
  defaultPrecedenceRank?: number;
  isDerived?: boolean;
  derivationType?: string;
  derivationFormula?: string;
  derivationDependencies?: string[];
  formulaLanguage?: string;
  // Time dimension fields
  isTimeVarying?: boolean;
  timeDimension?: 'NONE' | 'VALID_TIME' | 'TRANSACTION_TIME' | 'BITEMPORAL';
}

interface UpdateAttributeDefinitionInput {
  id: string;
  attributeName?: string;
  description?: string;
  dataType?: string;
  unitOfMeasure?: string;
  isRequired?: boolean;
  isMultiValued?: boolean;
  referenceDomainCode?: string;
  domainCode?: string;
  defaultPrecedenceRank?: number;
  isDerived?: boolean;
  derivationType?: string;
  derivationFormula?: string;
  derivationDependencies?: string[];
  formulaLanguage?: string;
  // Time dimension fields
  isTimeVarying?: boolean;
  timeDimension?: 'NONE' | 'VALID_TIME' | 'TRANSACTION_TIME' | 'BITEMPORAL';
  // Display and validation metadata
  displayFormat?: string;
  listValues?: string[];
  validationRules?: any;
  defaultValue?: string;
  displaySection?: string;
  displayGroup?: number;
  displaySpanColumns?: number;
  displaySpanRows?: number;
  isEditable?: boolean;
  isVisible?: boolean;
  // Reference list link
  referenceListCode?: string;
  // Aggregation and precision
  aggregationType?: 'NONE' | 'MIN' | 'MAX' | 'SUM' | 'AVG' | 'WEIGHTED_AVG';
  weightAttributeCode?: string;
  numericPrecision?: number;
}
