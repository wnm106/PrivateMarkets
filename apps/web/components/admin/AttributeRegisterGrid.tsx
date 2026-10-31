'use client';

import { useEffect, useMemo, useRef } from 'react';
import { AppGrid, type ColDef, type GridApi } from '@/components/grid/AppGrid';

export interface AttributeDefinition {
  id: string;
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description: string | null;
  displayFormat: string | null;
  listValues: string[];
  isMultiValued: boolean;
  validationRules: any;
  defaultValue: string | null;
  displaySection: string;
  displayGroup: number;
  isEditable: boolean;
  isVisible: boolean;
  aggregationType: string;
  weightAttributeCode: string | null;
  numericPrecision: number | null;
}

type GridRow = AttributeDefinition & {
  __editing: boolean;
  __selected: boolean;
  __edit: Partial<AttributeDefinition> | null;
  __newListValue: string;
};

interface Actions {
  attributes: AttributeDefinition[];
  handleSelectAll: () => void;
  handleSelectOne: (id: string) => void;
  handleEdit: (attr: AttributeDefinition) => void;
  handleCancel: () => void;
  handleSave: () => void;
  setEditForm: (next: Partial<AttributeDefinition> | ((current: Partial<AttributeDefinition>) => Partial<AttributeDefinition>)) => void;
  setNewListValue: (value: string) => void;
  handleAddListValue: () => void;
  handleRemoveListValue: (value: string) => void;
}

const NUMERIC = ['NUMBER', 'INTEGER', 'DECIMAL', 'FLOAT', 'CURRENCY', 'PERCENTAGE', 'PERCENT'];

function SelectAllHeader(props: any) {
  const actions = props.context.get() as Actions;
  const all = actions.attributes.length > 0 && props.context.selectedCount === actions.attributes.length;
  return (
    <input
      type="checkbox"
      checked={all}
      onChange={() => actions.handleSelectAll()}
      className="rounded"
      aria-label="Select all attributes"
    />
  );
}

function SelectCell(props: any) {
  const row = props.data as GridRow;
  return (
    <input
      type="checkbox"
      checked={row.__selected}
      onChange={() => (props.context.get() as Actions).handleSelectOne(row.id)}
      className="rounded"
      aria-label={`Select ${row.attributeCode}`}
    />
  );
}

function DescriptionCell(props: any) {
  const row = props.data as GridRow;
  if (!row.__editing || !row.__edit) {
    return row.description
      ? <span>{row.description}</span>
      : <span style={{ color: '#d1d5db', fontStyle: 'italic' }}>No description</span>;
  }
  const actions = props.context.get() as Actions;
  return (
    <textarea
      value={row.__edit.description || ''}
      onChange={(event) => actions.setEditForm({ ...row.__edit, description: event.target.value })}
      placeholder="Enter description for MCP context..."
      className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
      rows={2}
      style={{ resize: 'vertical', minWidth: '200px' }}
    />
  );
}

function AggregationCell(props: any) {
  const row = props.data as GridRow;
  const actions = props.context.get() as Actions;
  if (!row.__editing || !row.__edit) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span>
          {row.aggregationType && row.aggregationType !== 'NONE' ? (
            <span style={{
              display: 'inline-block',
              padding: '2px 8px',
              background: row.aggregationType === 'WEIGHTED_AVG' ? '#fef3c7' : '#e0e7ff',
              border: `1px solid ${row.aggregationType === 'WEIGHTED_AVG' ? '#fcd34d' : '#a5b4fc'}`,
              color: row.aggregationType === 'WEIGHTED_AVG' ? '#92400e' : '#3730a3',
              fontSize: '11px',
              borderRadius: '3px',
              fontWeight: 600,
            }}>
              {row.aggregationType === 'WEIGHTED_AVG' ? 'Weighted Avg' : row.aggregationType}
            </span>
          ) : (
            <span style={{ color: '#d1d5db', fontStyle: 'italic' }}>None</span>
          )}
        </span>
        {row.aggregationType === 'WEIGHTED_AVG' && row.weightAttributeCode && (
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            weight: <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: '2px' }}>{row.weightAttributeCode}</code>
          </span>
        )}
      </div>
    );
  }
  const form = row.__edit;
  return (
    <div>
      <select
        value={form.aggregationType || 'NONE'}
        onChange={(event) => {
          const aggregationType = event.target.value;
          actions.setEditForm({
            ...form,
            aggregationType,
            weightAttributeCode: aggregationType === 'WEIGHTED_AVG' ? form.weightAttributeCode : '',
          });
        }}
        className="border border-gray-300 rounded px-2 py-1 text-sm"
      >
        <option value="NONE">None</option>
        <option value="MIN">Min</option>
        <option value="MAX">Max</option>
        <option value="SUM">Sum</option>
        <option value="AVG">Average</option>
        <option value="WEIGHTED_AVG">Weighted Avg</option>
      </select>
      {form.aggregationType === 'WEIGHTED_AVG' && (
        <select
          value={form.weightAttributeCode || ''}
          onChange={(event) => actions.setEditForm({ ...form, weightAttributeCode: event.target.value })}
          className="border border-gray-300 rounded px-2 py-1 text-sm mt-1 w-full"
        >
          <option value="">-- Select weight attribute --</option>
          {actions.attributes
            .filter((attr) => NUMERIC.includes(attr.dataType))
            .map((attr) => (
              <option key={attr.id} value={attr.attributeCode}>
                {attr.attributeName} ({attr.attributeCode})
              </option>
            ))}
        </select>
      )}
    </div>
  );
}

