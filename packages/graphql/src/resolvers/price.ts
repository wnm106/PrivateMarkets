import { Context } from '../context';

export const priceResolvers = {
  Query: {
    prices: async (_: any, args: any, context: Context) => {
      const { filter, pagination } = args;
      
      let query = context.supabase.from('master_entities').select(`
        *,
        entity_attribute_values(valid_from, valid_to, golden_value_numeric, golden_value_date,
          attribute_register(attribute_code), source_registry(source_code))
      `, { count: 'exact' }).eq('domain_code', 'PRICE');
      
      if (filter) {
        if (filter.entityCode?.equals) query = query.eq('entity_code', filter.entityCode.equals);
        if (filter.currency?.equals) query = query.eq('currency', filter.currency.equals);
        if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      }
      
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1).order('entity_name');
      
      const { data, error, count } = await query;
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapPriceRow(row),
        cursor: btoa(String(offset + index)),
      }));
      
      return {
        edges,
        pageInfo: { hasNextPage: (offset + limit) < (count || 0), hasPreviousPage: offset > 0, startCursor: edges[0]?.cursor, endCursor: edges[edges.length - 1]?.cursor },
        totalCount: count || 0,
      };
    },
    
    price: async (_: any, args: any, context: Context) => {
      let query = context.supabase.from('master_entities').select(`
        *,
        entity_attribute_values(valid_from, valid_to, golden_value_numeric, golden_value_date,
          attribute_register(attribute_code), source_registry(source_code))
      `).eq('domain_code', 'PRICE');
      
      if (args.id) query = query.eq('id', args.id);
      else if (args.entityCode) query = query.eq('entity_code', args.entityCode);
      else return null;
      
      const { data, error } = await query.single();
      if (error) { if (error.code === 'PGRST116') return null; throw error; }
      return mapPriceRow(data);
    },
  },
  
  Price: {
    security: async (price: any, _: any, context: Context) => {
      if (!price.securityId) return null;
      const { data } = await context.supabase.from('security_master').select('*').eq('security_id', price.securityId).single();
      return data;
    },
    lineage: async (price: any, _: any, context: Context) => {
      const { data } = await context.supabase
        .from('entity_attribute_values')
        .select(`*, attribute_register!inner(attribute_code, attribute_name), source_registry!inner(source_code, source_name, precedence_rank)`)
        .eq('entity_id', price.id)
        .eq('valid_to', '9999-12-31').eq('system_to', '9999-12-31 23:59:59');
      
      const byAttribute = new Map<string, any[]>();
      (data || []).forEach((row: any) => {
        const code = row.attribute_register.attribute_code;
        if (!byAttribute.has(code)) byAttribute.set(code, []);
        byAttribute.get(code)!.push(row);
      });
      
      return Array.from(byAttribute.entries()).map(([code, values]) => ({
        attributeCode: code, attributeName: values[0].attribute_register.attribute_name,
        currentValue: values[0].golden_value,
        competingValues: values.map((v: any) => ({
          source: v.source_registry.source_code, sourceName: v.source_registry.source_name,
          value: v.golden_value, precedenceRank: v.precedence_rank, validFrom: v.valid_from, validTo: v.valid_to,
        })),
        resolutionRule: values[0].resolution_rule_applied, lastUpdated: values[0].system_from,
      }));
    },
  },
  
  Mutation: {
    createPrice: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .insert({ entity_code: input.entityCode, domain_code: 'PRICE', entity_name: input.entityName, created_by: context.user?.id })
          .select().single();
        if (error) throw error;
        return { price: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name }, errors: [] };
      } catch (error: any) {
        return { price: null, errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },
    
    updatePrice: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .update({ updated_by: context.user?.id, updated_at: new Date().toISOString() })
          .eq('id', input.id).select().single();
        if (error) throw error;
        return { price: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name }, errors: [] };
      } catch (error: any) {
        return { price: null, errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
  },
};

function mapPriceRow(row: any): any {
  const attrs = row.entity_attribute_values || [];
  const getAttr = (code: string) => attrs.find((a: any) => a.attribute_register?.attribute_code === code);
  
  return {
    id: row.id, entityCode: row.entity_code, entityName: row.entity_name,
    description: row.description, isActive: row.is_active,
    price: getAttr('PRICE')?.golden_value_numeric,
    priceDate: getAttr('PRICE_DATE')?.golden_value_date,
    currency: getAttr('CURRENCY')?.golden_value || 'USD',
    priceType: getAttr('PRICE_TYPE')?.golden_value,
    source: getAttr('PRICE')?.source_registry?.source_code,
    metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
