'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DQ_DATE_FNS,
  DQ_OPERATORS,
  type DqClause,
  type DqJoin,
  type DqOperator,
  applyRhs,
  clauseIssue,
  comparisonHint,
  describeRule,
  formatExpression,
  isComparison,
  literalKindFor,
  newClause,
  operatorNeedsValue,
  parseExpression,
  rhsText,
  serializeClauses,
} from '@/lib/dq-expression';

export interface DqAttributeOption {
  attributeCode: string;
  attributeName: string;
  domainCode: string | null;
  dataType?: string | null;
}

interface DqDomainOption {
  domainCode: string;
  domainName: string;
}

interface DqExpressionEditorProps {
  expression: string;
  attributes: DqAttributeOption[];
  domains?: DqDomainOption[];
  onChange: (expression: string, issue: string | null) => void;
}

const OPERATOR_GROUPS: Array<{ label: string; values: DqOperator[] }> = [
  { label: 'Presence', values: ['IS NOT NULL', 'IS NULL'] },
  { label: 'Comparison', values: ['=', '!=', '>', '>=', '<', '<='] },
  { label: 'List', values: ['IN'] },
  { label: 'Pattern', values: ['~', 'LIKE', 'ILIKE'] },
];

const GUIDANCE: Partial<Record<DqOperator, string>> = {
  'IS NULL': 'A blank value passes. Use or when a missing value should not fail the other checks.',
  '~': 'A regular expression, such as ^[A-Z]{2}$ for two letters.',
  LIKE: '% matches any text and _ matches one character. Case sensitive.',
  ILIKE: 'Same as is like, without case sensitivity.',
};

