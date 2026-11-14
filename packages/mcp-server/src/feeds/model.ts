/**
 * The Gemini model the import tools call. Models are retired from time to time,
 * and two files once named different ones, so there is one place to change it.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

export function geminiUrl(key: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
}

/** The key for the model, from whichever setting is present. Empty when none is. */
export function geminiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_API_KEY || env.GOOGLE_AI_API_KEY || env.NEXT_PUBLIC_GEMINI_API_KEY || '';
}
