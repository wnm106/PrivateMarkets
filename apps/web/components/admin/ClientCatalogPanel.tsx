'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  graphqlMutation,
  graphqlQuery,
  ADD_CLIENT_ENTITY_TYPE_ALIAS_MUTATION,
  CLIENT_CATALOG_SETTINGS_QUERY,
  REMOVE_CLIENT_ENTITY_TYPE_ALIAS_MUTATION,
  SET_CLIENT_ENTITY_TYPE_NAME_MUTATION,
  SET_CLIENT_FIELDS_HIDDEN_MUTATION,
} from '@/lib/graphql';
import {
  canToggle,
  fieldState,
  fieldSummary,
  filterFields,
  matchedWords,
  mergeSettings,
  nameChanged,
  unusedFields,
  usageLabel,
  type ClientCatalogSettings,
  type FieldFilter,
} from '@/lib/client-catalog';

interface ChangeResult {
  success: boolean;
  errors: Array<{ message: string }>;
  settings: ClientCatalogSettings | null;
}

const FILTERS: Array<{ id: FieldFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'hidden', label: 'Hidden' },
  { id: 'unused', label: 'No value' },
];

const WORD_NOTE: Record<string, string> = {
  name: 'the name above',
  catalog: 'catalog name',
  shared: 'shared',
};

const STATE_NOTE: Record<string, string> = {
  required: 'Required on every record',
  'catalog-hidden': 'Hidden for every client',
};

/**
 * What the client this session is working in calls one entity type, and which
 * of the type's fields it hides. Both are display only: the code, the stored
 * values, calculations and compliance do not change.
 */
