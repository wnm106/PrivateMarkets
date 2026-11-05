'use client';

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  OPERAND_FUNCTIONS,
  compileExpression,
  describeOperand,
  type OperandContext,
} from '@/lib/condition-expression';

interface Suggestion {
  key: string;
  label: string;
  insert: string;
  group: string;
  hint?: string;
}

interface ExpressionBoxProps {
  value: string;
  onChange: (text: string) => void;
  context: OperandContext;
  placeholder?: string;
  error?: string;
  loading?: boolean;
  disabled?: boolean;
  /** Typed text is read as a list (a, b, c), so suggestions and parsing are off. */
  plain?: boolean;
}

const TOKEN = /[A-Za-z0-9_.]*$/;
const AFTER_OPERATOR = /(^|[+\-*/(,])\s*$/;

// One box for every operand. Click it to pick a field from the list, type to narrow
// the list, or keep typing to build an expression: NAV * 0.1, ROUND(COST / 2, 1),
// END_OF_MONTH(CURRENT_DATE), POSITION.MARKET_VALUE + CASH.
export function ExpressionBox({ value, onChange, context, placeholder, error, loading, disabled, plain }: ExpressionBoxProps) {
  const [open, setOpen] = useState(false);
  const [functionsOnly, setFunctionsOnly] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const before = value.slice(0, caret);
  const token = TOKEN.exec(before)?.[0] ?? '';
  const tokenStart = caret - token.length;
  const showAll = functionsOnly || token === '' ;
  const canSuggest = !plain && !/^[0-9]/.test(token) && (functionsOnly || token !== '' || value.trim() === '' || AFTER_OPERATOR.test(before));

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!canSuggest) return [];
    const q = token.toLowerCase();
    const out: Suggestion[] = [];
    if (!functionsOnly) {
      for (const f of context.fields) {
        const insert = f.path.length ? `${f.domainCode}.${f.attributeCode}` : f.attributeCode;
        const haystack = `${f.attributeName} ${f.attributeCode} ${f.groupLabel} ${insert}`.toLowerCase();
        if (q && !haystack.includes(q)) continue;
        out.push({ key: f.valueKey, label: f.attributeName, insert, group: f.groupLabel, hint: f.dataType?.toLowerCase() });
        if (out.length >= 120) break;
      }
    }
    for (const fn of OPERAND_FUNCTIONS) {
      if (q && !showAll && !`${fn.name} ${fn.description}`.toLowerCase().includes(q)) continue;
      out.push({ key: `fn:${fn.name}`, label: fn.signature, insert: fn.insert, group: `Functions · ${fn.group}`, hint: fn.description });
    }
    return out;
  }, [canSuggest, token, functionsOnly, showAll, context.fields]);

  useEffect(() => {
    setActive(0);
  }, [token, functionsOnly, open]);

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
        setFunctionsOnly(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useLayoutEffect(() => {
    if (pendingCaret.current != null && input.current) {
      input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const pick = (s: Suggestion) => {
    const start = functionsOnly ? caret : tokenStart;
    const next = value.slice(0, start) + s.insert + value.slice(caret);
    onChange(next);
    const at = start + s.insert.length;
    pendingCaret.current = at;
    setCaret(at);
    setFunctionsOnly(false);
    setOpen(s.insert.endsWith('('));
    input.current?.focus();
  };

  const syncCaret = () => setCaret(input.current?.selectionStart ?? value.length);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && open && suggestions[active] && (token !== '' || functionsOnly || e.key === 'Enter')) {
      if (e.key === 'Enter' && token === '' && !functionsOnly && value.trim() !== '') return;
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setFunctionsOnly(false);
    }
  };

  const compiled = useMemo(() => (plain ? { ast: null } : compileExpression(value, context)), [plain, value, context]);
  const message = error || compiled.error;
  const suggesting = open && suggestions.length > 0;
  const described = !message && compiled.ast ? describeOperand(compiled.ast, context) : '';
  const showDescription = described && described !== value.trim();

  let lastGroup = '';
  return (
    <div className="xb" ref={root}>
      <div className={`xb-field ${message ? 'error' : ''}`}>
        <input
          ref={input}
          className="text-input xb-input"
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={loading ? 'Loading fields…' : placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setFunctionsOnly(false);
            if (!plain) setOpen(true);
          }}
          onFocus={() => {
            syncCaret();
            if (!plain) setOpen(true);
          }}
          onClick={() => {
            syncCaret();
            if (!plain) setOpen(true);
          }}
          onKeyUp={syncCaret}
          onKeyDown={onKeyDown}
        />
        {!plain && (
          <button
            type="button"
            className="xb-fx"
            disabled={disabled}
            title="Insert a function"
            aria-label="Insert a function"
            onMouseDown={(e) => {
              e.preventDefault();
              setFunctionsOnly(true);
              setCaret(input.current?.selectionStart ?? value.length);
              setOpen(true);
              input.current?.focus();
            }}
          >
            ƒx
          </button>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <ul className="ts-list xb-list" role="listbox" ref={list}>
          {suggestions.map((s, i) => {
            const header = s.group !== lastGroup ? <li key={`g-${s.group}`} className="ts-group">{s.group}</li> : null;
            lastGroup = s.group;
            return (
              <Fragment key={s.key}>
                {header}
                <li
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  className={`ts-opt ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                >
                  <span className={s.key.startsWith('fn:') ? 'mono' : undefined}>{s.label}</span>
                  {s.hint && <small>{s.hint}</small>}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
      {open && canSuggest && suggestions.length === 0 && token !== '' && (
        <ul className="ts-list xb-list">
          <li className="ts-empty">No field or function matches “{token}”. Keep typing to enter a value or an expression.</li>
        </ul>
      )}

      {message && !suggesting ? (
        <span className="xb-note err" data-cond-error>{message}</span>
      ) : !message && showDescription ? (
        <span className="xb-note">{described}</span>
      ) : null}
    </div>
  );
}
