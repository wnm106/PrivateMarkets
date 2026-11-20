import { NextRequest, NextResponse } from 'next/server';
import { answerDocuments, embedConfigFromEnv } from '@tapestrai/graphql/src/lib/document-content';
import { withAgentCaller } from '@/lib/agent-audit';
import { documentAnswerModel } from '@/lib/document-answer';
import { requireFeedUser } from '@/lib/feeds/require-user';
import { supabaseServerClient } from '@/lib/supabase-server';

/**
 * POST /api/documents/ask
 *
 * Body: { query, documentIds?, entityIds?, typeCodes?, tags? }
 *
 * Answers one question about the documents the caller can read. The summary
 * is written by a model that can search and read sections. The sections it
 * names come back with the document's own words.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

class BadRequest extends Error {}

function strings(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new BadRequest('Filters must be lists of text.');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new BadRequest('Filters must be lists of text.');
    const text = item.trim();
    if (text) out.push(text);
  }
  if (out.length > 40) throw new BadRequest('Too many filters.');
  return out.length > 0 ? out : null;
}

export async function POST(request: NextRequest) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to ask a question about a document.' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest('Send the question as JSON.');
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BadRequest) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: 'Send the question as JSON.' }, { status: 400 });
  }

  try {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) throw new BadRequest('Ask a question.');
    if (query.length > 2000) throw new BadRequest('Ask the question in 2,000 characters or fewer.');
    const filters = {
      documentIds: strings(body.documentIds),
      entityIds: strings(body.entityIds),
      typeCodes: strings(body.typeCodes),
      tags: strings(body.tags),
    };
    const supabase = await supabaseServerClient();
    const { result } = await withAgentCaller(supabase, user.id, {
      feature: 'documents',
      activity: 'document.answer',
      agent: 'reader',
      // One document asked about is the subject. A search across many has none.
      subject: filters.documentIds?.length === 1 ? { type: 'document', id: filters.documentIds[0] } : null,
    }, () => answerDocuments(supabase, query, filters, embedConfigFromEnv(), documentAnswerModel(supabase)));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BadRequest) return NextResponse.json({ error: error.message }, { status: 400 });
    const message = error instanceof Error && error.message ? error.message : 'The question could not be answered.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
