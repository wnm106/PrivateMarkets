'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/** One step in the bar shown while a surface is open. */
export interface SurfaceCrumb {
  label: string;
  href?: string;
}

interface SurfaceNavState {
  crumbs: SurfaceCrumb[] | null;
  setCrumbs: (crumbs: SurfaceCrumb[] | null) => void;
}

export const useSurfaceNavStore = create<SurfaceNavState>((set) => ({
  crumbs: null,
  setCrumbs: (crumbs) => set({ crumbs }),
}));

/**
 * While this component is mounted, the top bar shows this trail
 * instead of the entity path taken from the URL.
 */
export function useSurfaceNav(crumbs: SurfaceCrumb[]) {
  const setCrumbs = useSurfaceNavStore((state) => state.setCrumbs);
  const serialized = JSON.stringify(crumbs);

  useEffect(() => {
    setCrumbs(JSON.parse(serialized) as SurfaceCrumb[]);
    return () => setCrumbs(null);
  }, [serialized, setCrumbs]);
}
