'use client';

import { useState, useMemo, useRef } from 'react';

export interface PickerAttribute {
  id: string;
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description?: string;
  isUDF?: boolean;
  usageCount?: number;
}

export interface SelectedAttribute {
  attributeId: string;
  attribute: {
    attributeCode: string;
    attributeName: string;
    dataType: string;
  };
  isRequired: boolean;
  precedenceRank: number;
  displayOrder: number;
  displayLabel?: string;
}

export interface PickerSaveChanges {
  added: string[];
  removed: string[];
  reordered: string[];
  aliases: Record<string, string | undefined>;
}

interface TemplateAttributePickerProps {
  availableAttributes: PickerAttribute[];
  selectedAttributes: SelectedAttribute[];
  onSave: (changes: PickerSaveChanges) => void;
  onCancel?: () => void;
}


export function TemplateAttributePicker({
  availableAttributes,
  selectedAttributes,
  onSave,
  onCancel,
}: TemplateAttributePickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAvailable, setSelectedAvailable] = useState<Set<string>>(new Set());

  // Local working copies - changes are tracked here until Save
  const [localSelected, setLocalSelected] = useState<SelectedAttribute[]>(
    [...selectedAttributes].sort((a, b) => a.displayOrder - b.displayOrder)
  );
  const [localAliases, setLocalAliases] = useState<Record<string, string | undefined>>(() => {
    const map: Record<string, string | undefined> = {};
    selectedAttributes.forEach(a => {
      if (a.displayLabel) map[a.attributeId] = a.displayLabel;
    });
    return map;
  });

  // Track what was originally present for diffing
  const originalIds = useMemo(() => new Set(selectedAttributes.map(a => a.attributeId)), [selectedAttributes]);

  // Drag/drop state
  const dragIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const filteredAvailable = useMemo(() => {
    if (!searchQuery.trim()) return availableAttributes;
    const q = searchQuery.toLowerCase();
    return availableAttributes.filter(
      (a) =>
        a.attributeName.toLowerCase().includes(q) ||
        a.attributeCode.toLowerCase().includes(q) ||
        a.dataType.toLowerCase().includes(q)
    );
  }, [availableAttributes, searchQuery]);

  const localSelectedIds = useMemo(() => new Set(localSelected.map(a => a.attributeId)), [localSelected]);

  // Available = not in local selected
  const effectiveAvailable = useMemo(() => {
    return filteredAvailable.filter(a => !localSelectedIds.has(a.id));
  }, [filteredAvailable, localSelectedIds]);

  // Compute changes for save
  const computeChanges = (): PickerSaveChanges => {
    const added = localSelected.filter(a => !originalIds.has(a.attributeId)).map(a => a.attributeId);
    const removed = selectedAttributes.filter(a => !localSelectedIds.has(a.attributeId)).map(a => a.attributeId);
    const reordered = localSelected.map(a => a.attributeId);
    const aliases: Record<string, string | undefined> = {};
    localSelected.forEach(a => {
      const original = selectedAttributes.find(s => s.attributeId === a.attributeId);
      const currentAlias = localAliases[a.attributeId];
      if (currentAlias !== original?.displayLabel) {
        aliases[a.attributeId] = currentAlias;
      }
    });
    return { added, removed, reordered, aliases };
  };

  const hasChanges = useMemo(() => {
    const changes = computeChanges();
    return changes.added.length > 0 || changes.removed.length > 0 ||
      changes.reordered.some((id, i) => selectedAttributes[i]?.attributeId !== id) ||
      Object.keys(changes.aliases).length > 0;
  }, [localSelected, localAliases, selectedAttributes, originalIds]);

  const handleTransferRight = () => {
    const newAttrs = Array.from(selectedAvailable)
      .map((id: string) => {
        const attr = availableAttributes.find(a => a.id === id);
        if (!attr) return null;
        return {
          attributeId: attr.id,
          attribute: { attributeCode: attr.attributeCode, attributeName: attr.attributeName, dataType: attr.dataType },
          isRequired: false,
          precedenceRank: 100,
          displayOrder: localSelected.length + 1,
        };
      })
      .filter(Boolean) as SelectedAttribute[];
    setLocalSelected(prev => [...prev, ...newAttrs]);
    setSelectedAvailable(new Set());
  };

  const handleRemove = (attributeId: string) => {
    setLocalSelected(prev => prev.filter(a => a.attributeId !== attributeId));
  };

  const handleAliasChange = (attributeId: string, value: string) => {
    setLocalAliases(prev => ({ ...prev, [attributeId]: value || undefined }));
  };

  const handleToggleRequired = (attributeId: string) => {
    setLocalSelected(prev => prev.map(a =>
      a.attributeId === attributeId ? { ...a, isRequired: !a.isRequired } : a
    ));
  };

  // Drag and drop handlers
  const handleDragStart = (index: number) => {
    dragIndex.current = index;
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (index: number) => {
    if (dragIndex.current === null || dragIndex.current === index) {
      setDragOverIndex(null);
      return;
    }
    setLocalSelected(prev => {
      const items = [...prev];
      const [moved] = items.splice(dragIndex.current!, 1);
      items.splice(index, 0, moved);
      return items;
    });
    dragIndex.current = null;
    setDragOverIndex(null);
  };

  const handleSave = () => {
    onSave(computeChanges());
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '16px', minHeight: '420px' }}>
        {/* LEFT PANEL */}
        <div style={{ flex: '0 0 38%', display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-alt)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink-2)' }}>Available ({effectiveAvailable.length})</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn" style={{ fontSize: '11px', padding: '3px 8px' }}
                  onClick={() => setSelectedAvailable(new Set(effectiveAvailable.map((a) => a.id)))}>Select All</button>
                <button className="btn" style={{ fontSize: '11px', padding: '3px 8px' }}
                  onClick={() => setSelectedAvailable(new Set())}>Clear</button>
              </div>
            </div>
            <input className="text-input" placeholder="Search by name, code, or type..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '100%', fontSize: '13px', padding: '8px 10px' }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
            {effectiveAvailable.length === 0 ? (
              <div style={{ color: 'var(--ink-3)', fontSize: '13px', textAlign: 'center', padding: '32px 16px' }}>
                {searchQuery ? 'No matching attributes found' : 'All attributes are assigned'}
              </div>
            ) : (
              effectiveAvailable.map((attr) => (
                <div key={attr.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                    marginBottom: '6px',
                    background: selectedAvailable.has(attr.id) ? '#fef6ec' : 'transparent',
                    border: '1px solid', borderColor: selectedAvailable.has(attr.id) ? 'var(--accent)' : 'var(--line)',
                    borderRadius: '6px', cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSelectedAvailable(prev => {
                      const next = new Set(prev);
                      if (next.has(attr.id)) next.delete(attr.id); else next.add(attr.id);
                      return next;
                    });
                  }}>
                  <input type="checkbox" checked={selectedAvailable.has(attr.id)} onChange={() => {}}
                    style={{ width: '15px', height: '15px', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--ink)' }}>{attr.attributeName}</div>
                    <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '2px' }}>
                      <span className="mono">{attr.attributeCode}</span> &middot; {attr.dataType}
                      {attr.isUDF && <span style={{ marginLeft: '8px', color: 'var(--accent)' }}>UDF</span>}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* TRANSFER */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 8px' }}>
          <button className="btn btn-primary" onClick={handleTransferRight}
            disabled={selectedAvailable.size === 0}
            title="Add selected attributes"
            style={{ fontSize: '18px', padding: '10px 14px', minWidth: '44px' }}>&rarr;</button>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-alt)' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink-2)' }}>Assigned ({localSelected.length})</div>
            <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '3px' }}>Drag to reorder &middot; Edit alias inline</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
            {localSelected.length === 0 ? (
              <div style={{ color: 'var(--ink-3)', fontSize: '13px', textAlign: 'center', padding: '32px 16px' }}>
                No attributes assigned. Select from the left panel and click &rarr;
              </div>
            ) : (
              localSelected.map((tplAttr, index) => (
                <div key={tplAttr.attributeId}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={() => handleDrop(index)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px',
                    marginBottom: '6px', background: 'var(--surface)',
                    border: dragOverIndex === index ? '2px solid var(--accent)' : '1px solid var(--line)',
                    borderRadius: '6px', cursor: 'grab',
                    opacity: dragIndex.current === index ? 0.5 : 1,
                  }}>
                  <div style={{ color: 'var(--ink-3)', fontSize: '14px', flexShrink: 0, userSelect: 'none' }}>&#x2630;</div>
                  <div style={{
                    width: '24px', height: '24px',
                    background: tplAttr.isRequired ? 'var(--green, #059669)' : 'var(--ink-4, #d1d5db)',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', fontWeight: 700, borderRadius: '4px', flexShrink: 0,
                  }}>{index + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--ink)' }}>{tplAttr.attribute.attributeName}</div>
                    <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '2px' }}>
                      <span className="mono">{tplAttr.attribute.attributeCode}</span> &middot; {tplAttr.attribute.dataType}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--ink-3)', cursor: 'pointer', flexShrink: 0 }}>
                    <input type="checkbox" checked={tplAttr.isRequired}
                      onChange={() => handleToggleRequired(tplAttr.attributeId)}
                      style={{ width: '13px', height: '13px' }} />
                    Req
                  </label>
                  <div style={{ minWidth: '130px', maxWidth: '180px', flexShrink: 0 }}>
                    <input className="text-input"
                      value={localAliases[tplAttr.attributeId] || ''}
                      onChange={(e) => handleAliasChange(tplAttr.attributeId, e.target.value)}
                      placeholder="Alias..."
                      style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }} />
                  </div>
                  <button className="btn" style={{ color: 'var(--red)', fontSize: '12px', padding: '4px 8px', flexShrink: 0 }}
                    onClick={() => handleRemove(tplAttr.attributeId)} title="Remove">Remove</button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ACTION BAR */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '4px' }}>
        {onCancel && (
          <button className="btn" onClick={onCancel} style={{ fontSize: '13px', padding: '8px 20px' }}>Cancel</button>
        )}
        <button className="btn btn-primary" onClick={handleSave} disabled={!hasChanges}
          style={{ fontSize: '13px', padding: '8px 24px' }}>
          {hasChanges ? 'Save Changes' : 'No Changes'}
        </button>
      </div>
    </div>
  );
}
