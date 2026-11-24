import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerBorrowerTools } from '@tapestrai/mcp-server/src/tools/borrower-tools';
import { registerComplianceTools } from '@tapestrai/mcp-server/src/tools/compliance-tools';
import { registerDocumentTools } from '@tapestrai/mcp-server/src/tools/document-tools';
import { registerDomainTools } from '@tapestrai/mcp-server/src/tools/domain-tools';
import { registerDqCheckTools } from '@tapestrai/mcp-server/src/tools/dq-check-tools';
import { registerDQTools } from '@tapestrai/mcp-server/src/tools/dq-tools';
import { registerImportMapTools } from '@tapestrai/mcp-server/src/tools/import-map-tools';
import { registerLineageTools } from '@tapestrai/mcp-server/src/tools/lineage-tools';
import { registerListTools } from '@tapestrai/mcp-server/src/tools/list-tools';
import { registerNarrativeTools } from '@tapestrai/mcp-server/src/tools/narrative-tools';
import { registerOverrideTools } from '@tapestrai/mcp-server/src/tools/override-tools';
import { registerPositionFileTools } from '@tapestrai/mcp-server/src/tools/position-file-tools';
import { registerQueryTools } from '@tapestrai/mcp-server/src/tools/query-data';
import { registerRecTools } from '@tapestrai/mcp-server/src/tools/rec-tools';
import { registerNavReportTools } from '@tapestrai/mcp-server/src/tools/nav-report-tools';
import { registerSelectionTools } from '@tapestrai/mcp-server/src/tools/selection-tools';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { registerSpecialistTools } from '@tapestrai/mcp-server/src/tools/specialist-tools';
import { LIST_VALUE_TOOL, type FoundationAttribute, type ListValue } from '@tapestrai/graphql/src/lib/workflow-proposal';
import type { ToolSpec } from './agent';
import type { Actor, ToolNeed, ToolRunner } from './engine';

/**
 * The platform's tools, for workflow steps. These are the same tools the chat
 * assistant uses.
 *
 * Every call runs as the client's workflow service account: a user that is not
 * a person, belongs to that one client, and holds the Workflow Service role.
 * The worker's own service key is not used for data. It cannot read the data
 * schemas, and it would see every client at once. Running as an account that
 * belongs to one client keeps a run inside its client, under the same row
 * security as anyone signed in.
 *
 * The worker gets the account a session from Supabase Auth, using the service
 * key it already holds. No signing secret is kept, and no real person is ever
 * signed in for.
 *
 * People are checked by lookup, not by signing in as them. Whoever is behind a
 * step (the person who started the run, or who approved the change) must hold
 * the permissions that step needs, and must be able to reach each record the
 * call names: the account may see records a person's entity grants keep from
 * them, so its reach is not theirs.
 */

export interface ToolEnv {
  url: string;
  anonKey: string;
}

/** What the person behind each kind of call must hold. */
const NEEDS: Record<ToolNeed, string[]> = {
  read: ['workflow.run'],
  write: ['workflow.run', 'entity.write'],
  apply: ['workflow.review', 'entity.write'],
};

/**
 * Tools that write live records from a load. The service account holds
 * load.promote, so the person behind the call must too, as on the web routes
 * that do the same.
 */
const LOAD_PROMOTE_TOOLS = new Set(['promote_load_batch', 'revert_load_batch', 'process_position_file_import', 'load_position_file_table', 'run_load_session']);

/** What the person behind a call to this tool must hold, for this kind of call. */
export function permissionsFor(name: string, need: ToolNeed): string[] {
  return LOAD_PROMOTE_TOOLS.has(name) ? [...NEEDS[need], 'load.promote'] : NEEDS[need];
}

/** Tool settings that hold the reason for a change. A change is signed there with the person it was made for. */
const REASON_KEYS = ['overrideReason', 'resolutionNotes', 'note', 'reason'];

/**
 * Settings that name a record, by id or by code, at any depth (a list of
 * members names each one). A record id is a UUID; anything else in an id
 * setting (fundId takes a fund code too) is checked as a code.
 */
const RECORD_ID_KEY = /(?:entity|security|fund)ids?$/i;
const RECORD_CODE_KEY = /(?:entity|security|fund)codes?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERSON_CHECK_MS = 60_000;
/** A session is replaced this long before it expires, so a long step does not outlive it. */
const SESSION_MARGIN_MS = 5 * 60_000;
const NO_SESSION = { auth: { autoRefreshToken: false, persistSession: false } } as const;

export function buildRegistry(): ToolRegistry {
  // The registry keeps no client. Every call below passes the one it runs as.
  const registry = new ToolRegistry();
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
  registerListTools(registry);
  registerDqCheckTools(registry);
  registerRecTools(registry);
  registerNavReportTools(registry);
  registerSelectionTools(registry);
  registerDocumentTools(registry);
  registerBorrowerTools(registry);
  return registry;
}

