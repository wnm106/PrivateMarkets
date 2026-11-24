import { aliasPhrase, assembleAttributeSearch, loadAliasWords, NO_ALIAS_WORDS, type AliasSearchResult } from './semantic-aliases';

/**
 * Find a field, an entity type, or a record-name word from the words a person used.
 * Chat (`search_attributes`) and the Excel formula builder (`searchAttributes`) both read
 * this, so a word finds the same field in both places.
 */

type SearchClient = { from: (table: string) => any; rpc?: (fn: string, args?: Record<string, unknown>) => any };

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
  // The words of the client this session is working in: its own aliases win over the shared ones.
  const [attributes, words, domains] = await Promise.all([
    supabase.from('attribute_register').select(ATTRIBUTE_COLUMNS).or(`attribute_code.ilike.%${code}%,attribute_name.ilike.%${phrase}%,description.ilike.%${phrase}%`).order('attribute_code').limit(cap),
    loadAliasWords(supabase).catch(() => NO_ALIAS_WORDS),
    supabase.from('domain_types').select('domain_code, domain_name').eq('is_active', true),
  ]);
  if (attributes.error) throw attributes.error;
  const wanted = aliasPhrase(phrase);
  const matches = (alias: { aliasLabel: string; aliasCode?: string | null }) =>
    aliasPhrase(alias.aliasLabel).includes(wanted) || aliasPhrase(alias.aliasCode || '').includes(wanted);
  const attributeAliases = wanted ? words.attributeAliases.filter(matches).slice(0, cap) : [];
  const aliasIds = [...new Set(attributeAliases.map((alias) => alias.attributeId))];
  const known = new Set((attributes.data || []).map((row: { id: string }) => row.id));
  const missing = aliasIds.filter((id) => !known.has(id));
  const extra = missing.length
    ? await supabase.from('attribute_register').select(ATTRIBUTE_COLUMNS).in('id', missing)
    : { data: [], error: null };
  if (extra.error) throw extra.error;
  const found = assembleAttributeSearch(phrase, {
    attributes: [...(attributes.data || []), ...(extra.data || [])],
    attributeAliases: attributeAliases.map((alias) => ({
      attributeId: alias.attributeId,
      aliasLabel: alias.aliasLabel,
      aliasCode: alias.aliasCode || undefined,
      domainCode: alias.domainCode,
    })),
    nameAliases: words.nameAliases,
    domainAliases: words.domainAliases,
    domains: domains.error ? [] : (domains.data || []).map((row: any) => ({ domainCode: row.domain_code, domainName: row.domain_name })),
    limit: cap,
  });
  return { ...found, query: phrase };
}
