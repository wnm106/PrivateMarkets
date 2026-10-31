'use client';

import { useState } from 'react';
import { EntityAttributeTree, SelectedAttribute, RelationshipHop } from './EntityAttributeTree';

interface AttributePickerProps {
  label: string;
  rootDomainCode: string;
  value: string; // attribute code
  onChange: (attributeCode: string, path?: RelationshipHop[]) => void;
  attributes: Array<{ attributeCode: string; attributeName: string; dataType: string }>;
  placeholder?: string;
  error?: boolean;
}

export function AttributePicker({
  label,
  rootDomainCode,
  value,
  onChange,
  attributes,
  placeholder = 'Select attribute...',
  error,
}: AttributePickerProps) {
  const [showTree, setShowTree] = useState(false);
  const [selection, setSelection] = useState<SelectedAttribute | null>(null);

  const selectedAttr = attributes.find((a) => a.attributeCode === value);

  const handleTreeSelect = (sel: SelectedAttribute) => {
    setSelection(sel);
    onChange(sel.attribute.attributeCode, sel.path);
    setShowTree(false);
  };

  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
        <select
          className={`select ${error ? 'error' : ''}`}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setSelection(null);
          }}
          style={{ flex: 1 }}
        >
          <option value="">{placeholder}</option>
          {attributes.map((a) => (
            <option key={a.attributeCode} value={a.attributeCode}>
              {a.attributeName}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => setShowTree(!showTree)}
          style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap' }}
        >
          {showTree ? '✕ Close' : '🌳 Browse'}
        </button>
      </div>

      {/* Show path if selected via tree */}
      {selection && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--ink-3)' }}>
          Path: <span className="mono">{selection.pathLabel}</span>
        </div>
      )}

      {/* Tree browser */}
      {showTree && rootDomainCode && (
        <div style={{ marginTop: '8px' }}>
          <EntityAttributeTree
            rootDomainCode={rootDomainCode}
            onSelect={handleTreeSelect}
            selectedCode={value}
            maxHeight="400px"
          />
        </div>
      )}

      {error && <span className="field-error">Required</span>}
    </div>
  );
}
