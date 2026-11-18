'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { routeChatContext } from '@/lib/page-context';
import { SignedOutGate } from '@/components/auth/SignedOutGate';
import { TopBar } from './TopBar';
import { AppSidebar } from './AppSidebar';
import { ChatPanel } from './ChatPanel';
import { ImpersonationBanner } from './ImpersonationBanner';
import { AttributeInspectProvider } from '@/components/detail/AttributeInspect';
import type { SurfaceNavLink } from '@/lib/surface-links';

/** Routes rendered without the authenticated application chrome. */
const BARE_PATHS = ['/welcome', '/login', '/no-access', '/portal'];

export function AppChrome({
  children,
  surfaceLinks = [],
}: {
  children: React.ReactNode;
  surfaceLinks?: SurfaceNavLink[];
}) {
  const pathname = usePathname() || '/';
  const routeContext = useMemo(() => routeChatContext(pathname), [pathname]);
  const bare = BARE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const [leaving, setLeaving] = useState(false);
  const markLeaving = useCallback(() => setLeaving(true), []);

  const shell = (
    <div className="app-frame">
      <ImpersonationBanner />
      {/* The assistant is a flex sibling of the page content, so opening it
          compresses the page rather than overlaying it. */}
      <div className="app-shell">
        <AppSidebar surfaceLinks={surfaceLinks} />
        <div className="app-shell-main">
          <TopBar />
          <main className="main">{children}</main>
        </div>
        <ChatPanel context={routeContext} />
      </div>
    </div>
  );

  return (
    <AttributeInspectProvider>
      <SignedOutGate onLeave={bare ? undefined : markLeaving} />
      {bare ? children : leaving ? null : shell}
    </AttributeInspectProvider>
  );
}
