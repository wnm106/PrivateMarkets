/**
 * Condition rows: the shape a rule's condition is stored and matched in
 * (compliance.rule_conditions), built from what the condition builder sends.
 * Rules, a view's population filter, the rule editor's preview and the grid all
 * go through here, so one reading of a condition exists.
 */

export function toSnakeDim(dim?: {
  sourceScope?: string;
  offsetUnit?: string;
  offsetAmount?: number;
  snapTo?: string;
  knowledgeMode?: string;
  relationshipPath?: Array<{ relationshipCode: string; direction: string; recursive?: boolean }>;
} | null) {
  if (!dim) return {};
  const out: Record<string, any> = {};
  if (dim.sourceScope) out.source_scope = dim.sourceScope;
  if (dim.offsetUnit) out.offset_unit = dim.offsetUnit;
  if (dim.offsetAmount !== undefined && dim.offsetAmount !== null) out.offset_amount = dim.offsetAmount;
  if (dim.snapTo) out.snap_to = dim.snapTo;
  if (dim.knowledgeMode) out.knowledge_mode = dim.knowledgeMode;
  const path = (dim.relationshipPath || []).filter((h) => h?.relationshipCode);
  if (path.length) {
    out.relationship_path = path.map((h) => ({
      relationship_code: h.relationshipCode,
      direction: h.direction,
      recursive: !!h.recursive,
    }));
  }
  return out;
}

export function conditionRow(versionId: string, cond: any, extra: Record<string, unknown> = {}) {
  return {
    rule_version_id: versionId,
    applies_to: cond.appliesTo,
    condition_group: cond.conditionGroup ?? 1,
    condition_order: cond.conditionOrder ?? 1,
    attribute_code: cond.attributeCode,
    attribute_dimension: toSnakeDim(cond.attributeDimension),
    compare_attribute_code: cond.compareAttributeCode || null,
    compare_dimension: toSnakeDim(cond.compareDimension),
    operator: cond.operator,
    value: cond.value ?? null,
    logic_operator: cond.logicOperator ?? 'AND',
    ...(cond.leftExpression ? { left_expression: cond.leftExpression } : {}),
    ...(cond.rightExpression ? { right_expression: cond.rightExpression } : {}),
    ...extra,
  };
}

/**
 * Population conditions (as the condition builder sends them) as the rows the
 * matcher reads: the same shape a saved rule condition is stored in. A view's
 * filter, the rule editor's preview and the grid all go through this.
 */
export function populationRows(conditions: any[]): Array<Record<string, unknown>> {
  return (conditions || [])
    .filter((c: any) => c?.attributeCode)
    .map((c: any) => {
      const { rule_version_id: _version, ...row } = conditionRow('', { ...c, appliesTo: 'BASE', operator: c.operator || 'equals' });
      return row;
    });
}
