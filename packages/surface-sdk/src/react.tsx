'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { SurfaceHost } from './index';

const HostContext = createContext<SurfaceHost | null>(null);

export function SurfaceHostProvider({ host, children }: { host: SurfaceHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useSurfaceHost(): SurfaceHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('useSurfaceHost must be used inside a SurfaceHostProvider');
  return host;
}
