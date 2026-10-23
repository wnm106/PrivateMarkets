'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { compileCalcExpression, collectCalcRefs, decompileCalcExpression } from '@/lib/calc-expression';
import {
  bindingLabel,
  choicesForCode,
  fieldChoices,
  inferBinding,
  sameBinding,
  type CalcAttributeOption,
  type CalcFieldChoice,
  type CalcOperandBinding,
  type CalcRelationship,
} from '@/lib/calc-fields';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';

interface ExpressionFn {
  code: string;
  name: string;
  category: string;
  description: string;
  signature: string;
  callable: boolean;
}

interface CalculationInput {
  inputRole: string;
  attributeCode: string;
  traversal: string;
  relationshipCodes: string[];
}

export interface CalculationSpec {
  id: string;
  attributeCode: string;
  domainCode: string;
  calcKind: string;
  evaluationMode: string;
  outputGrain: string;
  expression: unknown;
  aggregateFn: string | null;
  seriesFn: string | null;
  inputs: CalculationInput[];
}

type Suggestion = { kind: 'field'; choice: CalcFieldChoice } | { kind: 'fn'; fn: ExpressionFn };

const CATALOG_QUERY = `
  query CalcExpressionCatalog {
    domainTypes { domainCode domainName }
    attributeRegister { attributeCode attributeName dataType domainCode }
    relationshipTypes { relationshipCode relationshipName parentDomainCode childDomainCode }
    expressionFunctions { code name category description signature callable }
  }
`;

const SAVE_EXPRESSION = `
  mutation UpdateCalcExpression($id: ID!, $expression: JSON!, $operands: [CalcOperandInput!]) {
    updateCalcExpression(id: $id, expression: $expression, operands: $operands) {
      definition {
        id
        attributeCode
        domainCode
        calcKind
        evaluationMode
        outputGrain
        expression
        aggregateFn
        seriesFn
        inputs { inputRole attributeCode traversal relationshipCodes }
      }
      errors { message }
    }
  }
`;

const OPERATORS = ['+', '-', '*', '/', '(', ')'];

export function CalculationWorkspace({
  spec,
  onSaved,
}: {
  spec: CalculationSpec;
  onSaved: (next: CalculationSpec) => void;
}) {
  const [attributes, setAttributes] = useState<CalcAttributeOption[]>([]);
  const [relationships, setRelationships] = useState<CalcRelationship[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [functions, setFunctions] = useState<ExpressionFn[]>([]);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{
      domainTypes: Array<{ domainCode: string; domainName: string }>;
      attributeRegister: CalcAttributeOption[];
      relationshipTypes: CalcRelationship[];
      expressionFunctions: ExpressionFn[];
    }>(CATALOG_QUERY, {}, 'network-only').then((result) => {
      if (cancelled || !result.data) return;
      const nextNames: Record<string, string> = {};
      for (const domain of result.data.domainTypes || []) nextNames[domain.domainCode] = domain.domainName;
      setNames(nextNames);
      setAttributes(result.data.attributeRegister || []);
      setRelationships(result.data.relationshipTypes || []);
      setFunctions(result.data.expressionFunctions || []);
    });
    return () => { cancelled = true; };
  }, []);

  const selfOnly = spec.evaluationMode === 'ON_READ';
  const choices = useMemo(
    () => fieldChoices(spec.domainCode, attributes, relationships, names, selfOnly),
    [spec.domainCode, attributes, relationships, names, selfOnly],
  );

  if (spec.calcKind !== 'EXPRESSION') {
    return (
      <div style={{ marginTop: '8px', fontSize: '13px' }}>
        <div style={{ fontFamily: 'var(--font-ibm-plex-mono), monospace', fontWeight: 600 }}>
          {spec.aggregateFn || spec.seriesFn || spec.calcKind}
        </div>
        <div style={{ color: 'var(--ink-3)', marginTop: '8px' }}>
          {spec.calcKind} · {spec.evaluationMode}{spec.outputGrain ? ` · ${spec.outputGrain.replace(/_/g, ' ').toLowerCase()}` : ''}
        </div>
        <OriginList spec={spec} relationships={relationships} names={names} choices={choices} />
      </div>
    );
  }

  return (
    <ExpressionDesigner
      spec={spec}
      choices={choices}
      relationships={relationships}
      names={names}
      functions={functions}
      selfOnly={selfOnly}
      onSaved={onSaved}
    />
  );
}

