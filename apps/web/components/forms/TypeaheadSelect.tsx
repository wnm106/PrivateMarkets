'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

export interface TypeaheadOption {
  value: string;
  label: string;
  selectedLabel?: string; // shown in the closed box when the list row only carries the field name
  group?: string;
  hint?: string; // right-aligned secondary text, e.g. the data type
  search?: string; // extra text matched when typing, e.g. the attribute code
}

interface TypeaheadSelectProps {
  options: TypeaheadOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  loading?: boolean;
  clearable?: boolean;
}

// A dropdown that is also a search box: click or focus to see the full list,
// type to narrow it, arrow keys and Enter to pick.
export function TypeaheadSelect({ options, value, onChange, placeholder = 'Select...', disabled, error, loading, clearable }: TypeaheadSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.search || ''} ${o.group || ''}`.toLowerCase().includes(q));
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: TypeaheadOption) => {
    onChange(o.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (filtered[active]) pick(filtered[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      close();
    }
  };

  let lastGroup: string | undefined;
  return (
    <div
      className="ts"
      ref={root}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <input
        className={`text-input ts-input ${error ? 'error' : ''}`}
        role="combobox"
        aria-expanded={open}
        value={open ? query : selected?.selectedLabel || selected?.label || ''}
        placeholder={open && selected ? selected.selectedLabel || selected.label : loading ? 'Loading…' : placeholder}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {clearable && value && !disabled ? (
        <button type="button" className="ts-clear" aria-label="Clear" onMouseDown={(e) => { e.preventDefault(); onChange(''); close(); }}>✕</button>
      ) : (
        <span className="ts-caret" aria-hidden />
      )}
      {open && (
        <ul className="ts-list" role="listbox" ref={list}>
          {filtered.length === 0 && <li className="ts-empty">{loading ? 'Loading…' : 'No matches'}</li>}
          {filtered.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? <li key={`g-${o.group}`} className="ts-group">{o.group}</li> : null;
            lastGroup = o.group;
            return (
              <Fragment key={o.value}>
                {header}
                <li
                  role="option"
                  aria-selected={o.value === value}
                  data-active={i === active}
                  className={`ts-opt ${i === active ? 'active' : ''} ${o.value === value ? 'sel' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                >
                  <span>{o.label}</span>
                  {o.hint && <small>{o.hint}</small>}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
