/**
 * Publishes the demo briefs on Bill McMahon's client and starts one run of each.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/publish-bill-demo-workflows.mts
 *
 * A second run skips a brief that already has a queued, running, waiting, or
 * succeeded run, so this can be repeated without stacking work.
 */

import { DEMO_WORKFLOWS } from '../packages/graphql/src/lib/workflow-templates.ts';

const BILL_USER_ID = 'd90bbd56-a5bb-4dfc-ae50-b6e1171585a4';
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED']);

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed ? String(parsed.message) : text;
    throw new Error(`${name} failed: ${message}`);
  }
  return parsed;
}

interface Listed {
  id: string;
  workflow_code: string;
  published_version: number | null;
}

interface RunRow {
  workflow_id: string;
  status: string;
}

async function main(): Promise<void> {
  const clients = (await fetch(`${url}/rest/v1/tenant_clients?select=id,client_code&client_code=eq.BILL_MCMahON`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  }).then((response) => response.json())) as Array<{ id: string; client_code: string }>;
  const clientId = clients[0]?.id;
  if (!clientId) throw new Error('Bill McMahon has no client.');

  const existing = (await rpc('workflow_list', {})) as Listed[];
  const byCode = new Map(existing.map((row) => [row.workflow_code, row]));
  const started: string[] = [];

  for (const template of DEMO_WORKFLOWS) {
    let row = byCode.get(template.code);
    if (!row) {
      const saved = (await rpc('workflow_save', {
        p_id: null,
        p_client_id: clientId,
        p_code: template.code,
        p_name: template.name,
        p_description: template.description,
        p_graph: template.graph,
        p_change_note: 'Demo brief for Bill McMahon',
      })) as { id: string; latest_version: number };
      await rpc('workflow_publish', { p_id: saved.id, p_version: saved.latest_version });
      row = { id: saved.id, workflow_code: template.code, published_version: saved.latest_version };
      byCode.set(template.code, row);
    }

    const runs = (await rpc('workflow_runs_list', { p_workflow_id: row.id, p_limit: 20 })) as RunRow[];
    if (runs.some((run) => ACTIVE.has(run.status))) {
      started.push(`${template.code} already running`);
      continue;
    }
    const runId = await rpc('workflow_run_start', {
      p_workflow_id: row.id,
      p_client_id: clientId,
      p_input: template.inputExample,
      p_user_id: BILL_USER_ID,
    });
    started.push(`${template.code} ${runId}`);
  }

  console.log(started.join('\n'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
