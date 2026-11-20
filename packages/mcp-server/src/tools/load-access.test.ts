import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { registerPositionFileTools } from './position-file-tools';
import { registerSpecialistTools } from './specialist-tools';
import {
  FeedAccessError,
  LOAD_PROMOTE_REFUSED,
  LOAD_WRITE_REFUSED,
  SEVERAL_CLIENTS_MESSAGE,
  clientIdsFromRows,
  soleClientId,
} from '../feeds/session-client';

/**
 * The load tools hand their work to code that writes with the service role.
 * Before any of it runs, the database is asked, as the caller, which client
 * they are in and what they may do there. A caller the database turns down
 * never reaches the loader.
 */

type Rpc = { name: string; args: any };

/** A caller's client: their clients, and the permissions they hold in each. */
function caller(clientIds: string[], permissions: string[]) {
  const rpcs: Rpc[] = [];
  const client: any = {
    schema: () => client,
    rpc: async (name: string, args: any) => {
      rpcs.push({ name, args });
      if (name === 'current_client_ids') return { data: clientIds.map((id) => ({ current_client_ids: id })), error: null };
      if (name === 'has_permission') return { data: clientIds.includes(args.p_client_id) && permissions.includes(args.p_permission_code), error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: () => {
      throw new Error('A tool read a table with the caller\'s client before its check');
    },
  };
  return { client, rpcs };
}

function registry() {
  const r = new ToolRegistry();
  registerPositionFileTools(r);
  registerSpecialistTools(r);
  return r;
}

/** What the loader says when it is reached without a service key: proof the check let the call through. */
const REACHED_LOADER = /service role key are required/;

const VIEWER: string[] = ['entity.read'];
const STEWARD = ['entity.read', 'entity.write'];
const ADMIN = ['entity.read', 'entity.write', 'load.promote'];

/** Tools that write live records, and the arguments each needs to get that far. */
const LIVE_LOADS: Array<[string, Record<string, unknown>]> = [
  ['process_position_file_import', { instanceId: 'i1' }],
  ['load_position_file_table', { instanceId: 'i1', columnMappings: [], asOfDate: '2026-09-30' }],
  ['run_load_session', { sessionId: 's1' }],
  ['promote_load_batch', { batchId: 'b1' }],
  ['revert_load_batch', { batchId: 'b1' }],
];

/** Tools that store or change a file or a staged batch, but no live record. */
const STAGING_WRITES: Array<[string, Record<string, unknown>]> = [
  ['create_position_file_import', { fileName: 'a.csv', csvText: 'Code\nA' }],
  ['update_position_file_import', { instanceId: 'i1', columnMappings: [] }],
  ['stage_position_file_import', { instanceId: 'i1' }],
  ['discard_load_batch', { batchId: 'b1' }],
  ['start_load_session', { fileName: 'a.csv', csvText: 'Code\nA' }],
  ['save_source_map', { sessionId: 's1' }],
];

async function refusal(promise: Promise<unknown>): Promise<FeedAccessError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FeedAccessError) return error;
    throw error;
  }
  throw new Error('The call was not refused');
}

describe('load tools ask the database about the caller before the loader runs', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_URL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(LIVE_LOADS)('%s needs load.promote: a viewer and a data steward are refused with 403', async (name, args) => {
    for (const permissions of [VIEWER, STEWARD]) {
      const { client, rpcs } = caller(['c1'], permissions);
      const error = await refusal(registry().executeTool(name, args, client));
      expect(error.status).toBe(403);
      expect(error.message).toBe(LOAD_PROMOTE_REFUSED);
      expect(rpcs).toContainEqual({ name: 'has_permission', args: { p_client_id: 'c1', p_permission_code: 'load.promote' } });
    }
  });

  it.each(LIVE_LOADS)('%s goes ahead for someone who holds load.promote', async (name, args) => {
    const { client } = caller(['c1'], ADMIN);
    await expect(registry().executeTool(name, args, client)).rejects.toThrow(REACHED_LOADER);
  });

  it.each(STAGING_WRITES)('%s needs entity.write: a viewer is refused with 403', async (name, args) => {
    const { client } = caller(['c1'], VIEWER);
    const error = await refusal(registry().executeTool(name, args, client));
    expect(error.status).toBe(403);
    expect(error.message).toBe(LOAD_WRITE_REFUSED);
  });

  it.each([...LIVE_LOADS, ...STAGING_WRITES])('%s refuses someone in more than one client instead of choosing one', async (name, args) => {
    const { client, rpcs } = caller(['c2', 'c1'], ADMIN);
    const error = await refusal(registry().executeTool(name, args, client));
    expect(error.status).toBe(400);
    expect(error.message).toBe(SEVERAL_CLIENTS_MESSAGE);
    expect(rpcs.some((rpc) => rpc.name === 'has_permission')).toBe(false);
  });
});

describe('which client a session is in', () => {
  it('reads the ids in a fixed order, whatever order the database returns them in', () => {
    expect(clientIdsFromRows([{ current_client_ids: 'b' }, 'a', { current_client_ids: 'b' }])).toEqual(['a', 'b']);
    expect(clientIdsFromRows(null)).toEqual([]);
  });

  it('names the only client, and no client when there are several', async () => {
    expect(await soleClientId(caller(['c1'], VIEWER).client)).toBe('c1');
    expect(await soleClientId(caller(['c1', 'c2'], VIEWER).client)).toBeNull();
    expect(await soleClientId(caller([], VIEWER).client)).toBeNull();
  });
});
