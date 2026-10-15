import type { SupabaseClient } from '@supabase/supabase-js';
import { buildStatementTemplate } from '../lib/statement-template/build';
import { loadStatementCatalog } from '../lib/statement-template/catalog';
import { statementKindCode } from '../lib/statement-template/entities';
import { applyStatementTemplate, requireDomain } from '../lib/statement-template/persist';
import type { StatementSource } from '../lib/statement-template/types';

function mapSection(row: any) {
  return {
    id: row.id,
    sectionCode: row.section_code,
    sectionName: row.section_name,
    displayOrder: row.display_order,
    description: row.description || null,
  };
}

function mapAlias(row: any) {
  const attribute = row.attribute_register || {};
  return {
    id: row.id,
    aliasLabel: row.alias_label,
    aliasCode: row.alias_code,
    matchKind: row.match_kind,
    confidence: Number(row.confidence ?? 1),
    domainCode: row.domain_code,
    attributeCode: attribute.attribute_code || row.attribute_code || '',
    attributeName: attribute.attribute_name || row.attribute_name || '',
  };
}

async function loadSections(supabase: SupabaseClient, templateId: string) {
  const { data, error } = await supabase
    .from('template_sections')
    .select('id, section_code, section_name, display_order, description')
    .eq('template_id', templateId)
    .order('display_order');
  if (error) return [];
  return (data || []).map(mapSection);
}

async function loadAliases(supabase: SupabaseClient, templateId: string, domainCode?: string) {
  const { data: assignments, error: assignmentError } = await supabase
    .from('template_attribute_assignments')
    .select('attribute_id')
    .eq('template_id', templateId);
  if (assignmentError) return [];
  const attributeIds = [...new Set((assignments || []).map((row: { attribute_id: string }) => row.attribute_id))];
  if (attributeIds.length === 0) return [];

  let query = supabase
    .from('attribute_aliases')
    .select('id, alias_label, alias_code, match_kind, confidence, domain_code, attribute_id')
    .eq('is_active', true)
    .in('attribute_id', attributeIds);
  const safeDomain = String(domainCode || '').replace(/[^A-Z0-9_]/g, '');
  if (safeDomain) query = query.or(`domain_code.eq.${safeDomain},domain_code.is.null`);
  const { data, error } = await query;
  if (error) return [];

  const rows = data || [];
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((row: any) => row.attribute_id))];
  const { data: attributes } = await supabase
    .from('attribute_register')
    .select('id, attribute_code, attribute_name')
    .in('id', ids);
  const byId = new Map((attributes || []).map((row: any) => [row.id, row]));
  return rows.map((row: any) => mapAlias({ ...row, attribute_register: byId.get(row.attribute_id) }));
}

export const statementTemplateResolvers = {
  Query: {
    previewStatementTemplate: async (_: unknown, args: { input: any }, context: { supabase: SupabaseClient }) => {
      const input = args.input || {};
      const domainCode = await requireDomain(context.supabase, input.domainCode);
      if (!domainCode) throw new Error('Choose an entity type.');
      const sources: StatementSource[] = (input.sources || []).map((source: any) => ({
        sourceName: String(source.sourceName || 'Statement'),
        sourceKind: source.sourceKind === 'image' || source.sourceKind === 'file' ? source.sourceKind : 'paste',
        text: String(source.text || ''),
      }));
      const catalog = await loadStatementCatalog(context.supabase, domainCode);
      return buildStatementTemplate(sources, catalog, { statementKind: statementKindCode(input.statementKind) });
    },
  },

  Mutation: {
    applyStatementTemplate: async (_: unknown, args: { input: any }, context: { supabase: SupabaseClient }) => {
      return applyStatementTemplate(context.supabase, args.input);
    },
  },

  Template: {
    sections: async (parent: any, _: unknown, context: { supabase: SupabaseClient }) => {
      if (Array.isArray(parent?.sections)) return parent.sections;
      if (!parent?.id) return [];
      return loadSections(context.supabase, parent.id);
    },
    aliases: async (parent: any, _: unknown, context: { supabase: SupabaseClient }) => {
      if (Array.isArray(parent?.aliases)) return parent.aliases;
      if (!parent?.id && !parent?.domainCode) return [];
      return loadAliases(context.supabase, parent.id, parent.domainCode);
    },
  },
};
