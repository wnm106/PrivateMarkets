/** Values in force at an as-of date and a knowledge time. A missing row stays missing. */

type TemporalClient = {
  from: (...args: any[]) => any;
  schema: (name: string) => { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> };
};

export function calendarDay(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : new Date().toISOString().slice(0, 10);
}

export function knowledgeInstant(value: unknown): string {
  const text = String(value ?? '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!text) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text >= today ? new Date().toISOString() : `${text}T23:59:59.999Z`;
  }
  const parsed = new Date(text.length === 16 ? `${text}:00` : text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** Lists skip the temporal read when the caller is asking for now. */
export function needsTemporalRead(asOfDate: unknown, knowledgeDate: unknown): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (calendarDay(asOfDate) !== today) return true;
  const text = String(knowledgeDate ?? '').trim();
  if (!text || (/^\d{4}-\d{2}-\d{2}$/.test(text) && text >= today)) return false;
  const parsed = Date.parse(text.length === 16 ? `${text}:00` : text);
  return Number.isFinite(parsed) && parsed < Date.now() - 1000;
}

export async function overlayTemporalAttributes(
  supabase: TemporalClient,
  nodes: Array<{ id: string; attributes: Record<string, unknown> }>,
  asOfDate: unknown,
  knowledgeDate: unknown,
  domainCode?: string,
) {
  const ids = nodes.map((node) => node.id).filter(Boolean);
  if (!ids.length) return;
  let definitions = supabase.from('attribute_register').select('id, attribute_code');
  if (domainCode) definitions = definitions.eq('domain_code', domainCode);
  const { data: defs, error } = await definitions;
  if (error) throw error;
  const codeOf = new Map((defs || []).map((row: { id: string; attribute_code: string }) => [row.id, row.attribute_code]));
  const attributeIds = [...codeOf.keys()];
  if (!attributeIds.length) {
    for (const node of nodes) node.attributes = {};
    return;
  }

  const asOf = calendarDay(asOfDate);
  const knowledge = knowledgeInstant(knowledgeDate);
  const byEntity = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < ids.length; index += 20) {
    const slice = ids.slice(index, index + 20);
    const { data, error: rpcError } = await supabase.schema('golden_master').rpc('winning_attribute_values', {
      p_entity_ids: slice,
      p_attribute_ids: attributeIds,
      p_as_of: asOf,
      p_knowledge: knowledge,
      p_require_text: false,
    });
    if (rpcError) throw rpcError;
    for (const row of (data || []) as Array<Record<string, unknown>>) {
      const code = codeOf.get(String(row.attribute_id));
      if (!code) continue;
      const bag = byEntity.get(String(row.entity_id)) || {};
      bag[code] = {
        value: row.golden_value,
        value_numeric: row.golden_value_numeric,
        value_date: row.golden_value_date,
        value_timestamp: row.golden_value_timestamp,
        source_id: row.source_id,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
      };
      byEntity.set(String(row.entity_id), bag);
    }
  }
  for (const node of nodes) node.attributes = byEntity.get(node.id) || {};
}
