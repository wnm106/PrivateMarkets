import { SupabaseClient } from '@supabase/supabase-js';

export const referenceListResolvers = {
  Query: {
    referenceLists: async (_: any, args: { domainCode?: string; isActive?: boolean }, { supabase }: { supabase: SupabaseClient }) => {
      const { data, error } = await supabase
        .from('reference_list_summary')
        .select('*')
        .order('list_name');

      if (error) {
        console.error('[referenceLists] Error:', error);
        throw new Error('Failed to fetch reference lists');
      }

      let lists = (data || []).map(mapReferenceListSummary);
      if (args.domainCode) lists = lists.filter((l: any) => l.domainCode === args.domainCode);
      if (args.isActive !== undefined) lists = lists.filter((l: any) => l.isActive === args.isActive);
      return lists;
    },

    referenceList: async (_: any, args: { id?: string; listCode?: string }, { supabase }: { supabase: SupabaseClient }) => {
      let query = supabase.from('reference_list_summary').select('*').limit(1);
      if (args.id) query = query.eq('id', args.id);
      else if (args.listCode) query = query.eq('list_code', args.listCode);
      else return null;

      const { data, error } = await query.maybeSingle();
      if (error) throw new Error('Failed to fetch reference list');
      if (!data) return null;

      const list: any = mapReferenceListSummary(data);
      const { data: values } = await supabase
        .from('reference_list_values')
        .select('*')
        .eq('list_id', data.id)
        .order('display_order');
      list.values = (values || []).map(mapReferenceListValue);
      return list;
    },

    normalizeValue: async (_: any, args: { listCode: string; values: string[] }, { supabase }: { supabase: SupabaseClient }) => {
      const { data, error } = await supabase
        .rpc('batch_normalize_values', {
          p_list_code: args.listCode,
          p_input_values: args.values,
        });

      if (error) {
        console.error('[normalizeValue] RPC error:', error);
        return normalizeInJs(args.listCode, args.values, supabase);
      }

      const results = Array.isArray(data) ? data : (data ? JSON.parse(data as any) : []);
      return results.map((r: any) => ({
        normalized: r.normalized || false,
        input: r.input,
        canonicalCode: r.canonical_code || null,
        canonicalLabel: r.canonical_label || null,
        matchType: r.match_type || null,
        confidence: r.confidence || null,
        message: r.message || null,
      }));
    },
  },

  Mutation: {
    createReferenceList: async (_: any, args: { input: any }, { supabase }: { supabase: SupabaseClient }) => {
      const { input } = args;
      const { data, error } = await supabase
        .from('reference_list_summary')
        .insert({
          list_code: input.listCode,
          list_name: input.listName,
          domain_code: input.domainCode || null,
          description: input.description || null,
        })
        .select()
        .single();

      if (error) return { referenceList: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { referenceList: { ...mapReferenceListSummary(data), values: [] }, errors: [] };
    },

    updateReferenceList: async (_: any, args: { input: any }, { supabase }: { supabase: SupabaseClient }) => {
      const { input } = args;
      const updateData: any = {};
      if (input.listName !== undefined) updateData.list_name = input.listName;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.isActive !== undefined) updateData.is_active = input.isActive;

      const { data, error } = await supabase
        .from('reference_list_summary')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) return { referenceList: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { referenceList: mapReferenceListSummary(data), errors: [] };
    },

    deleteReferenceList: async (_: any, args: { id: string }, { supabase }: { supabase: SupabaseClient }) => {
      await supabase.from('attribute_register').update({ reference_list_code: null }).eq('reference_list_code', args.id);
      const { error } = await supabase.from('reference_list_summary').delete().eq('id', args.id);
      if (error) return { success: false, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { success: true, errors: [] };
    },

    addReferenceListValue: async (_: any, args: { input: any }, { supabase }: { supabase: SupabaseClient }) => {
      const { input } = args;
      const { data, error } = await supabase
        .from('reference_list_values')
        .insert({
          list_id: input.listId,
          value_code: input.valueCode,
          value_label: input.valueLabel,
          display_order: input.displayOrder || 0,
          synonyms: input.synonyms || [],
        })
        .select()
        .single();

      if (error) return { value: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { value: mapReferenceListValue(data), errors: [] };
    },

    updateReferenceListValue: async (_: any, args: { input: any }, { supabase }: { supabase: SupabaseClient }) => {
      const { input } = args;
      const updateData: any = {};
      if (input.valueLabel !== undefined) updateData.value_label = input.valueLabel;
      if (input.displayOrder !== undefined) updateData.display_order = input.displayOrder;
      if (input.isActive !== undefined) updateData.is_active = input.isActive;
      if (input.synonyms !== undefined) updateData.synonyms = input.synonyms;

      const { data, error } = await supabase
        .from('reference_list_values')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) return { value: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { value: mapReferenceListValue(data), errors: [] };
    },

    deleteReferenceListValue: async (_: any, args: { id: string }, { supabase }: { supabase: SupabaseClient }) => {
      const { error } = await supabase.from('reference_list_values').delete().eq('id', args.id);
      if (error) return { success: false, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { success: true, errors: [] };
    },

    addValueSynonyms: async (_: any, args: { input: { valueId: string; synonyms: string[] } }, { supabase }: { supabase: SupabaseClient }) => {
      const { data: current, error: fetchError } = await supabase
        .from('reference_list_values')
        .select('synonyms')
        .eq('id', args.input.valueId)
        .single();
      if (fetchError) return { value: null, errors: [{ field: 'general', message: fetchError.message, code: 'DATABASE_ERROR' }] };

      const existing: string[] = current?.synonyms || [];
      const newSynonyms = [...new Set([...existing, ...args.input.synonyms])];
      const { data, error } = await supabase
        .from('reference_list_values')
        .update({ synonyms: newSynonyms })
        .eq('id', args.input.valueId)
        .select()
        .single();
      if (error) return { value: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { value: mapReferenceListValue(data), errors: [] };
    },

    removeValueSynonyms: async (_: any, args: { input: { valueId: string; synonyms: string[] } }, { supabase }: { supabase: SupabaseClient }) => {
      const { data: current, error: fetchError } = await supabase
        .from('reference_list_values')
        .select('synonyms')
        .eq('id', args.input.valueId)
        .single();
      if (fetchError) return { value: null, errors: [{ field: 'general', message: fetchError.message, code: 'DATABASE_ERROR' }] };

      const existing: string[] = current?.synonyms || [];
      const toRemove = new Set(args.input.synonyms.map(s => s.toLowerCase()));
      const updated = existing.filter(s => !toRemove.has(s.toLowerCase()));
      const { data, error } = await supabase
        .from('reference_list_values')
        .update({ synonyms: updated })
        .eq('id', args.input.valueId)
        .select()
        .single();
      if (error) return { value: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { value: mapReferenceListValue(data), errors: [] };
    },

    linkAttributeToList: async (_: any, args: { attributeId: string; listCode: string }, { supabase }: { supabase: SupabaseClient }) => {
      const { data, error } = await supabase
        .from('attribute_register')
        .update({ reference_list_code: args.listCode, data_type: 'REFERENCE_LIST' })
        .eq('id', args.attributeId)
        .select()
        .single();
      if (error) return { attribute: null, errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }] };
      return { attribute: mapAttributeDefinition(data), errors: [] };
    },
  },

  AttributeDefinition: {
    referenceList: async (parent: any, _: any, { supabase }: { supabase: SupabaseClient }) => {
      if (!parent.referenceListCode) return null;
      const { data, error } = await supabase
        .from('reference_list_summary')
        .select('*')
        .eq('list_code', parent.referenceListCode)
        .maybeSingle();
      if (error || !data) return null;
      return mapReferenceListSummary(data);
    },
  },
};

// ============================================================
// Helper mappers
// ============================================================

function mapReferenceListSummary(row: any) {
  return {
    id: row.id,
    listCode: row.list_code,
    listName: row.list_name,
    domainCode: row.domain_code,
    description: row.description,
    isActive: row.is_active !== false,
    activeValueCount: row.active_value_count || 0,
    totalValueCount: row.total_value_count || 0,
    totalSynonymCount: row.total_synonym_count || 0,
    linkedAttributeCount: row.linked_attribute_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReferenceListValue(row: any) {
  return {
    id: row.id,
    listId: row.list_id,
    valueCode: row.value_code,
    valueLabel: row.value_label,
    displayOrder: row.display_order || 0,
    isActive: row.is_active !== false,
    synonyms: row.synonyms || [],
    metadata: row.metadata || {},
  };
}

function mapAttributeDefinition(row: any) {
  return {
    id: row.id,
    attributeCode: row.attribute_code,
    attributeName: row.attribute_name,
    dataType: row.data_type,
    description: row.description,
    unitOfMeasure: row.unit_of_measure,
    isRequired: row.is_required || false,
    isMultiValued: row.is_multi_valued || false,
    referenceDomainCode: row.reference_domain_code,
    referenceListCode: row.reference_list_code,
    domainCode: row.domain_code,
    defaultPrecedenceRank: row.default_precedence_rank || 100,
    isDerived: row.is_derived || false,
    displayFormat: row.display_format,
    listValues: row.list_values || [],
    validationRules: row.validation_rules || {},
    defaultValue: row.default_value,
    displaySection: row.display_section || 'General',
    displayGroup: row.display_group || 0,
    isEditable: row.is_editable !== false,
    isVisible: row.is_visible !== false,
  };
}

/**
 * Fallback JS normalization when RPC is not available
 */
async function normalizeInJs(
  listCode: string,
  values: string[],
  supabase: SupabaseClient
): Promise<any[]> {
  const { data: listRow } = await supabase
    .from('reference_list_summary')
    .select('id')
    .eq('list_code', listCode)
    .maybeSingle();

  if (!listRow) {
    return values.map(v => ({
      normalized: false, input: v, canonicalCode: null, canonicalLabel: null,
      matchType: null, confidence: null, message: 'Reference list not found: ' + listCode,
    }));
  }

  const { data: listValues } = await supabase
    .from('reference_list_values')
    .select('value_code, value_label, synonyms')
    .eq('list_id', listRow.id)
    .eq('is_active', true);

  const entries = listValues || [];

  return values.map(inputValue => {
    if (!inputValue || !inputValue.trim()) {
      return { normalized: false, input: inputValue, canonicalCode: null, canonicalLabel: null, matchType: null, confidence: null, message: 'Empty input value' };
    }
    const normalized = inputValue.trim().toLowerCase();

    const codeMatch = entries.find(e => e.value_code.toLowerCase() === normalized);
    if (codeMatch) return { normalized: true, input: inputValue, canonicalCode: codeMatch.value_code, canonicalLabel: codeMatch.value_label, matchType: 'exact_code', confidence: null, message: null };

    const labelMatch = entries.find(e => e.value_label.toLowerCase() === normalized);
    if (labelMatch) return { normalized: true, input: inputValue, canonicalCode: labelMatch.value_code, canonicalLabel: labelMatch.value_label, matchType: 'exact_label', confidence: null, message: null };

    const synonymMatch = entries.find(e =>
      (e.synonyms || []).some((s: string) => s.trim().toLowerCase() === normalized)
    );
    if (synonymMatch) return { normalized: true, input: inputValue, canonicalCode: synonymMatch.value_code, canonicalLabel: synonymMatch.value_label, matchType: 'synonym', confidence: null, message: null };

    const fuzzyMatch = entries.find(e =>
      e.value_label.toLowerCase().includes(normalized) ||
      (e.synonyms || []).some((s: string) => s.trim().toLowerCase().includes(normalized))
    );
    if (fuzzyMatch) return { normalized: true, input: inputValue, canonicalCode: fuzzyMatch.value_code, canonicalLabel: fuzzyMatch.value_label, matchType: 'fuzzy', confidence: 'low', message: null };

    return { normalized: false, input: inputValue, canonicalCode: null, canonicalLabel: null, matchType: null, confidence: null, message: 'No matching canonical value found' };
  });
}
