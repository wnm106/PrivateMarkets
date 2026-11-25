/**
 * The app's tool pages. The sidebar draws them, and each one that is not a
 * surface is a page a client can be licensed for (kind 'tool', code = href).
 * Plain data, so the sidebar, the middleware and the admin screen share it.
 */
export const TOOL_PAGES = [
  { href: '/s/deal-pipeline', label: 'Deal Pipeline', icon: 'layers' },
  { href: '/fund-surface', label: 'Fund surface', icon: 'chart' },
  { href: '/fund-rec', label: 'Fund reconciliation', icon: 'chart' },
  { href: '/merge', label: 'Entity Resolution', icon: 'nodes' },
  { href: '/reconcile', label: 'Reconcile', icon: 'chart' },
  { href: '/lists', label: 'Value Lists', icon: 'layers' },
  { href: '/intersections', label: 'Composite Entities', icon: 'nodes' },
  { href: '/imports', label: 'Load data', icon: 'download' },
  { href: '/documents', label: 'Documents', icon: 'layers' },
  { href: '/assistant', label: 'Assistant', icon: 'list' },
  { href: '/workflows', label: 'Workflows', icon: 'nodes' },
] as const;

/** Pages a license switch can turn on or off. Surfaces are licensed as surfaces. */
export const LICENSED_PAGES: readonly { href: string; label: string }[] = [
  ...TOOL_PAGES.filter((page) => !page.href.startsWith('/s/')).map(({ href, label }) => ({ href, label })),
  { href: '/quality', label: 'Data Quality' },
];

/** The licensed page a path belongs to, or null for a path no license covers. */
export function licensedPageFor(pathname: string): string | null {
  for (const page of LICENSED_PAGES) {
    if (pathname === page.href || pathname.startsWith(`${page.href}/`)) return page.href;
  }
  return null;
}
