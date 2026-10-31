import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { visionJsonToStatementText } from '@tapestrai/graphql/src/lib/statement-template/parse';
import { requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 8;
const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  '';
const geminiModel = 'gemini-2.0-flash';

const VISION_PROMPT = `You are reading a fund NAV statement or a company financial statement.
Return JSON only, with this shape:
{"sections":[{"name":"Assets","lines":[{"label":"Investments at fair value","value":"12400000"}]}]}
Rules:
- Preserve the printed section order and the line order inside each section.
- Copy line labels verbatim.
- Put amounts, dates, and currencies in value. Use an empty string when a line has no figure.
- Section titles belong in name, not in lines.
- Do not invent lines that are not printed.`;

export async function POST(request: NextRequest) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to read a statement.' }, { status: 401 });

  const form = await request.formData();
  const files = form.getAll('files').filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return NextResponse.json({ error: 'Choose a file or an image.' }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Upload at most ${MAX_FILES} files at a time.` }, { status: 400 });

  try {
    const sources = [];
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: `${file.name} is larger than 8 MB.` }, { status: 400 });
      }
      sources.push(await sourceFromFile(file));
    }
    return NextResponse.json({ sources });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'The file could not be read.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function sourceFromFile(file: File) {
  const name = file.name || 'Statement';
  const mime = file.type || 'application/octet-stream';
  const bytes = Buffer.from(await file.arrayBuffer());
  if (mime.startsWith('image/')) {
    const text = await textFromImage(bytes, mime, name);
    return { sourceName: name, sourceKind: 'image' as const, text };
  }
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel')) {
    return { sourceName: name, sourceKind: 'file' as const, text: workbookToText(bytes) };
  }
  const text = bytes.toString('utf8');
  if (lower.endsWith('.json') || mime.includes('json')) {
    return { sourceName: name, sourceKind: 'file' as const, text: jsonToStatementText(text) };
  }
  return { sourceName: name, sourceKind: 'file' as const, text };
}

function workbookToText(bytes: Buffer): string {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  const blocks: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    if (workbook.SheetNames.length > 1) blocks.push(`# ${sheetName}`);
    for (const row of matrix) {
      blocks.push((row || []).map((cell) => String(cell ?? '').trim()).join('\t'));
    }
  }
  return blocks.join('\n');
}

function jsonToStatementText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const statement = visionJsonToStatementText(parsed);
    if (statement.trim()) return statement;
    if (Array.isArray(parsed) && parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      const headers = [...new Set(parsed.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
      const lines = [
        headers.join(','),
        ...parsed.map((row) => headers.map((header) => csvCell((row as Record<string, unknown>)[header])).join(',')),
      ];
      return lines.join('\n');
    }
  } catch {
    return text;
  }
  return text;
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function textFromImage(bytes: Buffer, mime: string, fileName: string): Promise<string> {
  if (!geminiApiKey) {
    throw new Error(`${fileName} is an image. Add a Gemini API key, or paste the statement table instead.`);
  }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: VISION_PROMPT },
            { inline_data: { mime_type: mime || 'image/png', data: bytes.toString('base64') } },
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Could not read ${fileName}. ${detail}`);
  }
  const payload = await response.json();
  const raw = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('\n') || '';
  const parsed = parseVisionJson(raw);
  const text = parsed ? visionJsonToStatementText(parsed) : raw;
  if (!text.trim()) throw new Error(`${fileName} did not contain a readable statement.`);
  return text;
}

function parseVisionJson(raw: string): unknown | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
