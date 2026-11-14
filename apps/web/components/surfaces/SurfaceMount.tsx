'use client';

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { SurfaceHost } from '@tapestrai/surface-sdk';
import { SurfaceHostProvider } from '@tapestrai/surface-sdk/react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { findSurface } from '@/lib/surface-registry';
import { useSurfaceNav } from '@/lib/surface-nav';
import { useTemporalStore } from '@/lib/store';

interface SurfaceMountProps {
  code: string;
  clientCode: string | null;
  permissions: string[];
}

/** Loads a registered surface and gives it the host API. The only bridge between platform and surface. */
export function SurfaceMount({ code, clientCode, permissions }: SurfaceMountProps) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const entry = findSurface(code);
    if (!entry) {
      setError('Unknown surface.');
      return;
    }
    entry
      .load()
      .then((mod) => { if (!cancelled) setComponent(() => mod.default.Component); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Surface failed to load.'); });
    return () => { cancelled = true; };
  }, [code]);

  const host = useMemo<SurfaceHost>(
    () => ({
      clientCode,
      permissions,
      asOfDate,
      query: (document, variables, policy) => graphqlQuery(document, variables ?? {}, policy) as never,
      mutate: (document, variables) => graphqlMutation(document, variables ?? {}) as never,
      href: (path) => path,
      useCrumbs: useSurfaceNav,
    }),
    [clientCode, permissions, asOfDate],
  );

  if (error) return <div className="xp-error">{error}</div>;
  if (!Component) return <div className="xp-empty">Loading…</div>;
  return (
    <SurfaceHostProvider host={host}>
      <Component />
    </SurfaceHostProvider>
  );
}
