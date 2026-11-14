'use client';

import { useState } from 'react';
import type { CustomCellEditorProps } from 'ag-grid-react';
import { AttributeValueInput } from '@/components/forms/AttributeValueInput';
import { cellEditSeed } from '@/lib/inline-field';

/** Register cell editor. The value it commits is saved as a manual override. */
export function AttributeCellEditor({ value, onValueChange, stopEditing, colDef }: CustomCellEditorProps) {
  const [draft, setDraft] = useState(() => cellEditSeed(value));

  const change = (next: string) => {
    setDraft(next);
    onValueChange(next);
  };

  return (
    <AttributeValueInput
      attributeCode={colDef.colId}
      value={draft}
      autoFocus
      className="text-input"
      style={{ width: '100%', height: '100%', boxSizing: 'border-box' }}
      ariaLabel={colDef.headerName || colDef.colId || 'Value'}
      onClick={(event) => event.stopPropagation()}
      onChange={change}
      onSelect={(next) => {
        change(next);
        stopEditing();
      }}
      onBlur={() => stopEditing()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          stopEditing();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          stopEditing(true);
        }
      }}
    />
  );
}
