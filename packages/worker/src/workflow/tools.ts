import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerComplianceTools } from '@tapestrai/mcp-server/src/tools/compliance-tools';
import { registerDomainTools } from '@tapestrai/mcp-server/src/tools/domain-tools';
import { registerDQTools } from '@tapestrai/mcp-server/src/tools/dq-tools';
import { registerImportMapTools } from '@tapestrai/mcp-server/src/tools/import-map-tools';
import { registerLineageTools } from '@tapestrai/mcp-server/src/tools/lineage-tools';
import { registerNarrativeTools } from '@tapestrai/mcp-server/src/tools/narrative-tools';
import { registerOverrideTools } from '@tapestrai/mcp-server/src/tools/override-tools';
import { registerPositionFileTools } from '@tapestrai/mcp-server/src/tools/position-file-tools';
import { registerQueryTools } from '@tapestrai/mcp-server/src/tools/query-data';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { registerSpecialistTools } from '@tapestrai/mcp-server/src/tools/specialist-tools';
import type { FoundationAttribute } from '@tapestrai/graphql/src/lib/workflow-proposal';
import type { ToolSpec } from './agent';
import type { Actor, ToolRunner } from './engine';

/**
 * The platform's tools, for workflow steps. These are the same tools the chat
 * assistant uses.
 *
 * A step never runs a tool as the worker. The worker's service key cannot read
 * the data schemas at all, and it should not: what a step may see is decided by
 * who it runs for. Each call is made with a short-lived token for that person
 * (the run's owner for reads, the reviewer for the changes they approved), so
 * tenancy and row security apply exactly as they do when that person is signed in.
 *
 * Signing that token needs the project's JWT secret, SUPABASE_JWT_SECRET.
 */

export interface ToolEnv {
  url: string;
  anonKey: string;
  jwtSecret: string;
}

const TOKEN_SECONDS = 15 * 60;
const MEMBER_CHECK_MS = 60_000;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** A Supabase access token for one person, signed with the project's JWT secret. */
export function userToken(userId: string, secret: string, now: number = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', iat: issued, exp: issued + TOKEN_SECONDS }));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function buildRegistry(): ToolRegistry {
  // The registry's own client is never used: every call passes the acting person's client.
  const registry = new ToolRegistry(null as unknown as SupabaseClient);
  registerDomainTools(registry);
  registerLineageTools(registry);
  registerOverrideTools(registry);
  registerDQTools(registry);
  registerImportMapTools(registry);
  registerPositionFileTools(registry);
  registerSpecialistTools(registry);
  registerComplianceTools(registry);
  registerReportingTools(registry);
  registerQueryTools(registry);
  registerNarrativeTools(registry);
  return registry;
}

export function toolSpecs(registry: ToolRegistry): ToolSpec[] {
  return (registry.listTools() as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: {}, ...tool.inputSchema },
  }));
}

export type WorkflowTools = ToolRunner & {
  specs(): ToolSpec[];
  foundation(args: Record<string, unknown>, actor: Actor): Promise<FoundationAttribute[]>;
};

export function workflowTools(service: SupabaseClient, env: ToolEnv, registry: ToolRegistry = buildRegistry()): WorkflowTools {
  const specs = toolSpecs(registry);
  const names = new Set(specs.map((tool) => tool.name));
  const checked = new Map<string, number>();

  /** Refuses when the person can no longer act for the client. Asked again after a minute. */
  async function assertMember(actor: Actor, permission: string): Promise<string> {
    if (!actor.userId) throw new Error('This step has no person to run as. Start the run from the app, or from a schedule someone owns.');
    const key = `${actor.userId}:${actor.clientId}:${permission}`;
    if ((checked.get(key) || 0) > Date.now()) return actor.userId;
    const { data, error } = await service.rpc('workflow_worker_member', { p_user_id: actor.userId, p_client_id: actor.clientId, p_permission: permission });
    if (error) throw new Error(error.message);
    if (typeof data === 'string' && data) throw new Error(data);
    checked.set(key, Date.now() + MEMBER_CHECK_MS);
    return actor.userId;
  }

  function clientFor(userId: string): SupabaseClient {
    if (!env.jwtSecret) {
      throw new Error('The worker has no SUPABASE_JWT_SECRET, so it cannot act as a person. Set it to the project\'s JWT secret. See docs/WORKFLOWS.md.');
    }
    return createClient(env.url, env.anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken(userId, env.jwtSecret)}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async function run(name: string, args: Record<string, unknown>, actor: Actor, permission: string): Promise<unknown> {
    if (!names.has(name)) throw new Error(`There is no tool called "${name}".`);
    const userId = await assertMember(actor, permission);
    return registry.executeTool(name, args, clientFor(userId));
  }

  return {
    names: () => names,
    specs: () => specs,
    run,
    async foundation(args, actor) {
      const templateCode = typeof args.templateCode === 'string' ? args.templateCode : '';
      const domainCode = typeof args.domainCode === 'string' ? args.domainCode : '';
      if (!templateCode && !domainCode) return [];
      try {
        const result = (await run('get_template_metadata', templateCode ? { templateCodes: [templateCode] } : { domainCode }, actor, 'entity.read')) as {
          templates?: Array<{ template_attribute_assignments?: Array<Record<string, any>> }>;
        };
        // Without a template code a domain may have several templates. Only what
        // every one of them requires is certain to be required here.
        const templates = result.templates || [];
        if (templates.length === 0) return [];
        const byCode = new Map<string, FoundationAttribute & { count: number }>();
        for (const template of templates) {
          for (const assignment of template.template_attribute_assignments || []) {
            if (!assignment.attribute_code || assignment.is_required !== true) continue;
            const seen = byCode.get(assignment.attribute_code);
            if (seen) seen.count += 1;
            else {
              byCode.set(assignment.attribute_code, {
                code: assignment.attribute_code,
                name: assignment.display_label || assignment.attribute_name || assignment.attribute_code,
                dataType: assignment.attribute_register?.data_type,
                required: true,
                count: 1,
              });
            }
          }
        }
        return [...byCode.values()].filter((attribute) => attribute.count === templates.length).map(({ count: _count, ...attribute }) => attribute);
      } catch {
        // The check adds questions. If it cannot run, the proposal still goes to review as the agent wrote it.
        return [];
      }
    },
  };
}
