'use client';

import { useMemo } from 'react';
import { TypeaheadSelect } from './TypeaheadSelect';

interface AttributePickerProps {
  label: string;
  rootDomainCode?: string;
  value: string; // attribute code
  onChange: (attributeCode: string) => void;
  attributes: Array<{ attributeCode: string; attributeName: string; dataType: string }>;
  placeholder?: string;
  error?: boolean;
  clearable?: boolean;
  /** Sit in a sentence row. The surrounding label names the control. */
  bare?: boolean;
}

// Labelled type-ahead over one entity's attribute list.
export function AttributePicker({
  label,
  value,
  onChange,
  attributes,
  placeholder = 'Select attribute...',
  error,
  clearable,
  bare,
}: AttributePickerProps) {
  const options = useMemo(
    () => attributes.map((a) => ({ value: a.attributeCode, label: a.attributeName, hint: a.dataType?.toLowerCase(), search: a.attributeCode })),
    [attributes],
  );
  return (
    <div className="field">
      {!bare && <label>{label}</label>}
      <TypeaheadSelect options={options} value={value} onChange={onChange} placeholder={placeholder} error={error} clearable={clearable} />
      {error && <span className="field-error">Required</span>}
    </div>
  );
}
