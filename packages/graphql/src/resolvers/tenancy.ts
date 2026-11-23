import { Context } from '../context';
import {
  assertIdentityProviderInput,
  normalizeEmailDomains,
  oidcIdentifier,
  removeRegisteredProvider,
  syncIdentityProvider,
  toIdentityProviderRow,
  type IdentityProviderKind,
} from '../lib/enterprise-sso';
import { requireUuid } from '../lib/input-guards';
import { ok } from '../lib/db-result';

// Always the caller's JWT. The service role bypasses row level security, so
// tenancy reads and writes go through `supabase` and Postgres policies.
// `supabaseAdmin` is reserved for auth.admin invite lookups.
/**
 * The Supabase address and service key for SSO registration. From the entry
 * point's own config (on Workers they are on `env`, not process.env), else the
 * Node process environment.
 */
function serviceConfig(context: Context): { supabaseUrl: string; serviceRoleKey: string } {
  return {
    supabaseUrl: context.config?.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    serviceRoleKey: context.config?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

function tn(context: Context) {
  return context.supabase.schema('tenancy');
}

const ADMIN_PERMISSIONS = ['user.manage', 'role.manage', 'entity_access.manage', 'client.manage'];

function collectAccess(roleRows: any[] | null, isTenantAdmin: boolean) {
  const permissionCodes = new Set<string>();
  for (const row of roleRows || []) {
    for (const rp of (row as any).role?.role_permissions || []) {
      if (rp.permission?.permission_code) permissionCodes.add(rp.permission.permission_code);
    }
  }
  const canManageEntityAccess = isTenantAdmin || permissionCodes.has('entity_access.manage');
  const canAccessAdmin = isTenantAdmin || ADMIN_PERMISSIONS.some((code) => permissionCodes.has(code));
  return { canAccessAdmin, canManageEntityAccess };
}

/** Refuses a role that belongs to a different client. A role with no client is shared by all. */
async function assertRolesForClient(context: Context, clientId: string, roleIds: string[]) {
  const ids = [...new Set(roleIds)];
  if (!ids.length) return;
  ids.forEach((id) => requireUuid(id, 'roleId'));
  const { data, error } = await tn(context).from('roles').select('id, client_id').in('id', ids);
  if (error) throw error;
  const found = new Map((data || []).map((row: any) => [row.id, row.client_id ?? null]));
  for (const id of ids) {
    if (!found.has(id)) throw new Error('That role was not found.');
    const owner = found.get(id);
    if (owner !== null && owner !== clientId) throw new Error('That role belongs to a different client.');
  }
}

/** Finds an existing account by email. listUsers returns one page at a time. */
async function findUserIdByEmail(admin: NonNullable<Context['supabaseAdmin']>, email: string): Promise<string | null> {
  const wanted = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 1000; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    const match = users.find((user) => user.email?.toLowerCase() === wanted);
    if (match) return match.id;
    if (users.length < perPage) return null;
  }
  return null;
}

async function callerMayInvite(context: Context, clientId: string) {
  const [{ data: allowed, error: allowedError }, { data: admin, error: adminError }] = await Promise.all([
    tn(context).rpc('has_permission', { p_client_id: clientId, p_permission_code: 'user.manage' }),
    tn(context).rpc('is_tenant_admin'),
  ]);
  if (allowedError) throw allowedError;
  if (adminError) throw adminError;
  return Boolean(allowed) || Boolean(admin);
}

export const tenancyResolvers = {
  Query: {
    me: async (_: any, __: any, context: Context) => {
      if (!context.user) {
        throw new Error('Not authenticated');
      }

      const [{ data: profile }, { data: clientUsers }, { data: impersonation }, { data: roleRows }] = await Promise.all([
        tn(context).from('profiles').select('*').eq('id', context.user.id).maybeSingle(),
        tn(context).from('client_users').select('client:clients(*)').eq('user_id', context.user.id).eq('is_active', true),
        tn(context)
          .from('impersonation_sessions')
          .select('*, client:clients(client_name)')
          .eq('admin_user_id', context.user.id)
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        tn(context)
          .from('user_roles')
          .select('role:roles(role_permissions(permission:permissions(permission_code)))')
          .eq('user_id', context.user.id),
      ]);

      const isTenantAdmin = profile?.is_tenant_admin ?? false;
      const access = collectAccess(roleRows, isTenantAdmin);
      const modules = await moduleCodesByClient(context);

      return {
        id: context.user.id,
        email: context.user.email,
        displayName: profile?.display_name ?? null,
        isTenantAdmin,
        canAccessAdmin: access.canAccessAdmin,
        canManageEntityAccess: access.canManageEntityAccess,
        clients: (clientUsers || []).map((row: any) => mapClient(row.client, modules.get(row.client?.id) ?? [])).filter(Boolean),
        impersonating: impersonation
          ? {
              id: impersonation.id,
              clientId: impersonation.client_id,
              clientName: impersonation.client?.client_name ?? null,
              reason: impersonation.reason,
              startedAt: impersonation.started_at,
            }
          : null,
      };
    },

    clients: async (_: any, __: any, context: Context) => {
      const [{ data, error }, modules] = await Promise.all([
        tn(context).from('clients').select('*').order('client_name'),
        moduleCodesByClient(context),
      ]);
      if (error) throw error;
      return (data || []).map((row: any) => mapClient(row, modules.get(row.id) ?? []));
    },

    client: async (_: any, args: { id: string }, context: Context) => {
      const [{ data, error }, modules] = await Promise.all([
        tn(context).from('clients').select('*').eq('id', args.id).maybeSingle(),
        moduleCodesByClient(context),
      ]);
      if (error) throw error;
      return data ? mapClient(data, modules.get(data.id) ?? []) : null;
    },

    clientModuleCatalog: async (_: any, __: any, context: Context) => {
      const { data, error } = await tn(context)
        .from('module_catalog')
        .select('module_code, module_name, description, display_order, domain_codes, surface_codes, workflow_codes, tool_hrefs')
        .order('display_order');
      if (error) throw error;
      return (data || []).map(mapModule);
    },

    clientUsers: async (_: any, args: { clientId: string }, context: Context) => {
      const [{ data: members, error: membersError }, { data: clientUserRows, error: cuError }, { data: roleRows, error: roleError }] = await Promise.all([
        tn(context).rpc('client_member_directory', { p_client_id: args.clientId }),
        tn(context).from('client_users').select('id, user_id, is_active').eq('client_id', args.clientId),
        tn(context).from('user_roles').select('user_id, role:roles(*)').eq('client_id', args.clientId),
      ]);
      if (membersError) throw membersError;
      if (cuError) throw cuError;
      if (roleError) throw roleError;

      const rolesByUser = new Map<string, any[]>();
      for (const row of roleRows || []) {
        const list = rolesByUser.get(row.user_id) ?? [];
        if (row.role) list.push(mapRole(row.role));
        rolesByUser.set(row.user_id, list);
      }
      const clientUserIdByUser = new Map<string, { id: string; isActive: boolean }>();
      for (const row of clientUserRows || []) {
        clientUserIdByUser.set(row.user_id, { id: row.id, isActive: row.is_active });
      }

      return (members || []).map((m: any) => ({
        id: clientUserIdByUser.get(m.user_id)?.id ?? m.user_id,
        clientId: args.clientId,
        userId: m.user_id,
        isActive: clientUserIdByUser.get(m.user_id)?.isActive ?? m.client_user_is_active,
        profile: mapProfile({ id: m.user_id, email: m.email, display_name: m.display_name, is_tenant_admin: false, is_active: m.is_active }),
        roles: rolesByUser.get(m.user_id) ?? [],
      }));
    },

    roles: async (_: any, args: { clientId?: string }, context: Context) => {
      let query = tn(context).from('roles').select('*, role_permissions(permission:permissions(permission_code))');
      // The id goes into a filter string, so it must be an id and nothing else.
      query = args.clientId ? query.or(`client_id.is.null,client_id.eq.${requireUuid(args.clientId, 'clientId')}`) : query;
      const { data, error } = await query.order('role_name');
      if (error) throw error;
      return (data || []).map(mapRole);
    },

    permissionsCatalog: async (_: any, __: any, context: Context) => {
      const { data, error } = await tn(context).from('permissions').select('permission_code').order('permission_code');
      if (error) throw error;
      return (data || []).map((row: any) => row.permission_code);
    },

    entityGrants: async (_: any, args: { entityId: string }, context: Context) => {
      const { data, error } = await tn(context)
        .from('entity_grants')
        .select('*, grantee_user:profiles!entity_grants_user_id_fkey(display_name), grantee_role:roles!entity_grants_role_id_fkey(role_name)')
        .eq('entity_id', args.entityId);
      if (error) throw error;
      return (data || []).map(mapEntityGrant);
    },

    entityAccess: async (_: any, args: { entityId: string }, context: Context) => {
      if (!context.user) throw new Error('Not authenticated');
      const { data, error } = await tn(context).rpc('entity_access_rows', {
        p_client_id: await entityClientId(context, args.entityId),
        p_entity_id: args.entityId,
        p_search: null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      return row ? mapAccessRecord(row) : null;
    },

    entityAccessRoster: async (_: any, args: { clientId: string; search?: string | null }, context: Context) => {
      if (!context.user) throw new Error('Not authenticated');
      const { data, error } = await tn(context).rpc('entity_access_rows', {
        p_client_id: args.clientId,
        p_entity_id: null,
        p_search: args.search ?? null,
      });
      if (error) throw error;
      return (data || []).map(mapAccessRecord);
    },

    myPermissions: async (_: any, args: { clientId: string }, context: Context) => {
      const { data: rows, error: rowsError } = await tn(context)
        .from('user_roles')
        .select('role:roles(role_permissions(permission:permissions(permission_code)))')
        .eq('client_id', args.clientId)
        .eq('user_id', context.user?.id ?? '');
      if (rowsError) throw rowsError;
      const codes = new Set<string>();
      for (const row of rows || []) {
        for (const rp of (row as any).role?.role_permissions || []) {
          if (rp.permission?.permission_code) codes.add(rp.permission.permission_code);
        }
      }
      return Array.from(codes);
    },

    clientAuthRequirements: async (_: any, args: { clientId: string }, context: Context) => {
      const { data, error } = await tn(context)
        .from('client_auth_requirements')
        .select('client_id, password_enabled, mfa_required, email_domains')
        .eq('client_id', args.clientId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapAuthRequirements(data) : null;
    },

    clientIdentityProviders: async (_: any, args: { clientId: string }, context: Context) => {
      const { data, error } = await tn(context)
        .from('client_identity_providers')
        .select('id, client_id, provider, display_name, email_domain, azure_tenant_id, saml_metadata_url, oidc_issuer, oidc_client_id, oidc_identifier, sso_provider_id, registration_status, registration_error, is_enabled')
        .eq('client_id', args.clientId)
        .order('provider');
      if (error) throw error;
      return (data || []).map(mapIdentityProvider);
    },
  },

  Mutation: {
    createClient: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { data: clientId, error } = await tn(context).rpc('provision_client', {
          p_client_code: args.input.clientCode,
          p_client_name: args.input.clientName,
          p_admin_user_id: null,
        });
        if (error) throw error;
        if (args.input.curatedModules) {
          const { error: moduleError } = await tn(context).rpc('set_client_modules', {
            p_client_id: clientId,
            p_curated: true,
            p_module_codes: args.input.moduleCodes ?? [],
          });
          if (moduleError) throw moduleError;
        }
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },

    setClientModules: async (_: any, args: { clientId: string; curated: boolean; moduleCodes: string[] }, context: Context) => {
      try {
        const { error } = await tn(context).rpc('set_client_modules', {
          p_client_id: args.clientId,
          p_curated: args.curated,
          p_module_codes: args.moduleCodes ?? [],
        });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'MODULES_FAILED' }] };
      }
    },

    createRole: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { data: role, error } = await tn(context)
          .from('roles')
          .insert({
            client_id: args.input.clientId,
            role_code: args.input.roleCode,
            role_name: args.input.roleName,
            description: args.input.description ?? null,
          })
          .select()
          .single();
        if (error) throw error;

        if (args.input.permissionCodes?.length) {
          const { data: permissions } = ok(await tn(context).from('permissions').select('id, permission_code').in('permission_code', args.input.permissionCodes));
          const rows = (permissions || []).map((p: any) => ({ role_id: role.id, permission_id: p.id }));
          if (rows.length) {
            const { error: rpError } = await tn(context).from('role_permissions').insert(rows);
            if (rpError) throw rpError;
          }
        }

        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },

    // Invites a brand-new user by email (requires the service role --
    // auth.admin.* is the one legitimate use of supabaseAdmin here) and adds
    // them to the client with the requested roles. If the user already
    // exists, skip the invite and just (re)assign membership/roles.
    inviteUser: async (_: any, args: { input: any }, context: Context) => {
      try {
        if (!context.user) throw new Error('Not authenticated');
        requireUuid(args.input.clientId, 'clientId');
        if (!(await callerMayInvite(context, args.input.clientId))) {
          throw new Error('Not allowed to invite users');
        }
        await assertRolesForClient(context, args.input.clientId, args.input.roleIds || []);
        if (!context.supabaseAdmin) {
          throw new Error('User invitation requires SUPABASE_SERVICE_ROLE_KEY to be configured on the server');
        }
        const { data: authRules, error: authRulesError } = await tn(context)
          .from('client_auth_requirements')
          .select('password_enabled')
          .eq('client_id', args.input.clientId)
          .maybeSingle();
        if (authRulesError && !/client_auth_requirements|schema cache/i.test(authRulesError.message)) throw authRulesError;
        if (authRules && authRules.password_enabled === false) {
          throw new Error('This client requires single sign-on. People join when they sign in with the organization identity provider.');
        }

        let userId: string | null = null;
        const { data: invited, error: inviteError } = await context.supabaseAdmin.auth.admin.inviteUserByEmail(args.input.email);
        if (inviteError) {
          // Already-registered users return an error here; look them up instead, on every page.
          const existingId = await findUserIdByEmail(context.supabaseAdmin, String(args.input.email || ''));
          if (!existingId) throw inviteError;
          userId = existingId;
        } else {
          userId = invited.user?.id ?? null;
        }
        if (!userId) throw new Error('Could not resolve invited user id');

        // These two inserts run through the RLS-scoped client, so the caller
        // must actually hold `user.manage` for this client (or be a tenant admin).
        const { error: membershipError } = await tn(context)
          .from('client_users')
          .upsert({ client_id: args.input.clientId, user_id: userId, invited_by: context.user?.id }, { onConflict: 'client_id,user_id' });
        if (membershipError) throw membershipError;

        if (args.input.roleIds?.length) {
          const rows = args.input.roleIds.map((roleId: string) => ({
            client_id: args.input.clientId,
            user_id: userId,
            role_id: roleId,
            granted_by: context.user?.id,
          }));
          const { error: roleError } = await tn(context).from('user_roles').upsert(rows, { onConflict: 'client_id,user_id,role_id' });
          if (roleError) throw roleError;
        }

        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'INVITE_FAILED' }] };
      }
    },

    assignRole: async (_: any, args: { input: any }, context: Context) => {
      try {
        requireUuid(args.input.clientId, 'clientId');
        await assertRolesForClient(context, args.input.clientId, [args.input.roleId]);
        const { error } = await tn(context)
          .from('user_roles')
          .upsert(
            { client_id: args.input.clientId, user_id: args.input.userId, role_id: args.input.roleId, granted_by: context.user?.id },
            { onConflict: 'client_id,user_id,role_id' }
          );
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'ASSIGN_FAILED' }] };
      }
    },

    revokeRole: async (_: any, args: { clientId: string; userId: string; roleId: string }, context: Context) => {
      try {
        // Row level security hides rows the caller may not change, so a refused delete removes nothing and returns no error.
        const { data, error } = await tn(context)
          .from('user_roles')
          .delete()
          .eq('client_id', args.clientId)
          .eq('user_id', args.userId)
          .eq('role_id', args.roleId)
          .select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('No role was removed. The person may not hold it, or you may not manage roles for this client.');
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'REVOKE_FAILED' }] };
      }
    },

    deactivateClientUser: async (_: any, args: { clientId: string; userId: string }, context: Context) => {
      try {
        const { data, error } = await tn(context)
          .from('client_users')
          .update({ is_active: false })
          .eq('client_id', args.clientId)
          .eq('user_id', args.userId)
          .select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('No one was deactivated. The person may not be in this client, or you may not manage its users.');
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'DEACTIVATE_FAILED' }] };
      }
    },

    grantEntityAccess: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { error } = await tn(context)
          .from('entity_grants')
          .insert({
            client_id: args.input.clientId,
            entity_id: args.input.entityId,
            grantee_type: args.input.granteeType,
            user_id: args.input.granteeType === 'USER' ? args.input.userId : null,
            role_id: args.input.granteeType === 'ROLE' ? args.input.roleId : null,
            access_level: args.input.accessLevel,
            include_children: args.input.includeChildren ?? true,
            created_by: context.user?.id,
          });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'GRANT_FAILED' }] };
      }
    },

    setEntityRoleAccess: async (_: any, args: { clientId: string; entityId: string; roles: { roleId: string; accessLevel: string }[] }, context: Context) => {
      try {
        if (!context.user) throw new Error('Not authenticated');
        const { error } = await tn(context).rpc('set_entity_role_access', {
          p_client_id: args.clientId,
          p_entity_id: args.entityId,
          p_roles: (args.roles || []).map((role) => ({
            role_id: role.roleId,
            access_level: role.accessLevel,
          })),
        });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'GRANT_FAILED' }] };
      }
    },

    revokeEntityAccess: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await tn(context).from('entity_grants').delete().eq('id', args.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('No access was removed. The grant may be gone, or you may not manage access to this record.');
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'REVOKE_FAILED' }] };
      }
    },

    startImpersonation: async (_: any, args: { clientId: string; reason?: string }, context: Context) => {
      try {
        // Public wrapper, called with the caller's JWT. The service-role client
        // and a tenancy-schema switch both clear auth.uid(), so the session
        // never starts and entity lists stay unscoped.
        const { error } = await context.supabase.rpc('start_impersonation', { p_client_id: args.clientId, p_reason: args.reason ?? null });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'IMPERSONATION_FAILED' }] };
      }
    },

    stopImpersonation: async (_: any, __: any, context: Context) => {
      try {
        const { error } = await context.supabase.rpc('stop_impersonation', {});
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'STOP_FAILED' }] };
      }
    },

    updateProfile: async (_: any, args: { input: { displayName?: string } }, context: Context) => {
      try {
        if (!context.user) {
          return { success: false, errors: [{ field: 'general', message: 'Not authenticated', code: 'UNAUTHENTICATED' }] };
        }
        if (args.input.displayName === undefined) {
          return { success: false, errors: [{ field: 'general', message: 'No fields to update', code: 'NO_CHANGES' }] };
        }
        const { data: profile, error } = await tn(context)
          .from('profiles')
          .update({ display_name: args.input.displayName.trim() || null })
          .eq('id', context.user.id)
          .select('*')
          .maybeSingle();
        if (error) throw error;
        if (!profile) {
          return { success: false, errors: [{ field: 'general', message: 'Profile not found', code: 'NOT_FOUND' }] };
        }
        const { data: roleRows } = ok(await tn(context)
          .from('user_roles')
          .select('role:roles(role_permissions(permission:permissions(permission_code)))')
          .eq('user_id', context.user.id));
        const isTenantAdmin = profile.is_tenant_admin ?? false;
        const access = collectAccess(roleRows, isTenantAdmin);
        const meResult = {
          id: context.user.id,
          email: context.user.email,
          displayName: profile.display_name ?? null,
          isTenantAdmin,
          canAccessAdmin: access.canAccessAdmin,
          canManageEntityAccess: access.canManageEntityAccess,
          clients: [],
          impersonating: null,
        };
        return { success: true, profile: meResult, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },

    updateClientAuthRequirements: async (_: any, args: { input: { clientId: string; passwordEnabled: boolean; mfaRequired: boolean; emailDomains: string[] } }, context: Context) => {
      try {
        await assertTenantAdmin(context);
        const unique = normalizeEmailDomains(args.input.emailDomains || []);
        const { data: providers, error: providerError } = await tn(context)
          .from('client_identity_providers')
          .select('email_domain')
          .eq('client_id', args.input.clientId);
        if (providerError) throw providerError;
        const stillUsed = (providers || [])
          .map((row: { email_domain: string | null }) => row.email_domain)
          .filter((domain): domain is string => typeof domain === 'string' && !unique.includes(domain));
        if (stillUsed.length) {
          throw new Error(`Remove the connection for ${stillUsed.join(', ')} before dropping that domain`);
        }
        const { error } = await tn(context).from('client_auth_requirements').upsert({
          client_id: args.input.clientId,
          password_enabled: args.input.passwordEnabled,
          mfa_required: args.input.mfaRequired,
          email_domains: unique,
          updated_by: context.user?.id ?? null,
        }, { onConflict: 'client_id' });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'AUTH_REQUIREMENTS_FAILED' }] };
      }
    },

    upsertClientIdentityProvider: async (_: any, args: { input: any }, context: Context) => {
      try {
        await assertTenantAdmin(context);
        const input = args.input;
        let existing: any = null;
        if (input.id) {
          const { data, error } = await tn(context)
            .from('client_identity_providers')
            .select('id, provider, oidc_identifier, sso_provider_id, saml_metadata_url, saml_metadata_xml')
            .eq('id', input.id)
            .eq('client_id', input.clientId)
            .maybeSingle();
          if (error) throw error;
          if (!data) throw new Error('Identity provider not found');
          existing = data;
        }
        const samlMetadataUrl = input.provider === 'SAML'
          ? (input.samlMetadataUrl || (!input.samlMetadataXml ? existing?.saml_metadata_url : null))
          : null;
        const samlMetadataXml = input.provider === 'SAML'
          ? (input.samlMetadataXml || (!input.samlMetadataUrl ? existing?.saml_metadata_xml : null))
          : null;
        const write = assertIdentityProviderInput({
          provider: input.provider as IdentityProviderKind,
          displayName: input.displayName ?? null,
          emailDomain: input.emailDomain ?? null,
          azureTenantId: input.azureTenantId ?? null,
          samlMetadataUrl,
          samlMetadataXml,
          oidcIssuer: input.oidcIssuer ?? null,
          oidcClientId: input.oidcClientId ?? null,
          oidcClientSecret: input.oidcClientSecret ?? null,
          isEnabled: input.isEnabled !== false,
        }, { secretRequired: input.provider === 'OIDC' && !existing?.oidc_identifier });
        const identifier = write.provider === 'OIDC'
          ? (existing?.oidc_identifier || (write.emailDomain ? oidcIdentifier(write.emailDomain) : null))
          : null;
        const registers = write.provider === 'SAML' || write.provider === 'OIDC';
        const payload = {
          ...toIdentityProviderRow(write, identifier),
          client_id: input.clientId,
          registration_status: registers ? 'pending' : 'active',
          registration_error: null,
        };
        const saved = input.id
          ? await tn(context).from('client_identity_providers').update(payload).eq('id', input.id).select('id').single()
          : await tn(context).from('client_identity_providers').insert(payload).select('id').single();
        if (saved.error) throw saved.error;
        if (!registers) return { success: true, errors: [] };

        const registration = await syncIdentityProvider({
          ...serviceConfig(context),
          row: {
            provider: write.provider,
            emailDomain: write.emailDomain,
            samlMetadataUrl: write.samlMetadataUrl,
            samlMetadataXml: write.samlMetadataXml,
            oidcIssuer: write.oidcIssuer,
            oidcClientId: write.oidcClientId,
            oidcClientSecret: write.oidcClientSecret,
            oidcIdentifier: identifier,
            ssoProviderId: existing?.sso_provider_id ?? null,
            displayName: write.displayName,
            isEnabled: write.isEnabled,
          },
        });
        const { error: statusError } = await tn(context)
          .from('client_identity_providers')
          .update({
            registration_status: registration.registrationStatus,
            registration_error: registration.registrationError,
            sso_provider_id: registration.ssoProviderId,
            oidc_identifier: registration.oidcIdentifier ?? identifier,
          })
          .eq('id', saved.data.id);
        if (statusError) throw statusError;
        if (registration.registrationStatus === 'error') {
          return { success: false, errors: [{ field: 'provider', message: registration.registrationError || 'Could not register the identity provider', code: 'REGISTRATION_FAILED' }] };
        }
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'IDENTITY_PROVIDER_FAILED' }] };
      }
    },

    deleteClientIdentityProvider: async (_: any, args: { id: string }, context: Context) => {
      try {
        await assertTenantAdmin(context);
        const { data: row, error } = await tn(context)
          .from('client_identity_providers')
          .select('id, provider, sso_provider_id, oidc_identifier')
          .eq('id', args.id)
          .maybeSingle();
        if (error) throw error;
        if (!row) return { success: true, errors: [] };
        await removeRegisteredProvider({
          ...serviceConfig(context),
          provider: row.provider,
          ssoProviderId: row.sso_provider_id,
          oidcIdentifier: row.oidc_identifier,
        });
        const { error: deleteError } = await tn(context).from('client_identity_providers').delete().eq('id', args.id);
        if (deleteError) throw deleteError;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'DELETE_FAILED' }] };
      }
    },
  },
};

