'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { rememberEntityRef, searchEntityRefs, useEntityRef, type EntityRef } from '@/lib/entity-reference';

const SEARCH_DELAY_MS = 200;

/**
 * Picks a record of one entity type for a reference field. Typing searches that
 * type by name. The stored value is the chosen record's master id.
 */
export function EntityReferencePicker({
  domainCode,
  value,
  onChange,
  onSelect,
  className,
  placeholder,
  ariaLabel,
  autoFocus,
  disabled,
  style,
  onKeyDown,
  onBlur,
  onClick,
}: {
  domainCode: string;
  value: string;
  onChange: (value: string) => void;
  onSelect?: (value: string) => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onBlur?: () => void;
  onClick?: (event: MouseEvent) => void;
}) {
  const current = useEntityRef(value);
  const [open, setOpen] = useState(Boolean(autoFocus));
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<EntityRef[] | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHits(null);
    const timer = setTimeout(() => {
      searchEntityRefs(domainCode, query)
        .then((found) => {
          if (cancelled) return;
          setHits(found);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, query ? SEARCH_DELAY_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, domainCode]);

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, hits]);

  // A stored value that names no visible record still shows, so it is not lost.
  const closedLabel = value ? current === undefined ? 'Loading…' : current?.entityName || value : '';
  const options = hits || [];
  const rows = value ? options.length + 1 : options.length;

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const choose = (next: EntityRef | null) => {
    if (next) rememberEntityRef(next);
    const id = next?.id || '';
    close();
    onChange(id);
    onSelect?.(id);
  };

  const pickRow = (index: number) => {
    if (value && index === options.length) choose(null);
    else if (options[index]) choose(options[index]);
  };

  return (
    <div className="ts" style={style} onClick={onClick}>
      <input
        className={`${className || 'text-input'} ts-input`}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        disabled={disabled}
        value={open ? query : closedLabel}
        placeholder={open && current ? current.entityName : placeholder || 'Search…'}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          close();
          onBlur?.();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, Math.max(rows - 1, 0)));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
            return;
          }
          if (event.key === 'Enter' && open && query && rows > 0) {
            event.preventDefault();
            pickRow(active);
            return;
          }
          if (event.key === 'Escape') close();
          onKeyDown?.(event);
        }}
      />
      <span className="ts-caret" aria-hidden />
      {open && !disabled && (
        <ul className="ts-list ts-list-ref" role="listbox" ref={list}>
          {hits === null && <li className="ts-empty">Searching…</li>}
          {hits !== null && options.length === 0 && <li className="ts-empty">No matches</li>}
          {options.map((ref, index) => (
            <li
              key={ref.id}
              role="option"
              aria-selected={ref.id === value}
              data-active={index === active}
              className={`ts-opt ${index === active ? 'active' : ''} ${ref.id === value ? 'sel' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(ref);
              }}
            >
              <span>{ref.entityName}</span>
              {ref.entityCode && ref.entityCode !== ref.entityName && <small>{ref.entityCode}</small>}
            </li>
          ))}
          {value && (
            <li
              role="option"
              aria-selected={false}
              data-active={active === options.length}
              className={`ts-opt ${active === options.length ? 'active' : ''}`}
              onMouseEnter={() => setActive(options.length)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(null);
              }}
            >
              <span>Clear</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
