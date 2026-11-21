import { assembleAttributeSearch, type AliasSearchResult } from './semantic-aliases';

/**
 * Find a field, an entity type, or a record-name word from the words a person used.
 * Chat (`search_attributes`) and the Excel formula builder (`searchAttributes`) both read
 * this, so a word finds the same field in both places.
 */

type SearchClient = { from: (table: string) => any };

const ATTRIBUTE_COLUMNS = 'id, attribute_code, attribute_name, description, data_type, reference_domain_code, domain_code';

export async function fetchAttributeSearch(
  supabase: SearchClient,
  query: string,
  limit?: number,
): Promise<AliasSearchResult & { query: string }> {
  const phrase = String(query || '').replace(/[%_,()*]/g, ' ').trim().slice(0, 80);
  if (!phrase) throw new Error('query is required');
  const code = phrase.toUpperCase().replace(/\s+/g, '_');
  const cap = Math.min(Math.max(Number(limit) || 15, 1), 30);
  const [attributes, attributeAliases, nameAliases, domainAliases, domains] = await Promise.all([
    supabase.from('attribute_register').select(ATTRIBUTE_COLUMNS).or(`attribute_code.ilike.%${code}%,attribute_name.ilike.%${phrase}%,description.ilike.%${phrase}%`).order('attribute_code').limit(cap),
    supabase.from('attribute_aliases').select('attribute_id, alias_label, alias_code, domain_code').eq('is_active', true).or(`alias_label.ilike.%${phrase}%,alias_code.ilike.%${code}%`).limit(cap),
    supabase.from('entity_name_aliases').select('domain_code, alias_label, alias_code').eq('is_active', true).or(`alias_label.ilike.%${phrase}%,alias_code.ilike.%${code}%`).limit(cap),
    supabase.from('domain_aliases').select('domain_code, alias_label, alias_code').eq('is_active', true).or(`alias_label.ilike.%${phrase}%,alias_code.ilike.%${code}%`).limit(cap),
    supabase.from('domain_types').select('domain_code, domain_name').eq('is_active', true),
  ]);
  if (attributes.error) throw attributes.error;
  const aliasIds = [...new Set((attributeAliases.error ? [] : attributeAliases.data || []).map((row: { attribute_id: string }) => row.attribute_id))];
  const known = new Set((attributes.data || []).map((row: { id: string }) => row.id));
  const missing = aliasIds.filter((id) => !known.has(id));
  const extra = missing.length
    ? await supabase.from('attribute_register').select(ATTRIBUTE_COLUMNS).in('id', missing)
    : { data: [], error: null };
  if (extra.error) throw extra.error;
  const found = assembleAttributeSearch(phrase, {
    attributes: [...(attributes.data || []), ...(extra.data || [])],
    attributeAliases: attributeAliases.error ? [] : (attributeAliases.data || []).map((row: any) => ({
      attributeId: row.attribute_id,
      aliasLabel: row.alias_label,
      aliasCode: row.alias_code,
      domainCode: row.domain_code,
    })),
    nameAliases: nameAliases.error ? [] : (nameAliases.data || []).map((row: any) => ({
      domainCode: row.domain_code,
      aliasLabel: row.alias_label,
      aliasCode: row.alias_code,
    })),
    domainAliases: domainAliases.error ? [] : (domainAliases.data || []).map((row: any) => ({
      domainCode: row.domain_code,
      aliasLabel: row.alias_label,
      aliasCode: row.alias_code,
    })),
    domains: domains.error ? [] : (domains.data || []).map((row: any) => ({ domainCode: row.domain_code, domainName: row.domain_name })),
    limit: cap,
  });
  return { ...found, query: phrase };
}
