'use client';

import type { ActivityData } from './types';

interface ActivityFeedPanelProps {
  activities: ActivityData[];
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatEffective(from?: string, to?: string) {
  if (!from) return '';
  const start = new Date(`${from.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime())) return '';
  const startLabel = start.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const openEnded = !to || to.startsWith('9999');
  if (openEnded) return `as of ${startLabel}`;
  const end = new Date(`${to.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(end.getTime())) return `as of ${startLabel}`;
  const endLabel = end.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${startLabel} – ${endLabel}`;
}

function formatActivityValue(value: string | undefined) {
  if (value == null || value === '') return 'Cleared';
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
    }
  }
  return value;
}

export function ActivityFeedPanel({ activities }: ActivityFeedPanelProps) {
  if (!activities || activities.length === 0) {
    return (
      <div className="rail-card">
        <div className="rail-head">Activity</div>
        <div style={{ padding: '20px', color: 'var(--ink-3)', textAlign: 'center' }}>
          No activity recorded.
        </div>
      </div>
    );
  }

  return (
    <div className="rail-card">
      <div className="rail-head">Activity</div>
      <div className="activity-list">
        {activities.map((item, i) => (
          <div key={`${item.attribute || item.text}-${item.time}-${i}`} className="activity-item">
            <div className="act-avatar" title={item.who}>{initials(item.who)}</div>
            <div style={{ minWidth: 0 }}>
              <div className="act-txt">{item.attribute || item.text}</div>
              {item.attribute && <div className="act-value">{formatActivityValue(item.value)}</div>}
              <div className="act-time">{[item.who, formatActivityTime(item.time), formatEffective(item.validFrom, item.validTo)].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
