import { invokeAgent } from '../agent/harness';
import { geminiAnswerText } from '../agent/usage';
import { GEMINI_MODEL, geminiKey } from './model';
import type { ParsedTable } from './types';

/**
 * When a file is prose or a messy export, ask the model to lift one table out of it.
 * This stays optional: with no model key the specialist says so and waits for a structured file.
 */
export async function extractTableWithAgent(text: string, fileName: string): Promise<ParsedTable | null> {
  const key = geminiKey();
  if (!key || !text.trim()) return null;
  try {
    const { response } = await invokeAgent({
      provider: 'gemini',
      model: GEMINI_MODEL,
      feature: 'feed-intake',
      activity: 'feed.extract-table',
      agent: fileName,
      apiKey: key,
      signal: AbortSignal.timeout(12000),
      body: {
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
      },
    });
    const raw = geminiAnswerText(response);
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
