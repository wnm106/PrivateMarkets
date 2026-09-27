import { Context } from '../context';

export const dealResolvers = {
  Query: {
    deals: async (_: any, args: any, context: Context) => {
      const { filter, pagination } = args;
      
      let query = context.supabase.from('deal_master').select('*', { count: 'exact' });
      
      if (filter) {
        if (filter.entityCode?.equals) query = query.eq('deal_code', filter.entityCode.equals);
        if (filter.dealType?.equals) query = query.eq('deal_type', filter.dealType.equals);
        if (filter.status?.equals) query = query.eq('status', filter.status.equals);
        if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      }
      
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1).order('deal_name');
      
      const { data, error, count } = await query;
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapDealRow(row),
        cursor: btoa(String(offset + index)),
      }));
      
      return {
        edges,
        pageInfo: { hasNextPage: (offset + limit) < (count || 0), hasPreviousPage: offset > 0, startCursor: edges[0]?.cursor, endCursor: edges[edges.length - 1]?.cursor },
        totalCount: count || 0,
      };
    },
    
    deal: async (_: any, args: any, context: Context) => {
      let query = context.supabase.from('deal_master').select('*');
      if (args.id) query = query.eq('deal_id', args.id);
      else if (args.entityCode) query = query.eq('deal_code', args.entityCode);
      else return null;
      
      const { data, error } = await query.single();
      if (error) { if (error.code === 'PGRST116') return null; throw error; }
      return mapDealRow(data);
    },
  },
  
  Deal: {
    issuer: async (deal: any, _: any, context: Context) => {
      if (!deal.issuerCode) return null;
      const { data } = await context.supabase.from('issuer_master').select('*').eq('issuer_code', deal.issuerCode).single();
      return data;
    },
    fund: async (deal: any, _: any, context: Context) => {
      if (!deal.fundCode) return null;
      const { data } = await context.supabase.from('fund_master').select('*').eq('fund_code', deal.fundCode).single();
      return data;
    },
    lineage: async (deal: any, _: any, context: Context) => {
      const { data } = await context.supabase
        .from('entity_attribute_values')
        .select(`*, attribute_register!inner(attribute_code, attribute_name), source_registry!inner(source_code, source_name, precedence_rank)`)
        .eq('entity_id', deal.id)
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
          source: v.source_registry.source_code, sourceName: v.source_registry.source_name,
          value: v.golden_value, precedenceRank: v.precedence_rank, validFrom: v.valid_from, validTo: v.valid_to,
        })),
        resolutionRule: values[0].resolution_rule_applied,
        lastUpdated: values[0].system_from,
      }));
    },
  },
  
  Mutation: {
    createDeal: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .insert({ entity_code: input.entityCode, domain_code: 'DEAL', entity_name: input.entityName, description: input.description, created_by: context.user?.id })
          .select().single();
        if (error) throw error;
        return { deal: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name }, errors: [] };
      } catch (error: any) {
        return { deal: null, errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },
    
    updateDeal: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data: entity, error } = await context.supabase
          .from('master_entities')
          .update({ entity_name: input.entityName, description: input.description, is_active: input.isActive, updated_by: context.user?.id, updated_at: new Date().toISOString() })
          .eq('id', input.id).select().single();
        if (error) throw error;
        return { deal: { id: entity.id, entityCode: entity.entity_code, entityName: entity.entity_name }, errors: [] };
      } catch (error: any) {
        return { deal: null, errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
  },
};

function mapDealRow(row: any): any {
  return {
    id: row.deal_id, entityCode: row.deal_code, entityName: row.deal_name,
    description: row.description, isActive: row.is_active,
    dealDate: row.deal_date, dealType: row.deal_type, dealValue: row.deal_value,
    currency: row.currency, status: row.status,
    issuerId: row.issuer_code, fundId: row.fund_code,
    metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
