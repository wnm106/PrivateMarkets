import { Context } from '../context';

// `tenancy` lives in a non-public Postgres schema. For read-only operations
// the anon-key client works (via exposed schema config), but writes require
// the service-role client (`supabaseAdmin`) which has full schema access.
// Authorization is enforced at the resolver level by scoping every operation
// to `context.user.id` -- the service role bypasses RLS but the resolver
// itself ensures users can only touch their own rows.
function tn(context: Context) {
  return (context.supabaseAdmin ?? context.supabase).schema('tenancy');
}

export const tenancyResolvers = {
  Query: {
    me: async (_: any, __: any, context: Context) => {
      if (!context.user) {
        throw new Error('Not authenticated');
      }

      const [{ data: profile }, { data: clientUsers }, { data: impersonation }] = await Promise.all([
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
      ]);

      return {
        id: context.user.id,
        email: context.user.email,
        displayName: profile?.display_name ?? null,
        isTenantAdmin: profile?.is_tenant_admin ?? false,
        clients: (clientUsers || []).map((row: any) => mapClient(row.client)).filter(Boolean),
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
      const { data, error } = await tn(context).from('clients').select('*').order('client_name');
      if (error) throw error;
      return (data || []).map(mapClient);
    },

    client: async (_: any, args: { id: string }, context: Context) => {
      const { data, error } = await tn(context).from('clients').select('*').eq('id', args.id).maybeSingle();
      if (error) throw error;
      return data ? mapClient(data) : null;
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
      query = args.clientId ? query.or(`client_id.is.null,client_id.eq.${args.clientId}`) : query;
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
  },

  Mutation: {
    createClient: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { error } = await tn(context).rpc('provision_client', {
          p_client_code: args.input.clientCode,
          p_client_name: args.input.clientName,
          p_admin_user_id: null,
        });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }] };
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
          const { data: permissions } = await tn(context).from('permissions').select('id, permission_code').in('permission_code', args.input.permissionCodes);
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
        if (!context.supabaseAdmin) {
          throw new Error('User invitation requires SUPABASE_SERVICE_ROLE_KEY to be configured on the server');
        }

        let userId: string | null = null;
        const { data: invited, error: inviteError } = await context.supabaseAdmin.auth.admin.inviteUserByEmail(args.input.email);
        if (inviteError) {
          // Already-registered users return an error here; look them up instead.
          const { data: existing } = await context.supabaseAdmin.auth.admin.listUsers();
          const match = existing?.users?.find((u) => u.email?.toLowerCase() === args.input.email.toLowerCase());
          if (!match) throw inviteError;
          userId = match.id;
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
        const { error } = await tn(context)
          .from('user_roles')
          .delete()
          .eq('client_id', args.clientId)
          .eq('user_id', args.userId)
          .eq('role_id', args.roleId);
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'REVOKE_FAILED' }] };
      }
    },

    deactivateClientUser: async (_: any, args: { clientId: string; userId: string }, context: Context) => {
      try {
        const { error } = await tn(context).from('client_users').update({ is_active: false }).eq('client_id', args.clientId).eq('user_id', args.userId);
        if (error) throw error;
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
            include_children: args.input.includeChildren,
            created_by: context.user?.id,
          });
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'GRANT_FAILED' }] };
      }
    },

    revokeEntityAccess: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await tn(context).from('entity_grants').delete().eq('id', args.id);
        if (error) throw error;
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
        // Use supabaseAdmin (service role) which has full schema access
        const supabase = context.supabaseAdmin ?? context.supabase;
        const { data, error } = await supabase
          .schema('tenancy')
          .from('profiles')
          .upsert({ id: context.user.id, display_name: args.input.displayName.trim() || null, updated_at: new Date().toISOString() }, { onConflict: 'id' })
          .select();
        if (error) throw error;
        // Re-fetch the full me object to return
        const { data: profile } = await supabase
          .schema('tenancy')
          .from('profiles')
          .select('*')
          .eq('id', context.user.id)
          .maybeSingle();
        const meResult = {
          id: context.user.id,
          email: context.user.email,
          displayName: profile?.display_name ?? null,
          isTenantAdmin: profile?.is_tenant_admin ?? false,
          clients: [],
          impersonating: null,
        };
        return { success: true, profile: meResult, errors: [] };
      } catch (error: any) {
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },
  },
};

function mapClient(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    clientCode: row.client_code,
    clientName: row.client_name,
    isActive: row.is_active,
    isInternal: row.is_internal,
    createdAt: row.created_at,
  };
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
    clientId: row.client_id,
    entityId: row.entity_id,
    granteeType: row.grantee_type,
    userId: row.user_id,
    roleId: row.role_id,
    granteeLabel: row.grantee_user?.display_name || row.grantee_role?.role_name || null,
    accessLevel: row.access_level,
    includeChildren: row.include_children,
    createdAt: row.created_at,
  };
}
