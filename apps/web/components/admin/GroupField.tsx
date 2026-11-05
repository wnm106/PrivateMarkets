'use client';

import { useState } from 'react';
import { CREATE_DOMAIN_GROUP_MUTATION, graphqlClient } from '@/lib/graphql';

export interface CatalogGroup {
  id: string;
  groupCode: string;
  groupName: string;
  description?: string | null;
  color: string;
  displayOrder: number;
}

export function GroupField({
  groups,
  value,
  onChange,
  onCreated,
  allowEmpty = false,
  required = false,
}: {
  groups: CatalogGroup[];
  value: string;
  onChange: (groupCode: string) => void;
  onCreated: (group: CatalogGroup) => void;
  allowEmpty?: boolean;
  required?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const ordered = [...groups].sort((a, b) => a.displayOrder - b.displayOrder || a.groupName.localeCompare(b.groupName));

  const addGroup = async () => {
    const groupName = name.trim();
    if (!groupName) {
      setError('Enter a group name.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await graphqlClient.mutation(CREATE_DOMAIN_GROUP_MUTATION, {
        input: { groupName, description: description.trim() || null },
      }).toPromise();
      const errors = result.data?.createDomainGroup?.errors;
      if (errors && errors.length > 0) {
        setError(errors[0].message);
        return;
      }
      if (result.error) {
        setError(result.error.message);
        return;
      }
      const group = result.data?.createDomainGroup?.group as CatalogGroup | undefined;
      if (!group) {
        setError('The group was not created.');
        return;
      }
      onCreated(group);
      onChange(group.groupCode);
      setAdding(false);
      setName('');
      setDescription('');
    } catch (caught: any) {
      setError(caught?.message || 'Could not create the group.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="field">
      <label>Group{required ? ' *' : ''}</label>
      <select
        className="text-input"
        value={adding ? '__new__' : value}
        required={required && !adding}
        onChange={(event) => {
          if (event.target.value === '__new__') {
            setAdding(true);
            setError('');
            return;
          }
          setAdding(false);
          onChange(event.target.value);
        }}
      >
        {allowEmpty && <option value="">No group</option>}
        {ordered.map((group) => (
          <option key={group.groupCode} value={group.groupCode}>{group.groupName}</option>
        ))}
        <option value="__new__">+ New group</option>
      </select>
      {adding && (
        <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
          <input
            className="text-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void addGroup();
              }
            }}
            placeholder="Group name"
            aria-label="New group name"
          />
          <input
            className="text-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void addGroup();
              }
            }}
            placeholder="Short description"
            aria-label="New group description"
          />
          {error && <div style={{ fontSize: '12px', color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="btn btn-sm" onClick={addGroup} disabled={saving}>
              {saving ? 'Adding…' : 'Add group'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAdding(false);
                setError('');
              }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
