'use client';

import Link from 'next/link';
import { qualityMatrix, topExceptions, sourceReliability, sources } from '@/lib/data';

export default function QualityPage() {
  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Data Quality Framework</span>
      </div>

      {/* Three Pillars */}
      <div className="pillar-grid">
        <div className="pillar" style={{ '--pillar-color': 'var(--accent-2)' } as React.CSSProperties}>
          <div className="pillar-lbl">Availability</div>
          <div className="pillar-val">
            94.2<span style={{ fontSize: '24px', color: 'var(--ink-3)' }}>%</span>
          </div>
          <div className="pillar-sub">of required fields populated</div>
          <div className="pillar-det">5,486 of 5,823 records fully populated</div>
        </div>
        <div className="pillar" style={{ '--pillar-color': 'var(--green)' } as React.CSSProperties}>
          <div className="pillar-lbl">Quality</div>
          <div className="pillar-val">
            92.4<span style={{ fontSize: '24px', color: 'var(--ink-3)' }}>%</span>
          </div>
          <div className="pillar-sub">fields passing validation rules</div>
          <div className="pillar-det">147 active validation exceptions</div>
        </div>
        <div className="pillar" style={{ '--pillar-color': 'var(--accent)' } as React.CSSProperties}>
          <div className="pillar-lbl">Trajectory</div>
          <div className="pillar-val" style={{ color: 'var(--green)' }}>
            +1.8<span style={{ fontSize: '24px', color: 'var(--ink-3)' }}>%</span>
          </div>
          <div className="pillar-sub">week-over-week improvement</div>
          <div className="pillar-det">Trending up in 4 of 5 domains</div>
        </div>
      </div>

      {/* Quality Matrix */}
      <div className="quality-matrix">
        <div className="qm-head">
          <div className="qm-title">Quality Matrix by Entity</div>
          <div className="qm-window">Trailing 7 days</div>
        </div>
        <div className="qm-thead">
          <div>Entity</div>
          <div>Availability</div>
          <div>Quality</div>
          <div>Trajectory</div>
          <div style={{ textAlign: 'right' }}>Exceptions</div>
          <div style={{ textAlign: 'right' }}>Trend</div>
        </div>
        {qualityMatrix.map((row, idx) => {
          const up = row.traj >= 0;
          const max = Math.max(...row.spark);
          const min = Math.min(...row.spark);
          const points = row.spark
            .map((val, i) => {
              const x = i * 10;
              const y = 28 - ((val - min) / Math.max(0.1, max - min)) * 22;
              return `${x},${y}`;
            })
            .join(' ');

          return (
            <div key={idx} className="qm-row">
              <div className="qm-ent">{row.ent}</div>
              <div className="qm-bar-wrap">
                <div className="qm-bar">
                  <div style={{ background: 'var(--accent-2)', width: `${row.avail}%` }}></div>
                </div>
                <div className="qm-pct">{row.avail}%</div>
              </div>
              <div className="qm-bar-wrap">
                <div className="qm-bar">
                  <div
                    style={{
                      background: row.qual >= 95 ? 'var(--green)' : row.qual >= 85 ? 'var(--accent-2)' : 'var(--amber)',
                      width: `${row.qual}%`,
                    }}
                  ></div>
                </div>
                <div className="qm-pct">{row.qual}%</div>
              </div>
              <div className="qm-traj" style={{ color: up ? 'var(--green)' : 'var(--red)' }}>
                {up ? '▲' : '▼'} {Math.abs(row.traj)}%
              </div>
              <div className="qm-exc">
                {row.exc === 0 ? (
                  <span style={{ color: 'var(--green)' }}>—</span>
                ) : (
                  <span style={{ color: 'var(--red)', fontWeight: 600 }}>{row.exc}</span>
                )}
              </div>
              <div className="qm-spark">
                <svg width="60" height="28" viewBox="0 0 60 28" style={{ display: 'inline-block' }}>
                  <polyline
                    points={points}
                    fill="none"
                    stroke={up ? '#2f7d4f' : '#b53030'}
                    strokeWidth="1.5"
                  />
                </svg>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Grid */}
      <div className="bottom-grid">
        <div className="bottom-card">
          <div className="bottom-title">Top Exception Rules (by count)</div>
          {topExceptions.map((exc, idx) => (
            <div key={idx} className="exc-item">
              <div className="exc-rule">
                <span className={`sev-dot sev-${exc.sev}`}></span>
                {exc.rule}
              </div>
              <div className="exc-count">{exc.count}</div>
            </div>
          ))}
        </div>
        <div className="bottom-card">
          <div className="bottom-title">Source Reliability (90-day)</div>
          {sourceReliability.map((item, idx) => {
            const src = sources[item.src];
            const up = item.delta >= 0;
            return (
              <div key={idx} className="src-item">
                <div className="src-item-name">
                  <span className="src-item-bar" style={{ background: src.hex }}></span>
                  {src.name}
                </div>
                <div className="src-item-vals">
                  <span className="src-item-delta" style={{ color: up ? 'var(--green)' : 'var(--red)' }}>
                    {up ? '▲' : '▼'} {Math.abs(item.delta)}
                  </span>
                  <span className="src-item-score">{item.score}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
