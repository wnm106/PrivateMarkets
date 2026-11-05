import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { parseRecInsights, withoutRuleEchoes, type RecInsightPayload } from '@/lib/fund-rec-insights';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  '';
const geminiModel = 'gemini-3.8-flash';

const INSTRUCTION = `You review one period of a private-fund NAV reconciliation for the person who will certify it.
The JSON is the reconciliation already computed from the administrator pack and our books. Dollar amounts are whole US dollars.
"rules" are the threshold exceptions already in the review queue. Do not repeat them.
Write up to 4 further points worth a reviewer's time: a tie that is arithmetically true but economically odd, a relationship across statements, a fee or mark pattern, or a movement the rules left alone.
Use only figures that appear in the JSON. If you cite a number, it must be present. Do not invent drivers, names, or amounts.
If nothing further is worth raising, return an empty list.
Respond with JSON only: {"points":[{"title":"","detail":"","severity":"info"|"watch"|"break"}]}
title is at most 12 words. detail is one or two sentences. severity is break when the close should not proceed, watch when someone should look, info when it is context.`;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!geminiApiKey) return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
  if (!supabaseUrl || !supabaseAnonKey) return NextResponse.json({ error: 'Authentication is not configured' }, { status: 500 });

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  let payload: RecInsightPayload;
  try {
    const body = await request.json();
    payload = body?.rec;
  } catch {
    return NextResponse.json({ error: 'The reconciliation could not be read' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || !payload.fundName || !payload.periodEnd) {
    return NextResponse.json({ error: 'A period reconciliation is required' }, { status: 400 });
  }
  const packed = JSON.stringify(payload);
  if (packed.length > 350_000) return NextResponse.json({ error: 'This period is too large to review' }, { status: 413 });

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: packed }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );

  if (!geminiResponse.ok) {
    const detail = (await geminiResponse.text()).replace(/key=[^&\s"]+/gi, 'key').slice(0, 180);
    return NextResponse.json({ error: `The model could not read this period. ${detail}` }, { status: 502 });
  }

  const generated = await geminiResponse.json();
  const candidate = generated.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((part: { text?: string }) => part.text || '').join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const finish = candidate?.finishReason || 'unknown';
    return NextResponse.json({
      error: finish === 'MAX_TOKENS'
        ? 'The model ran out of room before it finished the points.'
        : 'The model returned a response that could not be read.',
    }, { status: 502 });
  }
  const titles = Array.isArray(payload.rules) ? payload.rules.map((rule) => String(rule?.title ?? '')) : [];
  const points = withoutRuleEchoes(parseRecInsights(parsed), titles);
  return NextResponse.json({ points });
}
