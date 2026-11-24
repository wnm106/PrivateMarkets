import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';

/**
 * The screenshot library (html-to-image, MIT) as plain script text, for the
 * Surface Builder's capture frame. The frame has no origin of its own, so the
 * builder inlines this source into it rather than loading a URL.
 *
 * It is a published open-source library with no data in it, so it needs no
 * sign-in.
 */

let cached: string | null = null;

function librarySource(): string {
  if (cached !== null) return cached;
  const relative = 'node_modules/html-to-image/dist/html-to-image.js';
  for (const base of [process.cwd(), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')]) {
    try {
      cached = readFileSync(resolve(base, relative), 'utf8');
      return cached;
    } catch {
      // Not installed at this level of the workspace.
    }
  }
  cached = '';
  return cached;
}

export async function GET() {
  const source = librarySource();
  if (!source) return new NextResponse('The capture library is not installed.', { status: 404 });
  return new NextResponse(source, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
}
