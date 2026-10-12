import { Context } from '../context';
import {
  PrecedenceRule,
  PrecedenceCondition,
  PrecedenceChainItem,
  CreatePrecedenceRuleInput,
  UpdatePrecedenceRuleInput,
} from '../schema/types';

export const precedenceResolvers = {
  Query: {
    precedenceRules: async (
      _: any,
      args: { domainCode?: string; attributeCode?: string; isActive?: boolean },
      context: Context
    ) => {
      let query = context.supabase
        .from('precedence_rules')
        .select(`
          *,
          conditions:precedence_rule_conditions(*),
          chain:precedence_rule_chain(*)
        `)
        .order('created_at', { ascending: false });

      if (args.domainCode) {
        query = query.eq('domain_code', args.domainCode);
      }

      if (args.attributeCode) {
        query = query.eq('attribute_code', args.attributeCode);
      }

      if (args.isActive !== undefined) {
        query = query.eq('is_active', args.isActive);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching precedence rules:', error);
        throw new Error('Failed to fetch precedence rules');
      }

      return (data || []).map(mapPrecedenceRule);
    },

    precedenceRule: async (_: any, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase
        .from('precedence_rules')
        .select(`
          *,
          conditions:precedence_rule_conditions(*),
          chain:precedence_rule_chain(*)
        `)
        .eq('id', args.id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        console.error('Error fetching precedence rule:', error);
        throw new Error('Failed to fetch precedence rule');
      }

      return mapPrecedenceRule(data);
    },
  },

  Mutation: {
    createPrecedenceRule: async (
      _: any,
      args: { input: CreatePrecedenceRuleInput },
      context: Context
    ) => {
      try {
        const { input } = args;

        // Create the rule
        const { data: ruleData, error: ruleError } = await context.supabase
          .from('precedence_rules')
          .insert({
            rule_code: input.ruleCode,
            rule_name: input.ruleName,
            domain_code: input.domainCode,
            template_code: input.templateCode,
            attribute_code: input.attributeCode,
            priority_tier: input.priorityTier || 'field-specific',
            is_active: input.isActive !== undefined ? input.isActive : true,
            created_by: context.user?.email,
            metadata: input.metadata || {},
          })
          .select()
          .single();

        if (ruleError) throw ruleError;

        const ruleId = ruleData.id;

        // Create conditions
        if (input.conditions && input.conditions.length > 0) {
          const conditionsToInsert = input.conditions.map((cond, idx) => ({
            rule_id: ruleId,
            condition_group: cond.conditionGroup || 1,
            condition_order: cond.conditionOrder || idx + 1,
            attribute_code: cond.attributeCode,
            operator: cond.operator,
            value: cond.value,
            logic_operator: cond.logicOperator || 'AND',
          }));

          const { error: condError } = await context.supabase
            .from('precedence_rule_conditions')
            .insert(conditionsToInsert);

          if (condError) throw condError;
        }

        // Create chain
        if (input.chain && input.chain.length > 0) {
          const chainToInsert = input.chain.map((item, idx) => ({
            rule_id: ruleId,
            chain_order: item.chainOrder || idx + 1,
            source_code: item.sourceCode,
            condition_type: item.conditionType || 'if_value_present',
          }));

          const { error: chainError } = await context.supabase
            .from('precedence_rule_chain')
            .insert(chainToInsert);

          if (chainError) throw chainError;
        }

        // Fetch the complete rule
        const { data: completeRule, error: fetchError } = await context.supabase
          .from('precedence_rules')
          .select(`
            *,
            conditions:precedence_rule_conditions(*),
            chain:precedence_rule_chain(*)
          `)
          .eq('id', ruleId)
          .single();

        if (fetchError) throw fetchError;

        return {
          precedenceRule: mapPrecedenceRule(completeRule),
          errors: [],
        };
      } catch (error: any) {
        console.error('Error creating precedence rule:', error);
        return {
          precedenceRule: null,
          errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    updatePrecedenceRule: async (
      _: any,
      args: { id: string; input: UpdatePrecedenceRuleInput },
      context: Context
    ) => {
      try {
        const { id, input } = args;

        // Update the rule
        const updateData: any = {
          updated_at: new Date().toISOString(),
        };

        if (input.ruleCode !== undefined) updateData.rule_code = input.ruleCode;
        if (input.ruleName !== undefined) updateData.rule_name = input.ruleName;
        if (input.domainCode !== undefined) updateData.domain_code = input.domainCode;
        if (input.templateCode !== undefined) updateData.template_code = input.templateCode;
        if (input.attributeCode !== undefined) updateData.attribute_code = input.attributeCode;
        if (input.priorityTier !== undefined) updateData.priority_tier = input.priorityTier;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;
        if (input.metadata !== undefined) updateData.metadata = input.metadata;

        const { data: ruleData, error: ruleError } = await context.supabase
          .from('precedence_rules')
          .update(updateData)
          .eq('id', id)
          .select()
          .single();

        if (ruleError) throw ruleError;

        // Update conditions if provided
        if (input.conditions !== undefined) {
          // Delete existing conditions
          await context.supabase
            .from('precedence_rule_conditions')
            .delete()
            .eq('rule_id', id);

          // Insert new conditions
          if (input.conditions.length > 0) {
            const conditionsToInsert = input.conditions.map((cond, idx) => ({
              rule_id: id,
              condition_group: cond.conditionGroup || 1,
              condition_order: cond.conditionOrder || idx + 1,
              attribute_code: cond.attributeCode,
              operator: cond.operator,
              value: cond.value,
              logic_operator: cond.logicOperator || 'AND',
            }));

            const { error: condError } = await context.supabase
              .from('precedence_rule_conditions')
              .insert(conditionsToInsert);

            if (condError) throw condError;
          }
        }

        // Update chain if provided
        if (input.chain !== undefined) {
          // Delete existing chain
          await context.supabase
            .from('precedence_rule_chain')
            .delete()
            .eq('rule_id', id);

          // Insert new chain
          if (input.chain.length > 0) {
            const chainToInsert = input.chain.map((item, idx) => ({
              rule_id: id,
              chain_order: item.chainOrder || idx + 1,
              source_code: item.sourceCode,
              condition_type: item.conditionType || 'if_value_present',
            }));

            const { error: chainError } = await context.supabase
              .from('precedence_rule_chain')
              .insert(chainToInsert);

            if (chainError) throw chainError;
          }
        }

        // Fetch the complete rule
        const { data: completeRule, error: fetchError } = await context.supabase
          .from('precedence_rules')
          .select(`
            *,
            conditions:precedence_rule_conditions(*),
            chain:precedence_rule_chain(*)
          `)
          .eq('id', id)
          .single();

        if (fetchError) throw fetchError;

        return {
          precedenceRule: mapPrecedenceRule(completeRule),
          errors: [],
        };
      } catch (error: any) {
        console.error('Error updating precedence rule:', error);
        return {
          precedenceRule: null,
          errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    deletePrecedenceRule: async (
      _: any,
      args: { id: string },
      context: Context
    ) => {
      try {
        const { error } = await context.supabase
          .from('precedence_rules')
          .delete()
          .eq('id', args.id);

        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        console.error('Error deleting precedence rule:', error);
        return {
          success: false,
          errors: [{ field: 'general', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },

    updateAttributeDefaultPrecedence: async (
      _: any,
      args: { attributeCode: string; chain: string[] },
      context: Context
    ) => {
      try {
        const { attributeCode, chain } = args;

        // Find the template_attribute_assignment for this attribute
        const { data: assignment, error: findError } = await context.supabase
          .from('template_attribute_assignments')
          .select('id')
          .eq('attribute_id', attributeCode)
          .limit(1)
          .single();

        if (findError && findError.code !== 'PGRST116') {
          throw findError;
        }

        if (!assignment) {
          return {
            success: false,
            errors: [{ field: 'attributeCode', message: 'Attribute not found in any template', code: 'NOT_FOUND' }],
          };
        }

        // Update the default_precedence_chain
        const { error: updateError } = await context.supabase
          .from('template_attribute_assignments')
          .update({ default_precedence_chain: chain })
          .eq('id', assignment.id);

        if (updateError) throw updateError;

        return { success: true, errors: [] };
      } catch (error: any) {
        console.error('Error updating default precedence:', error);
        return {
          success: false,
          errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    reorderPrecedenceChain: async (
      _: any,
      args: { ruleId: string; chain: Array<{ sourceCode: string; chainOrder: number }> },
      context: Context
    ) => {
      try {
        const { ruleId, chain } = args;

        // Delete existing chain
        await context.supabase
          .from('precedence_rule_chain')
          .delete()
          .eq('rule_id', ruleId);

        // Insert new chain with updated order
        if (chain.length > 0) {
          const chainToInsert = chain.map((item) => ({
            rule_id: ruleId,
            chain_order: item.chainOrder,
            source_code: item.sourceCode,
            condition_type: 'if_value_present',
          }));

          const { error: chainError } = await context.supabase
            .from('precedence_rule_chain')
            .insert(chainToInsert);

          if (chainError) throw chainError;
        }

        return { success: true, errors: [] };
      } catch (error: any) {
        console.error('Error reordering chain:', error);
        return {
          success: false,
          errors: [{ field: 'general', message: error.message, code: 'REORDER_FAILED' }],
        };
      }
    },
  },
};

/**
 * Map database row to GraphQL PrecedenceRule type
 */
function mapPrecedenceRule(row: any): PrecedenceRule {
  return {
    id: row.id,
    ruleCode: row.rule_code,
    ruleName: row.rule_name,
    domainCode: row.domain_code,
    templateCode: row.template_code,
    attributeCode: row.attribute_code,
    priorityTier: row.priority_tier,
    isActive: row.is_active,
    conditions: (row.conditions || []).map(mapPrecedenceCondition),
    chain: (row.chain || []).map(mapPrecedenceChainItem).sort((a: PrecedenceChainItem, b: PrecedenceChainItem) => a.chainOrder - b.chainOrder),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    metadata: row.metadata,
  };
}

function mapPrecedenceCondition(row: any): PrecedenceCondition {
  return {
    id: row.id,
    ruleId: row.rule_id,
    conditionGroup: row.condition_group,
    conditionOrder: row.condition_order,
    attributeCode: row.attribute_code,
    operator: row.operator,
    value: row.value,
    logicOperator: row.logic_operator,
    createdAt: row.created_at,
  };
}

function mapPrecedenceChainItem(row: any): PrecedenceChainItem {
  return {
    id: row.id,
    ruleId: row.rule_id,
    chainOrder: row.chain_order,
    sourceCode: row.source_code,
    conditionType: row.condition_type,
    createdAt: row.created_at,
  };
}
