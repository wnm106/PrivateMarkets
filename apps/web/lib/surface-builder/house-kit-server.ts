/**
 * Reads the house kit from the app stylesheet on disk. Server only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractHouseKit } from './house-kit';

let cached: string | null = null;

export function houseKitCss(): string {
  if (cached !== null) return cached;
  for (const path of ['styles/globals.css', 'apps/web/styles/globals.css', '../web/styles/globals.css']) {
    try {
      cached = extractHouseKit(readFileSync(resolve(process.cwd(), path), 'utf8'));
      return cached;
    } catch {
      // Not at this level of the workspace.
    }
  }
  cached = '';
  return cached;
}
