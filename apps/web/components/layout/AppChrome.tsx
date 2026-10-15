'use client';

import { usePathname } from 'next/navigation';
import { TopBar } from './TopBar';
import { AppSidebar } from './AppSidebar';
import { SourceLegend } from './SourceLegend';
import { ChatPanel } from './ChatPanel';
import { ImpersonationBanner } from './ImpersonationBanner';

/** Routes rendered without the authenticated application chrome. */
const BARE_PATHS = ['/welcome', '/login', '/no-access'];

export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const bare = BARE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (bare) return <>{children}</>;

  return (
    <>
      <ImpersonationBanner />
      {/* The assistant is a flex sibling of the page content, so opening it
          compresses the page rather than overlaying it. */}
      <div className="app-shell">
        <AppSidebar />
        <div className="app-shell-main">
          <TopBar />
          {pathname !== '/' && <SourceLegend />}
          <main className="main">{children}</main>
        </div>
        <ChatPanel />
      </div>
    </>
  );
}
