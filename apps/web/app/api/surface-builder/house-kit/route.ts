import { NextResponse } from 'next/server';
import { houseKitCss } from '@/lib/surface-builder/house-kit-server';

/**
 * The house kit stylesheet (tokens and shared surface classes from the app's
 * own stylesheet), for Surface Builder previews. It is the same CSS the app
 * serves to every page, so it needs no sign-in.
 */
export async function GET() {
  const css = houseKitCss();
  if (!css) return new NextResponse('The app stylesheet could not be read.', { status: 404 });
  return new NextResponse(css, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' } });
}