export function toolSpecs(registry: ToolRegistry): ToolSpec[] {
  return (registry.listTools() as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: {}, ...tool.inputSchema },
  }));
}

/** The records a tool call names: their ids, and the codes of any named by code. */
export function namedRecords(args: unknown): { ids: string[]; codes: string[] } {
  const ids = new Set<string>();
  const codes = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const byId = RECORD_ID_KEY.test(key);
      if (byId || RECORD_CODE_KEY.test(key)) {
        for (const entry of Array.isArray(item) ? item : [item]) {
          const text = typeof entry === 'string' || typeof entry === 'number' ? String(entry).trim() : '';
          if (text) (byId && UUID.test(text) ? ids : codes).add(text);
        }
      }
      visit(item, depth + 1);
    }
  };
  visit(args, 0);
  return { ids: [...ids], codes: [...codes] };
}

/** Adds who a change was made for, or who approved it, to the tool's own reason field, when it has one. */
export function signReason(spec: ToolSpec | undefined, args: Record<string, unknown>, signature: string): Record<string, unknown> {
  const properties = (spec?.inputSchema.properties || {}) as Record<string, unknown>;
  const key = REASON_KEYS.find((candidate) => candidate in properties);
  if (!key) return args;
  const current = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  return { ...args, [key]: current ? `${current} ${signature}` : signature };
}

export type WorkflowTools = ToolRunner & {
  specs(): ToolSpec[];
  foundation(args: Record<string, unknown>, actor: Actor): Promise<FoundationAttribute[]>;
  /** The values an attribute accepts, or null when it takes any value. */
  listValues(attributeCode: string, actor: Actor): Promise<ListValue[] | null>;
};

interface Session {
  client: SupabaseClient;
  expiresAt: number;
}

export interface SessionSource {
  /** An access token for the user, and when it expires (ms since epoch). */
  (userId: string): Promise<{ token: string; expiresAt: number }>;
}