async function assertTenantAdmin(context: Context) {
  if (!context.user) throw new Error('Not authenticated');
  const { data, error } = await tn(context).rpc('is_tenant_admin');
  if (error) throw error;
  if (!data) throw new Error('Only a tenant admin can manage authentication');
}

function mapAuthRequirements(row: any) {
  return {
    clientId: row.client_id,
    passwordEnabled: row.password_enabled,
    mfaRequired: row.mfa_required,
    emailDomains: row.email_domains || [],
  };
}

function mapIdentityProvider(row: any) {
  return {
    id: row.id,
    clientId: row.client_id,
    provider: row.provider,
    displayName: row.display_name,
    emailDomain: row.email_domain,
    azureTenantId: row.azure_tenant_id,
    samlMetadataUrl: row.saml_metadata_url,
    oidcIssuer: row.oidc_issuer,
    oidcClientId: row.oidc_client_id,
    oidcIdentifier: row.oidc_identifier,
    ssoProviderId: row.sso_provider_id,
    registrationStatus: row.registration_status,
    registrationError: row.registration_error,
    isEnabled: row.is_enabled,
  };
}

function mapClient(row: any, moduleCodes: string[] = []) {
  if (!row) return null;
  return {
    id: row.id,
    clientCode: row.client_code,
    clientName: row.client_name,
    isActive: row.is_active,
    isInternal: row.is_internal,
    createdAt: row.created_at,
    curatedModules: row.curated_modules === true,
    moduleCodes,
  };
}

