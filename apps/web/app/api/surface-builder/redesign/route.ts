import { NextRequest, NextResponse } from 'next/server';
import { callerClientId } from '@/lib/agent-audit';
import { requireTenantAdmin } from '@/lib/surface-builder/admin-auth';
import { houseKitCss } from '@/lib/surface-builder/house-kit-server';
import { checkAsk, designerSystem, readRedesignReply, redesignAsk, type RedesignBinding } from '@/lib/surface-builder/redesign';
import { review, reviewerAvailable, type ReviewPart } from '@/lib/surface-builder/reviewer';
import { auditFindings, auditView } from '@/lib/surface-builder/view-audit';
import { usageForClient } from '@tapestrai/mcp-server/src/agent/harness';

/**
 * Surface Builder: redesigns one captured view of a prototype in the house
 * design. The first call writes the redesign; a second call (with `check`)
 * sends the redesign's own screenshot next to the original so the model can
 * correct what differs. Nothing is written.
 */

export const maxDuration = 800;

const BASE64 = /^[A-Za-z0-9+/=]+$/;

function image(value: unknown): string | undefined {
  return typeof value === 'string' && value.length < 2_000_000 && BASE64.test(value.slice(0, 400)) ? value : undefined;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function bindings(value: unknown): RedesignBinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((item) => {
    const row = (item || {}) as Record<string, unknown>;
    return {
      label: text(row.label, 120),
      attributeCode: text(row.attributeCode, 80) || undefined,
      decision: text(row.decision, 20) || 'ui',
      editable: row.editable === true || undefined,
    };
  }).filter((binding) => binding.label);
}

export async function POST(request: NextRequest) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 });
  }
  const label = text(body?.view?.label, 120);
  const markup = text(body?.view?.html, 120_000);
  if (!label || !markup) return NextResponse.json({ error: 'Capture the view first: it needs its rendered markup.' }, { status: 400 });
  const kit = houseKitCss();
  if (!kit) return NextResponse.json({ error: 'The app stylesheet could not be read, so there is no house kit to design with.' }, { status: 500 });
  const reviewer = reviewerAvailable();
  if (!reviewer) return NextResponse.json({ error: 'No model key is configured.' }, { status: 503 });

  const original = image(body?.view?.image);
  const shared: ReviewPart[] = [{ type: 'text', text: `ORIGINAL VIEW "${label}"\nRENDERED MARKUP:\n${markup}` }];
  if (original) {
    shared.push({ type: 'text', text: `SCREENSHOT of the original "${label}":` });
    shared.push({ type: 'image', data: original, mediaType: 'image/jpeg' });
  }
  const check = body?.check && typeof body.check === 'object' ? body.check as Record<string, unknown> : null;
  const draft = check ? text(check.html, 200_000) : '';
  const rendered = check ? image(check.image) : undefined;
  if (check) {
    if (!draft) return NextResponse.json({ error: 'The check round needs the redesign to compare.' }, { status: 400 });
    shared.push({ type: 'text', text: `YOUR REDESIGN (HTML):\n${draft}` });
    if (rendered) {
      shared.push({ type: 'text', text: 'SCREENSHOT of your redesign rendered with the house kit:' });
      shared.push({ type: 'image', data: rendered, mediaType: 'image/jpeg' });
    }
  }

  const clientId = await callerClientId(auth.supabase);
  try {
    const result = await review({
      system: designerSystem(kit),
      shared,
      // The check round is told what a read of its own HTML found: figures with no binding, small text, narrow inputs.
      ask: check
        ? checkAsk(label, auditFindings(auditView(label, draft)))
        : redesignAsk(label, text(body?.purpose, 1000) || undefined, bindings(body?.bindings), text(body?.shared, 30_000) || undefined),
      maxTokens: 64_000,
      json: false,
      activity: check ? 'surface-builder.redesign-check' : 'surface-builder.redesign',
      userId: auth.userId,
      clientId,
      subject: { type: 'surface', id: text(body?.name, 120) || label, label: `${text(body?.name, 120)} \u00b7 ${label}` },
      metadata: { view: label, check: Boolean(check), hasScreenshot: Boolean(original), hasRendered: Boolean(rendered) },
    });
    const reply = readRedesignReply(result.text);
    if (!reply) {
      const why = result.stopped === 'max_tokens' ? 'The model ran out of room before it finished the HTML.' : result.stopped === 'refusal' ? 'The model declined to redesign this view.' : 'The model reply had no HTML in it.';
      return NextResponse.json({ error: why, usage: usageForClient([result.audit]) }, { status: 502 });
    }
    // What is still unbound or too tight after this round, for the person reviewing the redesign.
    const remaining = auditFindings(auditView(label, reply.html));
    return NextResponse.json({ ...reply, notes: [...reply.notes, ...remaining.map((line) => `Still to fix: ${line}`)].slice(0, 40), model: result.model, usage: usageForClient([result.audit]) });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : 'unknown error').slice(0, 300);
    return NextResponse.json({ error: `The model could not redesign the view: ${detail}` }, { status: 502 });
  }
}