/** Gets a user a session from Supabase Auth with the service key. Used only for workflow service accounts. */
export function adminSessions(service: SupabaseClient, env: ToolEnv): SessionSource {
  return async (userId) => {
    const found = await service.auth.admin.getUserById(userId);
    const email = found.data?.user?.email;
    if (found.error || !email) throw new Error(`The workflow service account could not be read. ${found.error?.message || 'It has no email address.'}`);
    // Generates the sign-in token without sending any email.
    const link = await service.auth.admin.generateLink({ type: 'magiclink', email });
    const hash = link.data?.properties?.hashed_token;
    if (link.error || !hash) throw new Error(`A session for the workflow service account could not be started. ${link.error?.message || ''}`.trim());
    const verified = await createClient(env.url, env.anonKey, NO_SESSION).auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    const session = verified.data?.session;
    if (verified.error || !session) throw new Error(`A session for the workflow service account could not be started. ${verified.error?.message || ''}`.trim());
    return { token: session.access_token, expiresAt: (session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000 };
  };
}

export function workflowTools(
  service: SupabaseClient,
  env: ToolEnv,
  registry: ToolRegistry = buildRegistry(),
  sessions: SessionSource = adminSessions(service, env),
): WorkflowTools {
  const specs = toolSpecs(registry);
  const byName = new Map(specs.map((tool) => [tool.name, tool]));
  const names = new Set(byName.keys());
  const people = new Map<string, { until: number; name: string | null; tenantAdmin: boolean }>();
  const accounts = new Map<string, Promise<Session>>();

  /** Refuses when the person behind the call does not hold what it needs. Asked again after a minute. */
  async function personFor(actor: Actor, permissions: string[]): Promise<{ name: string | null; tenantAdmin: boolean }> {
    const key = `${actor.userId}:${actor.clientId}:${permissions.join(',')}`;
    const known = people.get(key);
    if (known && known.until > Date.now()) return known;
    const { data, error } = await service.rpc('workflow_worker_person', { p_user_id: actor.userId, p_client_id: actor.clientId, p_permissions: permissions });
    if (error) throw new Error(error.message);
    const result = (data || {}) as { problem?: string; name?: string | null; tenantAdmin?: boolean };
    if (result.problem) throw new Error(result.problem);
    const person = { until: Date.now() + PERSON_CHECK_MS, name: result.name || null, tenantAdmin: result.tenantAdmin === true };
    people.set(key, person);
    return person;
  }

  /**
   * Refuses when the person behind the call cannot reach a record it names: see
   * it, for a read, or change it, for a write or an approved change. Asked as
   * the person, through tenancy.has_entity_access, so their entity grants
   * apply. Every call is asked, because each names its own records.
   */
  async function assertRecordAccess(name: string, args: Record<string, unknown>, actor: Actor, need: ToolNeed): Promise<void> {
    const { ids, codes } = namedRecords(args);
    if (ids.length === 0 && codes.length === 0) return;
    const level = need === 'read' ? 'READ' : 'WRITE';
    const { data, error } = await service.rpc('workflow_worker_entity_access', {
      p_user_id: actor.userId,
      p_client_id: actor.clientId,
      p_level: level,
      p_entity_ids: ids,
      p_entity_codes: codes,
    });
    // Without an answer the call does not run: the service account's reach is wider than the person's.
    if (error) throw new Error(`"${name}" was not run: the records it names could not be checked against what the person behind this step may reach. ${error.message}`);
    const result = (data || {}) as { problem?: unknown; denied?: unknown };
    if (typeof result.problem === 'string' && result.problem) throw new Error(result.problem);
    if (typeof result.denied !== 'number') throw new Error(`"${name}" was not run: the records it names could not be checked against what the person behind this step may reach.`);
    if (result.denied > 0) {
      const what = result.denied === 1 && ids.length + codes.length === 1 ? 'the record' : result.denied === 1 ? 'one of the records' : `${result.denied} of the records`;
      throw new Error(`"${name}" was not run: the person behind this step may not ${level === 'READ' ? 'see' : 'change'} ${what} it names.`);
    }
  }

  /** A client for the service account of this client. The session is kept until shortly before it expires. */
  async function accountClient(clientId: string): Promise<SupabaseClient> {
    if (!env.url || !env.anonKey) throw new Error('The worker needs SUPABASE_URL and SUPABASE_ANON_KEY to run workflow steps.');
    const current = accounts.get(clientId);
    if (current) {
      try {
        const session = await current;
        if (session.expiresAt - SESSION_MARGIN_MS > Date.now()) return session.client;
      } catch {
        // The last attempt failed. Try again below.
      }
    }
    const started = (async (): Promise<Session> => {
      // Asked every time a session starts, so an account removed from the client stops working within the hour.
      const { data, error } = await service.rpc('workflow_worker_service_account', { p_client_id: clientId });
      if (error) throw new Error(error.message);
      const account = (data || {}) as { userId?: string; problem?: string };
      if (account.problem || !account.userId) throw new Error(account.problem || 'This client has no workflow service account.');
      const { token, expiresAt } = await sessions(account.userId);
      const client = createClient(env.url, env.anonKey, { ...NO_SESSION, global: { headers: { Authorization: `Bearer ${token}` } } });
      return { client, expiresAt };
    })();
    accounts.set(clientId, started);
    return (await started).client;
  }

  async function run(name: string, args: Record<string, unknown>, actor: Actor, need: ToolNeed, runId?: string): Promise<unknown> {
    if (!names.has(name)) throw new Error(`There is no tool called "${name}".`);
    const person = await personFor(actor, permissionsFor(name, need));
    await assertRecordAccess(name, args, actor, need);
    if (name === LIST_VALUE_TOOL) {
      // A list is shared by every client, and only a tenant admin may change one.
      // The service account is not one, so this single change is made with the
      // worker's own key, and only when a tenant admin approved it.
      if (need !== 'apply') throw new Error('A value is added to a shared list only as a change a reviewer approved.');
      if (!person.tenantAdmin) throw new Error('Adding a value to a shared list needs a tenant admin to approve it. Lists are shared by every client.');
      return registry.executeTool(name, args, service);
    }
    const client = await accountClient(actor.clientId);
    // The record's own history shows the service account. The reason says who the change was for:
    // the reviewer who approved it, or the person who started the run a fixed step changed it in.
    const where = runId ? ` in workflow run ${runId}` : '';
    const finalArgs =
      need === 'apply'
        ? signReason(byName.get(name), args, `Approved by ${person.name || 'a reviewer'}${where}.`)
        : need === 'write'
          ? signReason(byName.get(name), args, `Made by a workflow step for ${person.name || 'the person who started the run'}${where}.`)
          : args;
    return registry.executeTool(name, finalArgs, client);
  }

  return {
    names: () => names,
    specs: () => specs,
    run,
    async listValues(attributeCode, actor) {
      const result = (await run('get_attribute_list_values', { attributeCode }, actor, 'read')) as { hasList?: boolean; values?: ListValue[] };
      return result.hasList && Array.isArray(result.values) ? result.values : null;
    },
    async foundation(args, actor) {
      const templateCode = typeof args.templateCode === 'string' ? args.templateCode : '';
      const domainCode = typeof args.domainCode === 'string' ? args.domainCode : '';
      if (!templateCode && !domainCode) return [];
      try {
        const result = (await run('get_template_metadata', templateCode ? { templateCodes: [templateCode] } : { domainCode }, actor, 'read')) as {
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