export function DqExpressionEditor({ expression, attributes, domains = [], onChange }: DqExpressionEditorProps) {
  const initial = parseExpression(expression);
  const [clauses, setClauses] = useState<DqClause[]>(initial.clauses);
  const [rawMode, setRawMode] = useState(initial.raw);
  const [rawText, setRawText] = useState(expression);
  const [rawIssue, setRawIssue] = useState<string | null>(null);
  const [focusId, setFocusId] = useState('');

  const issues = clauses.map((clause) => (
    clauseIssue(clause, attributes.find((attribute) => attribute.attributeCode === clause.attribute)?.dataType)
  ));
  const issue = issues.find(Boolean) || null;
  const serialized = serializeClauses(clauses);
  const nameFor = (code: string) => attributes.find((attribute) => attribute.attributeCode === code)?.attributeName || code;
  const summarySource = rawMode ? parseExpression(rawText) : { clauses, raw: false };
  const summary = summarySource.raw
    ? 'This expression is edited as text.'
    : describeRule(summarySource.clauses, nameFor);
  const mixedJoins = clauses.some((clause) => clause.join === 'AND') && clauses.some((clause) => clause.join === 'OR');

  useEffect(() => {
    if (rawMode) {
      onChange(rawText, rawText.trim() ? null : 'Write an expression, or switch back to the condition builder.');
      return;
    }
    onChange(serialized, issue);
    // The parent stores the expression this effect reports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, issue, rawMode, rawText]);

  const update = (id: string, patch: Partial<DqClause>) => {
    setClauses((current) => current.map((clause) => (clause.id === id ? { ...clause, ...patch } : clause)));
  };

  const changeOperator = (clause: DqClause, operator: DqOperator) => {
    const patch: Partial<DqClause> = { operator };
    if (isComparison(operator) && !isComparison(clause.operator)) {
      const kind = literalKindFor(attributes.find((attribute) => attribute.attributeCode === clause.attribute)?.dataType);
      patch.valueKind = kind === 'number' ? 'number' : 'text';
      patch.value = '';
      patch.dateFn = null;
    }
    update(clause.id, patch);
  };

  const changeAttribute = (clause: DqClause, attribute: string) => {
    const dataType = attributes.find((item) => item.attributeCode === attribute)?.dataType;
    const patch: Partial<DqClause> = { attribute };
    if (isComparison(clause.operator) && !rhsMatches(clause, dataType, attributes)) {
      const kind = literalKindFor(dataType);
      patch.valueKind = kind === 'number' ? 'number' : 'text';
      patch.value = '';
      patch.dateFn = null;
    }
    update(clause.id, patch);
  };

  const removeClause = (id: string) => {
    setClauses((current) => {
      const next = current.filter((clause) => clause.id !== id);
      if (next[0]) next[0] = { ...next[0], join: null };
      return next.length ? next : [newClause()];
    });
  };

  const openBuilder = () => {
    const parsed = parseExpression(rawText);
    if (parsed.raw) {
      setRawIssue('The builder understands attribute checks joined by and or or. Simplify the text, or keep editing it here.');
      return;
    }
    setClauses(parsed.clauses);
    setRawMode(false);
    setRawIssue(null);
  };

  return (
    <div className="dq-builder">
      <div className="dq-summary">
        <div>
          <div className="dq-kicker">A record passes when</div>
          <p>{summary}</p>
          {!rawMode && mixedJoins && <p className="dq-note">And is checked before or.</p>}
          {!rawMode && issue && <p className="dq-note">Finish the marked condition before saving.</p>}
        </div>
        {rawMode ? (
          <button type="button" className="dq-text-btn" onClick={openBuilder}>Use condition builder</button>
        ) : (
          <button
            type="button"
            className="dq-text-btn"
            onClick={() => {
              setRawText(serialized || expression);
              setRawIssue(null);
              setRawMode(true);
            }}
          >
            Edit as text
          </button>
        )}
      </div>

      {rawMode ? (
        <div className="dq-raw">
          <textarea
            className="text-input mono"
            value={rawText}
            rows={6}
            aria-label="Rule expression"
            onChange={(event) => {
              setRawText(event.target.value);
              setRawIssue(null);
            }}
          />
          {rawIssue && <p className="dq-clause-issue">{rawIssue}</p>}
        </div>
      ) : (
        <div className="dq-clauses">
          {clauses.map((clause, index) => (
            <div key={clause.id}>
              {index > 0 && (
                <div className="dq-join">
                  <span className="dq-join-rule" />
                  <select
                    className="select dq-join-select"
                    aria-label="How this condition combines with the one above"
                    value={clause.join || 'AND'}
                    onChange={(event) => update(clause.id, { join: event.target.value as DqJoin })}
                  >
                    <option value="AND">and</option>
                    <option value="OR">or</option>
                  </select>
                  <span className="dq-join-rule" />
                </div>
              )}
              <article className={`dq-clause${issues[index] ? ' invalid' : ''}`} aria-label={`Condition ${index + 1}`}>
                <div className="dq-sentence">
                  <span className="dq-when" aria-hidden={index !== 0}>{index === 0 ? 'When' : ''}</span>
                  <AttributeField
                    attributes={attributes}
                    domains={domains}
                    value={clause.attribute}
                    autoOpen={focusId === clause.id}
                    onChange={(attribute) => changeAttribute(clause, attribute)}
                  />
                  <select
                    className="select dq-op"
                    aria-label="Check"
                    value={clause.operator}
                    onChange={(event) => changeOperator(clause, event.target.value as DqOperator)}
                  >
                    {OPERATOR_GROUPS.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.values.map((value) => {
                          const operator = DQ_OPERATORS.find((item) => item.value === value);
                          return <option key={value} value={value}>{operator?.label || value}</option>;
                        })}
                      </optgroup>
                    ))}
                  </select>
                  <ValueSlot
                    clause={clause}
                    attributes={attributes}
                    domains={domains}
                    onChange={(patch) => update(clause.id, patch)}
                  />
                  {clauses.length > 1 && (
                    <button type="button" className="dq-remove" onClick={() => removeClause(clause.id)}>
                      Remove
                    </button>
                  )}
                </div>
                <ClauseHint clause={clause} />
                {clause.operator === 'IN' && (
                  <InValues values={clause.values} onChange={(values) => update(clause.id, { values })} />
                )}
                {issues[index] && <p className="dq-clause-issue">{issues[index]}</p>}
              </article>
            </div>
          ))}
          <button
            type="button"
            className="add-cond"
            onClick={() => {
              const clause = newClause(clauses.length ? 'AND' : null);
              setClauses([...clauses, clause]);
              setFocusId(clause.id);
            }}
          >
            + Add condition
          </button>
        </div>
      )}

      <details className="dq-expression">
        <summary>View expression</summary>
        <pre><code>{formatExpression(rawMode ? rawText : serialized) || 'Nothing yet'}</code></pre>
      </details>
    </div>
  );
}

function ClauseHint({ clause }: { clause: DqClause }) {
  const hint = comparisonHint(clause) || GUIDANCE[clause.operator];
  return hint ? <p className="dq-hint">{hint}</p> : null;
}

function rhsMatches(clause: DqClause, dataType: string | null | undefined, attributes: DqAttributeOption[]) {
  const kind = literalKindFor(dataType);
  if (clause.valueKind === 'relative' || clause.valueKind === 'current_date') return kind === 'date';
  if (clause.valueKind === 'attribute') {
    if (clause.dateFn && kind !== 'date') return false;
    if (!clause.value.trim()) return true;
    return literalKindFor(attributes.find((item) => item.attributeCode === clause.value)?.dataType) === kind;
  }
  if (kind === 'number') return clause.valueKind === 'number';
  return clause.valueKind === 'text';
}

