'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  ATTRIBUTE_GRID_COLUMNS,
  clampAttributeSpan,
  sectionColumnCount,
  sectionKey,
  type AttributeSectionOrder,
} from '@/lib/attribute-layout';
import {
  ATTRIBUTE_SECTIONS_QUERY,
  CREATE_ATTRIBUTE_SECTION_MUTATION,
  DELETE_ATTRIBUTE_SECTION_MUTATION,
  graphqlClient,
  REORDER_ATTRIBUTE_SECTIONS_MUTATION,
  RENAME_ATTRIBUTE_SECTION_MUTATION,
  UPDATE_ATTRIBUTE_SECTION_MUTATION,
} from '@/lib/graphql';

interface SectionRow extends AttributeSectionOrder {
  id: string;
  columnCount?: number | null;
}

interface SectionAttribute {
  id: string;
  attributeName: string;
  displaySection?: string | null;
  displayGroup?: number | null;
  displaySpanColumns?: number | null;
  displaySpanRows?: number | null;
}

function sectionOf(attribute: SectionAttribute) {
  return attribute.displaySection?.trim() || 'General';
}

function mutationError(result: { data?: any; error?: { message?: string } }, key: string) {
  const payload = result.data?.[key];
  return payload?.errors?.[0]?.message || result.error?.message || (payload && payload.success === false ? 'The change was not saved.' : '');
}

