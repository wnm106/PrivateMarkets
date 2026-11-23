'use client';

import { useEffect, useRef } from 'react';
import type { CustomDateProps } from 'ag-grid-react';

function isoDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseIso(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/**
 * The date box in grid filters. A browser date box shows "mm/dd/yyyy" while
 * empty; this one is marked required so an empty box is :invalid, and the
 * stylesheet hides the format text until it has a date or the focus.
 */
export function GridDateInput({ date, onDateChange }: CustomDateProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = isoDate(date);

  // Left uncontrolled so a half-typed date is not wiped; synced when the grid sets a date.
  useEffect(() => {
    const input = inputRef.current;
    if (input && input.value !== shown && document.activeElement !== input) input.value = shown;
  }, [shown]);

  return (
    <input
      ref={inputRef}
      className="app-grid-date"
      type="date"
      required
      defaultValue={shown}
      aria-label="Date"
      onChange={(event) => {
        const next = parseIso(event.target.value);
        if (isoDate(next) !== shown) onDateChange(next);
      }}
    />
  );
}
