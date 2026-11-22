import { NextRequest, NextResponse } from 'next/server';
import { azureConfigured, llamaParseConfigured, listLoadSessions, listSourceMaps, startLoadSession } from '@/lib/feeds/load-sessions';
import { asFeedCaller } from '@/lib/agent-audit';
import { feedClientId, requireFeedUser, requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  try {
    const [maps, sessions] = await Promise.all([listSourceMaps(clientId), listLoadSessions(clientId)]);
    return NextResponse.json({
      azureConfigured: azureConfigured(),
      llamaParseConfigured: llamaParseConfigured(),
      maps,
      sessions,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The specialist could not be opened' }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const who = await requireFeedWriter('Sign in to load data');
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a file to read' }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: 'Files need to be 20 MB or smaller' }, { status: 400 });
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const session = await asFeedCaller(user.id, clientId, () =>
      startLoadSession(file.name, file.type || 'application/octet-stream', bytes, clientId),
    );
    return NextResponse.json(session);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be read' }, { status: 400 });
  }
}
