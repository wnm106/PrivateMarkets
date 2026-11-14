'use client';

import { useMemo, useState } from 'react';
import {
  applyLeftText,
  applyRightText,
  emptyReadSettings,
  leftTextOf,
  rightTextOf,
  type OperandContext,
} from '@/lib/condition-expression';
import { LeftOperand, RightOperand } from './ConditionOperands';
import type { ComplianceCondition, ConditionScope } from './ComplianceRuleForm';

// The grouped condition builder shared by compliance rules and data quality rules.
// It edits rows of ComplianceCondition. Each caller decides which fields can be
// picked, which operators exist, how operand text becomes stored values, and what
// the preview shows.

export const OPERATORS = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'] as const;
export const OPERATOR_LABELS: Record<(typeof OPERATORS)[number], string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  not_in: 'is not one of',
  is_null: 'is blank',
  is_not_null: 'is present',
};

export interface ConditionOperator {
  value: string;
  label: string;
  /** The right side is raw text, such as a pattern, not a value or expression. */
  plainValue?: boolean;
  placeholder?: string;
}

export const COMPLIANCE_OPERATORS: ConditionOperator[] = OPERATORS.map((value) => ({ value, label: OPERATOR_LABELS[value] }));

type RowPatch = Partial<ComplianceCondition>;

export const defaultLeftPatch = (text: string, ctx: OperandContext): RowPatch => {
  const r = applyLeftText(text, ctx);
  return { leftError: r.error, attributeCode: r.attributeCode, attributePath: r.attributePath, leftExpression: r.leftExpression };
};

export const defaultRightPatch = (text: string, operator: string, ctx: OperandContext): RowPatch => {
  const r = applyRightText(text, operator, ctx);
  return {
    rightError: r.error,
    value: r.value,
    compareAttributeCode: r.compareAttributeCode,
    compareAttributePath: r.compareAttributePath,
    rightExpression: r.rightExpression,
  };
};

interface ConditionCluster {
  id: string;
  rows: ComplianceCondition[];
}

const conditionKeys = new WeakMap<object, string>();

function conditionKey(condition: ComplianceCondition) {
  if (condition.key) return condition.key;
  let key = conditionKeys.get(condition);
  if (!key) {
    key = Math.random().toString(36).slice(2, 10);
    conditionKeys.set(condition, key);
  }
  return key;
}

export function blankCondition(appliesTo: ConditionScope, conditionGroup: number, conditionOrder: number): ComplianceCondition {
  return {
    key: Math.random().toString(36).slice(2, 10),
    appliesTo,
    conditionGroup,
    conditionOrder,
    attributeCode: '',
    attributePath: [],
    attributeDimension: emptyReadSettings(),
    operator: 'equals',
    value: '',
    compareAttributeCode: '',
    compareAttributePath: [],
    compareDimension: emptyReadSettings(),
    leftExpression: null,
    rightExpression: null,
    logicOperator: 'AND',
  };
}

export function clusterConditions(conditions: ComplianceCondition[]): ConditionCluster[] {
  const ordered = [...conditions].sort((a, b) => (a.conditionGroup || 1) - (b.conditionGroup || 1) || a.conditionOrder - b.conditionOrder);
  const groups: ConditionCluster[] = [];
  for (const condition of ordered) {
    const id = `g${condition.conditionGroup || 1}`;
    let group = groups.find((item) => item.id === id);
    if (!group) {
      group = { id, rows: [] };
      groups.push(group);
    }
    group.rows.push({ ...condition, key: conditionKey(condition) });
  }
  return groups;
}

function packConditions(groups: ConditionCluster[], appliesTo: ConditionScope): ComplianceCondition[] {
  return groups.filter((group) => group.rows.length).flatMap((group, gi) => group.rows.map((row, index) => ({
    ...row,
    key: row.key || conditionKey(row),
    appliesTo,
    conditionGroup: gi + 1,
    conditionOrder: index + 1,
    logicOperator: index === 0 ? 'AND' : (row.logicOperator === 'OR' ? 'OR' : 'AND'),
  })));
}

function groupMode(rows: ComplianceCondition[]): 'AND' | 'OR' | 'MIXED' {
  if (rows.length < 2) return 'AND';
  const joins = rows.slice(1).map((row) => row.logicOperator);
  if (joins.every((j) => j !== 'OR')) return 'AND';
  if (joins.every((j) => j === 'OR')) return 'OR';
  return 'MIXED';
}

