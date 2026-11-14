import { notFound, redirect } from 'next/navigation';
import { checkSurfaceAccess } from '@tapestrai/surface-sdk';
import { SurfaceMount } from '@/components/surfaces/SurfaceMount';
import { loadSurfaceUser } from '@/lib/surface-access-server';
import { findSurface } from '@/lib/surface-registry';

export default async function SurfacePage({ params }: { params: Promise<{ surface: string }> }) {
  const { surface } = await params;
  const entry = findSurface(surface);
  if (!entry) notFound();

  const user = await loadSurfaceUser();
  if (!user) redirect(`/login?redirectedFrom=${encodeURIComponent(`/s/${surface}`)}`);

  // A surface a client may not open looks the same as one that does not exist.
  if (!checkSurfaceAccess(entry.manifest, user).allowed) notFound();

  return <SurfaceMount code={surface} clientCode={user.clientCode} permissions={user.permissions} />;
}
