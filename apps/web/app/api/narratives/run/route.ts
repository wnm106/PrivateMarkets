import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { runDataQueries, summarizeResultsForLLM, validateDataQueries } from '@tapestrai/graphql/src/lib/data-query-engine';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  '';
const DEFAULT_MODEL = 'gemini-2.0-flash';

const OUTPUT_FORMAT_DOC = `
Respond with ONLY a JSON object: { "blocks": [ ... ] }. Each block has "type", "key", "title" and type-specific fields:
- markdown: { "type":"markdown", "key", "title", "text": "<markdown>" }
- table:    { "type":"table", "key", "title", "columns": ["Col A","Col B"], "rows": [["a", 1], ["b", 2]] }
- chart:    { "type":"chart", "key", "title", "chartType": "bar"|"line"|"pie", "labels": ["x1","x2"], "series": [ { "name":"S1", "values":[1,2] } ] }
- insights: { "type":"insights", "key", "title", "items": [ { "title":"...", "detail":"...", "severity":"info"|"positive"|"warning"|"critical" } ] }
Produce exactly the requested blocks, in order, using their keys. Use ONLY facts and numbers present in the supplied data; never invent values. If the data is missing or an error is reported for a data set, say so plainly in the relevant block. Keep prose concise and specific.
`.trim();

const MAX_TABLE_ROWS = 200;

function normalizeBlocks(raw: any): any[] {
  const blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
  const out: any[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const base = { key: String(b.key ?? `block_${out.length + 1}`), title: b.title ? String(b.title) : undefined };
    switch (b.type) {
      case 'markdown':
        out.push({ type: 'markdown', ...base, text: String(b.text ?? '') });
        break;
      case 'table': {
        const columns = Array.isArray(b.columns) ? b.columns.map(String) : [];
        const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_TABLE_ROWS).map((r: any) =>
          Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : c)) : [String(r)]
        );
        out.push({ type: 'table', ...base, columns, rows });
        break;
      }
      case 'chart': {
        const chartType = ['bar', 'line', 'pie'].includes(b.chartType) ? b.chartType : 'bar';
        const labels = Array.isArray(b.labels) ? b.labels.map(String) : [];
        const series = (Array.isArray(b.series) ? b.series : []).map((s: any) => ({
          name: String(s?.name ?? ''),
          values: (Array.isArray(s?.values) ? s.values : []).map((v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)),
        }));
        out.push({ type: 'chart', ...base, chartType, labels, series });
        break;
      }
      case 'insights': {
        const items = (Array.isArray(b.items) ? b.items : []).map((i: any) => ({
          title: String(i?.title ?? ''),
          detail: String(i?.detail ?? ''),
          severity: ['info', 'positive', 'warning', 'critical'].includes(i?.severity) ? i.severity : 'info',
        }));
        out.push({ type: 'insights', ...base, items });
        break;
      }
    }
  }
  return out;
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!geminiApiKey) return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });

  // Everything below runs as the CALLER (RLS / tenancy applies to data retrieval and run storage).
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    const userId = userData.user.id;

    const body = await request.json();
    const { narrativeId, entityId, params = {}, draft } = body as {
      narrativeId?: string;
      entityId?: string;
      params?: Record<string, any>;
      /** Unsaved designer draft; if present it is run instead of the stored template and is NOT persisted. */
      draft?: any;
    };

    let narrative: any = draft;
    if (!narrative) {
      if (!narrativeId) return NextResponse.json({ error: 'narrativeId required' }, { status: 400 });
      const { data, error } = await supabase.from('narrative_templates').select('*').eq('id', narrativeId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return NextResponse.json({ error: 'Narrative not found' }, { status: 404 });
      narrative = {
        instructions: data.instructions,
        dataQueries: data.data_queries,
        outputBlocks: data.output_blocks,
        model: data.model,
        domainCode: data.domain_code,
        narrativeName: data.narrative_name,
      };
    }

    const queries = narrative.dataQueries || [];
    const problems = validateDataQueries(queries);
    if (problems.length > 0) return NextResponse.json({ error: `Invalid data queries: ${problems.join('; ')}` }, { status: 400 });

    const dataResponse = await runDataQueries(supabase, queries, { entityId, params });
    const dataForModel = summarizeResultsForLLM(dataResponse, 80);

    const requested = (narrative.outputBlocks || [])
      .map((b: any, i: number) => `${i + 1}. type=${b.type} key=${b.key} title="${b.title || ''}"${b.guidance ? ` guidance: ${b.guidance}` : ''}`)
      .join('\n');

    const prompt = [
      `# Task\n${narrative.instructions || 'Review the data and report on the most important findings.'}`,
      `# Requested output blocks\n${requested || '1. type=markdown key=summary title="Summary"'}`,
      `# User inputs\n${JSON.stringify(params)}`,
      `# Data\n${JSON.stringify(dataForModel)}`,
    ].join('\n\n');

    const model = narrative.model || DEFAULT_MODEL;
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: `You are a careful private-markets data analyst producing structured reports from master data.\n\n${OUTPUT_FORMAT_DOC}` }],
          },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' },
        }),
      }
    );

    let blocks: any[] = [];
    let status: 'COMPLETED' | 'FAILED' = 'COMPLETED';
    let errorMessage: string | null = null;

    if (!geminiResponse.ok) {
      status = 'FAILED';
      errorMessage = `Model error: ${(await geminiResponse.text()).slice(0, 500)}`;
    } else {
      const g = await geminiResponse.json();
      const text = (g.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
      try {
        blocks = normalizeBlocks(JSON.parse(text));
        if (blocks.length === 0) {
          status = 'FAILED';
          errorMessage = 'The model returned no usable blocks.';
        }
      } catch {
        status = 'FAILED';
        errorMessage = 'The model returned output that could not be parsed.';
      }
    }

    const dataSummary = {
      entity: dataResponse.anchor ? { entityCode: dataResponse.anchor.entityCode, entityName: dataResponse.anchor.entityName } : null,
      datasets: Object.fromEntries(
        Object.entries(dataResponse.results).map(([k, r]) => [k, { rows: r.rows.length, matched: r.matched, truncated: r.truncated, error: r.error }])
      ),
      warnings: dataResponse.warnings,
    };

    const run = {
      id: null as string | null,
      narrativeId: narrativeId || null,
      entityId: entityId || null,
      parameters: params,
      blocks,
      status,
      errorMessage,
      model,
      dataSummary,
      createdAt: new Date().toISOString(),
    };

    // Persist only runs of saved narratives.
    if (!draft && narrativeId) {
      const { data: saved, error: saveError } = await supabase
        .from('narrative_runs')
        .insert({
          narrative_id: narrativeId,
          entity_id: entityId || null,
          parameters: params,
          blocks,
          status,
          error_message: errorMessage,
          model,
          data_summary: dataSummary,
          created_by: userId,
        })
        .select('id, created_at')
        .single();
      if (saveError) console.error('[narratives/run] failed to store run:', saveError.message);
      else {
        run.id = saved.id;
        run.createdAt = saved.created_at;
      }
    }

    return NextResponse.json({ run });
  } catch (error: any) {
    console.error('[narratives/run] Error:', error);
    return NextResponse.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
}