function groupStory(rows: ComplianceCondition[]) {
  if (rows.length < 2) return { title: 'Match this', hint: 'This line must be true.' };
  const joins = rows.slice(1).map((row) => row.logicOperator);
  if (joins.every((join) => join !== 'OR')) return { title: 'Match all', hint: 'Every line in this group must be true.' };
  if (joins.every((join) => join === 'OR')) return { title: 'Match any', hint: 'Any line in this group can be true.' };
  return { title: 'Match in order', hint: 'Each line joins the ones above it, from the top.' };
}

export interface ConditionBuilderProps {
  appliesTo: ConditionScope;
  conditions: ComplianceCondition[];
  ctx: OperandContext;
  loading?: boolean;
  /** Nothing can be picked yet, for example before a domain is chosen. */
  disabled?: boolean;
  /** "Show matching records" button and result panel. */
  preview?: { button: React.ReactNode; panel: React.ReactNode };
  operators?: ConditionOperator[];
  /** How operand text becomes stored values. The compliance reading is the default. */
  patchLeft?: (text: string, ctx: OperandContext) => RowPatch;
  patchRight?: (text: string, operator: string, ctx: OperandContext) => RowPatch;
  /** False keeps each group to all-of or any-of, so it can be written as a flat AND/OR line. */
  allowMixed?: boolean;
  emptyText?: string;
  leadText?: string;
  onCommit: (next: ComplianceCondition[]) => void;
}

