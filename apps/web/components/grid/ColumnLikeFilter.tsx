'use client';

import { useEffect, useRef, useState } from 'react';
import type { CustomFloatingFilterProps } from 'ag-grid-react';
import { likeSearchModel, textFromColumnFilter } from '@/lib/grid-filters';

/** Contains search under a column header. The filter menu keeps the value pick list. */
export function ColumnLikeFilter(props: CustomFloatingFilterProps) {
  const parentText = textFromColumnFilter(props.model);
  const [value, setValue] = useState(parentText);
  const valueRef = useRef(parentText);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);
  const header = props.column?.getColDef?.().headerName || 'column';

  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    if (parentText === valueRef.current) return;
    valueRef.current = parentText;
    setValue(parentText);
  }, [parentText]);

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  const commit = (text: string) => {
    const current = props.currentParentModel?.() ?? props.model;
    if (text === textFromColumnFilter(current)) return;
    props.onModelChange(likeSearchModel(current, text));
  };

  const schedule = (text: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(text), 200);
  };

  return (
    <input
      ref={inputRef}
      className="app-grid-like"
      type="search"
      value={value}
      placeholder="Contains"
      aria-label={`Contains ${header}`}
      autoComplete="off"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => {
        const text = event.target.value;
        valueRef.current = text;
        setValue(text);
        schedule(text);
      }}
      onBlur={() => {
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = null;
        commit(valueRef.current);
      }}
    />
  );
}
