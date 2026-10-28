'use client';

import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  caretToGap,
  compileCalcExpression,
  collectCalcRefs,
  decompileCalcExpression,
  deleteCalcDraft,
  insertCalcDraft,
  tokenizeCalcDraft,
  type CalcDraftToken,
} from '@/lib/calc-expression';
import { AS_OF_PERIODS, CALC_DATE_FUNCTIONS } from '@/lib/expression-library';
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

type PickerTab = 'all' | 'fields' | 'functions' | 'related';

interface PickerRow {
  key: string;
  group: string;
  title: string;
  detail: string;
  meta: string;
  choice?: CalcFieldChoice;
  fn?: ExpressionFn;
}

const PICKER_TABS: Array<{ id: PickerTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fields', label: 'Fields' },
  { id: 'functions', label: 'Functions' },
  { id: 'related', label: 'Related entities' },
];

const FORMULA_OPERATORS: Array<{ symbol: string; glyph: string; label: string }> = [
  { symbol: '+', glyph: '+', label: 'Add' },
  { symbol: '-', glyph: '−', label: 'Subtract' },
  { symbol: '*', glyph: '×', label: 'Multiply' },
  { symbol: '/', glyph: '÷', label: 'Divide' },
  { symbol: '(', glyph: '(', label: 'Open parenthesis' },
  { symbol: ')', glyph: ')', label: 'Close parenthesis' },
  { symbol: ',', glyph: ',', label: 'Comma' },
];