export function ConditionBuilder({
  appliesTo,
  conditions,
  ctx,
  loading,
  disabled,
  preview,
  operators = COMPLIANCE_OPERATORS,
  patchLeft = defaultLeftPatch,
  patchRight = defaultRightPatch,
  allowMixed = true,
  emptyText = 'Every record counts.',
  leadText = 'Record must match',
  onCommit,
}: ConditionBuilderProps) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const groups = useMemo(() => clusterConditions(conditions), [conditions]);
  const operatorFor = (value: string) => operators.find((operator) => operator.value === value);
  const commit = (next: ConditionCluster[]) => onCommit(packConditions(next, appliesTo));
  const edit = (mutate: (draft: ConditionCluster[]) => void) => {
    const draft = groups.map((group) => ({ id: group.id, rows: group.rows.map((row) => ({ ...row })) }));
    mutate(draft);
    commit(draft.filter((group) => group.rows.length > 0));
  };
  const dropOn = (targetGroupId: string, beforeKey: string | null) => {
    if (!dragKey || dragKey === beforeKey) return;
    edit((draft) => {
      let from: ConditionCluster | null = null;
      let fromIndex = -1;
      for (const group of draft) {
        const at = group.rows.findIndex((row) => row.key === dragKey);
        if (at >= 0) { from = group; fromIndex = at; }
      }
      if (!from || fromIndex < 0) return;
      const dest = draft.find((group) => group.id === targetGroupId);
      if (!dest) return;
      const sameGroup = from === dest;
      const joins = sameGroup ? from.rows.map((row) => row.logicOperator) : null;
      const [moving] = from.rows.splice(fromIndex, 1);
      const index = beforeKey ? dest.rows.findIndex((row) => row.key === beforeKey) : dest.rows.length;
      dest.rows.splice(index < 0 ? dest.rows.length : index, 0, { ...moving, logicOperator: 'AND' });
      if (joins) dest.rows.forEach((row, i) => { row.logicOperator = i === 0 ? 'AND' : joins[i]; });
    });
    setDragKey(null);
    setOverKey(null);
  };

  if (!groups.length) {
    return (
      <div className="cg">
        <div className="rb-sentence">
          <span className="rb-qualify">{emptyText}</span>
          <button type="button" className="btn btn-sm" onClick={() => onCommit([blankCondition(appliesTo, 1, 1)])}>+ Add a condition</button>
        </div>
        {preview?.panel}
      </div>
    );
  }

  return (
    <div className="cg">
      {groups.length > 1 && (
        <p className="cg-note">A record counts when it matches <b>any one</b> of the groups below.</p>
      )}
      {groups.map((group, gi) => {
        const story = groupStory(group.rows);
        const mode = groupMode(group.rows);
        const setMode = (next: 'AND' | 'OR') => edit((draft) => {
          draft[gi].rows.forEach((row, i) => { row.logicOperator = i === 0 ? 'AND' : next; });
        });
        return (
          <div key={group.id}>
            {gi > 0 && <div className="cg-or">or</div>}
            <section
              className={`cg-card ${overKey === group.id ? 'over' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setOverKey(group.id); }}
              onDragLeave={() => setOverKey((current) => current === group.id ? null : current)}
              onDrop={(event) => { event.preventDefault(); dropOn(group.id, null); }}
            >
              <header className="cg-head">
                <span className="cg-lead">{groups.length > 1 ? `Group ${gi + 1}` : leadText}</span>
                <div className="rb-seg small" role="radiogroup" aria-label="How the lines in this group combine">
                  <button type="button" role="radio" aria-checked={mode === 'AND'} className={mode === 'AND' ? 'on' : ''} onClick={() => setMode('AND')}>ALL of these</button>
                  <button type="button" role="radio" aria-checked={mode === 'OR'} className={mode === 'OR' ? 'on or' : ''} onClick={() => setMode('OR')}>ANY of these</button>
                  {mode === 'MIXED' && <button type="button" role="radio" aria-checked className="on mixed" disabled>Mixed</button>}
                </div>
                <span className="cg-hint">{story.hint}</span>
                {gi === 0 && preview && <span className="cg-del">{preview.button}</span>}
                {groups.length > 1 && (
                  <button type="button" className="btn btn-sm" onClick={() => edit((draft) => { draft[gi].rows = []; })}>Remove group</button>
                )}
              </header>
              <div className="cg-body">
                {group.rows.map((cond, ri) => (
                  <div key={cond.key}>
                    {ri > 0 && (
                      <div className={`cg-join ${cond.logicOperator === 'OR' ? 'or' : ''}`}>
                        <button
                          type="button"
                          className={`cg-op ${cond.logicOperator === 'OR' ? 'or' : ''}`}
                          disabled={!allowMixed}
                          title={allowMixed ? undefined : 'Use the ALL of these / ANY of these switch above'}
                          onClick={() => edit((draft) => {
                            const row = draft[gi].rows[ri];
                            draft[gi].rows[ri] = { ...row, logicOperator: row.logicOperator === 'OR' ? 'AND' : 'OR' };
                          })}
                        >
                          {cond.logicOperator === 'OR' ? 'or' : 'and'}
                        </button>
                      </div>
                    )}
                    <div
                      className={`cg-row ${dragKey === cond.key ? 'drag' : ''} ${overKey === cond.key ? 'over' : ''}`}
                      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setOverKey(cond.key || null); }}
                      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropOn(group.id, cond.key || null); }}
                    >
                      <button
                        type="button"
                        className="cg-grip"
                        draggable
                        aria-label="Drag to another place in the group"
                        title="Drag to reorder or move into another group"
                        onDragStart={(event) => {
                          event.dataTransfer.setData('text/plain', cond.key || '');
                          event.dataTransfer.effectAllowed = 'move';
                          setDragKey(cond.key || null);
                        }}
                        onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                      >
                        ⋮⋮
                      </button>
                      <div className="cg-fields">
                        <LeftOperand
                          text={cond.leftText ?? leftTextOf(cond, ctx)}
                          onChange={(text) => edit((draft) => { draft[gi].rows[ri] = { ...draft[gi].rows[ri], leftText: text, ...patchLeft(text, ctx) }; })}
                          ctx={ctx}
                          loading={loading}
                          disabled={disabled}
                          error={cond.leftError}
                        />
                        <select
                          className="select"
                          aria-label="Operator"
                          value={cond.operator}
                          onChange={(event) => edit((draft) => {
                            const row = draft[gi].rows[ri];
                            draft[gi].rows[ri] = { ...row, operator: event.target.value, ...patchRight(row.rightText ?? rightTextOf(row, ctx), event.target.value, ctx) };
                          })}
                        >
                          {operators.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
                        </select>
                        {cond.operator !== 'is_null' && cond.operator !== 'is_not_null' && (
                          <RightOperand
                            text={cond.rightText ?? rightTextOf(cond, ctx)}
                            operator={cond.operator}
                            plain={operatorFor(cond.operator)?.plainValue}
                            placeholder={operatorFor(cond.operator)?.placeholder}
                            onChange={(text) => edit((draft) => {
                              const row = draft[gi].rows[ri];
                              draft[gi].rows[ri] = { ...row, rightText: text, ...patchRight(text, row.operator, ctx) };
                            })}
                            ctx={ctx}
                            loading={loading}
                            error={cond.rightError}
                          />
                        )}
                        <button type="button" className="cond-remove" aria-label="Remove condition" onClick={() => edit((draft) => { draft[gi].rows.splice(ri, 1); })}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cg-actions">
                <button type="button" className="btn btn-sm" onClick={() => edit((draft) => { draft[gi].rows.push(blankCondition(appliesTo, gi + 1, draft[gi].rows.length + 1)); })}>+ Add rule</button>
              </div>
            </section>
          </div>
        );
      })}
      {preview?.panel}
      <button type="button" className="btn btn-sm cg-addgroup" onClick={() => edit((draft) => { draft.push({ id: `new-${draft.length}`, rows: [blankCondition(appliesTo, draft.length + 1, 1)] }); })}>+ Add group (or)</button>
    </div>
  );
}
