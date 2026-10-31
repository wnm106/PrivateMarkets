import type { SupabaseClient } from '@supabase/supabase-js';

export type SequenceTier = 'template' | 'attribute' | 'source';

export interface AttributeSequence {
  chain: string[];
  tier: SequenceTier;
}

function codes(chain: unknown): string[] {
  if (!Array.isArray(chain)) return [];
  return chain.filter((code): code is string => typeof code === 'string' && code.length > 0 && code !== 'MANUAL');
}

function storedChain(column: unknown, metadata: unknown): string[] {
  const fromColumn = codes(column);
  if (fromColumn.length > 0) return fromColumn;
  const stored = metadata && typeof metadata === 'object'
    ? (metadata as { defaultPrecedenceChain?: unknown }).defaultPrecedenceChain
    : undefined;
  return codes(stored);
}

export function sequencePosition(sourceCode: string, chain: string[], registryRank: number): number {
  const index = chain.indexOf(sourceCode);
  if (index >= 0) return index;
  const rank = Number.isFinite(registryRank) ? registryRank : 9999;
  return chain.length * 1000 + rank;
}

export function sequenceLabel(sequence: AttributeSequence): string {
  if (sequence.tier === 'template') return 'Template sequence';
  if (sequence.tier === 'attribute') return 'Global attribute sequence';
  return 'Data source sequence';
}

export function storedRuleLabel(code: string | null | undefined): string | null {
  if (code === 'TEMPLATE_SEQUENCE') return 'Template sequence';
  if (code === 'ATTRIBUTE_SEQUENCE') return 'Global attribute sequence';
  if (code === 'DATA_SOURCE_SEQUENCE') return 'Data source sequence';
  return null;
}

export function hasStoredValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value) !== '';
}

export function pickPersistedWinner<T extends { golden_source_id?: string | null; source_id?: string | null; golden_value?: unknown }>(values: T[]): T | undefined {
  const persisted = values.find((row) =>
    Boolean(row.golden_source_id) && row.source_id === row.golden_source_id && hasStoredValue(row.golden_value)
  );
  if (persisted) return persisted;
  return values.find((row) => hasStoredValue(row.golden_value)) || values[0];
}

export async function loadAttributeSequences(
  supabase: SupabaseClient,
  entityId: string,
  attributeCodes: string[],
): Promise<Map<string, AttributeSequence>> {
  const unique = [...new Set(attributeCodes.filter(Boolean))];
  const result = new Map<string, AttributeSequence>();
  if (unique.length === 0) return result;

  const [{ data: entity }, { data: attributes, error: attributeError }, { data: sources, error: sourceError }] = await Promise.all([
    supabase.from('master_entities').select('template_id').eq('id', entityId).maybeSingle(),
    supabase.from('attribute_register').select('id, attribute_code, metadata').in('attribute_code', unique),
    supabase.schema('entity_instances').from('source_registry').select('source_code, precedence_rank').eq('is_active', true).order('precedence_rank', { ascending: true }),
  ]);
  if (attributeError) throw attributeError;
  if (sourceError) throw sourceError;

  const sourceChain = (sources || [])
    .map((source: { source_code: string }) => source.source_code)
    .filter((code: string) => code && code !== 'MANUAL');
  const attributeRows = attributes || [];
  const templateChains = new Map<string, string[]>();

  if (entity?.template_id && attributeRows.length > 0) {
    const { data: assignments, error: assignmentError } = await supabase
      .from('template_attribute_assignments')
      .select('attribute_id, default_precedence_chain')
      .eq('template_id', entity.template_id)
      .in('attribute_id', attributeRows.map((attribute: { id: string }) => attribute.id));
    if (assignmentError) throw assignmentError;
    const codeById = new Map(attributeRows.map((attribute: { id: string; attribute_code: string }) => [attribute.id, attribute.attribute_code]));
    for (const assignment of assignments || []) {
      const chain = codes(assignment.default_precedence_chain);
      const code = codeById.get(assignment.attribute_id);
      if (code && chain.length > 0) templateChains.set(code, chain);
    }
  }

  for (const code of unique) {
    const templateChain = templateChains.get(code);
    if (templateChain && templateChain.length > 0) {
      result.set(code, { chain: templateChain, tier: 'template' });
      continue;
    }
    const attribute = attributeRows.find((row: { attribute_code: string }) => row.attribute_code === code);
    const attributeChain = storedChain(undefined, attribute?.metadata);
    if (attributeChain.length > 0) {
      result.set(code, { chain: attributeChain, tier: 'attribute' });
      continue;
    }
    result.set(code, { chain: sourceChain, tier: 'source' });
  }

  return result;
}