function PrecisionCell(props: any) {
  const row = props.data as GridRow;
  if (!row.__editing || !row.__edit) {
    return row.numericPrecision !== null && row.numericPrecision !== undefined ? (
      <span style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: '#f3f4f6',
        border: '1px solid #e5e7eb',
        fontSize: '11px',
        borderRadius: '3px',
        fontWeight: 500,
      }}>
        {row.numericPrecision} decimal{row.numericPrecision !== 1 ? 's' : ''}
      </span>
    ) : (
      <span style={{ color: '#d1d5db', fontStyle: 'italic' }}>Default</span>
    );
  }
  const actions = props.context.get() as Actions;
  return (
    <input
      type="number"
      min="0"
      value={row.__edit.numericPrecision ?? ''}
      onChange={(event) => {
        const val = event.target.value;
        actions.setEditForm({ ...row.__edit, numericPrecision: val === '' ? null : parseInt(val, 10) });
      }}
      placeholder="Default"
      className="border border-gray-300 rounded px-2 py-1 text-sm w-20"
    />
  );
}

function FormatCell(props: any) {
  const row = props.data as GridRow;
  if (!row.__editing || !row.__edit) return <span>{row.displayFormat || '-'}</span>;
  const actions = props.context.get() as Actions;
  return (
    <select
      value={row.__edit.displayFormat || ''}
      onChange={(event) => actions.setEditForm({ ...row.__edit, displayFormat: event.target.value })}
      className="border border-gray-300 rounded px-2 py-1 text-sm"
    >
      <option value="">None</option>
      <option value="currency">Currency</option>
      <option value="percentage">Percentage</option>
      <option value="date">Date</option>
      <option value="number">Number</option>
    </select>
  );
}

function SectionCell(props: any) {
  const row = props.data as GridRow;
  if (!row.__editing || !row.__edit) return <span>{row.displaySection || 'General'}</span>;
  const actions = props.context.get() as Actions;
  return (
    <input
      type="text"
      value={row.__edit.displaySection || ''}
      onChange={(event) => actions.setEditForm({ ...row.__edit, displaySection: event.target.value })}
      className="border border-gray-300 rounded px-2 py-1 text-sm w-32"
    />
  );
}

function ListValuesCell(props: any) {
  const row = props.data as GridRow;
  const actions = props.context.get() as Actions;
  if (!row.__editing || !row.__edit) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {row.listValues && row.listValues.length > 0 ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
              {row.listValues.slice(0, 3).map((value) => (
                <span key={value} style={{
                  display: 'inline-block',
                  padding: '1px 6px',
                  background: '#f3f4f6',
                  border: '1px solid #e5e7eb',
                  fontSize: '11px',
                  borderRadius: '2px',
                  color: '#374151',
                }}>{value}</span>
              ))}
              {row.listValues.length > 3 && (
                <span style={{ fontSize: '11px', color: '#9ca3af' }}>+{row.listValues.length - 3} more</span>
              )}
            </div>
            {row.isMultiValued && (
              <span style={{ fontSize: '11px', color: '#6366f1', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
                Multi-select
              </span>
            )}
          </>
        ) : (
          <span>-</span>
        )}
      </div>
    );
  }
  const values = row.__edit.listValues || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '260px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', minHeight: '28px' }}>
        {values.length === 0 && <span style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' }}>No values defined</span>}
        {values.map((val) => (
          <span key={val} style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 6px 3px 8px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#00334e',
            fontSize: '11px',
            borderRadius: '3px',
            fontWeight: 500,
          }}>
            {val}
            <button
              type="button"
              onClick={() => actions.handleRemoveListValue(val)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: '0 2px', fontSize: '14px', lineHeight: 1, fontWeight: 700 }}
              title={`Remove "${val}"`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input
          type="text"
          value={row.__newListValue}
          onChange={(event) => actions.setNewListValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              actions.handleAddListValue();
            }
          }}
          placeholder="Add value..."
          className="border border-gray-300 rounded px-2 py-1 text-sm flex-1"
        />
        <button
          type="button"
          onClick={() => actions.handleAddListValue()}
          disabled={!row.__newListValue.trim()}
          className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Add
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#374151', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={row.__edit.isMultiValued || false}
          onChange={(event) => actions.setEditForm({ ...row.__edit, isMultiValued: event.target.checked })}
          style={{ width: '14px', height: '14px' }}
        />
        Allow multiple selections
      </label>
    </div>
  );
}