function ValueSlot({
  clause,
  attributes,
  domains,
  onChange,
}: {
  clause: DqClause;
  attributes: DqAttributeOption[];
  domains: DqDomainOption[];
  onChange: (patch: Partial<DqClause>) => void;
}) {
  const canonical = rhsText(clause);
  const [draft, setDraft] = useState(canonical);
  useEffect(() => { setDraft(canonical); }, [canonical]);

  if (!operatorNeedsValue(clause.operator) || clause.operator === 'IN') return null;
  if (clause.operator === '~' || clause.operator === 'LIKE' || clause.operator === 'ILIKE') {
    return (
      <input
        className="text-input dq-value"
        aria-label="Pattern"
        value={clause.value}
        placeholder={clause.operator === '~' ? '^[A-Z]{2}$' : '%USD%'}
        onChange={(event) => onChange({ value: event.target.value, valueKind: 'text', dateFn: null })}
      />
    );
  }
  if (!clause.attribute) return null;

  const subject = attributes.find((attribute) => attribute.attributeCode === clause.attribute);
  const kind = literalKindFor(subject?.dataType);
  const compatible = attributes.filter((attribute) => (
    attribute.attributeCode !== clause.attribute && literalKindFor(attribute.dataType) === kind
  ));

  const commit = (next: string) => {
    setDraft(next);
    if (!next.trim()) {
      onChange({ value: '', valueKind: kind === 'number' ? 'number' : 'text', dateFn: null });
      return;
    }
    const patch = applyRhs(clause, next);
    if (patch) onChange(patch);
  };

  const insertExpression = (token: string) => {
    const current = draft.trim();
    const field = /^[A-Za-z_][A-Za-z0-9_]*$/.test(current) && current.toUpperCase() !== 'CURRENT_DATE' ? current : '';
    if (token === 'CURRENT_DATE') commit('CURRENT_DATE');
    else commit(field ? `${token}(${field})` : `${token}(CURRENT_DATE)`);
  };

  return (
    <div className="dq-value-slot">
      <input
        className="text-input dq-value-entry"
        aria-label="Value"
        value={draft}
        placeholder={kind === 'number' ? "0 or OTHER_FIELD" : kind === 'date' ? "2026-10-31, OTHER_DATE, END_OF_MONTH(CURRENT_DATE)" : kind === 'boolean' ? 'true, false' : "'US' or OTHER_FIELD"}
        onChange={(event) => commit(event.target.value)}
      />
      <AttributeField
        attributes={compatible}
        domains={domains}
        value=""
        autoOpen={false}
        emptyLabel="Attribute"
        onChange={(value) => commit(value)}
      />
      {kind === 'date' && (
        <select
          className="select"
          aria-label="Insert expression"
          value=""
          onChange={(event) => {
            if (event.target.value) insertExpression(event.target.value);
          }}
        >
          <option value="">Expression</option>
          {DQ_DATE_FNS.map((item) => (
            <option key={item.token} value={item.token}>{item.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function AttributeField({
  attributes,
  domains,
  value,
  autoOpen,
  emptyLabel = 'Choose an attribute',
  onChange,
}: {
  attributes: DqAttributeOption[];
  domains: DqDomainOption[];
  value: string;
  autoOpen: boolean;
  emptyLabel?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = attributes.find((attribute) => attribute.attributeCode === value);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return attributes.filter((attribute) => {
      if (!needle) return true;
      return `${attribute.attributeCode} ${attribute.attributeName} ${attribute.domainCode || ''}`.toLowerCase().includes(needle);
    });
  }, [attributes, query]);

  const groups = useMemo(() => {
    const names = new Map(domains.map((domain) => [domain.domainCode, domain.domainName]));
    const grouped = new Map<string, DqAttributeOption[]>();
    for (const attribute of matches) {
      const key = attribute.domainCode ? names.get(attribute.domainCode) || attribute.domainCode : 'Shared';
      grouped.set(key, [...(grouped.get(key) || []), attribute]);
    }
    return [...grouped.entries()];
  }, [matches, domains]);

  const flat = groups.flatMap(([, items]) => items);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = 300;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow < height && rect.top > height ? rect.top - height - 4 : rect.bottom + 4;
    setBox({ top, left: rect.left, width: Math.max(rect.width, 280) });
  };

  useEffect(() => {
    if (!autoOpen) return;
    setOpen(true);
    setQuery('');
  }, [autoOpen]);

  useEffect(() => {
    if (!open) return;
    place();
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = () => place();
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    if (!open || !box) return;
    searchRef.current?.focus();
  }, [open, Boolean(box)]);

  const choose = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`dq-pick${selected ? '' : ' empty'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `${selected.attributeName} (${selected.attributeCode})` : undefined}
        onClick={() => {
          setQuery('');
          setOpen((current) => !current);
        }}
      >
        <span>{selected ? selected.attributeName : emptyLabel}</span>
      </button>
      {open && box && createPortal(
        <div
          ref={menuRef}
          className="dq-menu"
          style={{ top: box.top, left: box.left, width: box.width }}
          role="listbox"
          aria-label="Attributes"
        >
          <div className="dq-menu-search">
            <input
              ref={searchRef}
              className="text-input"
              value={query}
              placeholder="Search attributes"
              aria-label="Search attributes"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setHighlight((current) => Math.min(current + 1, Math.max(flat.length - 1, 0)));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setHighlight((current) => Math.max(current - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const match = flat[highlight];
                  if (match) choose(match.attributeCode);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          </div>
          {flat.length === 0 && <div className="dq-menu-empty">No matching attribute</div>}
          {groups.map(([domain, items]) => (
            <div key={domain}>
              {groups.length > 1 && <div className="dq-menu-group">{domain}</div>}
              {items.map((attribute) => {
                const index = flat.findIndex((item) => item.attributeCode === attribute.attributeCode && item.domainCode === attribute.domainCode);
                const active = index === highlight;
                return (
                  <button
                    type="button"
                    key={`${domain}-${attribute.attributeCode}`}
                    role="option"
                    aria-selected={attribute.attributeCode === value}
                    data-active={active ? 'true' : 'false'}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(attribute.attributeCode);
                    }}
                  >
                    <strong>{attribute.attributeName}</strong>
                    <em>
                      {attribute.attributeCode}
                      {attribute.dataType ? ` · ${attribute.dataType}` : ''}
                    </em>
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function InValues({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const needle = filter.trim().toLowerCase();
  const visible = needle ? values.filter((value) => value.toLowerCase().includes(needle)) : values;

  const add = (incoming: string[]) => {
    const seen = new Set(values.map((value) => value.toLowerCase()));
    const next = [...values];
    for (const value of incoming) {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      next.push(value);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
    setConfirmClear(false);
  };

  return (
    <div className="dq-list">
      <div className="dq-list-head">
        <span>{values.length === 0 ? 'No values yet' : `${values.length} ${values.length === 1 ? 'value' : 'values'}`}</span>
        {values.length > 0 && (
          <button
            type="button"
            className="dq-text-btn"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              onChange([]);
              setConfirmClear(false);
              setFilter('');
            }}
          >
            {confirmClear ? 'Clear all values?' : 'Clear'}
          </button>
        )}
      </div>
      {values.length > 12 && (
        <input
          className="text-input"
          value={filter}
          placeholder="Find a value"
          aria-label="Find a value"
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <div className="dq-list-chips" aria-label="Allowed values">
        {values.map((value, index) => {
          if (needle && !value.toLowerCase().includes(needle)) return null;
          return (
            <span className="dq-chip" key={`${value}-${index}`}>
              <span>{value}</span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((_, item) => item !== index))}
              >
                ×
              </button>
            </span>
          );
        })}
        {values.length > 0 && visible.length === 0 && <span className="dq-list-empty">No values match.</span>}
      </div>
      <input
        className="text-input"
        value={draft}
        placeholder="Add a value and press Enter, or paste a list"
        aria-label="Add a value"
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add([draft.trim()]);
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text');
          const parts = splitValues(text);
          if (parts.length === 0) return;
          event.preventDefault();
          add(parts);
        }}
        onBlur={() => {
          if (draft.trim()) add([draft.trim()]);
        }}
      />
      <p className="dq-hint">Matching ignores case.</p>
    </div>
  );
}

function splitValues(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const pieces = /[,;\n\r]/.test(trimmed) ? trimmed.split(/[,;\n\r\t]+/) : trimmed.split(/\s+/);
  const tokens = pieces.map(cleanToken).filter(Boolean);
  const shortCode = (token: string) => token.length <= 5 && /^[A-Za-z0-9._-]+$/.test(token);
  if (!/[,;\n\r]/.test(trimmed) && tokens.length > 1 && !tokens.every(shortCode)) {
    const single = cleanToken(trimmed);
    return single ? [single] : [];
  }
  return tokens;
}

function cleanToken(value: string) {
  return value.trim().replace(/^['"]+|['"]+$/g, '').trim();
}
