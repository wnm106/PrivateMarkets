'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

const SEGMENT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

// Stepping the month, day, or year stays local until Enter or leaving the field.
// Choosing a day in the calendar commits when that picker closes.
export function CommittedDateInput({
  id,
  type = 'date',
  value,
  onCommit,
  className,
  title,
}: {
  id: string;
  type?: 'date' | 'datetime-local';
  value: string;
  onCommit: (value: string) => void;
  className?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const stepping = useRef(false);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);

  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      stepping.current = false;
      event.currentTarget.blur();
      return;
    }
    if (SEGMENT_KEYS.has(event.key)) stepping.current = true;
  };

  return (
    <input
      id={id}
      type={type}
      className={className}
      title={title}
      value={draft}
      onFocus={() => setFocused(true)}
      onPointerDown={() => {
        stepping.current = false;
      }}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (!stepping.current) commit(next);
      }}
      onBlur={(event) => {
        stepping.current = false;
        setFocused(false);
        commit(event.currentTarget.value);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
