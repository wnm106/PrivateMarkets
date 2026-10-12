'use client';

import Link from 'next/link';
import type { ConflictData } from './types';

interface ActiveConflictsPanelProps {
  conflicts: ConflictData[];
  entityId: string;
}

const severityColors = {
  high: 'var(--red)',
  med: 'var(--amber)',
  low: 'var(--ink-3)',
};

export function ActiveConflictsPanel({ conflicts, entityId }: ActiveConflictsPanelProps) {
  if (!conflicts || conflicts.length === 0) {
    return (
      <div className="rail-card">
        <div className="rail-head">
          Active Conflicts
          <span className="rail-count">0</span>
        </div>
        <div style={{ padding: '20px', color: 'var(--ink-3)', textAlign: 'center' }}>
          No active conflicts.
        </div>
      </div>
    );
  }

  return (
    <div className="rail-card alert">
      <div className="rail-head alert">
        Active Conflicts
        <span className="rail-count">{conflicts.length}</span>
      </div>
      {conflicts.map((c, i) => (
        <div key={i} className="conflict-item" style={{ borderLeftColor: severityColors[c.severity] }}>
          <div className="ttl">{c.field}</div>
          <div className="det">{c.description}</div>
        </div>
      ))}
      <Link href="/resolve">
        <button className="btn btn-sm" style={{ width: '100%', marginTop: '12px', textAlign: 'center' }}>
          Resolve All →
        </button>
      </Link>
    </div>
  );
}
