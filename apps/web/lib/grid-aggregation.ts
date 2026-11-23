/**
 * How a numeric column totals its rows when a grid is grouped.
 *
 * The attribute register's aggregation type decides (SUM, AVG, MIN, MAX,
 * COUNT, WEIGHTED_AVG). An attribute with none set totals by its data type:
 * amounts and counts add up, rates and ratios average. Other types show no
 * total.
 */

export type GridAggFunc = string | ((params: any) => number | null);

/** Aggregation for a data type when the register sets none. */
export function defaultAggregation(dataType: string | null | undefined): string {
  const type = String(dataType || '').toUpperCase();
  if (type === 'CURRENCY' || type === 'INTEGER' || type === 'NUMBER') return 'SUM';
  if (type === 'PERCENTAGE' || type === 'DECIMAL') return 'AVG';
  return 'NONE';
}

/** The aggregation that applies: the register's, else the data type's default. */
export function attributeAggregation(aggregationType: string | null | undefined, dataType: string | null | undefined): string {
  const set = String(aggregationType || '').trim().toUpperCase();
  return set && set !== 'NONE' ? set : defaultAggregation(dataType);
}

/**
 * The grid aggFunc for an aggregation. A weighted average needs a weight per
 * row; without one it is a plain average.
 */
export function gridAggFunc(
  aggregation: string,
  valueOf: (data: any) => number | null,
  weightOf?: ((data: any) => number | null) | null,
): GridAggFunc | undefined {
  const type = aggregation.toUpperCase();
  if (type === 'SUM') return 'sum';
  if (type === 'AVG' || type === 'AVERAGE') return 'avg';
  if (type === 'MIN') return 'min';
  if (type === 'MAX') return 'max';
  if (type === 'COUNT') return 'count';
  if (type === 'WEIGHTED_AVG') {
    if (!weightOf) return 'avg';
    const weightedAvg = (params: any) => {
      let weighted = 0;
      let weightTotal = 0;
      for (const leaf of params.rowNode?.allLeafChildren || []) {
        const value = valueOf(leaf.data);
        const weight = weightOf(leaf.data);
        if (typeof value === 'number' && typeof weight === 'number' && Number.isFinite(weight)) {
          weighted += value * weight;
          weightTotal += weight;
        }
      }
      return weightTotal ? weighted / weightTotal : null;
    };
    Object.defineProperty(weightedAvg, 'name', { value: 'weighted avg' });
    return weightedAvg;
  }
  return undefined;
}

/**
 * A grouped row's total as a number. The grid's average comes back as an
 * object holding the value and the count it was taken over.
 */
export function aggregateNumber(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) return (value as { value: unknown }).value;
  return value;
}

/** A stored value as a number, or null. */
export function numericValue(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
