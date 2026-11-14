export interface FundBoardResultRow {
  rule_id: string;
  anchor_entity_id: string;
  group_by_value?: string | null;
  rank_position?: number | null;
  status: string;
  evaluated_at?: string | null;
  id?: string | null;
}

function grainKey(row: FundBoardResultRow) {
  return `${row.rule_id}|${row.anchor_entity_id}|${row.group_by_value || ''}|${row.rank_position ?? ''}`;
}

function newer(candidate: FundBoardResultRow, current: FundBoardResultRow) {
  const nextAt = candidate.evaluated_at || '';
  const currentAt = current.evaluated_at || '';
  if (nextAt !== currentAt) return nextAt > currentAt;
  return (candidate.id || '') > (current.id || '');
}

/**
 * Keep the newest row for each fund, group, and rank. When that fund already
 * has a scored row for the rule, a NO_DATA row is only a placeholder and is
 * dropped. A fund whose every latest row is NO_DATA still shows that fact.
 */
export function selectLatestFundResults<T extends FundBoardResultRow>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = grainKey(row);
    const current = latest.get(key);
    if (!current || newer(row, current)) latest.set(key, row);
  }
  const scored = new Set<string>();
  for (const row of latest.values()) {
    if (row.status !== 'NO_DATA') scored.add(`${row.rule_id}|${row.anchor_entity_id}`);
  }
  return [...latest.values()].filter((row) => (
    row.status !== 'NO_DATA' || !scored.has(`${row.rule_id}|${row.anchor_entity_id}`)
  ));
}

export function parseFundBoardResultPayload(data: unknown): FundBoardResultRow[] {
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  return Array.isArray(parsed) ? parsed : [];
}
