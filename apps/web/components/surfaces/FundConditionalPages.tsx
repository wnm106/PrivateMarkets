'use client';

import { useEffect, useState } from 'react';
import { assignedFundType, factsForPack } from '@/lib/fund-surface-funds';
import { loadSurfaceResolution, type PageResolution, type SurfaceResolution } from '@/lib/surfaces';

interface FundConditionalPagesProps {
  entityId: string;
  entityName: string;
  activePage: string;
  onPageChange: (slotCode: string) => void;
}

const CONDITIONAL_SURFACE = 'FUND_CONDITIONAL_PAGE';

export function FundConditionalPages({ entityId, entityName, activePage, onPageChange }: FundConditionalPagesProps) {
  const [resolution, setResolution] = useState<SurfaceResolution | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await loadSurfaceResolution({
        surfaceCode: CONDITIONAL_SURFACE,
        entityId,
        facts: factsForPack(assignedFundType(entityName)),
      });
      if (cancelled) return;
      setResolution(result.data?.resolveSurface ?? null);
    })();
    return () => { cancelled = true; };
  }, [entityId, entityName]);

  if (!resolution) return null;

  const rendered = resolution.pages.filter((page) => page.status === 'RENDERED');
  const hidden = resolution.pages.filter((page) => page.status === 'HIDDEN');
  const selected = rendered.some((page) => page.slotCode === activePage) ? activePage : 'OVERVIEW';

  return (
    <div style={{ margin: '8px 0 18px' }}>
      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--line)', marginBottom: '10px' }}>
        {rendered.map((page) => (
          <button
            key={page.slotCode}
            type="button"
            onClick={() => onPageChange(page.slotCode)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: selected === page.slotCode ? '2px solid var(--ink)' : '2px solid transparent',
              padding: '10px 14px',
              fontSize: '13px',
              fontWeight: selected === page.slotCode ? 600 : 500,
              color: selected === page.slotCode ? 'var(--ink)' : 'var(--ink-3)',
              cursor: 'pointer',
            }}
          >
            {page.slotName}
          </button>
        ))}
      </div>
      {hidden.map((page) => (
        <div key={page.slotCode} style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '6px' }}>
          {page.slotName} is not on this fund. {page.decision}
        </div>
      ))}
      {selected !== 'OVERVIEW' && <ConditionalPageBody resolution={resolution} page={rendered.find((page) => page.slotCode === selected)} />}
    </div>
  );
}

function ConditionalPageBody({ resolution, page }: { resolution: SurfaceResolution; page?: PageResolution }) {
  if (!page) return null;
  const components = resolution.components.filter((component) => component.pageName === page.slotName && component.status === 'QUALIFIED');
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 20px', marginBottom: '18px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '18px' }}>{page.slotName}</h2>
      <p style={{ margin: '0 0 14px', color: 'var(--ink-2)', fontSize: '13px' }}>{page.decision}</p>
      {components.map((component) => (
        <div key={component.componentCode}>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>{component.componentName}</div>
          <div style={{ fontSize: '13px', color: 'var(--ink-2)', marginTop: '4px' }}>{component.ruleTrace}</div>
        </div>
      ))}
    </section>
  );
}
