'use client';

import { useState, useEffect } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import {
  graphqlClient,
  ATTRIBUTE_REGISTER_QUERY,
} from '@/lib/graphql';
import { gql } from '@urql/core';

const UPDATE_ATTRIBUTE_DEFINITION_MUTATION = gql`
  mutation UpdateAttributeDefinition($input: UpdateAttributeDefinitionInput!) {
    updateAttributeDefinition(input: $input) {
      success
      attribute {
        id
        attributeCode
        attributeName
        description
        displayFormat
        listValues
        isMultiValued
        validationRules
        defaultValue
        displaySection
        displayGroup
        isEditable
        isVisible
        aggregationType
        weightAttributeCode
        numericPrecision
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

interface Attribute {
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

export default function AdminAttributesPage() {
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Attribute>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkEditForm, setBulkEditForm] = useState<Partial<Attribute>>({});
  const [newListValue, setNewListValue] = useState('');
  const editingAttribute = attributes.find((attribute) => attribute.id === editingId) || null;

  usePublishViewContext(
    showBulkEdit
      ? {
          activity: 'editing',
          kind: 'attributes',
          label: `${selectedIds.size} attributes`,
          summary: 'Bulk edit',
          snapshot: { count: selectedIds.size, changes: bulkEditForm },
        }
      : editingAttribute
        ? {
            activity: 'editing',
            kind: 'attribute',
            label: editingAttribute.attributeName || editingAttribute.attributeCode,
            id: editingAttribute.id,
            snapshot: {
              attributeCode: editingAttribute.attributeCode,
              attributeName: editingAttribute.attributeName,
              dataType: editingAttribute.dataType,
              ...editForm,
            },
          }
        : null
  );

  useEffect(() => {
    loadAttributes();
  }, []);

  const loadAttributes = async () => {
    setLoading(true);
    try {
      const result = await graphqlClient.query(ATTRIBUTE_REGISTER_QUERY, {}).toPromise();
      if (result.data?.attributeRegister) {
        setAttributes(result.data.attributeRegister);
      }
      if (result.error) {
        setError(result.error.message);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (attr: Attribute) => {
    setEditingId(attr.id);
    setEditForm({
      description: attr.description || '',
      displayFormat: attr.displayFormat || '',
      listValues: attr.listValues || [],
      isMultiValued: attr.isMultiValued || false,
      validationRules: attr.validationRules || {},
      defaultValue: attr.defaultValue || '',
      displaySection: attr.displaySection || 'General',
      displayGroup: attr.displayGroup || 0,
      isEditable: attr.isEditable,
      isVisible: attr.isVisible,
      aggregationType: attr.aggregationType || 'NONE',
      weightAttributeCode: attr.weightAttributeCode || '',
      numericPrecision: attr.numericPrecision,
    });
    setNewListValue('');
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditForm({});
  };

  const handleSave = async () => {
    if (!editingId) return;

    try {
      const result = await graphqlClient
        .mutation(UPDATE_ATTRIBUTE_DEFINITION_MUTATION, {
          input: {
            id: editingId,
            description: editForm.description || null,
            displayFormat: editForm.displayFormat || null,
            listValues: editForm.listValues || [],
            isMultiValued: editForm.isMultiValued ?? false,
            validationRules: editForm.validationRules || {},
            defaultValue: editForm.defaultValue || null,
            displaySection: editForm.displaySection || 'General',
            displayGroup: editForm.displayGroup || 0,
            isEditable: editForm.isEditable ?? true,
            isVisible: editForm.isVisible ?? true,
            aggregationType: editForm.aggregationType || 'NONE',
            weightAttributeCode: editForm.aggregationType === 'WEIGHTED_AVG' 
              ? (editForm.weightAttributeCode || null)
              : null,
            numericPrecision: editForm.numericPrecision,
          },
        })
        .toPromise();

      if (result.data?.updateAttributeDefinition?.success) {
        setAttributes(attrs =>
          attrs.map(a => (a.id === editingId ? result.data.updateAttributeDefinition.attribute : a))
        );
        setEditingId(null);
        setEditForm({});
      } else {
        console.error('Failed to update attribute:', result.error);
      }
    } catch (err: any) {
      console.error('Error updating attribute:', err);
    }
  };

  const handleAddListValue = () => {
    const trimmed = newListValue.trim();
    if (!trimmed) return;
    const current = editForm.listValues || [];
    if (current.includes(trimmed)) return;
    setEditForm({ ...editForm, listValues: [...current, trimmed] });
    setNewListValue('');
  };

  const handleRemoveListValue = (value: string) => {
    setEditForm({
      ...editForm,
      listValues: (editForm.listValues || []).filter(v => v !== value),
    });
  };

  const handleListValuesChange = (value: string) => {
    setEditForm({ ...editForm, listValues: value.split(',').map(v => v.trim()).filter(v => v) });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === attributes.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(attributes.map(a => a.id)));
    }
  };

  const handleSelectOne = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleBulkEdit = () => {
    if (selectedIds.size === 0) return;
    setShowBulkEdit(true);
    setBulkEditForm({});
  };

  const handleBulkSave = async () => {
    try {
      const updates = Array.from(selectedIds).map(id => {
        return graphqlClient
          .mutation(UPDATE_ATTRIBUTE_DEFINITION_MUTATION, {
            input: {
              id,
              ...(bulkEditForm.displayFormat !== undefined && { displayFormat: bulkEditForm.displayFormat || null }),
              ...(bulkEditForm.displaySection !== undefined && { displaySection: bulkEditForm.displaySection || 'General' }),
              ...(bulkEditForm.listValues !== undefined && { listValues: bulkEditForm.listValues || [] }),
            },
          })
          .toPromise();
      });

      await Promise.all(updates);
      await loadAttributes();
      setSelectedIds(new Set());
      setShowBulkEdit(false);
      setBulkEditForm({});
    } catch (err: any) {
      console.error('Error in bulk update:', err);
    }
  };

  const handleBulkListValuesChange = (value: string) => {
    setBulkEditForm({ ...bulkEditForm, listValues: value.split(',').map(v => v.trim()).filter(v => v) });
  };

  if (loading) return <div className="p-8">Loading...</div>;
  if (error) return <div className="p-8">Error: {error}</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">Attribute Management</h1>
      <p className="text-gray-600 mb-6">
        Configure display formats, list values, validation rules, and other metadata for attributes.
      </p>

      {/* Bulk Edit Controls */}
      {selectedIds.size > 0 && (
        <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-blue-900">
              {selectedIds.size} attribute{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleBulkEdit}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                Bulk Edit
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
              >
                Clear Selection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Edit Panel */}
      {showBulkEdit && (
        <div className="mb-6 p-6 bg-white rounded-lg shadow-lg border-2 border-blue-300">
          <h2 className="text-xl font-bold mb-4">Bulk Edit {selectedIds.size} Attributes</h2>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Display Format</label>
              <select
                value={bulkEditForm.displayFormat || ''}
                onChange={e => setBulkEditForm({ ...bulkEditForm, displayFormat: e.target.value })}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                <option value="">No change</option>
                <option value="currency">Currency</option>
                <option value="percentage">Percentage</option>
                <option value="date">Date</option>
                <option value="number">Number</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Section</label>
              <input
                type="text"
                value={bulkEditForm.displaySection || ''}
                onChange={e => setBulkEditForm({ ...bulkEditForm, displaySection: e.target.value })}
                placeholder="No change"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Multi-Select</label>
              <select
                value={bulkEditForm.isMultiValued === undefined ? '' : String(bulkEditForm.isMultiValued)}
                onChange={e => {
                  const val = e.target.value;
                  setBulkEditForm({ 
                    ...bulkEditForm, 
                    isMultiValued: val === '' ? undefined : val === 'true' 
                  });
                }}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                <option value="">No change</option>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">List Values</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Current list values as removable chips */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', minHeight: '28px' }}>
                {(bulkEditForm.listValues || []).length === 0 && (
                  <span style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' }}>No values defined</span>
                )}
                {(bulkEditForm.listValues || []).map((val) => (
                  <span
                    key={val}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '3px 6px 3px 8px',
                      background: '#eff6ff',
                      border: '1px solid #bfdbfe',
                      color: '#1e40af',
                      fontSize: '11px',
                      borderRadius: '3px',
                      fontWeight: 500,
                    }}
                  >
                    {val}
                    <button
                      type="button"
                      onClick={() => setBulkEditForm({
                        ...bulkEditForm,
                        listValues: (bulkEditForm.listValues || []).filter(v => v !== val)
                      })}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#6b7280',
                        padding: '0 2px',
                        fontSize: '14px',
                        lineHeight: 1,
                        fontWeight: 700,
                      }}
                      title={`Remove "${val}"`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              {/* Add new value input */}
              <div style={{ display: 'flex', gap: '4px' }}>
                <input
                  type="text"
                  value={newListValue}
                  onChange={e => setNewListValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const trimmed = newListValue.trim();
                      if (trimmed && !(bulkEditForm.listValues || []).includes(trimmed)) {
                        setBulkEditForm({
                          ...bulkEditForm,
                          listValues: [...(bulkEditForm.listValues || []), trimmed]
                        });
                        setNewListValue('');
                      }
                    }
                  }}
                  placeholder="Add value..."
                  className="border border-gray-300 rounded px-2 py-1 text-sm flex-1"
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = newListValue.trim();
                    if (trimmed && !(bulkEditForm.listValues || []).includes(trimmed)) {
                      setBulkEditForm({
                        ...bulkEditForm,
                        listValues: [...(bulkEditForm.listValues || []), trimmed]
                      });
                      setNewListValue('');
                    }
                  }}
                  disabled={!newListValue.trim()}
                  className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  + Add
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleBulkSave}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
            >
              Apply to Selected
            </button>
            <button
              onClick={() => { setShowBulkEdit(false); setBulkEditForm({}); }}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left">
                <input
                  type="checkbox"
                  checked={selectedIds.size === attributes.length && attributes.length > 0}
                  onChange={handleSelectAll}
                  className="rounded"
                />
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Code
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Description
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Data Type
              </th>
              {/* Aggregation and Precision columns */}
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Aggregation
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Precision
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Display Format
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Section
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                List Values
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {attributes.map(attr => (
              <tr key={attr.id} className={editingId === attr.id ? 'bg-blue-50' : selectedIds.has(attr.id) ? 'bg-blue-50' : ''}>
                <td className="px-6 py-4">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(attr.id)}
                    onChange={() => handleSelectOne(attr.id)}
                    className="rounded"
                  />
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {attr.attributeCode}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {attr.attributeName}
                </td>
                <td className="px-6 py-4 text-sm text-gray-500 max-w-xs">
                  {editingId === attr.id ? (
                    <textarea
                      value={editForm.description || ''}
                      onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                      placeholder="Enter description for MCP context..."
                      className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                      rows={2}
                      style={{ resize: 'vertical', minWidth: '200px' }}
                    />
                  ) : (
                    attr.description || <span style={{ color: '#d1d5db', fontStyle: 'italic' }}>No description</span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {attr.dataType}
                </td>

                {editingId === attr.id ? (
                  <>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <select
                        value={editForm.aggregationType || 'NONE'}
                        onChange={e => {
                          const newAgg = e.target.value;
                          setEditForm({
                            ...editForm,
                            aggregationType: newAgg,
                            // Clear weight if not weighted avg
                            weightAttributeCode: newAgg === 'WEIGHTED_AVG' ? editForm.weightAttributeCode : '',
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
                      {editForm.aggregationType === 'WEIGHTED_AVG' && (
                        <select
                          value={editForm.weightAttributeCode || ''}
                          onChange={e => setEditForm({ ...editForm, weightAttributeCode: e.target.value })}
                          className="border border-gray-300 rounded px-2 py-1 text-sm mt-1 w-full"
                        >
                          <option value="">-- Select weight attribute --</option>
                          {attributes
                            .filter(attr => ['NUMBER', 'INTEGER', 'DECIMAL', 'FLOAT', 'CURRENCY', 'PERCENTAGE', 'PERCENT'].includes(attr.dataType))
                            .map(attr => (
                              <option key={attr.id} value={attr.attributeCode}>
                                {attr.attributeName} ({attr.attributeCode})
                              </option>
                            ))
                          }
                        </select>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        type="number"
                        min="0"
                        value={editForm.numericPrecision ?? ''}
                        onChange={e => {
                          const val = e.target.value;
                          setEditForm({ ...editForm, numericPrecision: val === '' ? null : parseInt(val, 10) });
                        }}
                        placeholder="Default"
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-20"
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <select
                        value={editForm.displayFormat || ''}
                        onChange={e => setEditForm({ ...editForm, displayFormat: e.target.value })}
                        className="border border-gray-300 rounded px-2 py-1 text-sm"
                      >
                        <option value="">None</option>
                        <option value="currency">Currency</option>
                        <option value="percentage">Percentage</option>
                        <option value="date">Date</option>
                        <option value="number">Number</option>
                      </select>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        type="text"
                        value={editForm.displaySection || ''}
                        onChange={e => setEditForm({ ...editForm, displaySection: e.target.value })}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-32"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '260px' }}>
                        {/* Current list values as removable chips */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', minHeight: '28px' }}>
                          {(editForm.listValues || []).length === 0 && (
                            <span style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' }}>No values defined</span>
                          )}
                          {(editForm.listValues || []).map((val) => (
                            <span
                              key={val}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '3px 6px 3px 8px',
                                background: '#eff6ff',
                                border: '1px solid #bfdbfe',
                                color: '#1e40af',
                                fontSize: '11px',
                                borderRadius: '3px',
                                fontWeight: 500,
                              }}
                            >
                              {val}
                              <button
                                type="button"
                                onClick={() => handleRemoveListValue(val)}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: '#6b7280',
                                  padding: '0 2px',
                                  fontSize: '14px',
                                  lineHeight: 1,
                                  fontWeight: 700,
                                }}
                                title={`Remove "${val}"`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                        {/* Add new value input */}
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <input
                            type="text"
                            value={newListValue}
                            onChange={e => setNewListValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddListValue(); } }}
                            placeholder="Add value..."
                            className="border border-gray-300 rounded px-2 py-1 text-sm flex-1"
                          />
                          <button
                            type="button"
                            onClick={handleAddListValue}
                            disabled={!newListValue.trim()}
                            className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            + Add
                          </button>
                        </div>
                        {/* Multi-select toggle */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#374151', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={editForm.isMultiValued || false}
                            onChange={e => setEditForm({ ...editForm, isMultiValued: e.target.checked })}
                            style={{ width: '14px', height: '14px' }}
                          />
                          Allow multiple selections
                        </label>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <button
                        onClick={handleSave}
                        className="text-blue-600 hover:text-blue-900 mr-3"
                      >
                        Save
                      </button>
                      <button
                        onClick={handleCancel}
                        className="text-gray-600 hover:text-gray-900"
                      >
                        Cancel
                      </button>
                    </td>
                  </>
                ) : (
                  <>
                    {/* Aggregation and Precision cells */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span>
                          {attr.aggregationType && attr.aggregationType !== 'NONE' ? (
                            <span style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              background: attr.aggregationType === 'WEIGHTED_AVG' ? '#fef3c7' : '#e0e7ff',
                              border: `1px solid ${attr.aggregationType === 'WEIGHTED_AVG' ? '#fcd34d' : '#a5b4fc'}`,
                              color: attr.aggregationType === 'WEIGHTED_AVG' ? '#92400e' : '#3730a3',
                              fontSize: '11px',
                              borderRadius: '3px',
                              fontWeight: 600,
                            }}>
                              {attr.aggregationType === 'WEIGHTED_AVG' ? 'Weighted Avg' : attr.aggregationType}
                            </span>
                          ) : (
                            <span style={{ color: '#d1d5db', fontStyle: 'italic' }}>None</span>
                          )}
                        </span>
                        {attr.aggregationType === 'WEIGHTED_AVG' && attr.weightAttributeCode && (
                          <span style={{ fontSize: '10px', color: '#6b7280' }}>
                            weight: <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: '2px' }}>{attr.weightAttributeCode}</code>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {attr.numericPrecision !== null && attr.numericPrecision !== undefined ? (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          background: '#f3f4f6',
                          border: '1px solid #e5e7eb',
                          fontSize: '11px',
                          borderRadius: '3px',
                          fontWeight: 500,
                        }}>
                          {attr.numericPrecision} decimal{attr.numericPrecision !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span style={{ color: '#d1d5db', fontStyle: 'italic' }}>Default</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {attr.displayFormat || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {attr.displaySection || 'General'}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {attr.listValues && attr.listValues.length > 0 ? (
                          <>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                              {attr.listValues.slice(0, 3).map(v => (
                                <span
                                  key={v}
                                  style={{
                                    display: 'inline-block',
                                    padding: '1px 6px',
                                    background: '#f3f4f6',
                                    border: '1px solid #e5e7eb',
                                    fontSize: '10px',
                                    borderRadius: '2px',
                                    color: '#374151',
                                  }}
                                >
                                  {v}
                                </span>
                              ))}
                              {attr.listValues.length > 3 && (
                                <span style={{ fontSize: '10px', color: '#9ca3af' }}>+{attr.listValues.length - 3} more</span>
                              )}
                            </div>
                            {attr.isMultiValued && (
                              <span style={{ fontSize: '9px', color: '#6366f1', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Multi-select
                              </span>
                            )}
                          </>
                        ) : (
                          <span>-</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <button
                        onClick={() => handleEdit(attr)}
                        className="text-blue-600 hover:text-blue-900"
                      >
                        Edit
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
