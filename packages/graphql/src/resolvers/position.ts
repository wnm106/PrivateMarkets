import { Context } from '../context';

export const positionResolvers = {
  Query: {
    positions: async (_: any, args: any, context: Context) => {
      const { filter, pagination, asOfDate } = args;
      const asOf = asOfDate || new Date().toISOString().split('T')[0];
      
      let query = context.supabase.from('position_master').select('*', { count: 'exact' });
      
      if (filter) {
        if (filter.intersectionCode?.equals) query = query.eq('position_code', filter.intersectionCode.equals);
        if (filter.positionType?.equals) query = query.eq('position_type', filter.positionType.equals);
        if (filter.fundId?.equals) query = query.eq('fund_code', filter.fundId.equals);
        if (filter.securityId?.equals) query = query.eq('security_code', filter.securityId.equals);
        if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      }
      
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;
      
      query = query.range(offset, offset + limit - 1).order('position_code');
      
      const { data, error, count } = await query;
      if (error) throw error;
      
      const edges = (data || []).map((row: any, index: number) => ({
        node: mapPositionRow(row),
        cursor: btoa(String(offset + index)),
      }));
      
      return {
        edges,
        pageInfo: { hasNextPage: (offset + limit) < (count || 0), hasPreviousPage: offset > 0, startCursor: edges[0]?.cursor, endCursor: edges[edges.length - 1]?.cursor },
        totalCount: count || 0,
      };
    },
    
    position: async (_: any, args: any, context: Context) => {
      let query = context.supabase.from('position_master').select('*');
      if (args.id) query = query.eq('position_id', args.id);
      else if (args.intersectionCode) query = query.eq('position_code', args.intersectionCode);
      else return null;
      
      const { data, error } = await query.single();
      if (error) { if (error.code === 'PGRST116') return null; throw error; }
      return mapPositionRow(data);
    },
  },
  
  Position: {
    fund: async (position: any, _: any, context: Context) => {
      if (!position.fundCode) return null;
      const { data } = await context.supabase.from('fund_master').select('*').eq('fund_code', position.fundCode).single();
      return data;
    },
    issuer: async (position: any, _: any, context: Context) => {
      if (!position.issuerCode) return null;
      const { data } = await context.supabase.from('issuer_master').select('*').eq('issuer_code', position.issuerCode).single();
      return data;
    },
    deal: async (position: any, _: any, context: Context) => {
      if (!position.dealCode) return null;
      const { data } = await context.supabase.from('deal_master').select('*').eq('deal_code', position.dealCode).single();
      return data;
    },
    security: async (position: any, _: any, context: Context) => {
      if (!position.securityCode) return null;
      const { data } = await context.supabase.from('security_master').select('*').eq('security_code', position.securityCode).single();
      return data;
    },
  },
  
  Mutation: {
    createPosition: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data, error } = await context.supabase
          .from('dimensional_intersections')
          .insert({
            intersection_code: input.intersectionCode,
            position_type: input.positionType,
            fund_entity_id: input.fundId,
            issuer_entity_id: input.issuerId,
            deal_entity_id: input.dealId,
            security_entity_id: input.securityId,
            quantity: input.quantity,
            currency: input.currency,
            valid_from: input.validFrom,
            created_by: context.user?.id,
          })
          .select().single();
        
        if (error) throw error;
        return { position: { id: data.id, intersectionCode: data.intersection_code }, errors: [] };
      } catch (error: any) {
        return { position: null, errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },
    
    updatePosition: async (_: any, args: { input: any }, context: Context) => {
      const { input } = args;
      try {
        const { data, error } = await context.supabase
          .from('dimensional_intersections')
          .update({ quantity: input.quantity, metadata: input.metadata, updated_at: new Date().toISOString() })
          .eq('id', input.id).select().single();
        
        if (error) throw error;
        return { position: { id: data.id, intersectionCode: data.intersection_code }, errors: [] };
      } catch (error: any) {
        return { position: null, errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
  },
};

function mapPositionRow(row: any): any {
  return {
    id: row.position_id, intersectionCode: row.position_code, positionType: row.position_type,
    quantity: row.quantity, currency: row.currency,
    fundId: row.fund_code, issuerId: row.issuer_code, dealId: row.deal_code, securityId: row.security_code,
    marketValue: row.market_value, costBasis: row.cost_basis,
    unrealizedGainLoss: row.unrealized_gain_loss, realizedGainLoss: row.realized_gain_loss,
    dailyReturn: row.daily_return, ytdReturn: row.ytd_return, metricsDate: row.metrics_date,
    validFrom: row.valid_from, validTo: row.valid_to,
    metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
