'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { sources, qualityColor } from '@/lib/data';

interface GoldenRecordHeaderProps {
  id: string;
  name: string;
  type: string;
  status: string;
  lastReviewed: string;
  quality: number;
  conflicts: number;
  entityPath: string;
  listPath: string;
  listLabel: string;
  accentColor: string;
  onRename?: (name: string) => Promise<void>;
}

export function GoldenRecordHeader({
  id,
  name,
  type,
  status,
  lastReviewed,
  quality,
  conflicts,
  entityPath,
  listPath,
  listLabel,
  accentColor,
  onRename,
}: GoldenRecordHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  const cancelRename = () => {
    setDraft(name);
    setRenameError(null);
    setEditing(false);
  };

  const saveRename = async () => {
    const next = draft.trim();
    if (!next) {
      setRenameError('Name is required');
      return;
    }
    if (!onRename || next === name) {
      setEditing(false);
      setRenameError(null);
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Could not save name');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href={listPath} className="crumb-link">{listLabel}</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{id}</span>
      </div>

      {/* Golden Record Header */}
      <div className="gr-header">
        <div className="gr-header-left">
          <div className="gr-accent-bar" style={{ background: accentColor }} />
          <div>
            <div className="gr-meta-row">
              <span className="rec-id">{id}</span>
              <span className="status-chip active">● {status.toUpperCase()}</span>
              {conflicts > 0 && (
                <span className="status-chip conflict">⚠ {conflicts} CONFLICT{conflicts !== 1 ? 'S' : ''}</span>
              )}
              <span className="rec-time">Last reviewed {lastReviewed}</span>
            </div>
            {onRename && editing ? (
              <form
                className="gr-name-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRename();
                }}
              >
                <input
                  className="text-input gr-name-input"
                  value={draft}
                  autoFocus
                  disabled={saving}
                  aria-label="Entity name"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') cancelRename();
                  }}
                />
                <button className="btn btn-sm btn-primary" type="submit" disabled={saving || !draft.trim()}>
                  {saving ? 'Saving' : 'Save'}
                </button>
                <button className="btn btn-sm" type="button" onClick={cancelRename} disabled={saving}>
                  Cancel
                </button>
              </form>
            ) : (
              <div className="gr-name">{name}</div>
            )}
            {renameError && <div className="gr-name-error">{renameError}</div>}
            <div className="gr-type">{type}</div>
          </div>
        </div>

        <div className="gr-header-center">
          <div className="gr-score-block">
            <div className="gr-score-lbl">Golden Record</div>
            <div className="gr-score-val" style={{ color: qualityColor(quality) }}>
              {quality}<span className="gr-score-pct">%</span>
            </div>
            <div className="gr-score-sub">Composite quality score</div>
          </div>
        </div>

        <div className="gr-header-right">
          <div className="gr-actions">
            {onRename && !editing && (
              <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
                Rename
              </button>
            )}
            <Link href={`${entityPath}/lineage`}>
              <button className="btn btn-sm">View Lineage</button>
            </Link>
            {conflicts > 0 && (
              <Link href="/resolve">
                <button className="btn btn-sm btn-primary">Resolve Conflicts</button>
              </Link>
            )}
            <Link href={listPath}>
              <button className="btn btn-sm">← Back</button>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
