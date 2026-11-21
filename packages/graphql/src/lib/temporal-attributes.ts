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

/** One winning value: the row that resolves an attribute on a record at an as-of date and knowledge time. */
export interface WinningValueRow {
  entity_id: string;
  attribute_id: string;
  source_id: string | null;
  golden_value: string | null;
  golden_value_numeric: number | string | null;
  golden_value_date: string | null;
  golden_value_timestamp: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

/**
 * The winning value of each attribute on each record, as of a date and a knowledge time.
 * `golden_master.winning_attribute_values` decides the winner; this only batches the call.
 */
export async function loadWinningValues(
  supabase: TemporalClient,
  entityIds: readonly string[],
  attributeIds: readonly string[],
  asOfDate: unknown,
  knowledgeDate: unknown,
): Promise<WinningValueRow[]> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  const attributes = [...new Set(attributeIds.filter(Boolean))];
  if (!ids.length || !attributes.length) return [];
  const asOf = calendarDay(asOfDate);
  const knowledge = knowledgeInstant(knowledgeDate);
  const rows: WinningValueRow[] = [];
  for (let index = 0; index < ids.length; index += 20) {
    const slice = ids.slice(index, index + 20);
    const { data, error: rpcError } = await supabase.schema('golden_master').rpc('winning_attribute_values', {
      p_entity_ids: slice,
      p_attribute_ids: attributes,
      p_as_of: asOf,
      p_knowledge: knowledge,
      p_require_text: false,
    });
    if (rpcError) throw rpcError;
    for (const row of (data || []) as Array<Record<string, unknown>>) {
      rows.push({
        entity_id: String(row.entity_id),
        attribute_id: String(row.attribute_id),
        source_id: row.source_id == null ? null : String(row.source_id),
        golden_value: row.golden_value == null ? null : String(row.golden_value),
        golden_value_numeric: (row.golden_value_numeric ?? null) as number | string | null,
        golden_value_date: row.golden_value_date == null ? null : String(row.golden_value_date),
        golden_value_timestamp: row.golden_value_timestamp == null ? null : String(row.golden_value_timestamp),
        valid_from: row.valid_from == null ? null : String(row.valid_from),
        valid_to: row.valid_to == null ? null : String(row.valid_to),
      });
    }
  }
  return rows;
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
  const codeOf = new Map<string, string>((defs || []).map((row: { id: string; attribute_code: string }) => [row.id, row.attribute_code]));
  const attributeIds = [...codeOf.keys()];
  if (!attributeIds.length) {
    for (const node of nodes) node.attributes = {};
    return;
  }

  const byEntity = new Map<string, Record<string, unknown>>();
  for (const row of await loadWinningValues(supabase, ids, attributeIds, asOfDate, knowledgeDate)) {
    const code = codeOf.get(row.attribute_id);
    if (!code) continue;
    const bag = byEntity.get(row.entity_id) || {};
    bag[code] = {
      value: row.golden_value,
      value_numeric: row.golden_value_numeric,
      value_date: row.golden_value_date,
      value_timestamp: row.golden_value_timestamp,
      source_id: row.source_id,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
    };
    byEntity.set(row.entity_id, bag);
  }
  for (const node of nodes) node.attributes = byEntity.get(node.id) || {};
}
