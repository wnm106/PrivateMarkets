import { NextRequest, NextResponse } from 'next/server';
import { refreshImportInstance } from '@/lib/feeds/import-instances';
import { requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await refreshImportInstance(id));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be read again' }, { status: 400 });
  }
}
