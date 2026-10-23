import { Context } from '../context';
import { loadAttributeSequences, pickPersistedWinner, sequenceLabel, sequencePosition, storedRuleLabel } from '../lib/attribute-sequence';
import { dirtyAttributeCodes } from './calculation';
import { resolveSchemaClientId, withClientNames } from './schema-scope';

function normalizePrecedenceChain(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function normalizeChainVersion(value: unknown): number {
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.trunc(version) : 1;
}

export const entityResolvers = {
  Query: {
    entities: async (
      _: any,
      args: { filter?: any; pagination?: any; asOfDate?: string },
      context: Context
    ) => {
      const { filter, pagination, asOfDate } = args;
      
      try {
        // Query from generic entity_master view
        let query = context.supabase
          .from('entity_master')
          .select('*', { count: 'exact' });
        
        // Apply filters
        if (filter) {
          if (filter.domainCode) {
            query = query.eq('domain_code', filter.domainCode);
          }
          if (filter.templateCode) {
            query = query.eq('template_code', filter.templateCode);
          }
          if (filter.entityCode) {
            query = query.eq('entity_code', filter.entityCode);
          }
          if (filter.entityName) {
            query = query.ilike('entity_name', `%${filter.entityName}%`);
          }
          if (filter.isActive !== undefined) {
            query = query.eq('is_active', filter.isActive);
          }
          // Attribute-based filtering using JSONB operators
          if (filter.attributes) {
            for (const [key, value] of Object.entries(filter.attributes)) {
              query = query.contains('attributes', { [key]: { value } });
            }
          }
          // Relationship filters
          if (filter.hasParent) {
            // This would require a more complex query with entity_relationships
            // For now, we'll handle this in post-processing
          }
          if (filter.hasChild) {
            // Similar to hasParent
          }
        }
        
        // Apply pagination
        const limit = pagination?.first || 20;
        const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
        
        query = query.range(offset, offset + limit - 1);
        query = query.order('entity_name');
        
        const { data, error, count } = await query;
        
        if (error) {
          console.error('Error fetching entities:', error);
          throw error;
        }
        
        const edges = (data || []).map((row: any, index: number) => ({
          node: mapEntityRow(row),
          cursor: btoa(String(offset + index)),
        }));
        
        return {
          edges,
          pageInfo: {
            hasNextPage: (offset + limit) < (count || 0),
            hasPreviousPage: offset > 0,
            startCursor: edges[0]?.cursor,
            endCursor: edges[edges.length - 1]?.cursor,
          },
          totalCount: count || 0,
        };
      } catch (error: any) {
        console.error('Exception in entities resolver:', error);
        throw error;
      }
    },
    
    entity: async (
      _: any,
      args: { id?: string; entityCode?: string; asOfDate?: string },
      context: Context
    ) => {
      let query = context.supabase.from('entity_master').select('*');
      
      if (args.id) {
        query = query.eq('entity_id', args.id);
      } else if (args.entityCode) {
        query = query.eq('entity_code', args.entityCode);
      } else {
        return null;
      }
      
      const { data, error } = await query.single();
      
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      
      return attachCompositeMembers(mapEntityRow(data), context);
    },
    
    // Queries for entity management
    entityIdentifierDefinitions: async (_: any, args: { domainCode?: string }, context: Context) => {
      let query = context.supabase
        .from('entity_identifier_definitions')
        .select(`
          id,
          identifier_code,
          identifier_name,
          domain_code,
          attribute_codes,
          is_primary,
          description,
          is_active,
          created_at,
          updated_at
        `)
        .eq('is_active', true);

      if (args.domainCode) {
        query = query.eq('domain_code', args.domainCode);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Fetch domain names to enrich the response
      const domainCodes = [...new Set(data?.map(item => item.domain_code))];
      const { data: domains, error: domainError } = await context.supabase
        .from('domain_types')
        .select('domain_code, domain_name')
        .in('domain_code', domainCodes);

      if (domainError) throw domainError;

      const domainMap: Record<string, string> = {};
      domains.forEach((domain: any) => {
        domainMap[domain.domain_code] = domain.domain_name;
      });

      return data?.map((item: any) => ({
        id: item.id,
        identifierCode: item.identifier_code,
        identifierName: item.identifier_name,
        domainCode: item.domain_code,
        domainName: domainMap[item.domain_code] || item.domain_code,
        attributeCodes: item.attribute_codes,
        isPrimary: item.is_primary,
        description: item.description,
        isActive: item.is_active,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })) || [];
    },

    domainRecordCounts: async (_: any, __: any, context: Context) => {
      const { data: domains, error: domainError } = await context.supabase
        .from('domain_types')
        .select('domain_code')
        .eq('is_active', true);

      if (domainError) throw domainError;

      return Promise.all((domains || []).map(async (domain: { domain_code: string }) => {
        const { count, error } = await context.supabase
          .from('master_entities')
          .select('id', { count: 'exact', head: true })
          .eq('domain_code', domain.domain_code)
          .eq('is_active', true);

        if (error) throw error;

        return {
          domainCode: domain.domain_code,
          totalCount: count || 0,
        };
      }));
    },

    domainTypes: async (_: any, __: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('domain_types')
        .select(`
          id,
          domain_code,
          domain_name,
          description,
          is_active,
          created_at,
          updated_at,
          client_id
        `);

      if (error) throw error;

      const rows = data?.map((item: any) => ({
        id: item.id,
        domainCode: item.domain_code,
        domainName: item.domain_name,
        description: item.description,
        isActive: item.is_active,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        clientId: item.client_id ?? null,
      })) || [];
      return withClientNames(context, rows);
    },
    
    // Domain-specific convenience queries - delegate to entities with domainCode filter
    funds: async (_: any, args: any, context: Context) => {
      return entityResolvers.Query.entities(_, { 
        ...args, 
        filter: { ...args.filter, domainCode: 'FUND' } 
      }, context);
    },
    
    issuers: async (_: any, args: any, context: Context) => {
      return entityResolvers.Query.entities(_, { 
        ...args, 
        filter: { ...args.filter, domainCode: 'ISSUER' } 
      }, context);
    },
    
    securities: async (_: any, args: any, context: Context) => {
      return entityResolvers.Query.entities(_, { 
        ...args, 
        filter: { ...args.filter, domainCode: 'SECURITY' } 
      }, context);
    },
    
    deals: async (_: any, args: any, context: Context) => {
      return entityResolvers.Query.entities(_, { 
        ...args, 
        filter: { ...args.filter, domainCode: 'DEAL' } 
      }, context);
    },
    
    investors: async (_: any, args: any, context: Context) => {
      return entityResolvers.Query.entities(_, { 
        ...args, 
        filter: { ...args.filter, domainCode: 'INVESTOR' } 
      }, context);
    },
    
    positions: async (_: any, args: any, context: Context) => {
      return entityResolvers.Query.entities(_, { 
        ...args, 
        filter: { ...args.filter, domainCode: 'POSITION' } 
      }, context);
    },
    
    relationshipTypes: async (_: any, __: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('relationship_types')
        .select('*')
        .eq('is_active', true)
        .order('relationship_code');
      
      if (error) throw error;
      
      const rows = (data || []).map((row: any) => ({
        id: row.id,
        relationshipCode: row.relationship_code,
        relationshipName: row.relationship_name,
        parentDomainCode: row.parent_domain_code,
        childDomainCode: row.child_domain_code,
        cardinality: row.cardinality || 'ONE_TO_ONE',
        compositeKey: row.composite_key || [],
        description: row.description,
        isActive: row.is_active,
        isRequired: row.is_required || false,
        clientId: row.client_id ?? null,
      }));
      return withClientNames(context, rows);
    },
  },
  
  Entity: {
    lineage: async (entity: any, _: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('entity_attribute_values')
        .select('*')
        .eq('entity_id', entity.id)
        .eq('valid_to', '9999-12-31')
        .eq('system_to', '9999-12-31 23:59:59');
      
      if (error) throw error;

      const attributeIds = [...new Set((data || []).map((row: any) => row.attribute_id).filter(Boolean))];
      const sourceIds = [...new Set((data || []).map((row: any) => row.source_id).filter(Boolean))];
      const [{ data: attributes, error: attributeError }, { data: sourceRows, error: sourceError }] = await Promise.all([
        attributeIds.length
          ? context.supabase.from('attribute_register').select('id, attribute_code, attribute_name').in('id', attributeIds)
          : Promise.resolve({ data: [], error: null }),
        sourceIds.length
          ? context.supabase.schema('entity_instances').from('source_registry').select('id, source_code, source_name').in('id', sourceIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (attributeError) throw attributeError;
      if (sourceError) throw sourceError;
      const attributeById = new Map((attributes || []).map((attribute: any) => [attribute.id, attribute]));
      const sourceById = new Map((sourceRows || []).map((source: any) => [source.id, source]));
      const rows = (data || []).map((row: any) => ({
        ...row,
        attribute_code: attributeById.get(row.attribute_id)?.attribute_code,
        attribute_name: attributeById.get(row.attribute_id)?.attribute_name,
        source_code: sourceById.get(row.source_id)?.source_code,
        source_name: sourceById.get(row.source_id)?.source_name,
      })).filter((row: any) => row.attribute_code && row.source_code);
      
      // Group by attribute
      const byAttribute = new Map<string, any[]>();
      rows.forEach((row: any) => {
        const code = row.attribute_code;
        if (!byAttribute.has(code)) byAttribute.set(code, []);
        byAttribute.get(code)!.push(row);
      });
      
      const sequences = await loadAttributeSequences(context.supabase, entity.id, [...byAttribute.keys()]);
      const dirty = await dirtyAttributeCodes(context, entity.id);

      return Array.from(byAttribute.entries()).map(([code, values]) => {
        const sequence = sequences.get(code) ?? { chain: [], tier: 'source' as const };
        const winningRecord = pickPersistedWinner(values);
        const ordered = [
          ...(winningRecord ? [winningRecord] : []),
          ...values
            .filter((row: any) => row !== winningRecord)
            .sort((a: any, b: any) =>
              sequencePosition(a.source_code, sequence.chain, a.precedence_rank ?? 999) -
              sequencePosition(b.source_code, sequence.chain, b.precedence_rank ?? 999)
            ),
        ];
        return {
          attributeCode: code,
          attributeName: winningRecord?.attribute_name,
          currentValue: winningRecord?.golden_value ?? null,
          competingValues: ordered.map((v: any) => {
            const sequenceIndex = sequence.chain.indexOf(v.source_code);
            return {
              source: v.source_code,
              sourceName: v.source_name,
              value: v.golden_value,
              precedenceRank: sequenceIndex >= 0 ? sequenceIndex + 1 : v.precedence_rank,
              validFrom: v.valid_from,
              validTo: v.valid_to,
              confidenceScore: v.confidence_score,
            };
          }),
          resolutionRule: storedRuleLabel(winningRecord?.resolution_rule_applied) || sequenceLabel(sequence),
          lastUpdated: winningRecord?.system_from,
          calcDirty: dirty.has(code),
        };
      });
    },
  },
  
  Mutation: {
    createEntity: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        // Get template_id if templateCode provided
        let templateId = null;
        if (input.templateCode) {
          const { data: template } = await context.supabase
            .from('domain_templates')
            .select('id')
            .eq('template_code', input.templateCode)
            .single();
          templateId = template?.id;
        }
        
        const clientId = await resolveSchemaClientId(context, input.clientId, { required: true });

        // Insert into master_entities
        const { data: entity, error: entityError } = await context.supabase
          .from('master_entities')
          .insert({
            entity_code: input.entityCode,
            entity_name: input.entityName,
            domain_code: input.domainCode,
            template_id: templateId,
            description: input.description,
            client_id: clientId,
            created_by: userId,
          })
          .select()
          .single();
        
        if (entityError) throw entityError;
        
        // Insert attributes into golden_master
        if (input.attributes) {
          for (const [attrCode, value] of Object.entries(input.attributes)) {
            const { data: attr } = await context.supabase
              .from('attribute_register')
              .select('id, default_precedence_rank')
              .eq('attribute_code', attrCode)
              .single();
            
            if (attr) {
              const { data: source } = await context.supabase
                .schema('entity_instances')
                .from('source_registry')
                .select('id')
                .eq('source_code', 'MANUAL')
                .single();
              
              await context.supabase.from('entity_attribute_values').insert({
                entity_id: entity.id,
                attribute_id: attr.id,
                source_id: source?.id,
                golden_value: typeof value === 'string' ? value : null,
                golden_value_numeric: typeof value === 'number' ? value : null,
                valid_from: new Date().toISOString().split('T')[0],
                precedence_rank: attr.default_precedence_rank,
                created_by: userId,
              });
            }
          }
        }
        
        // Insert relationships
        if (input.parentRelationships) {
          for (const rel of input.parentRelationships) {
            await context.supabase.from('entity_relationships').insert({
              parent_entity_id: rel.parentEntityId,
              child_entity_id: entity.id,
              relationship_type: rel.relationshipType,
              relationship_code: rel.relationshipCode,
              is_primary: rel.isPrimary ?? false,
              valid_from: rel.validFrom,
            });
          }
        }
        
        if (input.childRelationships) {
          for (const rel of input.childRelationships) {
            await context.supabase.from('entity_relationships').insert({
              parent_entity_id: entity.id,
              child_entity_id: rel.childEntityId,
              relationship_type: rel.relationshipType,
              relationship_code: rel.relationshipCode,
              is_primary: rel.isPrimary ?? false,
              valid_from: rel.validFrom,
            });
          }
        }
        
        // Fetch the created entity from the view
        const { data: createdEntity } = await context.supabase
          .from('entity_master')
          .select('*')
          .eq('entity_id', entity.id)
          .single();
        
        return { 
          entity: createdEntity ? mapEntityRow(createdEntity) : null, 
          errors: [] 
        };
      } catch (error: any) {
        return {
          entity: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },
    
    updateEntity: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        const patch: Record<string, unknown> = {
          updated_by: userId,
          updated_at: new Date().toISOString(),
        };
        if (typeof input.entityName === 'string') {
          const entityName = input.entityName.trim();
          if (!entityName) {
            return {
              entity: null,
              errors: [{ field: 'entityName', message: 'Entity name is required', code: 'VALIDATION' }],
            };
          }
          patch.entity_name = entityName;
        }
        if (input.description !== undefined) patch.description = input.description;
        if (typeof input.isActive === 'boolean') patch.is_active = input.isActive;

        // Update master_entities. Only fields present on the input are written,
        // so an attribute save does not clear the name.
        const { data: entity, error: entityError } = await context.supabase
          .from('master_entities')
          .update(patch)
          .eq('id', input.id)
          .select()
          .single();
        
        if (entityError) throw entityError;
        
        // Update attributes (bi-temporal split)
        if (input.attributes) {
          for (const [attrCode, value] of Object.entries(input.attributes)) {
            const { data: attr } = await context.supabase
              .from('attribute_register')
              .select('id, default_precedence_rank')
              .eq('attribute_code', attrCode)
              .single();
            
            if (attr) {
              const raw = value && typeof value === 'object' && 'value' in value
                ? (value as { value: unknown }).value
                : value;
              const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
              if (!text) continue;

              const { data: source, error: sourceError } = await context.supabase
                .schema('entity_instances')
                .from('source_registry')
                .select('id')
                .eq('source_code', 'MANUAL')
                .single();
              if (sourceError || !source?.id) throw sourceError || new Error('Manual source is not registered');

              const numeric = typeof raw === 'number'
                ? raw
                : Number.isFinite(Number(text)) ? Number(text) : null;

              // Replace only the manual source. Other sources stay, and the preference trigger stamps the winner.
              const { error: closeError } = await context.supabase
                .from('entity_attribute_values')
                .update({
                  valid_to: new Date().toISOString().split('T')[0],
                  system_to: new Date().toISOString(),
                })
                .eq('entity_id', input.id)
                .eq('attribute_id', attr.id)
                .eq('source_id', source.id)
                .eq('system_to', '9999-12-31 23:59:59');
              if (closeError) throw closeError;

              // Insert new record
              const { error: insertError } = await context.supabase.from('entity_attribute_values').insert({
                entity_id: input.id,
                attribute_id: attr.id,
                source_id: source.id,
                golden_value: text,
                golden_value_numeric: numeric,
                valid_from: new Date().toISOString().split('T')[0],
                precedence_rank: attr.default_precedence_rank,
                created_by: userId,
              });
              if (insertError) throw insertError;
            }
          }
        }
        
        // Update relationships if provided
        if (input.parentRelationships) {
          // Close existing parent relationships
          await context.supabase
            .from('entity_relationships')
            .update({
              valid_to: new Date().toISOString().split('T')[0],
              system_to: new Date().toISOString(),
            })
            .eq('child_entity_id', input.id)
            .eq('system_to', '9999-12-31 23:59:59');
          
          // Insert new relationships
          for (const rel of input.parentRelationships) {
            await context.supabase.from('entity_relationships').insert({
              parent_entity_id: rel.parentEntityId,
              child_entity_id: input.id,
              relationship_type: rel.relationshipType,
              relationship_code: rel.relationshipCode,
              is_primary: rel.isPrimary ?? false,
              valid_from: rel.validFrom,
            });
          }
        }
        
        if (input.childRelationships) {
          // Close existing child relationships
          await context.supabase
            .from('entity_relationships')
            .update({
              valid_to: new Date().toISOString().split('T')[0],
              system_to: new Date().toISOString(),
            })
            .eq('parent_entity_id', input.id)
            .eq('system_to', '9999-12-31 23:59:59');
          
          // Insert new relationships
          for (const rel of input.childRelationships) {
            await context.supabase.from('entity_relationships').insert({
              parent_entity_id: input.id,
              child_entity_id: rel.childEntityId,
              relationship_type: rel.relationshipType,
              relationship_code: rel.relationshipCode,
              is_primary: rel.isPrimary ?? false,
              valid_from: rel.validFrom,
            });
          }
        }
        
        // Fetch the updated entity from the view
        const { data: updatedEntity } = await context.supabase
          .from('entity_master')
          .select('*')
          .eq('entity_id', input.id)
          .single();
        
        return { 
          entity: updatedEntity ? mapEntityRow(updatedEntity) : null, 
          errors: [] 
        };
      } catch (error: any) {
        return {
          entity: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },
    
    createRelationship: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;

      if (!input.parentEntityId || !input.childEntityId) {
        return {
          relationship: null,
          errors: [
            {
              field: !input.parentEntityId ? 'parentEntityId' : 'childEntityId',
              message: 'Both parentEntityId and childEntityId are required to create a standalone relationship.',
              code: 'VALIDATION_ERROR',
            },
          ],
        };
      }

      try {
        const { data, error } = await context.supabase
          .from('entity_relationships')
          .insert({
            parent_entity_id: input.parentEntityId,
            child_entity_id: input.childEntityId,
            relationship_type: input.relationshipType,
            relationship_code: input.relationshipCode,
            is_primary: input.isPrimary ?? false,
            valid_from: input.validFrom,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        // Fetch related entities to build the relationship object
        const { data: parentEntity } = await context.supabase
          .from('master_entities')
          .select('entity_code, entity_name, domain_code')
          .eq('id', input.parentEntityId)
          .single();
        
        const { data: childEntity } = await context.supabase
          .from('master_entities')
          .select('entity_code, entity_name, domain_code')
          .eq('id', input.childEntityId)
          .single();
        
        const relationship = {
          parentEntityId: data.parent_entity_id,
          parentEntityCode: parentEntity?.entity_code,
          parentEntityName: parentEntity?.entity_name,
          parentDomainCode: parentEntity?.domain_code,
          childEntityId: data.child_entity_id,
          childEntityCode: childEntity?.entity_code,
          childEntityName: childEntity?.entity_name,
          childDomainCode: childEntity?.domain_code,
          relationshipType: data.relationship_type,
          relationshipCode: data.relationship_code,
          isPrimary: data.is_primary,
        };
        
        return { relationship, errors: [] };
      } catch (error: any) {
        return {
          relationship: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },
    
    updateRelationship: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      
      try {
        const { data, error } = await context.supabase
          .from('entity_relationships')
          .update({
            is_primary: input.isPrimary,
            valid_from: input.validFrom,
            valid_to: input.validTo,
          })
          .eq('id', input.id)
          .select()
          .single();
        
        if (error) throw error;
        
        // Fetch related entities
        const { data: parentEntity } = await context.supabase
          .from('master_entities')
          .select('entity_code, entity_name, domain_code')
          .eq('id', data.parent_entity_id)
          .single();
        
        const { data: childEntity } = await context.supabase
          .from('master_entities')
          .select('entity_code, entity_name, domain_code')
          .eq('id', data.child_entity_id)
          .single();
        
        const relationship = {
          parentEntityId: data.parent_entity_id,
          parentEntityCode: parentEntity?.entity_code,
          parentEntityName: parentEntity?.entity_name,
          parentDomainCode: parentEntity?.domain_code,
          childEntityId: data.child_entity_id,
          childEntityCode: childEntity?.entity_code,
          childEntityName: childEntity?.entity_name,
          childDomainCode: childEntity?.domain_code,
          relationshipType: data.relationship_type,
          relationshipCode: data.relationship_code,
          isPrimary: data.is_primary,
        };
        
        return { relationship, errors: [] };
      } catch (error: any) {
        return {
          relationship: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },
    
    deleteRelationship: async (
      _: any,
      args: { id: string },
      context: Context
    ) => {
      try {
        const { error } = await context.supabase
          .from('entity_relationships')
          .delete()
          .eq('id', args.id);
        
        if (error) throw error;
        
        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },
    

    
    createAttribute: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      
      try {
        const clientId = await resolveSchemaClientId(context, input.clientId, { required: false });
        const { data, error } = await context.supabase
          .from('attribute_register')
          .insert({
            attribute_code: input.attributeCode,
            attribute_name: input.attributeName,
            data_type: input.dataType,
            description: input.description,
            unit_of_measure: input.unitOfMeasure,
            validation_regex: input.validationRegex,
            is_required: input.isRequired ?? false,
            is_multi_valued: input.isMultiValued ?? false,
            reference_domain_code: input.referenceDomainCode,
            domain_code: input.domainCode,
            client_id: clientId,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        return {
          attribute: {
            id: data.id,
            attributeCode: data.attribute_code,
            attributeName: data.attribute_name,
            dataType: data.data_type,
            description: data.description,
            unitOfMeasure: data.unit_of_measure,
            isRequired: data.is_required,
            isMultiValued: data.is_multi_valued,
            referenceDomainCode: data.reference_domain_code,
            defaultPrecedenceRank: data.default_precedence_rank,
            clientId: data.client_id ?? null,
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          attribute: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },
    
    createTemplate: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      
      try {
        const clientId = await resolveSchemaClientId(context, input.clientId, { required: false });
        const { data, error } = await context.supabase
          .from('domain_templates')
          .insert({
            template_code: input.templateCode,
            domain_code: input.domainCode,
            template_name: input.templateName,
            description: input.description,
            client_id: clientId,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        return {
          template: {
            id: data.id,
            templateCode: data.template_code,
            domainCode: data.domain_code,
            templateName: data.template_name,
            description: data.description,
            isActive: data.is_active,
            clientId: data.client_id ?? null,
            attributes: [],
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          template: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },
    
    assignAttributeToTemplate: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      
      try {
        const insertRow: Record<string, unknown> = {
          template_id: input.templateId,
          attribute_id: input.attributeId,
          is_required: input.isRequired ?? false,
          precedence_rank: input.precedenceRank ?? 100,
          display_order: input.displayOrder ?? 0,
          display_label: input.displayLabel,
        };
        if (input.defaultPrecedenceChain !== undefined) {
          insertRow.default_precedence_chain = input.defaultPrecedenceChain ?? [];
        }

        const { data, error } = await context.supabase
          .from('template_attribute_assignments')
          .insert(insertRow)
          .select()
          .single();
        
        if (error) throw error;
        
        // Fetch attribute details
        const { data: attr } = await context.supabase
          .from('attribute_register')
          .select('*')
          .eq('id', input.attributeId)
          .single();
        
        return {
          assignment: {
            attributeId: data.attribute_id,
            attribute: {
              id: attr.id,
              attributeCode: attr.attribute_code,
              attributeName: attr.attribute_name,
              dataType: attr.data_type,
              description: attr.description,
              unitOfMeasure: attr.unit_of_measure,
              isRequired: attr.is_required,
              isMultiValued: attr.is_multi_valued,
              referenceDomainCode: attr.reference_domain_code,
              defaultPrecedenceRank: attr.default_precedence_rank,
            },
            isRequired: data.is_required,
            precedenceRank: data.precedence_rank,
            displayOrder: data.display_order,
            displayLabel: data.display_label,
            defaultPrecedenceChain: normalizePrecedenceChain(data.default_precedence_chain),
            chainVersion: normalizeChainVersion(data.chain_version),
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          assignment: null,
          errors: [{ field: '', message: error.message, code: 'ASSIGN_FAILED' }],
        };
      }
    },

    updateTemplateAttribute: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;

      try {
        const updateData: any = {};
        if (input.isRequired !== undefined) updateData.is_required = input.isRequired;
        if (input.precedenceRank !== undefined) updateData.precedence_rank = input.precedenceRank;
        if (input.displayOrder !== undefined) updateData.display_order = input.displayOrder;
        if (input.displayLabel !== undefined) updateData.display_label = input.displayLabel;

        const { data, error } = await context.supabase
          .from('template_attribute_assignments')
          .update(updateData)
          .eq('template_id', input.templateId)
          .eq('attribute_id', input.attributeId)
          .select()
          .single();

        if (error) throw error;

        const { data: attr } = await context.supabase
          .from('attribute_register')
          .select('*')
          .eq('id', input.attributeId)
          .single();

        return {
          assignment: {
            attributeId: data.attribute_id,
            attribute: {
              id: attr.id,
              attributeCode: attr.attribute_code,
              attributeName: attr.attribute_name,
              dataType: attr.data_type,
              description: attr.description,
              unitOfMeasure: attr.unit_of_measure,
              isRequired: attr.is_required,
              isMultiValued: attr.is_multi_valued,
              referenceDomainCode: attr.reference_domain_code,
              defaultPrecedenceRank: attr.default_precedence_rank,
            },
            isRequired: data.is_required,
            precedenceRank: data.precedence_rank,
            displayOrder: data.display_order,
            displayLabel: data.display_label,
            defaultPrecedenceChain: normalizePrecedenceChain(data.default_precedence_chain),
            chainVersion: normalizeChainVersion(data.chain_version),
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          assignment: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    updateTemplateSourcePreference: async (
      _: any,
      args: { input: { templateId: string; attributeId: string; defaultPrecedenceChain: string[] } },
      context: Context
    ) => {
      const { input } = args;
      const chain = normalizePrecedenceChain(input.defaultPrecedenceChain);

      try {
        const { data, error } = await context.supabase
          .from('template_attribute_assignments')
          .update({ default_precedence_chain: chain })
          .eq('template_id', input.templateId)
          .eq('attribute_id', input.attributeId)
          .select()
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          return {
            assignment: null,
            errors: [{
              field: 'attributeId',
              message: 'That attribute is not assigned to this template',
              code: 'NOT_FOUND',
            }],
          };
        }

        const { data: attr, error: attrError } = await context.supabase
          .from('attribute_register')
          .select('*')
          .eq('id', input.attributeId)
          .single();

        if (attrError) throw attrError;

        return {
          assignment: {
            attributeId: data.attribute_id,
            attribute: {
              id: attr.id,
              attributeCode: attr.attribute_code,
              attributeName: attr.attribute_name,
              dataType: attr.data_type,
              description: attr.description,
              unitOfMeasure: attr.unit_of_measure,
              isRequired: attr.is_required,
              isMultiValued: attr.is_multi_valued,
              referenceDomainCode: attr.reference_domain_code,
              defaultPrecedenceRank: attr.default_precedence_rank,
            },
            isRequired: data.is_required,
            precedenceRank: data.precedence_rank,
            displayOrder: data.display_order,
            displayLabel: data.display_label,
            defaultPrecedenceChain: normalizePrecedenceChain(data.default_precedence_chain),
            chainVersion: normalizeChainVersion(data.chain_version),
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          assignment: null,
          errors: [{ field: 'defaultPrecedenceChain', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    reorderTemplateAttributes: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;

      try {
        const updates = input.attributeIds.map((attributeId: string, index: number) =>
          context.supabase
            .from('template_attribute_assignments')
            .update({ display_order: index + 1 })
            .eq('template_id', input.templateId)
            .eq('attribute_id', attributeId)
        );

        await Promise.all(updates);

        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: '', message: error.message, code: 'REORDER_FAILED' }] };
      }
    },

    updateTemplate: async (
      _: any,
      args: { id: string; input: any },
      context: Context
    ) => {
      const { id, input } = args;

      try {
        const updateData: any = { updated_at: new Date().toISOString() };
        if (input.templateName !== undefined) updateData.template_name = input.templateName;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;
        if (input.applicabilityRules !== undefined) updateData.applicability_rules = input.applicabilityRules;

        const { data, error } = await context.supabase
          .from('domain_templates')
          .update(updateData)
          .eq('id', id)
          .select()
          .single();

        if (error) throw error;

        const { data: assignments } = await context.supabase
          .from('template_attribute_assignments')
          .select('*, attribute_register!inner(*)')
          .eq('template_id', data.id);

        return {
          template: {
            id: data.id,
            templateCode: data.template_code,
            domainCode: data.domain_code,
            templateName: data.template_name,
            description: data.description,
            isActive: data.is_active,
            applicabilityRules: data.applicability_rules || {},
            attributes: (assignments || []).map((a: any) => ({
              attributeId: a.attribute_id,
              attribute: {
                id: a.attribute_register.id,
                attributeCode: a.attribute_register.attribute_code,
                attributeName: a.attribute_register.attribute_name,
                dataType: a.attribute_register.data_type,
                description: a.attribute_register.description,
                unitOfMeasure: a.attribute_register.unit_of_measure,
                isRequired: a.attribute_register.is_required,
                isMultiValued: a.attribute_register.is_multi_valued,
                referenceDomainCode: a.attribute_register.reference_domain_code,
                defaultPrecedenceRank: a.attribute_register.default_precedence_rank,
              },
              isRequired: a.is_required,
              precedenceRank: a.precedence_rank,
              displayOrder: a.display_order,
              displayLabel: a.display_label,
              defaultPrecedenceChain: normalizePrecedenceChain(a.default_precedence_chain),
              chainVersion: normalizeChainVersion(a.chain_version),
            })),
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          template: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    unassignAttributeFromTemplate: async (
      _: any,
      args: { templateId: string; attributeId: string },
      context: Context
    ) => {
      const { templateId, attributeId } = args;

      try {
        const { error } = await context.supabase
          .from('template_attribute_assignments')
          .delete()
          .eq('template_id', templateId)
          .eq('attribute_id', attributeId);

        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'UNASSIGN_FAILED' }],
        };
      }
    },


    // Domain Type mutations
    createDomainType: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;

      try {
        const clientId = await resolveSchemaClientId(context, input.clientId, { required: false });
        const { data, error } = await context.supabase
          .from('domain_types')
          .insert({
            domain_code: input.domainCode,
            domain_name: input.domainName,
            description: input.description,
            client_id: clientId,
          })
          .select()
          .single();

        if (error) throw error;

        return {
          domainType: {
            id: data.id,
            domainCode: data.domain_code,
            domainName: data.domain_name,
            description: data.description,
            isActive: data.is_active,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            clientId: data.client_id ?? null,
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          domainType: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    updateDomainType: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;

      try {
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        if (input.domainName !== undefined) updateData.domain_name = input.domainName;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;

        const { data, error } = await context.supabase
          .from('domain_types')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        return {
          domainType: {
            id: data.id,
            domainCode: data.domain_code,
            domainName: data.domain_name,
            description: data.description,
            isActive: data.is_active,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            clientId: data.client_id ?? null,
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          domainType: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    deleteDomainType: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { data: domain, error: fetchError } = await context.supabase
          .from('domain_types')
          .select('domain_code')
          .eq('id', args.id)
          .single();

        if (fetchError) throw fetchError;

        const domainCode = domain.domain_code;

        // Block deletion if the domain type is still referenced anywhere,
        // since domain_code is a natural key with FK references that don't cascade.
        const [entitiesCheck, templatesCheck, attributesCheck] = await Promise.all([
          context.supabase
            .from('master_entities')
            .select('id', { count: 'exact', head: true })
            .eq('domain_code', domainCode),
          context.supabase
            .from('domain_templates')
            .select('id', { count: 'exact', head: true })
            .eq('domain_code', domainCode),
          context.supabase
            .from('attribute_register')
            .select('id', { count: 'exact', head: true })
            .eq('reference_domain_code', domainCode),
        ]);

        const entityCount = entitiesCheck.count || 0;
        const templateCount = templatesCheck.count || 0;
        const attributeCount = attributesCheck.count || 0;

        if (entityCount > 0 || templateCount > 0 || attributeCount > 0) {
          const parts = [];
          if (entityCount > 0) parts.push(`${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}`);
          if (templateCount > 0) parts.push(`${templateCount} template${templateCount === 1 ? '' : 's'}`);
          if (attributeCount > 0) parts.push(`${attributeCount} attribute${attributeCount === 1 ? '' : 's'}`);

          return {
            success: false,
            errors: [
              {
                field: '',
                message: `Cannot delete domain type "${domainCode}" — it is still referenced by ${parts.join(', ')}.`,
                code: 'IN_USE',
              },
            ],
          };
        }

        const { error } = await context.supabase.from('domain_types').delete().eq('id', args.id);
        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },

    createRelationshipType: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;

      try {
        const { data, error } = await context.supabase
          .from('relationship_types')
          .insert({
            relationship_code: input.relationshipCode,
            relationship_name: input.relationshipName,
            parent_domain_code: input.parentDomainCode,
            child_domain_code: input.childDomainCode,
            cardinality: input.cardinality || 'ONE_TO_ONE',
            composite_key: input.compositeKey || [],
            description: input.description,
            client_id: await resolveSchemaClientId(context, input.clientId, { required: false }),
          })
          .select()
          .single();

        if (error) throw error;

        return {
          relationshipType: {
            id: data.id,
            relationshipCode: data.relationship_code,
            relationshipName: data.relationship_name,
            parentDomainCode: data.parent_domain_code,
            childDomainCode: data.child_domain_code,
            cardinality: data.cardinality,
            compositeKey: data.composite_key,
            description: data.description,
            isActive: data.is_active,
            clientId: data.client_id ?? null,
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          relationshipType: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    updateRelationshipType: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;

      try {
        const updateData: Record<string, any> = {};
        if (input.relationshipName !== undefined) updateData.relationship_name = input.relationshipName;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.parentDomainCode !== undefined) updateData.parent_domain_code = input.parentDomainCode;
        if (input.childDomainCode !== undefined) updateData.child_domain_code = input.childDomainCode;
        if (input.cardinality !== undefined) updateData.cardinality = input.cardinality;
        if (input.compositeKey !== undefined) updateData.composite_key = input.compositeKey;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;

        const { data, error } = await context.supabase
          .from('relationship_types')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        return {
          relationshipType: {
            id: data.id,
            relationshipCode: data.relationship_code,
            relationshipName: data.relationship_name,
            parentDomainCode: data.parent_domain_code,
            childDomainCode: data.child_domain_code,
            cardinality: data.cardinality,
            compositeKey: data.composite_key,
            description: data.description,
            isActive: data.is_active,
          },
          errors: [],
        };
      } catch (error: any) {
        return {
          relationshipType: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    deleteRelationshipType: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { data: relType, error: fetchError } = await context.supabase
          .from('relationship_types')
          .select('relationship_code')
          .eq('id', args.id)
          .single();

        if (fetchError) throw fetchError;

        // Block deletion if any live entity relationship instances currently use this type,
        // since entity_relationships.relationship_code has no FK/cascade tie to relationship_types.
        const { count: usageCount } = await context.supabase
          .from('entity_relationships')
          .select('id', { count: 'exact', head: true })
          .eq('relationship_code', relType.relationship_code)
          .eq('system_to', '9999-12-31 23:59:59');

        if ((usageCount || 0) > 0) {
          return {
            success: false,
            errors: [
              {
                field: '',
                message: `Cannot delete relationship type "${relType.relationship_code}" — it is currently used by ${usageCount} relationship${usageCount === 1 ? '' : 's'}.`,
                code: 'IN_USE',
              },
            ],
          };
        }

        const { error } = await context.supabase.from('relationship_types').delete().eq('id', args.id);
        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },

    createEntityIdentifier: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;

      try {
        const { data, error } = await context.supabase
          .from('entity_identifier_definitions')
          .insert({
            domain_code: input.domainCode,
            identifier_code: input.identifierCode,
            identifier_name: input.identifierName,
            attribute_codes: input.attributeCodes,
            is_primary: input.isPrimary ?? false,
            description: input.description,
          })
          .select()
          .single();

        if (error) throw error;

        return {
          identifier: await mapIdentifierRow(data, context),
          errors: [],
        };
      } catch (error: any) {
        return {
          identifier: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    updateEntityIdentifier: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;

      try {
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        if (input.identifierName !== undefined) updateData.identifier_name = input.identifierName;
        if (input.attributeCodes !== undefined) updateData.attribute_codes = input.attributeCodes;
        if (input.isPrimary !== undefined) updateData.is_primary = input.isPrimary;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;

        const { data, error } = await context.supabase
          .from('entity_identifier_definitions')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        return {
          identifier: await mapIdentifierRow(data, context),
          errors: [],
        };
      } catch (error: any) {
        return {
          identifier: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    deleteEntityIdentifier: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await context.supabase
          .from('entity_identifier_definitions')
          .delete()
          .eq('id', args.id);

        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },

  },
};

async function mapIdentifierRow(row: any, context: Context): Promise<any> {
  const { data: domain } = await context.supabase
    .from('domain_types')
    .select('domain_name')
    .eq('domain_code', row.domain_code)
    .single();

  return {
    id: row.id,
    identifierCode: row.identifier_code,
    identifierName: row.identifier_name,
    domainCode: row.domain_code,
    domainName: domain?.domain_name || row.domain_code,
    attributeCodes: row.attribute_codes,
    isPrimary: row.is_primary,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// read_projections.entity_master aggregates parent/child relationships as JSONB
// arrays with snake_case keys (see supabase/migrations/00010_generic_read_projection.sql).
// Each entry only carries fields for the "other" side of the relationship -- the
// entity itself is implied -- so this maps to the nullable EntityRelationship schema
// fields rather than assuming both parent* and child* are present.
function mapParentRelationship(rel: any): any {
  return {
    parentEntityId: rel.parent_entity_id,
    parentEntityCode: rel.parent_entity_code,
    parentEntityName: rel.parent_entity_name,
    parentDomainCode: rel.parent_domain_code,
    childEntityId: null,
    childEntityCode: null,
    childEntityName: null,
    childDomainCode: null,
    relationshipType: rel.relationship_type,
    relationshipCode: rel.relationship_code,
    isPrimary: rel.is_primary,
    members: [],
  };
}

function mapChildRelationship(rel: any): any {
  return {
    parentEntityId: null,
    parentEntityCode: null,
    parentEntityName: null,
    parentDomainCode: null,
    childEntityId: rel.child_entity_id,
    childEntityCode: rel.child_entity_code,
    childEntityName: rel.child_entity_name,
    childDomainCode: rel.child_domain_code,
    relationshipType: rel.relationship_type,
    relationshipCode: rel.relationship_code,
    isPrimary: rel.is_primary,
    members: [],
  };
}

// A position's own name does not say which fund and security it joins.
// For related entities whose domain is an intersection type, attach those constituents.
async function attachCompositeMembers(entity: any, context: Context): Promise<any> {
  const relationships = [...(entity.parentRelationships || []), ...(entity.childRelationships || [])];
  for (const relationship of relationships) relationship.members = relationship.members || [];
  if (relationships.length === 0) return entity;

  const { data: types, error: typeError } = await context.supabase
    .from('intersection_types')
    .select('intersection_code, intersection_type_members(domain_code, display_order)')
    .eq('is_active', true);
  if (typeError) throw typeError;

  const orderByDomain = new Map<string, Map<string, number>>();
  for (const type of types || []) {
    const order = new Map<string, number>();
    for (const member of type.intersection_type_members || []) {
      order.set(member.domain_code, member.display_order ?? 0);
    }
    orderByDomain.set(type.intersection_code, order);
  }
  if (orderByDomain.size === 0) return entity;

  const compositeIds = [...new Set(relationships.flatMap((relationship) => {
    const related = [
      { id: relationship.parentEntityId, domain: relationship.parentDomainCode },
      { id: relationship.childEntityId, domain: relationship.childDomainCode },
    ];
    return related.filter((item) => item.id && orderByDomain.has(item.domain)).map((item) => item.id as string);
  }))];
  if (compositeIds.length === 0) return entity;

  const membersById = new Map<string, Array<{ entityId: string; entityCode: string; entityName: string; domainCode: string }>>();
  for (let index = 0; index < compositeIds.length; index += 100) {
    const { data: rows, error } = await context.supabase
      .from('entity_master')
      .select('entity_id, domain_code, parent_relationships')
      .in('entity_id', compositeIds.slice(index, index + 100));
    if (error) throw error;
    for (const row of rows || []) {
      const order = orderByDomain.get(row.domain_code) || new Map<string, number>();
      const members = (row.parent_relationships || [])
        .map((parent: any) => ({
          entityId: parent.parent_entity_id,
          entityCode: parent.parent_entity_code,
          entityName: parent.parent_entity_name,
          domainCode: parent.parent_domain_code,
        }))
        .filter((member: { entityId: string; entityName: string }) => member.entityId && member.entityName)
        .sort((a: { domainCode: string }, b: { domainCode: string }) =>
          (order.get(a.domainCode) ?? 999) - (order.get(b.domainCode) ?? 999)
        );
      membersById.set(row.entity_id, members);
    }
  }

  for (const relationship of relationships) {
    relationship.members = membersById.get(relationship.parentEntityId)
      || membersById.get(relationship.childEntityId)
      || [];
  }
  return entity;
}

function mapEntityRow(row: any): any {
  return {
    id: row.entity_id,
    entityCode: row.entity_code,
    entityName: row.entity_name,
    domainCode: row.domain_code,
    domainName: row.domain_name,
    templateCode: row.template_code,
    templateName: row.template_name,
    description: row.description,
    isActive: row.is_active,
    attributes: row.attributes || {},
    parentRelationships: (row.parent_relationships || []).map(mapParentRelationship),
    childRelationships: (row.child_relationships || []).map(mapChildRelationship),
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
