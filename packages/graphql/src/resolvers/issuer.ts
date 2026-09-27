import { Context } from '../context';
import { Issuer, IssuerConnection } from '../schema/types';

export const issuerResolvers = {
  Query: {
    issuers: async (
      _: any,
      args: { filter?: any; pagination?: any; asOfDate?: string },
      context: Context
    ): Promise<IssuerConnection> => {
      const { filter, pagination, asOfDate } = args;
      
      let query = context.supabase
        .from('issuer_master')
        .select('*', { count: 'exact' });
      
      if (filter) {
        if (filter.entityCode?.equals) {
          query = query.eq('issuer_code', filter.entityCode.equals);
        }
        if (filter.entityName?.contains) {
          query = query.ilike('issuer_name', `%${filter.entityName.contains}%`);
        }
        if (filter.country?.equals) {
          query = query.eq('country', filter.country.equals);
        }
        if (filter.sector?.equals) {
          query = query.eq('sector', filter.sector.equals);
        }
        if (filter.isActive !== undefined) {
          query = query.eq('is_active', filter.isActive);
        }
      }
      
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1);
      query = query.order('issuer_name');
      
      const { data, error, count } = await query;
      
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapIssuerRow(row),
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
    
    issuer: async (
      _: any,
      args: { id?: string; entityCode?: string; asOfDate?: string },
      context: Context
    ): Promise<Issuer | null> => {
      let query = context.supabase.from('issuer_master').select('*');
      
      if (args.id) {
        query = query.eq('issuer_id', args.id);
      } else if (args.entityCode) {
        query = query.eq('issuer_code', args.entityCode);
      } else {
        return null;
      }
      
      const { data, error } = await query.single();
      
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      
      return mapIssuerRow(data);
    },
  },
  
  Issuer: {
    securities: async (issuer: Issuer, args: any, context: Context) => {
      const { data, error, count } = await context.supabase
        .from('security_master')
        .select('*', { count: 'exact' })
        .eq('issuer_code', issuer.entityCode)
        .limit(args?.pagination?.first || 20);
      
      if (error) throw error;
      
      return {
        edges: (data || []).map((row: any, index: number) => ({
          node: mapSecurityRow(row),
          cursor: btoa(String(index)),
        })),
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: count || 0,
      };
    },
    
    lineage: async (issuer: Issuer, _: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('entity_attribute_values')
        .select(`
          *,
          attribute_register!inner(attribute_code, attribute_name),
          source_registry!inner(source_code, source_name, precedence_rank)
        `)
        .eq('entity_id', issuer.id)
        .eq('valid_to', '9999-12-31')
        .eq('system_to', '9999-12-31 23:59:59');
      
      if (error) throw error;
      
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
    createIssuer: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .insert({
            entity_code: input.entityCode,
            domain_code: 'ISSUER',
            template_id: input.templateId,
            entity_name: input.entityName,
            description: input.description,
            created_by: userId,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        return {
          issuer: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name },
          errors: [],
        };
      } catch (error: any) {
        return {
          issuer: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },
    
    updateIssuer: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      const userId = context.user?.id;
      
      try {
        const { data: entity, error } = await context.supabase
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
        
        if (error) throw error;
        
        return {
          issuer: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name },
          errors: [],
        };
      } catch (error: any) {
        return {
          issuer: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },
  },
};

function mapIssuerRow(row: any): Issuer {
  return {
    id: row.issuer_id,
    entityCode: row.issuer_code,
    entityName: row.issuer_name,
    description: row.description,
    isActive: row.is_active,
    lei: row.lei,
    country: row.country,
    sector: row.sector,
    industry: row.industry,
    marketCap: row.market_cap,
    creditRating: row.credit_rating,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSecurityRow(row: any): any {
  return {
    id: row.security_id,
    entityCode: row.security_code,
    entityName: row.security_name,
    description: row.description,
    isActive: row.is_active,
    isin: row.isin,
    cusip: row.cusip,
    ticker: row.ticker,
    securityType: row.security_type,
    currency: row.currency,
    price: row.price,
    priceDate: row.price_date,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
