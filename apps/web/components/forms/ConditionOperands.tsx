'use client';

import { useMemo, useState } from 'react';
import {
  EXPRESSION_PLACEHOLDER_CODE,
  applyLeftText,
  compileExpression,
  describeOperand,
  refKey,
  type OperandContext,
  type OperandField,
} from '@/lib/condition-expression';
import { ExpressionBox } from './ExpressionBox';
import { TypeaheadSelect, type TypeaheadOption } from './TypeaheadSelect';

/** What a typed operand means, in the field names a compliance officer knows. */
export function plainOperand(text: string, ctx: OperandContext): string {
  if (!text.trim()) return '';
  const { ast } = compileExpression(text, ctx);
  return ast ? describeOperand(ast, ctx) : text;
}

const insertText = (f: OperandField) => (f.path.length ? `${f.domainCode}.${f.attributeCode}` : f.attributeCode);

function useFieldOptions(ctx: OperandContext): TypeaheadOption[] {
  return useMemo(
    () =>
      ctx.fields.map((f) => ({
        value: f.valueKey,
        label: f.attributeName,
        selectedLabel: `${f.groupLabel.split(' › ').pop() || f.groupLabel} · ${f.attributeName}`,
        group: f.groupLabel,
        hint: f.dataType?.toLowerCase(),
        search: f.attributeCode,
      })),
    [ctx.fields],
  );
}

/** The field a piece of text names exactly, if it names one. */
function singleField(text: string, ctx: OperandContext): OperandField | undefined {
  if (!text.trim()) return undefined;
  const r = applyLeftText(text, ctx);
  if (r.error || !r.attributeCode || r.attributeCode === EXPRESSION_PLACEHOLDER_CODE) return undefined;
  const key = refKey(r.attributePath, r.attributeCode);
  return ctx.fields.find((f) => f.valueKey === key);
}

interface BaseProps {
  text: string;
  onChange: (text: string) => void;
  ctx: OperandContext;
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  quiet?: boolean;
}

/** Left side of a condition: pick a field from the list, or switch to an expression. */
export function LeftOperand({ text, onChange, ctx, loading, disabled, error, quiet }: BaseProps) {
  const [wantExpr, setWantExpr] = useState(false);
  const options = useFieldOptions(ctx);
  const field = singleField(text, ctx);
  const asPicker = !wantExpr && (!text.trim() || !!field);

  if (asPicker) {
    return (
      <div className="op">
        <TypeaheadSelect
          options={options}
          value={field?.valueKey || ''}
          loading={loading}
          disabled={disabled}
          placeholder={disabled ? 'Choose an entity type first' : 'Pick a field'}
          error={!!error}
          onChange={(key) => {
            const f = ctx.fields.find((x) => x.valueKey === key);
            onChange(f ? insertText(f) : '');
          }}
        />
        <button type="button" className="op-fx" title="Write an expression instead" aria-label="Write an expression instead" disabled={disabled} onClick={() => setWantExpr(true)}>ƒx</button>
      </div>
    );
  }
  return (
    <div className="op">
      <ExpressionBox value={text} onChange={onChange} context={ctx} loading={loading} disabled={disabled} placeholder="Type an expression, e.g. COST / 2" error={error} quiet={quiet} />
      <button
        type="button"
        className="op-fx on"
        title="Back to the field list"
        aria-label="Back to the field list"
        onClick={() => {
          setWantExpr(false);
          if (!singleField(text, ctx)) onChange('');
        }}
      >
        List
      </button>
    </div>
  );
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const toLiteral = (raw: string) => {
  const t = raw.trim();
  if (!t) return '';
  if (NUMBER.test(t) || /^(true|false)$/i.test(t)) return t.toLowerCase();
  return `'${raw.replace(/'/g, "''")}'`;
};
const fromLiteral = (text: string) => {
  const m = /^'(.*)'$/s.exec(text.trim());
  return m ? m[1].replace(/''/g, "'") : text;
};

type RightMode = 'value' | 'field' | 'expr';

/** Right side: a typed value, another field, or an expression. */
export function RightOperand({ text, onChange, ctx, loading, error, operator, plain, placeholder }: BaseProps & { operator: string; plain?: boolean; placeholder?: string }) {
  const [picked, setPicked] = useState<RightMode | null>(null);
  const isList = operator === 'in' || operator === 'not_in';

  // A pattern is typed as it is, with no quoting or expression mode.
  if (plain) {
    return (
      <div className="op">
        <input className={`text-input mono ${error ? 'error' : ''}`} aria-label="Pattern" value={text} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      </div>
    );
  }

  const derived: RightMode = (() => {
    if (!text.trim()) return 'value';
    const { ast, error: bad } = compileExpression(text, ctx);
    if (bad || !ast) return NUMBER.test(text.trim()) ? 'value' : 'expr';
    if ('const' in ast) return 'value';
    if ('ref' in ast && ast.ref !== 'CURRENT_DATE') return 'field';
    return 'expr';
  })();
  const mode = picked ?? derived;

  if (isList) {
    return (
      <div className="op">
        <input className={`text-input ${error ? 'error' : ''}`} aria-label="Allowed values" value={text} onChange={(e) => onChange(e.target.value)} placeholder="Comma separated, e.g. US, GB, DE" />
      </div>
    );
  }

  // One line, like the left side: a plain value (or an expression) with a switch for the other.
  const asExpression = mode !== 'value';
  return (
    <div className="op">
      {asExpression ? (
        <>
          <ExpressionBox value={text} onChange={onChange} context={ctx} loading={loading} placeholder="A field or expression, e.g. NAV * 0.1" error={error} />
          <button
            type="button"
            className="op-fx on"
            title="Back to a plain value"
            aria-label="Back to a plain value"
            onClick={() => {
              setPicked('value');
              const { ast } = compileExpression(text, ctx);
              if (!ast || !('const' in ast)) onChange('');
            }}
          >
            Value
          </button>
        </>
      ) : (
        <>
          <input
            className={`text-input ${error ? 'error' : ''}`}
            aria-label="Value"
            value={fromLiteral(text)}
            onChange={(e) => onChange(toLiteral(e.target.value))}
            onBlur={(e) => onChange(toLiteral(e.target.value.trim()))}
            placeholder="A value, e.g. 10 or Energy"
          />
          <button type="button" className="op-fx" title="Use a field or an expression" aria-label="Use a field or an expression" onClick={() => setPicked('expr')}>ƒx</button>
        </>
      )}
      {error && !asExpression && <span className="field-error">{error}</span>}
    </div>
  );
}