function ActionsCell(props: any) {
  const row = props.data as GridRow;
  const actions = props.context.get() as Actions;
  if (row.__editing) {
    return (
      <div className="whitespace-nowrap text-sm">
        <button type="button" onClick={() => actions.handleSave()} className="text-blue-600 hover:text-blue-900 mr-3">Save</button>
        <button type="button" onClick={() => actions.handleCancel()} className="text-gray-600 hover:text-gray-900">Cancel</button>
      </div>
    );
  }
  return (
    <button type="button" onClick={() => actions.handleEdit(row)} className="text-blue-600 hover:text-blue-900">Edit</button>
  );
}

const COLUMNS: ColDef<GridRow>[] = [
  { colId: 'select', headerName: '', width: 58, maxWidth: 58, sortable: false, filter: false, resizable: false, headerComponent: SelectAllHeader, cellRenderer: SelectCell },
  { field: 'attributeCode', headerName: 'Code', minWidth: 160, flex: 1 },
  { field: 'attributeName', headerName: 'Name', minWidth: 160, flex: 1 },
  { colId: 'description', headerName: 'Description', minWidth: 220, flex: 1.4, sortable: false, filter: false, autoHeight: true, wrapText: true, cellRenderer: DescriptionCell },
  { field: 'dataType', headerName: 'Data Type', minWidth: 130 },
  { colId: 'aggregation', headerName: 'Aggregation', minWidth: 170, sortable: false, filter: false, autoHeight: true, cellRenderer: AggregationCell },
  { colId: 'precision', headerName: 'Precision', minWidth: 120, sortable: false, filter: false, cellRenderer: PrecisionCell },
  { colId: 'format', headerName: 'Display Format', minWidth: 150, sortable: false, filter: false, cellRenderer: FormatCell },
  { colId: 'section', headerName: 'Section', minWidth: 150, sortable: false, filter: false, cellRenderer: SectionCell },
  { colId: 'list', headerName: 'List Values', minWidth: 280, sortable: false, filter: false, autoHeight: true, wrapText: true, cellRenderer: ListValuesCell },
  { colId: 'actions', headerName: 'Actions', width: 130, sortable: false, filter: false, cellRenderer: ActionsCell },
];

export function AttributeRegisterGrid({
  attributes,
  editingId,
  editForm,
  selectedIds,
  newListValue,
  onSelectAll,
  onSelectOne,
  onEdit,
  onCancel,
  onSave,
  onEditForm,
  onNewListValue,
  onAddListValue,
  onRemoveListValue,
}: {
  attributes: AttributeDefinition[];
  editingId: string | null;
  editForm: Partial<AttributeDefinition>;
  selectedIds: Set<string>;
  newListValue: string;
  onSelectAll: () => void;
  onSelectOne: (id: string) => void;
  onEdit: (attr: AttributeDefinition) => void;
  onCancel: () => void;
  onSave: () => void;
  onEditForm: (next: Partial<AttributeDefinition> | ((current: Partial<AttributeDefinition>) => Partial<AttributeDefinition>)) => void;
  onNewListValue: (value: string) => void;
  onAddListValue: () => void;
  onRemoveListValue: (value: string) => void;
}) {
  const apiRef = useRef<GridApi<GridRow> | null>(null);
  const actions = useRef<Actions>(null as unknown as Actions);
  actions.current = {
    attributes,
    handleSelectAll: onSelectAll,
    handleSelectOne: onSelectOne,
    handleEdit: onEdit,
    handleCancel: onCancel,
    handleSave: onSave,
    setEditForm: onEditForm,
    setNewListValue: onNewListValue,
    handleAddListValue: onAddListValue,
    handleRemoveListValue: onRemoveListValue,
  };
  const context = useMemo(() => ({ get: () => actions.current, selectedCount: selectedIds.size }), [selectedIds.size]);

  useEffect(() => {
    apiRef.current?.refreshHeader();
  }, [selectedIds, attributes.length]);

  const rows = useMemo<GridRow[]>(() => attributes.map((attr) => ({
    ...attr,
    __editing: attr.id === editingId,
    __selected: selectedIds.has(attr.id),
    __edit: attr.id === editingId ? editForm : null,
    __newListValue: attr.id === editingId ? newListValue : '',
  })), [attributes, editForm, editingId, newListValue, selectedIds]);

  return (
    <div className="screen-fill bg-white rounded-lg shadow overflow-hidden">
      <AppGrid
        rows={rows}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        autoHeight={false}
        height="100%"
        autoRowHeight
        enableSortFilter
        headerHeight={48}
        emptyMessage="No attributes"
        context={context}
        layoutKey={`${editingId}:${newListValue}:${editForm.listValues?.length || 0}:${editForm.aggregationType || ''}`}
        getRowClass={(params) => (params.data?.__editing || params.data?.__selected ? 'row-selected' : '')}
        onGridReady={(api) => { apiRef.current = api; }}
      />
    </div>
  );
}
