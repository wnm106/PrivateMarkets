import { Context } from '../context';
import { Fund, FundConnection } from '../schema/types';

export const fundResolvers = {
  Query: {
    funds: async (
      _: any,
      args: { filter?: any; pagination?: any; asOfDate?: string },
      context: Context
    ): Promise<FundConnection> => {
      const { filter, pagination, asOfDate } = args;
      const asOf = asOfDate || new Date().toISOString().split('T')[0];
      
      // Query from read projection
      let query = context.supabase
        .from('fund_master')
        .select('*', { count: 'exact' });
      
      // Apply filters
      if (filter) {
        if (filter.entityCode?.equals) {
          query = query.eq('fund_code', filter.entityCode.equals);
        }
        if (filter.entityName?.contains) {
          query = query.ilike('fund_name', `%${filter.entityName.contains}%`);
        }
        if (filter.fundStatus?.equals) {
          query = query.eq('fund_status', filter.fundStatus.equals);
        }
        if (filter.isActive !== undefined) {
          query = query.eq('is_active', filter.isActive);
        }
      }
      
      // Apply pagination
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1);
      query = query.order('fund_name');
      
      const { data, error, count } = await query;
      
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapFundRow(row),
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
    },
    
    fund: async (
      _: any,
      args: { id?: string; entityCode?: string; asOfDate?: string },
      context: Context
    ): Promise<Fund | null> => {
      const asOf = args.asOfDate || new Date().toISOString().split('T')[0];
      
      let query = context.supabase.from('fund_master').select('*');
      
      if (args.id) {
        query = query.eq('fund_id', args.id);
      } else if (args.entityCode) {
        query = query.eq('fund_code', args.entityCode);
      } else {
        return null;
      }
      
      const { data, error } = await query.single();
      
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      
      return mapFundRow(data);
    },
  },
  
  Fund: {
    lineage: async (fund: Fund, _: any, context: Context) => {
      // Get field lineage for all attributes
      const { data, error } = await context.supabase
        .from('entity_attribute_values')
        .select(`
          *,
          attribute_register!inner(attribute_code, attribute_name),
          source_registry!inner(source_code, source_name, precedence_rank)
        `)
        .eq('entity_id', fund.id)
        .eq('valid_to', '9999-12-31')
        .eq('system_to', '9999-12-31 23:59:59');
      
      if (error) throw error;
      
      // Group by attribute
      const byAttribute = new Map<string, any[]>();
      (data || []).forEach((row: any) => {
        const code = row.attribute_register.attribute_code;
        if (!byAttribute.has(code)) byAttribute.set(code, []);
        byAttribute.get(code)!.push(row);
      });
      
      return Array.from(byAttribute.entries()).map(([code, values]) => ({
        attributeCode: code,
        attributeName: values[0].attribute_register.attribute_name,
        currentValue: values[0].golden_value,
        competingValues: values.map((v: any) => ({
          source: v.source_registry.source_code,
          sourceName: v.source_registry.source_name,
          value: v.golden_value,
          precedenceRank: v.precedence_rank,
          validFrom: v.valid_from,
          validTo: v.valid_to,
          confidenceScore: v.confidence_score,
        })),
        resolutionRule: values[0].resolution_rule_applied,
        lastUpdated: values[0].system_from,
      }));
    },
  },
  
  Mutation: {
    createFund: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        // Create master entity
        const { data: entity, error: entityError } = await context.supabase
          .from('master_entities')
          .insert({
            entity_code: input.entityCode,
            domain_code: 'FUND',
            template_id: input.templateId,
            entity_name: input.entityName,
            description: input.description,
            created_by: userId,
          })
          .select()
          .single();
        
        if (entityError) throw entityError;
        
        // Insert attributes if provided
        if (input.attributes?.length) {
          for (const attr of input.attributes) {
            await insertAttribute(context, entity.id, attr, userId);
          }
        }
        
        return {
          fund: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name },
          errors: [],
        };
      } catch (error: any) {
        return {
          fund: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },
    
    updateFund: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        // Update master entity
        const { data: entity, error: entityError } = await context.supabase
          .from('master_entities')
          .update({
            entity_name: input.entityName,
            description: input.description,
            is_active: input.isActive,
            updated_by: userId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.id)
          .select()
          .single();
        
        if (entityError) throw entityError;
        
        // Update attributes if provided
        if (input.attributes?.length) {
          for (const attr of input.attributes) {
            await insertAttribute(context, entity.id, attr, userId);
          }
        }
        
        return {
          fund: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name },
          errors: [],
        };
      } catch (error: any) {
        return {
          fund: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },
  },
};

function mapFundRow(row: any): Fund {
  return {
    id: row.fund_id,
    entityCode: row.fund_code,
    entityName: row.fund_name,
    description: row.description,
    isActive: row.is_active,
    nav: row.nav,
    navCurrency: row.nav_currency,
    navDate: row.nav_date,
    inceptionDate: row.inception_date,
    fundStatus: row.fund_status,
    fundType: row.fund_type,
    manager: row.manager,
    aum: row.aum,
    navSource: row.nav_source,
    lastUpdated: row.last_updated,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertAttribute(
  context: Context,
  entityId: string,
  attr: any,
  userId?: string
) {
  // Get attribute definition
  const { data: attrDef } = await context.supabase
    .from('attribute_register')
    .select('*')
    .eq('attribute_code', attr.attributeCode)
    .single();
  
  if (!attrDef) throw new Error(`Attribute not found: ${attr.attributeCode}`);
  
  // Get source
  const sourceId = attr.sourceId || (
    await context.supabase
      .from('source_registry')
      .select('id')
      .eq('source_code', 'MANUAL')
      .single()
  ).data?.id;
  
  // Insert into golden master
  await context.supabase.from('entity_attribute_values').insert({
    entity_id: entityId,
    attribute_id: attrDef.id,
    source_id: sourceId,
    golden_value: attr.value,
    golden_value_numeric: attr.valueNumeric,
    golden_value_date: attr.valueDate,
    golden_value_timestamp: attr.valueTimestamp,
    golden_value_boolean: attr.valueBoolean,
    valid_from: attr.validFrom || new Date().toISOString().split('T')[0],
    precedence_rank: attrDef.default_precedence_rank,
    confidence_score: attr.confidenceScore,
    created_by: userId,
  });
}
