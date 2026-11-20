import { notFound, redirect } from 'next/navigation';
import { checkSurfaceAccess } from '@tapestrai/surface-sdk';
import { SurfaceMount } from '@/components/surfaces/SurfaceMount';
import { moduleAllowsSurface } from '@/lib/client-modules';
import { loadModuleScope, loadSurfaceUser } from '@/lib/surface-access-server';
import { findSurface } from '@/lib/surface-registry';

export default async function SurfacePage({ params }: { params: Promise<{ surface: string }> }) {
  const { surface } = await params;
  const entry = findSurface(surface);
  if (!entry) notFound();

  const [user, scope] = await Promise.all([loadSurfaceUser(), loadModuleScope()]);
  if (!user) redirect(`/login?redirectedFrom=${encodeURIComponent(`/s/${surface}`)}`);

  // A surface a client may not open looks the same as one that does not exist.
  if (!checkSurfaceAccess(entry.manifest, user).allowed || !moduleAllowsSurface(scope, surface)) notFound();

  return <SurfaceMount code={surface} clientCode={user.clientCode} permissions={user.permissions} />;
}
