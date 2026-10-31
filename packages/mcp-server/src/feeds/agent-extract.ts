import type { ParsedTable } from './types';

/**
 * When a file is prose or a messy export, ask the model to lift one table out of it.
 * This stays optional: with no model key the specialist says so and waits for a structured file.
 */
export async function extractTableWithAgent(text: string, fileName: string): Promise<ParsedTable | null> {
  const key = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
  if (!key || !text.trim()) return null;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: [
                `Extract one table from "${fileName}".`,
                'Reply with JSON only, no markdown: {"headers":["column"],"rows":[{"column":"value"}]}.',
                'Keep the document\'s own column names. Leave dates as text.',
                'If there is no table, reply {"headers":[],"rows":[]}.',
                '',
                text.slice(0, 15000),
              ].join('\n'),
            }],
          }],
        }),
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!response.ok) return null;
    const body = await response.json();
    const raw = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) return null;
    const headers = parsed.headers.map((header: unknown) => String(header ?? '').trim()).filter(Boolean);
    const rows = parsed.rows
      .filter((row: unknown) => row && typeof row === 'object')
      .map((row: Record<string, unknown>) => {
        const record: Record<string, string> = {};
        for (const header of headers) record[header] = String(row[header] ?? '').trim();
        return record;
      })
      .filter((row: Record<string, string>) => Object.values(row).some(Boolean));
    if (headers.length < 2 || rows.length === 0) return null;
    return { headers, rows };
  } catch {
    return null;
  }
}
