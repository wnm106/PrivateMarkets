'use client';

import { useEffect, useState } from 'react';
import { loadSurfaceResolution, type SurfaceResolution } from '@/lib/surfaces';

/** Panels this build can mount. The database names which tab uses which one. */
export const FUND_PANEL_KEYS = new Set([
  'nav', 'pacing', 'activity', 'review', 'returns', 'liquidity', 'investors', 'exposure', 'accounts', 'filings',
]);

export const DEAL_PANEL_KEYS = new Set([
  'capital', 'memo', 'compliance', 'syndicate', 'closing', 'servicing', 'financials', 'performance',
]);

export function mountedPanel(
  page: { status: string; panelKey?: string | null },
  known: ReadonlySet<string>,
): string | null {
  if (page.status !== 'RENDERED' || !page.panelKey || !known.has(page.panelKey)) return null;
  return page.panelKey;
}

export function useLiveSurface(
  surfaceCode: string,
  entityId: string,
  facts?: Record<string, string> | null,
) {
  const [resolution, setResolution] = useState<SurfaceResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const factKey = JSON.stringify(facts || {});

  useEffect(() => {
    if (!surfaceCode || !entityId) return;
    let cancelled = false;
    const load = async () => {
      const result = await loadSurfaceResolution({
        surfaceCode,
        entityId,
        facts: facts && Object.keys(facts).length > 0 ? { attributes: facts } : undefined,
      });
      if (cancelled) return;
      setResolution(result.data?.resolveSurface ?? null);
      setError(result.error?.message || null);
    };
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [surfaceCode, entityId, factKey]);

  return {
    resolution,
    pages: resolution?.pages ?? [],
    error,
  };
}

export function tabReason(
  page: { status: string; decision: string; panelKey?: string | null },
  known: ReadonlySet<string>,
): string | undefined {
  if (page.status !== 'RENDERED') return page.decision;
  if (!mountedPanel(page, known)) return 'Not built yet';
  return undefined;
}
