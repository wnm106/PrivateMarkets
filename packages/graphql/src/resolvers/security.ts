import { Context } from '../context';

export const securityResolvers = {
  Query: {
    securities: async (_: any, args: any, context: Context) => {
      const { filter, pagination } = args;
      
      let query = context.supabase
        .from('security_master')
        .select('*', { count: 'exact' });
      
      if (filter) {
        if (filter.entityCode?.equals) query = query.eq('security_code', filter.entityCode.equals);
        if (filter.isin?.equals) query = query.eq('isin', filter.isin.equals);
        if (filter.cusip?.equals) query = query.eq('cusip', filter.cusip.equals);
        if (filter.ticker?.equals) query = query.eq('ticker', filter.ticker.equals);
        if (filter.securityType?.equals) query = query.eq('security_type', filter.securityType.equals);
        if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      }
      
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1).order('security_name');
      
      const { data, error, count } = await query;
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapSecurityRow(row),
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
    
    security: async (_: any, args: any, context: Context) => {
      let query = context.supabase.from('security_master').select('*');
      
      if (args.id) query = query.eq('security_id', args.id);
      else if (args.entityCode) query = query.eq('security_code', args.entityCode);
      else if (args.isin) query = query.eq('isin', args.isin);
      else if (args.cusip) query = query.eq('cusip', args.cusip);
      else return null;
      
      const { data, error } = await query.single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      return mapSecurityRow(data);
    },
  },
  
  Security: {
    issuer: async (security: any, _: any, context: Context) => {
      if (!security.issuerCode) return null;
      const { data } = await context.supabase
        .from('issuer_master')
        .select('*')
        .eq('issuer_code', security.issuerCode)
        .single();
      return data;
    },
    
    lineage: async (security: any, _: any, context: Context) => {
      const { data } = await context.supabase
        .from('entity_attribute_values')
        .select(`*, attribute_register!inner(attribute_code, attribute_name), source_registry!inner(source_code, source_name, precedence_rank)`)
        .eq('entity_id', security.id)
        .eq('valid_to', '9999-12-31')
        .eq('system_to', '9999-12-31 23:59:59');
      
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
        })),
        resolutionRule: values[0].resolution_rule_applied,
        lastUpdated: values[0].system_from,
      }));
    },
  },
  
  Mutation: {
    createSecurity: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .insert({
            entity_code: input.entityCode,
            domain_code: 'SECURITY',
            entity_name: input.entityName,
            description: input.description,
            created_by: context.user?.id,
          })
          .select()
          .single();
        
        if (error) throw error;
        return { security: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name }, errors: [] };
      } catch (error: any) {
        return { security: null, errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },
    
    updateSecurity: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .update({ entity_name: input.entityName, description: input.description, is_active: input.isActive, updated_by: context.user?.id, updated_at: new Date().toISOString() })
          .eq('id', input.id)
          .select()
          .single();
        
        if (error) throw error;
        return { security: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name }, errors: [] };
      } catch (error: any) {
        return { security: null, errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
  },
};

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
    exchange: row.exchange,
    price: row.price,
    priceDate: row.price_date,
    issuerId: row.issuer_code,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
