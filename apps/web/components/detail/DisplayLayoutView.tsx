'use client';

import { useEffect, useState } from 'react';
import {
  applyControlChange,
  collectControls,
  expandLayout,
  type DisplayNode,
  type LayoutParameter,
} from '@tapestrai/graphql/src/lib/display-layout';
import { AttributeValueInput, useAttributeDisplay } from '@/components/forms/AttributeValueInput';
import { formatAttributeDisplay } from '@/lib/attribute-display';

export interface DisplayParameterOption {
  value: string;
  label: string;
  sets?: Record<string, string> | null;
}

export interface DisplayParameter {
  name: string;
  label?: string | null;
  type?: string | null;
  binds?: string | null;
  multi?: boolean | null;
  defaultValue?: string | null;
  options: DisplayParameterOption[];
}

export interface DisplayCellData {
  periodKey: string;
  basis: string;
  value: string | null;
  readOnly: boolean;
  entityId?: string | null;
  periodStart: string;
  periodEnd: string;
  periodGrain: string;
}

export interface ResolvedLayoutView {
  id: string;
  layoutName: string;
  htmlTemplate: string;
  parameters: DisplayParameter[];
  effectiveControls: Record<string, string>;
  periods: Array<{ key: string; label: string; periodStart: string; periodEnd: string; grain: string; entityId?: string | null }>;
  rows: Array<{ attributeCode: string; cells: DisplayCellData[] }>;
}

function asParameters(parameters: DisplayParameter[]): LayoutParameter[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
    label: parameter.label || undefined,
    type: parameter.type || undefined,
    binds: parameter.binds || undefined,
    multi: Boolean(parameter.multi),
    default: parameter.defaultValue || undefined,
    options: parameter.options.map((option) => ({
      value: option.value,
      label: option.label,
      sets: option.sets || undefined,
    })),
  }));
}

function findCell(layout: ResolvedLayoutView, attributeCode: string, periodKey: string, basis: string): DisplayCellData | null {
  const row = layout.rows.find((item) => item.attributeCode === attributeCode);
  if (!row) return null;
  return row.cells.find((cell) => (
    (!periodKey || cell.periodKey === periodKey)
    && (!basis || cell.basis === basis)
  )) || null;
}

export function DisplayLayoutView({
  layout,
  controls,
  onControlsChange,
  onSaveCell,
}: {
  layout: ResolvedLayoutView;
  controls: Record<string, string>;
  onControlsChange: (next: Record<string, string>) => void;
  onSaveCell: (attributeCode: string, cell: DisplayCellData, value: string) => Promise<void>;
}) {
  const active = { ...layout.effectiveControls, ...controls };
  const parameters = asParameters(layout.parameters);
  const nodes = expandLayout(layout.htmlTemplate, layout.periods as any, {
    viewGrain: (active.viewGrain as any) || 'QUARTERLY',
    statementBasis: (active.statementBasis || 'ACTUAL').split(',').filter(Boolean),
    presentation: active.presentation === 'LTM' || active.presentation === 'YTD' ? active.presentation : 'AS_REPORTED',
    values: active,
  });
  const placed = collectControls(nodes);
  const unplaced = layout.parameters.filter((parameter) => !placed.has(parameter.name));

  const change = (name: string, value: string) => {
    onControlsChange(applyControlChange(parameters, active, name, value));
  };

  return (
    <div className="statement-layout">
      <div className="statement-layout-name">{layout.layoutName}</div>
      {unplaced.length > 0 && (
        <div className="statement-toolbar">
          {unplaced.map((parameter) => (
            <ControlField key={parameter.name} parameter={parameter} value={active[parameter.name] || ''} onChange={change} />
          ))}
        </div>
      )}
      <LayoutNodes nodes={nodes} layout={layout} active={active} onChange={change} onSaveCell={onSaveCell} />
    </div>
  );
}

function ControlField({
  parameter,
  value,
  onChange,
}: {
  parameter: DisplayParameter;
  value: string;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <label>
      {parameter.label || parameter.name}
      <select className="text-input" value={value} onChange={(event) => onChange(parameter.name, event.target.value)}>
        {parameter.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function LayoutNodes({
  nodes,
  layout,
  active,
  onChange,
  onSaveCell,
}: {
  nodes: DisplayNode[];
  layout: ResolvedLayoutView;
  active: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onSaveCell: (attributeCode: string, cell: DisplayCellData, value: string) => Promise<void>;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <LayoutNode key={index} node={node} layout={layout} active={active} onChange={onChange} onSaveCell={onSaveCell} />
      ))}
    </>
  );
}

function LayoutNode({
  node,
  layout,
  active,
  onChange,
  onSaveCell,
}: {
  node: DisplayNode;
  layout: ResolvedLayoutView;
  active: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onSaveCell: (attributeCode: string, cell: DisplayCellData, value: string) => Promise<void>;
}) {
  if (node.type === 'text') return <>{node.text}</>;
  if (node.type === 'control') {
    const parameter = layout.parameters.find((item) => item.name === node.control);
    if (!parameter) return null;
    return <ControlField parameter={parameter} value={active[parameter.name] || ''} onChange={onChange} />;
  }
  if (node.type === 'field') {
    const cell = findCell(layout, node.attributeCode || '', node.periodKey || '', node.basis || '');
    return (
      <FieldCell
        attributeCode={node.attributeCode}
        value={cell?.value ?? ''}
        readOnly={!cell || cell.readOnly}
        onSave={async (value) => {
          if (cell && node.attributeCode) await onSaveCell(node.attributeCode, cell, value);
        }}
      />
    );
  }
  const Tag = (node.tag || 'div') as keyof JSX.IntrinsicElements;
  const style = node.indent ? { paddingLeft: `${Number(node.indent) * 16}px`, fontWeight: node.role === 'total' ? 600 : undefined } : node.role === 'total' ? { fontWeight: 600 } : undefined;
  return (
    <Tag className={node.className} style={style}>
      <LayoutNodes nodes={node.children || []} layout={layout} active={active} onChange={onChange} onSaveCell={onSaveCell} />
    </Tag>
  );
}

function FormattedAttributeText({ attributeCode, value }: { attributeCode?: string; value: string }) {
  const meta = useAttributeDisplay(attributeCode);
  const text = formatAttributeDisplay(value, meta) || value;
  return <span>{text || '—'}</span>;
}

function FieldCell({
  attributeCode,
  value,
  readOnly,
  onSave,
}: {
  attributeCode?: string;
  value: string;
  readOnly: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  if (readOnly) return <FormattedAttributeText attributeCode={attributeCode} value={value} />;
  const save = (next: string) => {
    if (next === value || !next.trim()) return;
    setSaving(true);
    onSave(next).finally(() => setSaving(false));
  };
  return (
    <AttributeValueInput
      attributeCode={attributeCode}
      className="text-input statement-field"
      value={draft}
      disabled={saving}
      onChange={setDraft}
      onSelect={save}
      onBlur={() => save(draft)}
    />
  );
}