function mapModule(row: any) {
  return {
    code: row.module_code,
    name: row.module_name,
    description: row.description,
    domainCodes: row.domain_codes || [],
    surfaceCodes: row.surface_codes || [],
    workflowCodes: row.workflow_codes || [],
    toolHrefs: row.tool_hrefs || [],
  };
}

async function moduleCodesByClient(context: Context) {
  const { data, error } = await tn(context).from('client_modules').select('client_id, module_code');
  if (error) throw error;
  const byClient = new Map<string, string[]>();
  for (const row of data || []) {
    const list = byClient.get(row.client_id) ?? [];
    list.push(row.module_code);
    byClient.set(row.client_id, list);
  }
  return byClient;
}

function mapProfile(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email ?? null,
    displayName: row.display_name,
    isTenantAdmin: row.is_tenant_admin,
    isActive: row.is_active,
  };
}

function mapRole(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    roleCode: row.role_code,
    roleName: row.role_name,
    description: row.description,
    isSystemRole: row.is_system_role,
    permissionCodes: (row.role_permissions || []).map((rp: any) => rp.permission?.permission_code).filter(Boolean),
  };
}

function mapEntityGrant(row: any) {
  return {
    id: row.id,
    clientId: row.client_id ?? row.clientId,
    entityId: row.entity_id ?? row.entityId,
    granteeType: row.grantee_type ?? row.granteeType,
    userId: row.user_id ?? row.userId ?? null,
    roleId: row.role_id ?? row.roleId ?? null,
    granteeLabel: row.grantee_user?.display_name || row.grantee_role?.role_name || row.granteeLabel || null,
    accessLevel: row.access_level ?? row.accessLevel,
    includeChildren: row.include_children ?? row.includeChildren,
    createdAt: row.created_at ?? row.createdAt,
  };
}

function mapAccessRecord(row: any) {
  const grants = Array.isArray(row.grants) ? row.grants : [];
  return {
    entityId: row.entity_id,
    clientId: row.client_id,
    entityCode: row.entity_code,
    entityName: row.entity_name,
    domainCode: row.domain_code,
    restricted: row.restricted,
    grants: grants.map(mapEntityGrant),
  };
}

// The directory function is client-scoped. Look up the entity's client with the
// caller's JWT so a guessed id in another tenant returns nothing.
async function entityClientId(context: Context, entityId: string) {
  const { data, error } = await context.supabase
    .schema('entity_instances')
    .from('master_entities')
    .select('client_id')
    .eq('id', entityId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.client_id) {
    throw new Error('Entity not found');
  }
  return data.client_id as string;
}
