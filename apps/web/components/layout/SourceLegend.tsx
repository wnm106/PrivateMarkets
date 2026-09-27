'use client';

import { sources } from '@/lib/data';

export function SourceLegend() {
  return (
    <div className="legend">
      <div className="legend-label">Source Legend</div>
      {Object.entries(sources).map(([key, src]) => (
        <div key={key} className="legend-item">
          <span className="legend-swatch" style={{ background: src.hex }}></span>
          {src.name}
        </div>
      ))}
      <div className="legend-sync">
        Last sync · <strong>Thu 21 May, 06:14 EST</strong>
      </div>
    </div>
  );
}
