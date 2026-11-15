'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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

/** URL query parameter on the surface's own page, as a hook. */
function useHostQueryParam(name: string): [string | null, (value: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(name);
  const set = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next == null || next === '') params.delete(name);
      else params.set(name, next);
      const text = params.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [name, pathname, router, searchParams],
  );
  return [value, set];
}

/** Loads a registered surface and gives it the host API. The only bridge between platform and surface. */
export function SurfaceMount({ code, clientCode, permissions }: SurfaceMountProps) {
  const router = useRouter();
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
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
      knowledgeDate,
      basePath: `/s/${code}`,
      navigate: (path, options) => (options?.replace ? router.replace(path) : router.push(path)),
      useQueryParam: useHostQueryParam,
      query: (document, variables, policy) => graphqlQuery(document, variables ?? {}, policy) as never,
      mutate: (document, variables) => graphqlMutation(document, variables ?? {}) as never,
      href: (path) => path,
      useCrumbs: useSurfaceNav,
    }),
    [clientCode, permissions, asOfDate, knowledgeDate, code, router],
  );

  if (error) return <div className="xp-error">{error}</div>;
  if (!Component) return <div className="xp-empty">Loading…</div>;
  return (
    <SurfaceHostProvider host={host}>
      <Component />
    </SurfaceHostProvider>
  );
}
