'use client';

import { createContext, useContext, type AnchorHTMLAttributes, type ReactNode } from 'react';
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

/** Anchor that navigates client-side through the host. Modified clicks fall through to the browser. */
export function SurfaceLink({ href, children, ...rest }: { href: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const host = useSurfaceHost();
  return (
    <a
      {...rest}
      href={host.href(href)}
      onClick={(event) => {
        rest.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        host.navigate(href);
      }}
    >
      {children}
    </a>
  );
}
