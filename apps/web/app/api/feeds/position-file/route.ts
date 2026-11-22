import { NextRequest, NextResponse } from 'next/server';
import { createImportInstance, listImportInstances, listMappingCatalog, listReferenceLists, listSources } from '@/lib/feeds/import-instances';
import { asFeedCaller } from '@/lib/agent-audit';
import { feedClientId, requireFeedUser, requireFeedWriter } from '@/lib/feeds/require-user';
import { mappingTargets } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  try {
    const [catalog, instances, lists, sources] = await Promise.all([listMappingCatalog(clientId), listImportInstances(clientId), listReferenceLists(), listSources()]);
    return NextResponse.json({
      sourceCode: 'IMPORT',
      name: 'Load data',
      description: 'Upload a file. Columns are discovered, confirmed, and saved as a map for the next file with the same columns.',
      targets: mappingTargets(catalog.attributes, catalog.domains, { domains: catalog.domainAliases, names: catalog.nameAliases }),
      lists,
      sources,
      instances,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The import queue could not be loaded' }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const who = await requireFeedWriter();
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a file to load' }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: 'Files need to be 20 MB or smaller' }, { status: 400 });
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const instance = await asFeedCaller(user.id, clientId, () =>
      createImportInstance(file.name, file.type || 'application/octet-stream', bytes, clientId),
    );
    return NextResponse.json(instance);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be stored' }, { status: 400 });
  }
}