export function AttributeSectionsPanel({
  domainCode,
  attributes,
  onAttributesChanged,
  onCountChange,
}: {
  domainCode: string;
  attributes: SectionAttribute[];
  onAttributesChanged: () => void;
  onCountChange?: (count: number) => void;
}) {
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSections = useCallback(async () => {
    const result = await graphqlClient.query(ATTRIBUTE_SECTIONS_QUERY, { domainCode }, { requestPolicy: 'network-only' }).toPromise();
    if (result.error) {
      setMessage(result.error.message);
      return;
    }
    const rows = (result.data?.attributeSections || []) as SectionRow[];
    setSections(rows);
    setDrafts(Object.fromEntries(rows.map((section) => [section.id, section.sectionName])));
    onCountChange?.(rows.length);
  }, [domainCode, onCountChange]);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const rename = async (section: SectionRow) => {
    const next = (drafts[section.id] || '').trim();
    if (!next || next === section.sectionName) {
      setDrafts((current) => ({ ...current, [section.id]: section.sectionName }));
      return;
    }
    setBusy(true);
    setMessage('');
    const result = await graphqlClient.mutation(RENAME_ATTRIBUTE_SECTION_MUTATION, { id: section.id, sectionName: next }).toPromise();
    setBusy(false);
    const error = mutationError(result, 'renameAttributeSection');
    if (error) {
      setMessage(error);
      setDrafts((current) => ({ ...current, [section.id]: section.sectionName }));
      return;
    }
    onAttributesChanged();
    await loadSections();
  };

  const persistOrder = async (next: SectionRow[]) => {
    setSections(next);
    setBusy(true);
    setMessage('');
    const result = await graphqlClient.mutation(REORDER_ATTRIBUTE_SECTIONS_MUTATION, {
      domainCode,
      orderedIds: next.map((section) => section.id),
    }).toPromise();
    setBusy(false);
    const error = mutationError(result, 'reorderAttributeSections');
    if (error) {
      setMessage(error);
      await loadSections();
      return;
    }
    if (result.data?.reorderAttributeSections?.sections) {
      setSections(result.data.reorderAttributeSections.sections);
    }
  };

  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const from = sections.findIndex((section) => section.id === dragId);
    const to = sections.findIndex((section) => section.id === targetId);
    setDragId(null);
    setOverId(null);
    if (from < 0 || to < 0) return;
    const next = [...sections];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void persistOrder(next);
  };

  const setColumnWidth = async (section: SectionRow, columnCount: number) => {
    setSections((current) => current.map((item) => item.id === section.id ? { ...item, columnCount } : item));
    setBusy(true);
    setMessage('');
    const result = await graphqlClient.mutation(UPDATE_ATTRIBUTE_SECTION_MUTATION, { id: section.id, columnCount }).toPromise();
    setBusy(false);
    const error = mutationError(result, 'updateAttributeSection');
    if (error) {
      setMessage(error);
      await loadSections();
    }
  };

  const addSection = async () => {
    const sectionName = newName.trim();
    if (!sectionName) return;
    setBusy(true);
    setMessage('');
    const result = await graphqlClient.mutation(CREATE_ATTRIBUTE_SECTION_MUTATION, { domainCode, sectionName }).toPromise();
    setBusy(false);
    const error = mutationError(result, 'createAttributeSection');
    if (error) {
      setMessage(error);
      return;
    }
    setNewName('');
    await loadSections();
  };

  const removeSection = async (section: SectionRow) => {
    const count = attributes.filter((attribute) => sectionKey(sectionOf(attribute)) === sectionKey(section.sectionName)).length;
    if (count > 0) {
      setMessage('Move the attributes out of this section before deleting it.');
      return;
    }
    setBusy(true);
    setMessage('');
    const result = await graphqlClient.mutation(DELETE_ATTRIBUTE_SECTION_MUTATION, { id: section.id }).toPromise();
    setBusy(false);
    const error = mutationError(result, 'deleteAttributeSection');
    if (error) {
      setMessage(error);
      return;
    }
    await loadSections();
  };

  const sectionAttributes = (section: SectionRow) => attributes
    .filter((attribute) => sectionKey(sectionOf(attribute)) === sectionKey(section.sectionName))
    .sort((a, b) => (a.displayGroup || 0) - (b.displayGroup || 0) || a.attributeName.localeCompare(b.attributeName));

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>
          {sections.length} section{sections.length === 1 ? '' : 's'}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
          Drag a row to set the sequence. Each section can use 1 to {ATTRIBUTE_GRID_COLUMNS} columns. Click a section to preview it.
        </div>
      </div>

      {message && (
        <div style={{ padding: '10px 12px', background: '#fdecec', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '13px' }}>
          {message}
        </div>
      )}

      <table className="section-table">
        <thead>
          <tr>
            <th aria-label="Drag" />
            <th>Section</th>
            <th>Columns</th>
            <th>Attributes</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const rows = sectionAttributes(section);
            const columns = sectionColumnCount(section.columnCount);
            const open = openId === section.id;
            return (
              <Fragment key={section.id}>
                <tr
                  className={`${open ? 'is-open' : ''} ${overId === section.id ? 'is-drop' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (dragId && dragId !== section.id) setOverId(section.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOn(section.id);
                  }}
                  onClick={() => setOpenId(open ? null : section.id)}
                >
                  <td>
                    <button
                      type="button"
                      className="section-drag"
                      draggable
                      aria-label={`Drag ${section.sectionName}`}
                      onClick={(event) => event.stopPropagation()}
                      onDragStart={(event) => {
                        setDragId(section.id);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', section.id);
                      }}
                      onDragEnd={() => { setDragId(null); setOverId(null); }}
                    >
                      ⋮⋮
                    </button>
                  </td>
                  <td>
                    <input
                      className="text-input"
                      value={drafts[section.id] ?? section.sectionName}
                      aria-label={`Section name ${section.sectionName}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDrafts((current) => ({ ...current, [section.id]: event.target.value }))}
                      onBlur={() => { void rename(section); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
                      }}
                    />
                  </td>
                  <td>
                    <select
                      className="text-input"
                      aria-label={`Columns for ${section.sectionName}`}
                      value={columns}
                      disabled={busy}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => { void setColumnWidth(section, Number(event.target.value)); }}
                    >
                      {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
                    </select>
                  </td>
                  <td>{rows.length}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      style={{ color: 'var(--red)' }}
                      disabled={busy || rows.length > 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeSection(section);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="section-preview-row">
                    <td colSpan={5}>
                      {rows.length === 0 ? (
                        <div style={{ padding: '12px 4px', color: 'var(--ink-3)', fontSize: '13px' }}>No attributes in this section.</div>
                      ) : (
                        <div className="attribute-display-grid" style={{ ['--section-columns' as string]: String(columns) }}>
                          {rows.map((attribute) => {
                            const span = clampAttributeSpan(attribute.displaySpanColumns, attribute.displaySpanRows, columns);
                            return (
                              <div key={attribute.id} className={`attribute-layout-tile attr-span-cols-${span.columns} attr-span-rows-${span.rows}`}>
                                <span style={{ fontSize: '13px', fontWeight: 600 }}>{attribute.attributeName}</span>
                                <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{span.columns}×{span.rows}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          className="text-input"
          value={newName}
          placeholder="New section name"
          aria-label="New section name"
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void addSection();
          }}
          style={{ maxWidth: '280px' }}
        />
        <button type="button" className="btn" disabled={busy || !newName.trim()} onClick={() => { void addSection(); }}>+ Section</button>
      </div>
    </div>
  );
}
