/** On-read calculations are not stored. The record screen asks for them and shows the result. */

export interface OnReadValue {
  attributeCode: string;
  attributeName: string;
  valueText: string;
}

export interface OnReadLineage {
  attributeCode: string;
  attributeName?: string | null;
  currentValue: string | null;
  competingValues: Array<{
    source: string;
    sourceName?: string | null;
    value: string | null;
    precedenceRank?: number | null;
    validFrom?: string | null;
    validTo?: string | null;
    confidenceScore?: number | null;
    receivedAt?: string | null;
  }>;
  resolutionRule?: string | null;
  lastUpdated?: string | null;
  calcDirty?: boolean;
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

function missingOnReadRpc(error: { code?: string; message?: string }): boolean {
  const code = String(error.code || '');
  const message = String(error.message || '');
  return code === 'PGRST202' || /could not find the function/i.test(message) || /on_read_attribute_values/i.test(message);
}

/** A past knowledge date or timestamp. Today, or a time that has not arrived, means current knowledge. */
export function knowledgeCutoff(knowledgeDate?: string | null): string | null {
  if (!knowledgeDate) return null;
  const trimmed = knowledgeDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const today = new Date().toISOString().slice(0, 10);
    if (trimmed >= today) return null;
    return `${trimmed}T23:59:59.999Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() >= Date.now() - 1000) return null;
  return parsed.toISOString();
}

export async function loadOnReadValues(
  supabase: RpcClient,
  entityId: string,
  asOf?: string | null,
  knowledge?: string | null,
): Promise<OnReadValue[]> {
  const { data, error } = await supabase.rpc('on_read_attribute_values', {
    p_entity_id: entityId,
    p_as_of: asOf || null,
    p_knowledge: knowledgeCutoff(knowledge),
  });
  if (error) {
    if (missingOnReadRpc(error)) return [];
    throw error;
  }
  return ((data || []) as Array<Record<string, unknown>>).flatMap((row) => {
    const attributeCode = String(row.attribute_code || '');
    const valueText = row.value_text == null ? '' : String(row.value_text);
    if (!attributeCode || !valueText) return [];
    return [{
      attributeCode,
      attributeName: String(row.attribute_name || attributeCode),
      valueText,
    }];
  });
}

function manualWinner(row: OnReadLineage): boolean {
  const winner = row.competingValues?.[0];
  return String(winner?.source || '').toUpperCase() === 'MANUAL' && winner?.value != null && String(winner.value) !== '';
}

/** A manual entry stays. Every other open value yields to the calculation. */
export function mergeOnReadLineage<T extends OnReadLineage>(rows: T[], reads: OnReadValue[], asOf: string): T[] {
  const byCode = new Map(rows.map((row) => [row.attributeCode, row]));
  for (const read of reads) {
    const existing = byCode.get(read.attributeCode);
    if (existing && manualWinner(existing)) continue;
    const calculated = {
      source: 'CALCULATED',
      sourceName: 'Calculated',
      value: read.valueText,
      precedenceRank: 1,
      validFrom: asOf,
      validTo: '9999-12-31',
      confidenceScore: null,
      receivedAt: null,
    };
    if (!existing) {
      byCode.set(read.attributeCode, {
        attributeCode: read.attributeCode,
        attributeName: read.attributeName,
        currentValue: read.valueText,
        competingValues: [calculated],
        resolutionRule: 'Calculated',
        lastUpdated: null,
        calcDirty: false,
      } as T);
      continue;
    }
    existing.currentValue = read.valueText;
    existing.resolutionRule = 'Calculated';
    existing.competingValues = [
      calculated,
      ...existing.competingValues.filter((value) => String(value.source).toUpperCase() !== 'CALCULATED'),
    ];
  }
  return [...byCode.values()];
}

export async function fillBlankOnReadAttributes(
  supabase: RpcClient,
  entity: { id: string; attributes?: Record<string, unknown> },
  asOf?: string | null,
  knowledge?: string | null,
): Promise<void> {
  const reads = await loadOnReadValues(supabase, entity.id, asOf, knowledge);
  if (!reads.length) return;
  const attributes = entity.attributes || {};
  for (const read of reads) {
    const current = attributes[read.attributeCode];
    const value = current && typeof current === 'object' && 'value' in (current as Record<string, unknown>)
      ? (current as { value?: unknown }).value
      : current;
    if (value !== null && value !== undefined && String(value) !== '') continue;
    attributes[read.attributeCode] = { value: read.valueText, source_code: 'CALCULATED' };
  }
  entity.attributes = attributes;
}
