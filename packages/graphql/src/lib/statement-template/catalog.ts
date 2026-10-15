import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogAttribute } from './types';

export async function loadStatementCatalog(supabase: SupabaseClient, domainCode: string): Promise<CatalogAttribute[]> {
  const code = domainCode.trim().toUpperCase();
  const { data: attributes, error } = await supabase
    .from('attribute_register')
    .select('id, attribute_code, attribute_name, data_type, domain_code');
  if (error) throw new Error(error.message);

  const rows = (attributes || []).filter((row: { domain_code?: string | null }) => !row.domain_code || row.domain_code === code);
  const ids = rows.map((row: { id: string }) => row.id);
  const aliasesByAttribute = new Map<string, string[]>();

  if (ids.length > 0) {
    const { data: aliases, error: aliasError } = await supabase
      .from('attribute_aliases')
      .select('attribute_id, alias_label, domain_code, is_active')
      .eq('is_active', true)
      .in('attribute_id', ids);
    if (!aliasError) {
      for (const alias of aliases || []) {
        if (alias.domain_code && alias.domain_code !== code) continue;
        const list = aliasesByAttribute.get(alias.attribute_id) || [];
        list.push(alias.alias_label);
        aliasesByAttribute.set(alias.attribute_id, list);
      }
    }
  }

  return rows.map((row: { id: string; attribute_code: string; attribute_name: string; data_type: string }) => ({
    attributeCode: row.attribute_code,
    attributeName: row.attribute_name,
    dataType: row.data_type,
    aliases: aliasesByAttribute.get(row.id) || [],
  }));
}