function OriginList({
  spec,
  relationships,
  names,
  choices,
}: {
  spec: CalculationSpec;
  relationships: CalcRelationship[];
  names: Record<string, string>;
  choices: CalcFieldChoice[];
}) {
  if (spec.inputs.length === 0) return null;
  return (
    <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
      {spec.inputs.map((input) => {
        const binding = toBinding(input);
        const attribute = choices.find((choice) => choice.attributeCode === input.attributeCode);
        return (
          <div key={`${input.inputRole}-${input.attributeCode}`}>
            <span style={{ fontFamily: 'var(--font-ibm-plex-mono), monospace' }}>{input.attributeCode}</span>
            <span style={{ color: 'var(--ink-3)' }}>
              {' '}· {attribute?.attributeName || input.inputRole.toLowerCase()} · {bindingLabel(binding, spec.domainCode, relationships, names)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ExpressionDesigner({
  spec,
  choices,
  relationships,
  names,
  functions,
  selfOnly,
  onSaved,
}: {
  spec: CalculationSpec;
  choices: CalcFieldChoice[];
  relationships: CalcRelationship[];
  names: Record<string, string>;
  functions: ExpressionFn[];
  selfOnly: boolean;
  onSaved: (next: CalculationSpec) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(decompileCalcExpression(spec.expression));
  const [bindings, setBindings] = useState<Record<string, CalcOperandBinding>>(() => initialBindings(spec));
  const [fieldQuery, setFieldQuery] = useState('');
  const [fnQuery, setFnQuery] = useState('');
  const [token, setToken] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const compiled = useMemo(() => {
    try {
      return { expr: compileCalcExpression(draft), issue: '' };
    } catch (err: any) {
      return { expr: null, issue: draft.trim() ? (err?.message || 'Expression is incomplete') : '' };
    }
  }, [draft]);
  const refs = compiled.expr ? collectCalcRefs(compiled.expr) : [];

  useEffect(() => {
    if (!compiled.expr) return;
    const used = collectCalcRefs(compiled.expr);
    setBindings((current) => {
      const next = { ...current };
      for (const ref of used) {
        if (!next[ref]) next[ref] = inferBinding(ref, choices, spec.domainCode);
      }
      return next;
    });
  }, [compiled.expr, choices, spec.domainCode]);

  const suggestions = useMemo(() => buildSuggestions(token, choices, functions), [token, choices, functions]);
  const groups = useMemo(() => groupChoices(choices, fieldQuery), [choices, fieldQuery]);
  const visibleFunctions = useMemo(() => {
    const needle = fnQuery.trim().toLowerCase();
    return functions.filter((fn) => {
      if (needle) return `${fn.code} ${fn.name} ${fn.signature}`.toLowerCase().includes(needle);
      return fn.callable;
    });
  }, [functions, fnQuery]);

  const syncToken = (value: string, caret: number) => {
    const partial = /[A-Za-z_][A-Za-z0-9_]*$/.exec(value.slice(0, caret));
    const next = partial?.[0] || '';
    setToken(next);
    setOpen(next.length > 0);
    setActive(0);
  };

  const write = (next: string, caret: number) => {
    setDraft(next);
    setOpen(false);
    setToken('');
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    });
  };

  const insertToken = (text: string) => {
    const caret = area.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const partial = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
    const start = partial ? caret - partial[0].length : caret;
    let prefix = '';
    if (!partial) {
      const left = draft.slice(0, start).trimEnd();
      if (/^[A-Za-z_]/.test(text) && left && !/[+\-*/(,]$/.test(left)) prefix = ' * ';
    }
    const insertion = `${prefix}${text}`;
    write(draft.slice(0, start) + insertion + after, start + insertion.length);
  };

  const insertRaw = (text: string) => {
    const caret = area.current?.selectionStart ?? draft.length;
    const left = draft.slice(0, caret);
    const gap = left && !/\s$/.test(left) && !/[+\-*/(,]$/.test(left.trimEnd()) ? ' ' : '';
    const insertion = `${gap}${text}`;
    write(left + insertion + draft.slice(caret), caret + insertion.length);
  };

  const applyChoice = (choice: CalcFieldChoice) => {
    setBindings((current) => ({
      ...current,
      [choice.attributeCode]: {
        attributeCode: choice.attributeCode,
        traversal: choice.place.traversal,
        relationshipCodes: choice.place.relationshipCodes,
      },
    }));
    insertToken(choice.attributeCode);
  };

  const applySuggestion = (suggestion: Suggestion) => {
    if (suggestion.kind === 'field') applyChoice(suggestion.choice);
    else insertToken(`${suggestion.fn.code}(`);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const expression = compileCalcExpression(draft);
      const used = collectCalcRefs(expression);
      const operands = used.map((code) => bindings[code] || inferBinding(code, choices, spec.domainCode));
      const result = await graphqlMutation<{
        updateCalcExpression: { definition: CalculationSpec | null; errors: Array<{ message: string }> };
      }>(SAVE_EXPRESSION, { id: spec.id, expression, operands });
      const saved = result.data?.updateCalcExpression;
      const message = result.error?.message || saved?.errors?.[0]?.message;
      if (message || !saved?.definition) {
        setError(message || 'Could not save the expression');
      } else {
        setDraft(decompileCalcExpression(saved.definition.expression));
        setBindings(initialBindings(saved.definition));
        onSaved(saved.definition);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not read the expression');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="calc-expr">
      <div className="calc-expr-main">
        <div className="calc-expr-head"><span>Expression</span></div>
        <div className="calc-expr-input">
          <textarea
            ref={area}
            value={draft}
            aria-label="Calculation expression"
            aria-autocomplete="list"
            aria-expanded={open}
            spellCheck={false}
            rows={4}
            onChange={(event) => {
              setDraft(event.target.value);
              syncToken(event.target.value, event.target.selectionStart || 0);
            }}
            onKeyDown={(event) => {
              if (!open || suggestions.length === 0) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => (index + 1) % suggestions.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                applySuggestion(suggestions[active] || suggestions[0]);
              } else if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {open && suggestions.length > 0 && (
            <div className="calc-suggest" role="listbox">
              {suggestions.map((suggestion, index) => (
                <button
                  type="button"
                  key={suggestion.kind === 'field' ? `${suggestion.choice.attributeCode}-${suggestion.choice.groupLabel}` : suggestion.fn.code}
                  className={index === active ? 'active' : ''}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applySuggestion(suggestion);
                  }}
                >
                  <strong>{suggestion.kind === 'field' ? suggestion.choice.attributeCode : suggestion.fn.code}</strong>
                  <span>
                    {suggestion.kind === 'field'
                      ? `${suggestion.choice.attributeName} · ${suggestion.choice.groupLabel}`
                      : suggestion.fn.signature}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="calc-ops">
          {OPERATORS.map((operator) => (
            <button key={operator} type="button" className="btn btn-sm" onClick={() => insertRaw(operator === '(' || operator === ')' ? operator : ` ${operator} `)}>
              {operator}
            </button>
          ))}
        </div>
        {compiled.issue && <div className="calc-expr-issue">{compiled.issue}</div>}
        <div className="calc-expr-note">
          {selfOnly
            ? 'This calculation is read when the record is opened, so every attribute comes from this record.'
            : 'Type an attribute or function, or pick one from the lists. Each attribute shows the entity it is read from.'}
        </div>
        {refs.length > 0 && (
          <div className="calc-origins">
            {refs.map((code) => {
              const binding = bindings[code] || inferBinding(code, choices, spec.domainCode);
              const options = choicesForCode(choices, code);
              const selected = options.findIndex((choice) => sameBinding(binding, {
                attributeCode: code,
                traversal: choice.place.traversal,
                relationshipCodes: choice.place.relationshipCodes,
              }));
              const attribute = options[0] || choices.find((choice) => choice.attributeCode === code);
              return (
                <div key={code} className="calc-origin">
                  <code>{code}</code>
                  <span>{attribute?.attributeName || 'Attribute'}</span>
                  {options.length > 1 ? (
                    <select
                      className="select"
                      aria-label={`Entity for ${code}`}
                      value={selected >= 0 ? String(selected) : 'current'}
                      onChange={(event) => {
                        const choice = options[Number(event.target.value)];
                        if (!choice) return;
                        setBindings((current) => ({
                          ...current,
                          [code]: {
                            attributeCode: code,
                            traversal: choice.place.traversal,
                            relationshipCodes: choice.place.relationshipCodes,
                          },
                        }));
                      }}
                    >
                      {selected < 0 && <option value="current">{bindingLabel(binding, spec.domainCode, relationships, names)}</option>}
                      {options.map((choice, index) => (
                        <option key={choice.groupLabel} value={index}>{choice.groupLabel}</option>
                      ))}
                    </select>
                  ) : (
                    <em>{bindingLabel(binding, spec.domainCode, relationships, names)}</em>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && <div className="calc-expr-issue">{error}</div>}
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving || !draft.trim() || Boolean(compiled.issue)}>
          {saving ? 'Saving…' : 'Save expression'}
        </button>
      </div>

      <aside className="calc-expr-side">
        <div className="calc-expr-head"><span>Fields</span></div>
        <input className="text-input" value={fieldQuery} placeholder="Search fields" onChange={(event) => setFieldQuery(event.target.value)} />
        <div className="calc-catalog">
          {groups.length === 0 && <div className="calc-empty">No fields for this entity yet.</div>}
          {groups.map(([label, items]) => (
            <div key={label}>
              <div className="calc-domain">{label}</div>
              {items.map((choice) => (
                <button
                  type="button"
                  key={`${choice.groupLabel}-${choice.attributeCode}`}
                  className="calc-attr"
                  onClick={() => applyChoice(choice)}
                >
                  <strong>{choice.attributeCode}</strong>
                  <span>{choice.attributeName}{choice.dataType ? ` · ${choice.dataType}` : ''}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="calc-expr-head"><span>Functions</span></div>
        <input className="text-input" value={fnQuery} placeholder="Search functions" onChange={(event) => setFnQuery(event.target.value)} />
        <div className="calc-catalog">
          {visibleFunctions.length === 0 && <div className="calc-empty">No functions match.</div>}
          {visibleFunctions.map((fn) => (
            <button
              type="button"
              key={fn.code}
              className="calc-attr"
              disabled={!fn.callable}
              title={fn.description}
              onClick={() => { if (fn.callable) insertToken(`${fn.code}(`); }}
            >
              <strong>{fn.code}</strong>
              <span>{fn.callable ? fn.signature : `${fn.signature} · pattern`}</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function initialBindings(spec: CalculationSpec): Record<string, CalcOperandBinding> {
  const bindings: Record<string, CalcOperandBinding> = {};
  for (const input of spec.inputs) {
    if (input.inputRole !== 'OPERAND') continue;
    bindings[input.attributeCode] = toBinding(input);
  }
  return bindings;
}

function toBinding(input: CalculationInput): CalcOperandBinding {
  return {
    attributeCode: input.attributeCode,
    traversal: input.traversal === 'UP' || input.traversal === 'DOWN' ? input.traversal : 'SELF',
    relationshipCodes: input.relationshipCodes || [],
  };
}

function groupChoices(choices: CalcFieldChoice[], query: string) {
  const needle = query.trim().toLowerCase();
  const grouped = new Map<string, CalcFieldChoice[]>();
  for (const choice of choices) {
    if (needle) {
      const haystack = `${choice.attributeCode} ${choice.attributeName} ${choice.groupLabel}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    grouped.set(choice.groupLabel, [...(grouped.get(choice.groupLabel) || []), choice]);
  }
  return [...grouped.entries()];
}

function buildSuggestions(token: string, choices: CalcFieldChoice[], functions: ExpressionFn[]): Suggestion[] {
  const needle = token.trim().toLowerCase();
  if (!needle) return [];
  const fields = choices
    .filter((choice) => choice.attributeCode.toLowerCase().includes(needle) || choice.attributeName.toLowerCase().includes(needle))
    .slice(0, 8)
    .map((choice) => ({ kind: 'field' as const, choice }));
  const fns = functions
    .filter((fn) => fn.callable && (fn.code.toLowerCase().includes(needle) || fn.name.toLowerCase().includes(needle)))
    .slice(0, 5)
    .map((fn) => ({ kind: 'fn' as const, fn }));
  return [...fields, ...fns];
}
