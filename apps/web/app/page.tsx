import { redirect } from 'next/navigation';
import { HomeView } from '@/components/home/HomeView';
import type { HomePlace } from '@/lib/home';
import { filterByTools, moduleAllowsSurface } from '@/lib/client-modules';
import { loadModuleScope, loadSurfaceUser } from '@/lib/surface-access-server';
import { eligibleManifests } from '@/lib/surface-links';
import { SURFACES } from '@/lib/surface-registry';

/** Built-in pages a person can pin. The first group is pinned until they choose. */
const PAGES: readonly HomePlace[] = [
  { key: 'page:fund-surface', title: 'Fund surface', description: 'Holdings, limits, and compliance for one fund.', href: '/fund-surface', pinnedByDefault: true },
  { key: 'page:fund-rec', title: 'Fund reconciliation', description: 'NAV and cash against the administrator.', href: '/fund-rec', pinnedByDefault: true },
  { key: 'page:workflows', title: 'Workflows', description: 'Run workflows and review what they propose.', href: '/workflows', pinnedByDefault: false },
  { key: 'page:assistant', title: 'Assistant', description: 'What you follow and when you get a brief.', href: '/assistant', pinnedByDefault: false },
  { key: 'page:merge', title: 'Entity resolution', description: 'Match and merge duplicate records.', href: '/merge', pinnedByDefault: false },
  { key: 'page:reconcile', title: 'Reconcile', description: 'Compare sources line by line.', href: '/reconcile', pinnedByDefault: false },
  { key: 'page:imports', title: 'Load data', description: 'Files received and loaded.', href: '/imports', pinnedByDefault: false },
  { key: 'page:quality', title: 'Data quality', description: 'Open exceptions and rule results.', href: '/quality', pinnedByDefault: false },
];

export default async function HomePage() {
  const [user, scope] = await Promise.all([loadSurfaceUser(), loadModuleScope()]);
  if (!user) redirect('/login?redirectedFrom=%2F');

  // A surface the person may not open is never offered, the same as /s/<code>.
  const surfaces: HomePlace[] = eligibleManifests(
    SURFACES.map((entry) => entry.manifest).filter((manifest) => moduleAllowsSurface(scope, manifest.code)),
    user,
  ).map((manifest) => ({
    key: `s:${manifest.code}`,
    title: manifest.title,
    description: manifest.description || '',
    href: `/s/${manifest.code}`,
    pinnedByDefault: true,
  }));

  // A page that a mounted surface has replaced (same title) is offered once, as the surface.
  const titles = new Set(surfaces.map((place) => place.title.toLowerCase()));
  const pages = filterByTools(PAGES.filter((page) => !titles.has(page.title.toLowerCase())), scope);

  return <HomeView user={{ permissions: user.permissions, isTenantAdmin: user.isTenantAdmin }} places={[...surfaces, ...pages]} />;
}
