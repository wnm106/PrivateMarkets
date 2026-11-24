import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Anthropic key for server code in the web app.
 *
 * The worker reads ANTHROPIC_API_KEY from the repository .env. Next does not
 * load that file, so a key that is only there is read once and kept.
 */

let repoKey: string | null = null;

function keyIn(text: string): string {
  const match = text.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/m);
  if (!match) return '';
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.trim();
}

export function anthropicKey(): string {
  const current = (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (current) return current;
  if (repoKey !== null) return repoKey;
  repoKey = '';
  for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env'), resolve(process.cwd(), '../../.env')]) {
    try {
      const value = keyIn(readFileSync(path, 'utf8'));
      if (value) {
        repoKey = value;
        break;
      }
    } catch {
      // This candidate is not the repository env file.
    }
  }
  return repoKey;
}
