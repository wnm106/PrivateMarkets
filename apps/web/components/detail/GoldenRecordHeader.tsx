'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { sources, qualityColor } from '@/lib/data';
import { DQ_RECORD_SCORE_QUERY, MERGE_CANDIDATE_PAIRS_QUERY, graphqlQuery } from '@/lib/graphql';
import { knowledgeArgument, scoreFromWeights, type QualityScore, type ScoreWeights } from '@/lib/dq-scores';
import { useTemporalStore } from '@/lib/store';
import { openPairCount, readDismissed } from '@/lib/merge-dismissed';

interface GoldenRecordHeaderProps {
  id: string;
  name: string;
  type: string;
  status: string;
  lastReviewed: string;
  conflicts: number;
  entityPath: string;
  listPath: string;
  listLabel: string;
  accentColor: string;
  onRename?: (name: string) => Promise<void>;
  mergeHref?: string;
  entityId?: string;
}

function formatScore(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDay(value: string | null | undefined) {
  const date = new Date(`${(value || new Date().toISOString()).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function GoldenRecordHeader({
  id,
  name,
  type,
  status,
  lastReviewed,
  conflicts,
  entityPath,
  listPath,
  listLabel,
  accentColor,
  onRename,
  mergeHref,
  entityId,
}: GoldenRecordHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  // The record's data-quality score, as of the As Of date: the same score its Data quality tab shows for that day.
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [score, setScore] = useState<QualityScore | null | undefined>(undefined);
  useEffect(() => {
    setScore(undefined);
    if (!entityId) {
      setScore(null);
      return;
    }
    let cancelled = false;
    const day = (asOfDate || new Date().toISOString()).slice(0, 10);
    graphqlQuery<{ dataQualityDashboard: { scores: ScoreWeights | null } | null }, { fromDate: string; toDate: string; knowledgeDate: string | null; entityId: string }>(
      DQ_RECORD_SCORE_QUERY,
      { fromDate: day, toDate: day, knowledgeDate: knowledgeArgument(knowledgeDate || ''), entityId },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const weights = result.data?.dataQualityDashboard?.scores;
      setScore(weights ? scoreFromWeights(weights) : null);
    }).catch(() => {
      if (!cancelled) setScore(null);
    });
    return () => { cancelled = true; };
  }, [entityId, asOfDate, knowledgeDate]);
  const scoreValue = score?.score ?? null;
  const scoreTitle = score
    ? [
        ['Availability', score.availability],
        ['Quality', score.quality],
        ['Freshness', score.freshness],
        ['Consensus', score.consensus],
      ].filter(([, value]) => value != null).map(([label, value]) => `${label} ${value}%`).join(' · ')
    : undefined;

  // The duplicates link shows only when this record has possible duplicates nobody has dismissed.
  const [duplicates, setDuplicates] = useState(0);
  useEffect(() => {
    setDuplicates(0);
    if (!mergeHref || !entityId) return;
    let cancelled = false;
    graphqlQuery<{ mergeCandidates: { candidates: Array<{ left: { id: string }; right: { id: string } }> } }, { filter: { entityId: string; limit: number } }>(
      MERGE_CANDIDATE_PAIRS_QUERY,
      { filter: { entityId, limit: 200 } },
      'network-only',
    ).then((result) => {
      if (!cancelled) setDuplicates(openPairCount(result.data?.mergeCandidates?.candidates || [], readDismissed()));
    }).catch(() => {
      if (!cancelled) setDuplicates(0);
    });
    return () => { cancelled = true; };
  }, [mergeHref, entityId]);

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
          <div className="gr-score-block" title={scoreTitle || undefined}>
            <div className="gr-score-lbl">Data quality</div>
            <div className="gr-score-val" style={{ color: scoreValue == null ? 'var(--ink-3)' : qualityColor(scoreValue) }}>
              {score === undefined ? '…' : scoreValue == null ? '—' : <>{formatScore(scoreValue)}<span className="gr-score-pct">%</span></>}
            </div>
            <div className="gr-score-sub">{score === undefined ? 'Scoring…' : scoreValue == null ? 'No checks apply' : `As of ${formatDay(asOfDate)}`}</div>
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
            {mergeHref && duplicates > 0 && (
              <Link href={mergeHref}>
                <button className="btn btn-sm btn-warn">
                  {duplicates === 1 ? '1 possible duplicate' : `${duplicates} possible duplicates`}
                </button>
              </Link>
            )}
            {conflicts > 0 && (
              <Link href={entityId ? `/resolve?entity=${entityId}` : '/resolve'}>
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