const OP_GLYPH: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' };

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
  const [ready, setReady] = useState(false);

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
      const loaded = result.data.expressionFunctions || [];
      const codes = new Set(loaded.map((fn) => fn.code));
      const periods = AS_OF_PERIODS.map((period) => ({
        code: period.code,
        name: period.name,
        category: 'ROW',
        description: period.description,
        signature: period.signature,
        callable: true,
      }));
      setFunctions([...loaded, ...CALC_DATE_FUNCTIONS.filter((fn) => !codes.has(fn.code)), ...periods.filter((fn) => !codes.has(fn.code))]);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const selfOnly = spec.evaluationMode === 'ON_READ';
  const returnType = attributes.find((item) => item.attributeCode === spec.attributeCode)?.dataType || '';
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
      ready={ready}
      returnType={returnType}
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
  ready,
  returnType,
  onSaved,
}: {
  spec: CalculationSpec;
  choices: CalcFieldChoice[];
  relationships: CalcRelationship[];
  names: Record<string, string>;
  functions: ExpressionFn[];
  selfOnly: boolean;
  ready: boolean;
  returnType: string;
  onSaved: (next: CalculationSpec) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const gapFocus = useRef(false);
  const initial = decompileCalcExpression(spec.expression);
  const [draft, setDraft] = useState(initial);
  const [gap, setGap] = useState(() => tokenizeCalcDraft(initial).length);
  const [partial, setPartial] = useState('');
  const [tab, setTab] = useState<PickerTab>('all');
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [bindings, setBindings] = useState<Record<string, CalcOperandBinding>>(() => initialBindings(spec));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nullary = useMemo(
    () => new Set(functions.filter((fn) => fn.callable && !fn.signature.includes('(')).map((fn) => fn.code.toUpperCase())),
    [functions],
  );
  const tokens = useMemo(() => tokenizeCalcDraft(draft, nullary), [draft, nullary]);
  const safeGap = Math.min(gap, tokens.length);

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
      let changed = false;
      for (const ref of used) {
        if (!next[ref]) {
          next[ref] = inferBinding(ref, choices, spec.domainCode);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [compiled.expr, choices, spec.domainCode]);

  const tabs = selfOnly ? PICKER_TABS.filter((item) => item.id !== 'related') : PICKER_TABS;
  const rows = useMemo(() => buildPickerRows(tab, partial, choices, functions), [tab, partial, choices, functions]);
  const activeIndex = rows.length ? Math.min(active, rows.length - 1) : 0;
  const structured = /^\s*[{[]/.test(draft);
  const typeLabel = (returnType || 'value').toUpperCase();
  const status = !draft.trim()
    ? { tone: 'wait', label: 'Add an expression' }
    : compiled.issue
      ? { tone: 'bad', label: 'Invalid' }
      : { tone: 'ok', label: `Valid · returns ${typeLabel}` };

  useEffect(() => { setActive(0); }, [partial, tab]);
  useEffect(() => {
    if (selfOnly && tab === 'related') setTab('all');
  }, [selfOnly, tab]);
  useEffect(() => {
    if (!gapFocus.current) return;
    composer.current?.focus();
  }, [gap, draft]);
  useEffect(() => {
    const row = activeRow.current;
    const list = listRef.current;
    if (!open || !row || !list) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeIndex, open, partial, tab, rows.length]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const place = (baseDraft: string, baseGap: number, text: string) => {
    const parts = tokenizeCalcDraft(baseDraft, nullary);
    const gapIndex = Math.max(0, Math.min(baseGap, parts.length));
    const offset = gapIndex === 0 ? 0 : parts[gapIndex - 1].end;
    const result = insertCalcDraft(baseDraft, offset, text);
    return { draft: result.next, gap: caretToGap(tokenizeCalcDraft(result.next, nullary), result.caret) };
  };

  const writeInsertion = (text: string, keepPartial = false) => {
    const pending = partial.trim();
    const seeded = keepPartial && isCalcAtom(pending) ? place(draft, safeGap, pending) : { draft, gap: safeGap };
    const next = place(seeded.draft, seeded.gap, text);
    gapFocus.current = true;
    setPartial('');
    setDraft(next.draft);
    setGap(next.gap);
    setOpen(true);
  };

  const removeAt = (index: number) => {
    const token = tokens[index];
    if (!token) return;
    const result = deleteCalcDraft(draft, token.start, token.end);
    gapFocus.current = true;
    setDraft(result.next);
    setGap(caretToGap(tokenizeCalcDraft(result.next, nullary), result.caret));
    setOpen(true);
  };

  const activate = (nextGap: number) => {
    gapFocus.current = true;
    setGap(nextGap);
    setOpen(true);
    requestAnimationFrame(() => composer.current?.focus());
  };

  const insertField = (choice: CalcFieldChoice) => {
    setBindings((current) => ({
      ...current,
      [choice.attributeCode]: {
        attributeCode: choice.attributeCode,
        traversal: choice.place.traversal,
        relationshipCodes: choice.place.relationshipCodes,
      },
    }));
    writeInsertion(choice.attributeCode);
  };

  const insertRow = (row: PickerRow) => {
    if (row.choice) insertField(row.choice);
    else if (row.fn) writeInsertion(row.fn.signature.includes('(') ? `${row.fn.code}(` : row.fn.code);
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (!rows.length) return;
      setActive((index) => {
        const count = rows.length;
        const base = Math.min(index, count - 1);
        return event.key === 'ArrowDown' ? (base + 1) % count : (base - 1 + count) % count;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const typed = partial.trim();
      if (isCalcNumber(typed)) {
        writeInsertion(typed);
        return;
      }
      if (open && rows.length) {
        insertRow(rows[activeIndex]);
        return;
      }
      if (isCalcIdent(typed)) writeInsertion(typed);
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Backspace' && partial === '' && event.currentTarget.selectionStart === 0) {
      event.preventDefault();
      removeAt(safeGap - 1);
      return;
    }
    if (event.key === 'ArrowLeft' && partial === '' && event.currentTarget.selectionStart === 0) {
      event.preventDefault();
      gapFocus.current = true;
      setGap((value) => Math.max(0, Math.min(value, tokens.length) - 1));
      return;
    }
    if (event.key === 'ArrowRight' && partial === '' && event.currentTarget.selectionStart === event.currentTarget.value.length) {
      event.preventDefault();
      gapFocus.current = true;
      setGap((value) => Math.min(tokens.length, value + 1));
      return;
    }
    if (event.key === ' ' && isCalcAtom(partial.trim())) {
      event.preventDefault();
      writeInsertion(partial.trim());
      return;
    }
    if ('+-*/(),'.includes(event.key) && event.key.length === 1) {
      if (partial.trim() && !isCalcAtom(partial.trim())) return;
      event.preventDefault();
      writeInsertion(event.key, true);
    }
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
        const nextDraft = decompileCalcExpression(saved.definition.expression);
        setDraft(nextDraft);
        setPartial('');
        setGap(tokenizeCalcDraft(nextDraft, nullary).length);
        setBindings(initialBindings(saved.definition));
        onSaved(saved.definition);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not read the expression');
    } finally {
      setSaving(false);
    }
  };

  const help = selfOnly
    ? 'Every attribute comes from this record. Type to search, or press /.'
    : 'Build the value from other attributes. Type to search, or press /.';

  const fieldMeta = (code: string) => {
    const binding = bindings[code] || inferBinding(code, choices, spec.domainCode);
    const choice = choices.find((item) => item.attributeCode === code);
    return {
      caption: viaCaption(binding, relationships) || choice?.attributeName || '',
      hint: sourceCaption(binding, spec.domainCode, relationships, names),
    };
  };

  const composerInput = (
    <input
      ref={composer}
      className={`calc-compose${partial || safeGap === tokens.length ? ' wide' : ''}`}
      value={partial}
      placeholder={safeGap === tokens.length ? 'Add a field, function, number or operator...' : ''}
      aria-label="Add a field, function, number or operator"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open && rows[activeIndex] ? `${listId}-${activeIndex}` : undefined}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      onChange={(event) => {
        setPartial(event.target.value);
        setOpen(true);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={onComposerKeyDown}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text').replace(/\s+/g, ' ').trim();
        if (!text) return;
        event.preventDefault();
        writeInsertion(text);
      }}
    />
  );

  if (structured) {
    return (
      <div className="calc-builder">
        <BuilderHead help="This expression is stored in a structured form. Edit it here, or replace it with a formula." status={status} issue={compiled.issue} />
        <div className="calc-label">Expression</div>
        <textarea className="calc-raw" value={draft} aria-label="Calculation expression" spellCheck={false} rows={6} onChange={(event) => setDraft(event.target.value)} />
        {compiled.issue && <div className="calc-expr-issue">{compiled.issue}</div>}
        {error && <div className="calc-expr-issue">{error}</div>}
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving || !draft.trim() || Boolean(compiled.issue)}>
          {saving ? 'Saving…' : 'Save expression'}
        </button>
      </div>
    );
  }

  return (
    <div
      className="calc-builder"
      ref={root}
      onKeyDownCapture={(event) => {
        if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
        const tag = (event.target as HTMLElement).tagName;
        if (tag === 'SELECT' || tag === 'TEXTAREA') return;
        event.preventDefault();
        setOpen(true);
        gapFocus.current = true;
        composer.current?.focus();
      }}
    >
      <BuilderHead help={help} status={status} issue={compiled.issue} />
      <div className="calc-label">Expression</div>
      <div
        className={`calc-formula${open ? ' open' : ''}`}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('button, input')) return;
          event.preventDefault();
          activate(tokens.length);
        }}
      >
        {tokens.map((token, index) => {
          const meta = token.kind === 'field' ? fieldMeta(token.text) : { caption: '', hint: '' };
          return (
            <Fragment key={`${token.start}-${token.text}`}>
              {safeGap === index ? composerInput : null}
              <FormulaChip
                token={token}
                caption={meta.caption}
                hint={meta.hint}
                onActivate={() => activate(index + 1)}
                onRemove={token.kind === 'field' || token.kind === 'fn' || token.kind === 'number' || token.kind === 'text' ? () => removeAt(index) : undefined}
              />
            </Fragment>
          );
        })}
        {safeGap === tokens.length ? composerInput : null}
      </div>
      {compiled.issue && <div className="calc-expr-issue">{compiled.issue}</div>}

      <div className={`calc-stage${open ? '' : ' collapsed'}`}>
        {open && (
          <div className="calc-picker">
            <div className="calc-tabs" role="tablist">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={tab === item.id ? 'calc-tab active' : 'calc-tab'}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setTab(item.id);
                    setOpen(true);
                    gapFocus.current = true;
                    composer.current?.focus();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="calc-picker-list" id={listId} role="listbox" ref={listRef} aria-label="Fields and functions">
              {!ready && <div className="calc-empty">Loading fields and functions…</div>}
              {ready && rows.length === 0 && <div className="calc-empty">Nothing matches.</div>}
              {rows.map((row, index) => {
                const showHeader = index === 0 || rows[index - 1].group !== row.group;
                return (
                  <Fragment key={`${row.key}-${index}`}>
                    {showHeader && <div className="calc-picker-group">{row.group}</div>}
                    <button
                      type="button"
                      role="option"
                      id={`${listId}-${index}`}
                      ref={index === activeIndex ? activeRow : undefined}
                      aria-selected={index === activeIndex}
                      tabIndex={-1}
                      className={index === activeIndex ? 'calc-row active' : 'calc-row'}
                      title={row.fn?.description || row.detail}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        insertRow(row);
                      }}
                    >
                      <span className="calc-row-copy">
                        <span className="calc-row-title">{row.title}</span>
                        {row.detail && <span className="calc-row-detail">{row.detail}</span>}
                      </span>
                      {row.fn
                        ? <span className="calc-signature">{row.meta}</span>
                        : row.meta ? <span className="calc-type">{row.meta}</span> : null}
                    </button>
                  </Fragment>
                );
              })}
            </div>
            <div className="calc-picker-foot">
              <span><kbd className="calc-kbd">↑</kbd><kbd className="calc-kbd">↓</kbd> move</span>
              <span><kbd className="calc-kbd">Enter</kbd> insert</span>
              <span><kbd className="calc-kbd">Esc</kbd> close</span>
              <span><kbd className="calc-kbd">⌫</kbd> remove</span>
            </div>
          </div>
        )}

        <div className="calc-rail">
          <div>
            <div className="calc-rail-label">Operators</div>
            <div className="calc-op-grid">
              {FORMULA_OPERATORS.map((operator) => (
                <button
                  key={operator.symbol}
                  type="button"
                  className="calc-op-btn"
                  aria-label={operator.label}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => writeInsertion(operator.symbol, true)}
                >
                  {operator.glyph}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="calc-rail-label">Reads from</div>
            {refs.length === 0 && <p className="calc-read-empty">Fields you add are listed here, with the record they are read from.</p>}
            <div className="calc-reads">
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
                  <div key={code} className="calc-read">
                    <span title={code}>{attribute?.attributeName || code}</span>
                    {options.length > 1 ? (
                      <select
                        className="select"
                        aria-label={`Record for ${attribute?.attributeName || code}`}
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
                        {selected < 0 && <option value="current">{sourceCaption(binding, spec.domainCode, relationships, names)}</option>}
                        {options.map((choice, index) => (
                          <option key={choice.groupLabel} value={index}>{choice.groupLabel}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="calc-read-from">{sourceCaption(binding, spec.domainCode, relationships, names)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {error && <div className="calc-expr-issue">{error}</div>}
      <button className="btn btn-primary" type="button" onClick={save} disabled={saving || !draft.trim() || Boolean(compiled.issue)}>
        {saving ? 'Saving…' : 'Save expression'}
      </button>
    </div>
  );
}

function BuilderHead({ help, status, issue }: { help: string; status: { tone: string; label: string }; issue: string }) {
  return (
    <div className="calc-builder-top">
      <p className="calc-help">{help}</p>
      <span className={`calc-badge ${status.tone}`} title={issue || undefined}>
        {status.tone === 'ok' ? '✓ ' : ''}{status.label}
      </span>
    </div>
  );
}

function FormulaChip({
  token,
  caption,
  hint,
  onActivate,
  onRemove,
}: {
  token: CalcDraftToken;
  caption: string;
  hint: string;
  onActivate: () => void;
  onRemove?: () => void;
}) {
  const hold = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
  if (token.kind === 'op' || token.kind === 'paren') {
    return (
      <button type="button" className="calc-opchip" tabIndex={-1} aria-label={token.text} onMouseDown={hold}>
        {OP_GLYPH[token.text] || token.text}
      </button>
    );
  }
  if (token.kind === 'comma') {
    return <button type="button" className="calc-comma" tabIndex={-1} aria-label="Comma" onMouseDown={hold}>,</button>;
  }
  if (token.kind === 'keyword') {
    return <button type="button" className="calc-keyword" tabIndex={-1} onMouseDown={hold}>{token.text.toUpperCase()}</button>;
  }
  const tone = token.kind === 'fn' ? 'fn' : token.kind === 'number' ? 'num' : token.kind === 'text' ? 'bad' : '';
  return (
    <span className={`calc-chip${tone ? ` ${tone}` : ''}`} title={hint || undefined} onMouseDown={hold}>
      <span className="calc-chip-code">{token.text}</span>
      {caption && <span className="calc-chip-name">{caption}</span>}
      {onRemove && (
        <button
          type="button"
          className="calc-chip-x"
          aria-label={`Remove ${token.text}`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
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

function buildPickerRows(tab: PickerTab, query: string, choices: CalcFieldChoice[], functions: ExpressionFn[]): PickerRow[] {
  const needle = query.trim().toLowerCase();
  const hit = (...parts: string[]) => !needle || parts.join(' ').toLowerCase().includes(needle);
  const fieldRow = (choice: CalcFieldChoice): PickerRow => ({
    key: `${choice.groupLabel}-${choice.attributeCode}-${choice.place.relationshipCodes.join('.')}`,
    group: choice.groupLabel,
    title: choice.attributeCode,
    detail: choice.attributeName,
    meta: (choice.dataType || '').toUpperCase(),
    choice,
  });
  const fnRow = (fn: ExpressionFn): PickerRow => ({
    key: fn.code,
    group: 'Functions',
    title: fn.code,
    detail: fn.name.toUpperCase() === fn.code.toUpperCase() ? fn.description : fn.name,
    meta: fn.signature,
    fn,
  });
  const self = choices.filter((choice) => choice.place.traversal === 'SELF' && hit(choice.attributeCode, choice.attributeName, choice.groupLabel));
  const related = choices.filter((choice) => choice.place.traversal !== 'SELF' && hit(choice.attributeCode, choice.attributeName, choice.groupLabel));
  const fns = functions.filter((fn) => fn.callable && hit(fn.code, fn.name, fn.signature, fn.description));
  const rows: PickerRow[] = [];
  if (tab === 'all' || tab === 'fields') rows.push(...self.map(fieldRow));
  if (tab === 'all' || tab === 'functions') rows.push(...fns.map(fnRow));
  if (tab === 'all' || tab === 'related') rows.push(...related.map(fieldRow));
  return rows;
}

function isCalcIdent(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isCalcNumber(value: string) {
  return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value);
}

function isCalcAtom(value: string) {
  return isCalcIdent(value) || isCalcNumber(value);
}

function viaCaption(binding: CalcOperandBinding, relationships: CalcRelationship[]) {
  if (binding.traversal === 'SELF' || binding.relationshipCodes.length === 0) return '';
  const hops = binding.relationshipCodes.map((code) => relationships.find((item) => item.relationshipCode === code)?.relationshipName || code);
  return `via ${hops.join(' → ')}`;
}

function sourceCaption(
  binding: CalcOperandBinding,
  rootDomain: string,
  relationships: CalcRelationship[],
  names: Record<string, string>,
) {
  const label = bindingLabel(binding, rootDomain, relationships, names);
  if (binding.traversal === 'SELF' || binding.relationshipCodes.length === 0) return label;
  return label.replace(' via ', ', via ');
}
