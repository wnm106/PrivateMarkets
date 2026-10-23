'use client';

import { useEffect, useState } from 'react';
import { sources } from '@/lib/data';
import { graphqlQuery } from '@/lib/graphql';

interface LegendSource {
  sourceCode: string;
  sourceName: string;
  color: string | null;
  metadata: { color?: string } | null;
}

export function SourceLegend() {
  const [items, setItems] = useState<Array<{ key: string; name: string; hex: string }>>(
    Object.entries(sources).map(([key, src]) => ({ key, name: src.name, hex: src.hex }))
  );

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      graphqlQuery<{ dataSources: LegendSource[] }>(
        `query LegendSources { dataSources { sourceCode sourceName color metadata } }`,
        {},
        'network-only'
      ).then((result) => {
        if (cancelled || !result.data?.dataSources?.length) return;
        setItems(result.data.dataSources.map((source) => {
          const key = source.sourceCode.toLowerCase();
          const fallback = sources[key as keyof typeof sources];
          return {
            key,
            name: source.sourceName,
            hex: source.color || source.metadata?.color || fallback?.hex || '#475569',
          };
        }));
      });
    };
    load();
    window.addEventListener('sources-updated', load);
    return () => {
      cancelled = true;
      window.removeEventListener('sources-updated', load);
    };
  }, []);

  return (
    <div className="legend">
      <div className="legend-label">Source Legend</div>
      {items.map((src) => (
        <div key={src.key} className="legend-item">
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