export function ClientCatalogPanel({
  domainCode,
  onNameChanged,
  onFieldsChanged,
}: {
  domainCode: string;
  /** The name the type now shows under for this client. */
  onNameChanged?: (name: string) => void;
  onFieldsChanged?: () => void;
}) {
  const [settings, setSettings] = useState<ClientCatalogSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftWord, setDraftWord] = useState('');
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<FieldFilter>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{ clientCatalogSettings: ClientCatalogSettings }>(
      CLIENT_CATALOG_SETTINGS_QUERY,
      { domainCode },
      'network-only',
    );
    if (result.error || !result.data?.clientCatalogSettings) {
      setError(result.error?.message || 'The client settings could not be read.');
      setSettings(null);
    } else {
      setSettings(result.data.clientCatalogSettings);
      setDraftName(result.data.clientCatalogSettings.displayName || '');
    }
    setLoading(false);
  }, [domainCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback((result: { data?: Record<string, ChangeResult>; error?: any }, key: string): ClientCatalogSettings | null => {
    const answer = result.data?.[key];
    if (result.error || !answer || !answer.success || !answer.settings) {
      setError(answer?.errors?.[0]?.message || result.error?.message || 'The change could not be saved.');
      return null;
    }
    const merged = mergeSettings(settings, answer.settings);
    setSettings(merged);
    return merged;
  }, [settings]);

  const saveName = async (name: string) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    const result = await graphqlMutation<Record<string, ChangeResult>>(
      SET_CLIENT_ENTITY_TYPE_NAME_MUTATION,
      { domainCode, displayName: name.trim() },
    );
    const merged = apply(result, 'setClientEntityTypeName');
    if (merged) {
      setDraftName(merged.displayName || '');
      onNameChanged?.(merged.displayName || merged.catalogName);
    }
    setSaving(false);
  };

  const addWord = async () => {
    const label = draftWord.trim();
    if (!settings || !label) return;
    setSaving(true);
    setError(null);
    const result = await graphqlMutation<Record<string, ChangeResult>>(
      ADD_CLIENT_ENTITY_TYPE_ALIAS_MUTATION,
      { domainCode, label },
    );
    if (apply(result, 'addClientEntityTypeAlias')) setDraftWord('');
    setSaving(false);
  };

  const removeWord = async (aliasId: string) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    const result = await graphqlMutation<Record<string, ChangeResult>>(
      REMOVE_CLIENT_ENTITY_TYPE_ALIAS_MUTATION,
      { domainCode, aliasId },
    );
    apply(result, 'removeClientEntityTypeAlias');
    setSaving(false);
  };

  const setHidden = async (attributeIds: string[], hidden: boolean) => {
    if (!settings || attributeIds.length === 0) return;
    setSaving(true);
    setError(null);
    const result = await graphqlMutation<Record<string, ChangeResult>>(
      SET_CLIENT_FIELDS_HIDDEN_MUTATION,
      { domainCode, attributeIds, hidden },
    );
    if (apply(result, 'setClientFieldsHidden')) onFieldsChanged?.();
    setSaving(false);
  };

  const fields = settings?.fields || [];
  const shown = useMemo(() => filterFields(fields, filter, search), [fields, filter, search]);
  const unused = useMemo(() => unusedFields(fields), [fields]);
  const hiddenIds = useMemo(() => fields.filter((field) => field.hidden).map((field) => field.attributeId), [fields]);

  if (loading) {
    return <div style={noteStyle}>Loading this client&apos;s settings&hellip;</div>;
  }
  if (!settings) {
    return (
      <div style={errorStyle} role="alert">
        {error || 'The client settings could not be read.'}{' '}
        <button type="button" className="btn" style={smallButton} onClick={() => void load()}>Try again</button>
      </div>
    );
  }
  if (!settings.clientId) {
    return (
      <div style={noteStyle}>
        You are working across the whole catalog, so there is no one client to set this for.
        To set what a client calls {settings.catalogName}, or which fields it hides, simulate that client
        from Admin &rsaquo; Tenancy and open this page again. A person who belongs to one client sees that client here.
      </div>
    );
  }

  const readOnly = !settings.canEdit;
  const who = settings.clientName || 'this client';

  return (
    <div style={{ display: 'grid', gap: '24px' }}>
      {error && <div style={errorStyle} role="alert">{error}</div>}
      {readOnly && (
        <div style={noteStyle}>You can see {who}&apos;s settings. Changing them needs permission to edit entities.</div>
      )}

      <div style={cardStyle}>
        <div style={cardTitle}>Name</div>
        <div style={cardHelp}>
          The catalog calls this entity type <strong>{settings.catalogName}</strong> (<span className="mono" style={{ fontSize: '12px' }}>{settings.domainCode}</span>).
          Give it the name {who} uses. Menus, search, record pages and import mapping follow; the code does not change.
        </div>
        <form
          style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault();
            void saveName(draftName);
          }}
        >
          <label htmlFor="client-type-name" style={{ fontSize: '13px', fontWeight: 500 }}>{who} calls it</label>
          <input
            id="client-type-name"
            type="text"
            value={draftName}
            maxLength={200}
            placeholder={settings.catalogName}
            disabled={readOnly || saving}
            onChange={(event) => setDraftName(event.target.value)}
            style={inputStyle}
          />
          <button type="submit" className="btn btn-primary" disabled={readOnly || saving || !nameChanged(settings, draftName)}>
            Save name
          </button>
          {settings.displayName && (
            <button type="button" className="btn" disabled={readOnly || saving} onClick={() => void saveName('')}>
              Use the catalog name
            </button>
          )}
        </form>
      </div>

      <div style={cardStyle}>
        <div style={cardTitle}>Other words</div>
        <div style={cardHelp}>
          Words that mean this entity type when {who} loads a file or searches. A word {who} adds wins over a
          shared word, so it can mean something else for another client.
        </div>
        <ul style={wordListStyle} aria-label="Words that mean this entity type">
          {matchedWords(settings).map((word) => (
            <li key={word.key} style={wordStyle}>
              <span style={{ fontSize: '13px', fontWeight: 500 }}>{word.label}</span>
              {WORD_NOTE[word.kind] && <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{WORD_NOTE[word.kind]}</span>}
              {word.kind === 'own' && word.id && (
                <button
                  type="button"
                  className="btn"
                  style={smallButton}
                  aria-label={`Remove ${word.label}`}
                  disabled={readOnly || saving}
                  onClick={() => void removeWord(word.id as string)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '12px' }}
          onSubmit={(event) => {
            event.preventDefault();
            void addWord();
          }}
        >
          <label htmlFor="client-type-word" style={{ fontSize: '13px', fontWeight: 500 }}>Add a word</label>
          <input
            id="client-type-word"
            type="text"
            value={draftWord}
            maxLength={200}
            disabled={readOnly || saving}
            onChange={(event) => setDraftWord(event.target.value)}
            style={inputStyle}
          />
          <button type="submit" className="btn" disabled={readOnly || saving || !draftWord.trim()}>Add</button>
        </form>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <div style={cardTitle}>Fields</div>
            <div style={cardHelp}>
              A hidden field leaves {who}&apos;s record pages, forms and column lists. Its values stay stored,
              and calculations and compliance still read them. {fieldSummary(fields)}.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={readOnly || saving || unused.length === 0}
              title="Hide every shown field that no record holds a value in today"
              onClick={() => void setHidden(unused.map((field) => field.attributeId), true)}
            >
              Hide {unused.length} with no value
            </button>
            <button
              type="button"
              className="btn"
              disabled={readOnly || saving || hiddenIds.length === 0}
              onClick={() => void setHidden(hiddenIds, false)}
            >
              Show all
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
          <input
            type="search"
            value={search}
            placeholder="Find a field"
            aria-label="Find a field"
            onChange={(event) => setSearch(event.target.value)}
            style={inputStyle}
          />
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              style={{
                ...chipStyle,
                background: filter === item.id ? 'var(--accent)' : 'transparent',
                color: filter === item.id ? '#fff' : 'var(--ink-2)',
                borderColor: filter === item.id ? 'var(--accent)' : 'var(--line)',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <div style={noteStyle}>
            {fields.length === 0 ? 'This entity type has no fields of its own.' : 'No field matches.'}
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: '72px' }}>Hide</th>
                <th style={thStyle}>Field</th>
                <th style={thStyle}>Section</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Records with a value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((field) => {
                const state = fieldState(field);
                const note = STATE_NOTE[state];
                return (
                  <tr key={field.attributeId} style={{ opacity: state === 'catalog-hidden' ? 0.6 : 1 }}>
                    <td style={tdStyle}>
                      <input
                        type="checkbox"
                        aria-label={`Hide ${field.attributeName}`}
                        checked={field.hidden || state === 'catalog-hidden'}
                        disabled={readOnly || saving || !canToggle(field)}
                        title={note}
                        onChange={(event) => void setHidden([field.attributeId], event.target.checked)}
                      />
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontSize: '13px', fontWeight: 500 }}>{field.attributeName}</div>
                      <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                        <span className="mono" style={{ fontSize: '12px' }}>{field.attributeCode}</span>
                        {field.isDerived && <span> &middot; Calculated</span>}
                        {note && <span> &middot; {note}</span>}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontSize: '13px', color: 'var(--ink-2)' }}>{field.displaySection}</td>
                    <td style={{ ...tdStyle, fontSize: '13px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {usageLabel(field, settings.recordCount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '16px',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  background: 'var(--bg)',
};
const cardTitle: React.CSSProperties = { fontSize: '14px', fontWeight: 600, marginBottom: '4px' };
const cardHelp: React.CSSProperties = { fontSize: '13px', color: 'var(--ink-2)', marginBottom: '12px', maxWidth: '760px', lineHeight: 1.5 };
const noteStyle: React.CSSProperties = { fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.5, maxWidth: '760px' };
const errorStyle: React.CSSProperties = {
  padding: '10px 12px',
  background: '#fdecec',
  border: '1px solid var(--red)',
  color: 'var(--red)',
  fontSize: '13px',
  borderRadius: '6px',
};
const inputStyle: React.CSSProperties = {
  fontSize: '13px',
  padding: '6px 10px',
  border: '1px solid var(--line)',
  borderRadius: '4px',
  minWidth: '240px',
  background: 'var(--bg)',
  color: 'var(--ink)',
};
const chipStyle: React.CSSProperties = {
  fontSize: '12px',
  padding: '4px 12px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  cursor: 'pointer',
};
const smallButton: React.CSSProperties = { fontSize: '12px', padding: '4px 10px', marginLeft: '8px' };
const wordListStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '8px', listStyle: 'none', margin: 0, padding: 0 };
const wordStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '4px 10px',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  background: 'var(--bg-2, #f5f5f5)',
};
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--ink-3)',
  padding: '8px 10px',
  borderBottom: '1px solid var(--line)',
};
const tdStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
