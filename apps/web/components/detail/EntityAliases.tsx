'use client';

import { useCallback, useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { usePublishTab } from '@/lib/view-context';

interface EntityAlias {
  id: string;
  aliasLabel: string;
  aliasCode: string;
  aliasKind: string;
}

interface NameAlias {
  aliasLabel: string;
  aliasCode: string;
}

const ALIASES_QUERY = `
  query EntityAliases($entityId: ID!, $domainCode: String!) {
    entityAliases(entityId: $entityId) { id aliasLabel aliasCode aliasKind }
    entityNameAliases(domainCode: $domainCode) { aliasLabel aliasCode }
  }
`;

const SAVE_ALIAS = `
  mutation SaveEntityAlias($input: SaveEntityAliasInput!) {
    saveEntityAlias(input: $input) {
      alias { id aliasLabel aliasCode aliasKind }
      errors { message }
    }
  }
`;

const DELETE_ALIAS = `
  mutation DeleteEntityAlias($id: ID!) {
    deleteEntityAlias(id: $id) { success errors { message } }
  }
`;

export function EntityAliases({
  entityId,
  entityName,
  domainCode,
  onCount,
}: {
  entityId: string;
  entityName: string;
  domainCode: string;
  onCount?: (count: number) => void;
}) {
  const [aliases, setAliases] = useState<EntityAlias[] | null>(null);
  const [kinds, setKinds] = useState<NameAlias[]>([]);
  const [label, setLabel] = useState('');
  const [aliasCode, setAliasCode] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const result = await graphqlQuery<
      { entityAliases: EntityAlias[]; entityNameAliases: NameAlias[] },
      { entityId: string; domainCode: string }
    >(ALIASES_QUERY, { entityId, domainCode }, 'network-only');
    if (result.error) {
      setError(result.error.message || 'The names could not be loaded');
      setAliases([]);
      return;
    }
    const rows = result.data?.entityAliases || [];
    setAliases(rows);
    setKinds(result.data?.entityNameAliases || []);
    onCount?.(rows.length);
  }, [entityId, domainCode, onCount]);

  useEffect(() => {
    setAliases(null);
    setLabel('');
    setAliasCode('');
    setError('');
    load();
  }, [load]);

  const kindName = (code: string) => kinds.find((kind) => kind.aliasCode === code)?.aliasLabel || 'Name';

  usePublishTab('aliases', {
    label: 'Aliases',
    purpose: `Other names people use for ${entityName}, besides its record name.`,
    howToRead: 'A kind such as Project name says which name this is. Search and import match these names to this record.',
    data: aliases ? {
      record: entityName,
      names: aliases.map((alias) => ({ name: alias.aliasLabel, kind: kindName(alias.aliasCode) })),
    } : null,
  });

  const save = async () => {
    setSaving(true);
    setError('');
    const result = await graphqlMutation<
      { saveEntityAlias: { alias: EntityAlias | null; errors: Array<{ message: string }> } },
      { input: { entityId: string; aliasLabel: string; aliasCode?: string } }
    >(SAVE_ALIAS, { input: { entityId, aliasLabel: label, ...(aliasCode ? { aliasCode } : {}) } });
    setSaving(false);
    const saved = result.data?.saveEntityAlias;
    if (result.error || saved?.errors?.length || !saved?.alias) {
      setError(saved?.errors?.[0]?.message || result.error?.message || 'That name could not be saved');
      return;
    }
    setLabel('');
    await load();
  };

  const remove = async (id: string) => {
    setError('');
    const result = await graphqlMutation<{ deleteEntityAlias: { success: boolean; errors: Array<{ message: string }> } }, { id: string }>(
      DELETE_ALIAS,
      { id },
    );
    const removed = result.data?.deleteEntityAlias;
    if (result.error || !removed?.success) {
      setError(removed?.errors?.[0]?.message || result.error?.message || 'That name could not be removed');
      return;
    }
    await load();
  };

  return (
    <section className="field-section">
      <div className="field-section-head">
        <span className="field-section-name">Other names for {entityName}</span>
        <span className="field-section-count">{aliases ? aliases.length : ''}</span>
      </div>
      {aliases === null ? (
        <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>Loading…</div>
      ) : (
        <div style={{ padding: '14px 16px', display: 'grid', gap: '14px' }}>
          <p style={{ margin: 0, color: 'var(--ink-3)', fontSize: '13px' }}>
            Search and import use these when someone refers to this record by another name.
          </p>
          {aliases.length === 0 ? (
            <p style={{ margin: 0, fontSize: '13px' }}>No other names yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-3)', fontWeight: 600 }}>Name</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-3)', fontWeight: 600 }}>Kind</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {aliases.map((alias) => (
                  <tr key={alias.id} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '8px' }}>{alias.aliasLabel}</td>
                    <td style={{ padding: '8px', color: 'var(--ink-2)' }}>{kindName(alias.aliasCode)}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      <button type="button" className="btn btn-sm" onClick={() => remove(alias.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!saving && label.trim()) save();
            }}
            style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'end' }}
          >
            <label style={{ display: 'grid', gap: '4px', fontSize: '12px', color: 'var(--ink-3)' }}>
              Name
              <input className="text-input" value={label} onChange={(event) => setLabel(event.target.value)} aria-label="Alias name" />
            </label>
            <label style={{ display: 'grid', gap: '4px', fontSize: '12px', color: 'var(--ink-3)' }}>
              Kind
              <select className="select" value={aliasCode} onChange={(event) => setAliasCode(event.target.value)} aria-label="Alias kind">
                <option value="">Another name</option>
                {kinds.map((kind) => (
                  <option key={kind.aliasCode} value={kind.aliasCode}>{kind.aliasLabel}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn" disabled={saving || !label.trim()}>
              {saving ? 'Saving…' : 'Add name'}
            </button>
          </form>
          {error && <p style={{ margin: 0, color: 'var(--red)', fontSize: '13px' }}>{error}</p>}
        </div>
      )}
    </section>
  );
}
