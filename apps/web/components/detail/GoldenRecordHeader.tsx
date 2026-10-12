'use client';

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
}: GoldenRecordHeaderProps) {
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
            <div className="gr-name">{name}</div>
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
