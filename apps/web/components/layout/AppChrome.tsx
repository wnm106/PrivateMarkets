'use client';

import { usePathname } from 'next/navigation';
import { TopBar } from './TopBar';
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
      <TopBar />
      <SourceLegend />
      <main className="main">{children}</main>
      <ChatPanel />
    </>
  );
}
