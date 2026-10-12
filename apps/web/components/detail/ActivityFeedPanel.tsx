'use client';

import type { ActivityData } from './types';

interface ActivityFeedPanelProps {
  activities: ActivityData[];
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
      {activities.map((item, i) => (
        <div key={i} className="activity-item">
          <div className="act-avatar">{item.who}</div>
          <div>
            <div className="act-txt">{item.text}</div>
            <div className="act-time">{item.time}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
