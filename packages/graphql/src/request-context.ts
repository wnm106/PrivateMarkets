/**
 * The context every GraphQL request runs with, for both entry points: the web
 * app's /api/graphql (apps/web) and the Workers API (apps/api). One builder, so
 * the two cannot drift in who the caller is or which client they hold.
 *
 * - `supabase` carries the caller's own JWT, so row security decides what they
 *   see. `supabaseAdmin` holds the service role, for the few audited calls that
 *   need it.
 * - `user.role` comes from app_metadata, which only the server can set. Never
 *   from user_metadata: any signed-in user can change their own user_metadata.
 *   Permissions are decided in the database (tenancy roles), not by this field.
 * - `config` hands resolvers the Supabase address and service key the entry
 *   point was given. On Workers they arrive on `env`, not process.env.
 */

import { createClient } from '@supabase/supabase-js';
import { GraphQLError } from 'graphql';
import { clientIp, ipRefusal } from './lib/client-ip';
import type { Context, User } from './context';

export interface RequestContextConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey?: string;
}

const ROLES: ReadonlyArray<User['role']> = ['admin', 'steward', 'ops', 'governance', 'readonly'];

/** The caller's role from server-set app_metadata, or readonly. */
export function roleFromAppMetadata(appMetadata: unknown): User['role'] {
  const role = (appMetadata as { role?: unknown } | null | undefined)?.role;
  return ROLES.includes(role as User['role']) ? (role as User['role']) : 'readonly';
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.substring(7) : null;
}

/**
 * CORS for both entry points. Callers send a bearer token, never a cookie, so
 * no request needs credentials: a page on another origin cannot make the
 * browser attach the caller's token for it.
 */
export const GRAPHQL_CORS = {
  origin: '*',
  credentials: false,
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

export async function createRequestContext(request: Request, config: RequestContextConfig): Promise<Context> {
  const token = bearerToken(request);
  const options = { auth: { autoRefreshToken: false, persistSession: false } };
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    ...options,
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const supabaseAdmin = config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, options)
    : null;

  let user: User | null = null;
  const ip = clientIp(request.headers);
  if (token) {
    const { data } = await supabase.auth.getUser(token);
    const authUser = data?.user;
    if (authUser) {
      user = {
        id: authUser.id,
        email: authUser.email || '',
        role: roleFromAppMetadata(authUser.app_metadata),
        metadata: authUser.user_metadata,
      };
      // A client that lists its networks is used only from them (20261126150000_ip_allowlist).
      const refusal = await ipRefusal(supabase, authUser.id, ip);
      if (refusal) throw new GraphQLError(refusal, { extensions: { code: 'FORBIDDEN', http: { status: 403 } } });
    }
  }

  return {
    supabase,
    supabaseAdmin,
    user,
    requestId: crypto.randomUUID(),
    loaders: {} as Context['loaders'],
    config: { supabaseUrl: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey || '' },
    clientIp: ip,
  };
}
