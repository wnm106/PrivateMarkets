import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAdmin } from '@/lib/surface-builder/admin-auth';
import { loadPlatformCatalog } from '@/lib/surface-builder/catalog-server';

/** What the Surface Builder will analyze against: entity types for the picker, and the size of each part of the catalog. */
export async function GET(request: NextRequest) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const catalog = await loadPlatformCatalog(auth.supabase);
  return NextResponse.json({
    domains: catalog.domains.map((domain) => ({ code: domain.code, name: domain.name })).sort((a, b) => a.name.localeCompare(b.name)),
    counts: {
      domains: catalog.domains.length,
      attributes: catalog.attributes.length,
      relationships: catalog.relationships.length,
      tools: catalog.tools.length,
      readTools: catalog.tools.filter((tool) => tool.readOnly).length,
      skills: catalog.skills.length,
      surfaces: catalog.surfaces.length,
    },
    skills: catalog.skills.map((skill) => skill.name),
    gaps: catalog.gaps,
  });
}
