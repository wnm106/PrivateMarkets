'use client';

import type { SourceContributionData } from './types';

interface SourceContributionPanelProps {
  sources: SourceContributionData[];
}

export function SourceContributionPanel({ sources }: SourceContributionPanelProps) {
  if (!sources || sources.length === 0) {
    return (
      <div className="rail-card">
        <div className="rail-head">Source Contribution</div>
        <div style={{ padding: '20px', color: 'var(--ink-3)', textAlign: 'center' }}>
          No source data available.
        </div>
      </div>
    );
  }

  return (
    <div className="rail-card">
      <div className="rail-head">Source Contribution</div>
      {sources.map((item) => (
        <div key={item.source} className="src-contribution">
          <div className="src-c-head">
            <span className="src-c-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: 8, height: 8, background: item.color, display: 'inline-block', borderRadius: '50%' }} />
              {item.sourceName}
            </span>
            <span className="src-c-detail">
              {item.fieldCount} field{item.fieldCount !== 1 ? 's' : ''} · {item.percentage}%
            </span>
          </div>
          <div className="src-c-bar">
            <div style={{ width: `${item.percentage}%`, background: item.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}
