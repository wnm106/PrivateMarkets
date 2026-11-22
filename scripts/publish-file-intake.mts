/**
 * Publishes a workflow for one client from its template: File intake unless
 * another template code is given (NAV_RECONCILIATION, DATA_CLEANUP, ...).
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node --experimental-strip-types scripts/publish-file-intake.mts <client code> [template code]
 *
 * The first run creates the workflow. A later run saves the template as a new
 * version of it and publishes that, which is how a client picks up a step added
 * to the template. Runs already started keep the version they started on.
 */

import { WORKFLOW_TEMPLATES } from '../packages/graphql/src/lib/workflow-templates.ts';

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const clientCode = process.argv[2] || '';
const templateCode = process.argv[3] || 'FILE_INTAKE';
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
if (!clientCode) throw new Error('Pass the client code.');

const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed ? String(parsed.message) : text;
    throw new Error(`${name} failed: ${message}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.code === templateCode);
  if (!template) throw new Error(`There is no template ${templateCode}. Templates: ${WORKFLOW_TEMPLATES.map((candidate) => candidate.code).join(', ')}.`);
  const clients = (await fetch(`${url}/rest/v1/tenant_clients?select=id,client_code&client_code=eq.${encodeURIComponent(clientCode)}`, { headers }).then((response) => response.json())) as Array<{ id: string }>;
  const clientId = clients[0]?.id;
  if (!clientId) throw new Error(`There is no client with the code ${clientCode}.`);

  const existing = ((await rpc('workflow_list', {})) as Array<{ id: string; workflow_code: string; client_id: string | null }>)
    .find((row) => row.workflow_code === template.code && row.client_id === clientId);
  const saved = (await rpc('workflow_save', {
    p_id: existing?.id || null,
    p_client_id: clientId,
    p_code: template.code,
    p_name: template.name,
    p_description: template.description,
    p_graph: template.graph,
    p_change_note: existing ? `Updated from the ${template.name} template` : `Started from the ${template.name} template`,
  })) as { id: string; latest_version: number };
  await rpc('workflow_publish', { p_id: saved.id, p_version: saved.latest_version });
  console.log(`${existing ? 'Updated' : 'Created'} ${template.name} for ${clientCode}: version ${saved.latest_version} is published (${saved.id}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
