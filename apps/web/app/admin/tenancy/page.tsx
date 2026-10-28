'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { graphqlClient } from '@/lib/graphql';
import {
  CLIENTS_QUERY,
  CLIENT_USERS_QUERY,
  ROLES_QUERY,
  PERMISSIONS_CATALOG_QUERY,
  ENTITY_GRANTS_QUERY,
  CREATE_CLIENT_MUTATION,
  CREATE_ROLE_MUTATION,
  INVITE_USER_MUTATION,
  ASSIGN_ROLE_MUTATION,
  REVOKE_ROLE_MUTATION,
  DEACTIVATE_CLIENT_USER_MUTATION,
  GRANT_ENTITY_ACCESS_MUTATION,
  REVOKE_ENTITY_ACCESS_MUTATION,
} from '@/lib/graphql';

interface Client {
  id: string;
  clientCode: string;
  clientName: string;
  isActive: boolean;
  isInternal: boolean;
}
interface Role {
  id: string;
  clientId: string | null;
  roleCode: string;
  roleName: string;
  description: string | null;
  isSystemRole: boolean;
  permissionCodes: string[];
}
interface ClientUser {
  id: string;
  userId: string;
  isActive: boolean;
  profile: { email: string | null; displayName: string | null } | null;
  roles: { id: string; roleCode: string; roleName: string }[];
}
interface EntityGrant {
  id: string;
  entityId: string;
  granteeType: string;
  granteeLabel: string | null;
  accessLevel: string;
  includeChildren: boolean;
}

type Tab = 'clients' | 'members' | 'entity-access';

export default function TenancyAdminPage() {
  const [tab, setTab] = useState<Tab>('clients');
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadClients = async () => {
    const result = await graphqlClient.query(CLIENTS_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
    if (result.error) setError(result.error.message);
    const list: Client[] = result.data?.clients ?? [];
    setClients(list);
    if (!selectedClientId && list.length) setSelectedClientId(list.find((c) => !c.isInternal)?.id ?? list[0].id);
  };

  useEffect(() => {
    loadClients().finally(() => setLoading(false));
  }, []);

  return (
    <div className="screen">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Clients, Users &amp; Roles</h1>
        <p className="text-gray-600">
          Manage tenants (clients), who belongs to each, their roles, and fine-grained access to specific entities.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between">
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="text-red-600">×</button>
        </div>
      )}

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {([
          ['clients', 'Clients'],
          ['members', 'Members & Roles'],
          ['entity-access', 'Entity Access'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : tab === 'clients' ? (
        <ClientsTab clients={clients} onChanged={loadClients} onError={setError} />
      ) : tab === 'members' ? (
        <MembersTab
          clients={clients}
          selectedClientId={selectedClientId}
          onSelectClient={setSelectedClientId}
          onError={setError}
        />
      ) : (
        <EntityAccessTab clients={clients} onError={setError} />
      )}
    </div>
  );
}

function ClientsTab({ clients, onChanged, onError }: { clients: Client[]; onChanged: () => void; onError: (e: string | null) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [clientCode, setClientCode] = useState('');
  const [clientName, setClientName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const result = await graphqlClient
        .mutation(CREATE_CLIENT_MUTATION, { input: { clientCode: clientCode.toUpperCase(), clientName, adminEmail: adminEmail || null } })
        .toPromise();
      if (result.error) { onError(result.error.message); return; }
      if (!result.data?.createClient?.success) { onError(result.data?.createClient?.errors?.[0]?.message ?? 'Failed to create client'); return; }
      setShowForm(false);
      setClientCode(''); setClientName(''); setAdminEmail('');
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button onClick={() => setShowForm(!showForm)} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm">
          + Add Client
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-lg shadow p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Client code (e.g. ACME_CAPITAL)" value={clientCode} onChange={(e) => setClientCode(e.target.value)} className="px-3 py-2 border rounded" />
            <input placeholder="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} className="px-3 py-2 border rounded" />
          </div>
          <input placeholder="First admin's email (optional)" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="w-full px-3 py-2 border rounded" />
          <button disabled={saving || !clientCode || !clientName} onClick={handleCreate} className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-300 text-sm">
            Create
          </button>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <AppGrid
          rows={clients}
          columns={CLIENT_COLUMNS}
          getRowId={(row) => row.id}
          autoHeight
          emptyMessage="No clients yet"
        />
      </div>
    </div>
  );
}

function MembersTab({
  clients,
  selectedClientId,
  onSelectClient,
  onError,
}: {
  clients: Client[];
  selectedClientId: string;
  onSelectClient: (id: string) => void;
  onError: (e: string | null) => void;
}) {
  const [members, setMembers] = useState<ClientUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');

  const load = async (clientId: string) => {
    if (!clientId) return;
    setLoading(true);
    try {
      const [membersResult, rolesResult] = await Promise.all([
        graphqlClient.query(CLIENT_USERS_QUERY, { clientId }, { requestPolicy: 'network-only' }).toPromise(),
        graphqlClient.query(ROLES_QUERY, { clientId }, { requestPolicy: 'network-only' }).toPromise(),
      ]);
      if (membersResult.error) onError(membersResult.error.message);
      if (rolesResult.error) onError(rolesResult.error.message);
      setMembers(membersResult.data?.clientUsers ?? []);
      setRoles(rolesResult.data?.roles ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(selectedClientId);
  }, [selectedClientId]);

  const handleInvite = async () => {
    if (!inviteEmail || !inviteRoleId) return;
    const result = await graphqlClient
      .mutation(INVITE_USER_MUTATION, { input: { clientId: selectedClientId, email: inviteEmail, roleIds: [inviteRoleId] } })
      .toPromise();
    if (result.error || !result.data?.inviteUser?.success) {
      onError(result.error?.message ?? result.data?.inviteUser?.errors?.[0]?.message ?? 'Invite failed');
      return;
    }
    setInviteEmail(''); setInviteRoleId('');
    load(selectedClientId);
  };

  const handleRevoke = async (userId: string, roleId: string) => {
    await graphqlClient.mutation(REVOKE_ROLE_MUTATION, { clientId: selectedClientId, userId, roleId }).toPromise();
    load(selectedClientId);
  };

  const handleAssign = async (userId: string, roleId: string) => {
    if (!roleId) return;
    await graphqlClient.mutation(ASSIGN_ROLE_MUTATION, { input: { clientId: selectedClientId, userId, roleId } }).toPromise();
    load(selectedClientId);
  };

  const handleDeactivate = async (userId: string) => {
    if (!confirm('Remove this user from the client?')) return;
    await graphqlClient.mutation(DEACTIVATE_CLIENT_USER_MUTATION, { clientId: selectedClientId, userId }).toPromise();
    load(selectedClientId);
  };

  const [newRoleCode, setNewRoleCode] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [newRolePerms, setNewRolePerms] = useState<string[]>([]);
  const [permCatalog, setPermCatalog] = useState<string[]>([]);
  useEffect(() => {
    graphqlClient.query(PERMISSIONS_CATALOG_QUERY, {}).toPromise().then((r) => setPermCatalog(r.data?.permissionsCatalog ?? []));
  }, []);

  const handleCreateRole = async () => {
    if (!newRoleCode || !newRoleName) return;
    const result = await graphqlClient
      .mutation(CREATE_ROLE_MUTATION, {
        input: { clientId: selectedClientId, roleCode: newRoleCode.toUpperCase(), roleName: newRoleName, permissionCodes: newRolePerms },
      })
      .toPromise();
    if (result.error || !result.data?.createRole?.success) {
      onError(result.error?.message ?? result.data?.createRole?.errors?.[0]?.message ?? 'Could not create role');
      return;
    }
    setNewRoleCode(''); setNewRoleName(''); setNewRolePerms([]);
    load(selectedClientId);
  };

  const memberActions = useRef({ handleRevoke, handleAssign, handleDeactivate, roles });
  memberActions.current = { handleRevoke, handleAssign, handleDeactivate, roles };
  const memberContext = useMemo(() => ({ get: () => memberActions.current }), []);

  return (
    <div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
        <select value={selectedClientId} onChange={(e) => onSelectClient(e.target.value)} className="px-3 py-2 border rounded">
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.clientName}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : (
        <>
          <div className="bg-white rounded-lg shadow p-4 mb-4">
            <h3 className="font-semibold mb-3">Invite a user</h3>
            <div className="flex gap-2">
              <input placeholder="email@client.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="flex-1 px-3 py-2 border rounded" />
              <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)} className="px-3 py-2 border rounded">
                <option value="">Role…</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.roleName}</option>)}
              </select>
              <button onClick={handleInvite} disabled={!inviteEmail || !inviteRoleId} className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-300 text-sm">
                Invite
              </button>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow overflow-x-auto mb-6">
            <AppGrid
              rows={members.map((member) => ({ ...member, __rolesReady: roles.map((role) => role.id).join(',') }))}
              columns={MEMBER_COLUMNS}
              getRowId={(row) => row.id}
              autoHeight
              autoRowHeight
              context={memberContext}
              emptyMessage="No members yet"
            />
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold mb-3">Roles</h3>
            <ul className="mb-4 space-y-1">
              {roles.map((r) => (
                <li key={r.id} className="text-sm text-gray-700">
                  <strong>{r.roleName}</strong>{r.isSystemRole && <span className="text-gray-400"> (system)</span>} — {r.permissionCodes.join(', ') || 'no permissions'}
                </li>
              ))}
            </ul>
            <div className="border-t pt-4">
              <h4 className="text-sm font-medium mb-2">New custom role for this client</h4>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input placeholder="ROLE_CODE" value={newRoleCode} onChange={(e) => setNewRoleCode(e.target.value)} className="px-3 py-2 border rounded text-sm" />
                <input placeholder="Role name" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} className="px-3 py-2 border rounded text-sm" />
              </div>
              <div className="flex flex-wrap gap-2 mb-2">
                {permCatalog.map((p) => (
                  <label key={p} className="text-xs flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={newRolePerms.includes(p)}
                      onChange={(e) => setNewRolePerms((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))}
                    />
                    {p}
                  </label>
                ))}
              </div>
              <button onClick={handleCreateRole} disabled={!newRoleCode || !newRoleName} className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-300 text-sm">
                Create role
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EntityAccessTab({ clients, onError }: { clients: Client[]; onError: (e: string | null) => void }) {
  const [entityId, setEntityId] = useState('');
  const [grants, setGrants] = useState<EntityGrant[]>([]);
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [roles, setRoles] = useState<Role[]>([]);
  const [granteeType, setGranteeType] = useState<'USER' | 'ROLE'>('ROLE');
  const [roleId, setRoleId] = useState('');
  const [userId, setUserId] = useState('');
  const [accessLevel, setAccessLevel] = useState<'READ' | 'WRITE'>('READ');
  const [includeChildren, setIncludeChildren] = useState(true);

  const load = async () => {
    if (!entityId) return;
    const result = await graphqlClient.query(ENTITY_GRANTS_QUERY, { entityId }, { requestPolicy: 'network-only' }).toPromise();
    if (result.error) { onError(result.error.message); return; }
    setGrants(result.data?.entityGrants ?? []);
  };

  useEffect(() => {
    if (clientId) {
      graphqlClient.query(ROLES_QUERY, { clientId }).toPromise().then((r) => setRoles(r.data?.roles ?? []));
    }
  }, [clientId]);

  const handleGrant = async () => {
    if (!entityId || !clientId) return;
    const result = await graphqlClient
      .mutation(GRANT_ENTITY_ACCESS_MUTATION, {
        input: { clientId, entityId, granteeType, userId: granteeType === 'USER' ? userId : null, roleId: granteeType === 'ROLE' ? roleId : null, accessLevel, includeChildren },
      })
      .toPromise();
    if (result.error || !result.data?.grantEntityAccess?.success) {
      onError(result.error?.message ?? result.data?.grantEntityAccess?.errors?.[0]?.message ?? 'Grant failed');
      return;
    }
    load();
  };

  const handleRevoke = async (id: string) => {
    await graphqlClient.mutation(REVOKE_ENTITY_ACCESS_MUTATION, { id }).toPromise();
    load();
  };

  const grantActions = useRef({ handleRevoke });
  grantActions.current = { handleRevoke };
  const grantContext = useMemo(() => ({ get: () => grantActions.current }), []);

  return (
    <div>
      <p className="text-sm text-gray-600 mb-4">
        Restrict who can see or edit a specific entity (e.g. a Fund) — adding any grant here hides it from everyone
        else in the client except explicitly granted users/roles. With "Include children" on, this cascades to any
        child entity linked via a parent/child relationship (e.g. the Fund's Positions, Deals, etc.).
      </p>

      <div className="bg-white rounded-lg shadow p-4 mb-4 space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Entity ID</label>
          <div className="flex gap-2">
            <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="UUID of the entity" className="flex-1 px-3 py-2 border rounded" />
            <button onClick={load} className="px-4 py-2 bg-gray-200 rounded text-sm">Load grants</button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full px-3 py-2 border rounded">
              {clients.map((c) => <option key={c.id} value={c.id}>{c.clientName}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Access level</label>
            <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as any)} className="w-full px-3 py-2 border rounded">
              <option value="READ">Read</option>
              <option value="WRITE">Write</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Grant to</label>
            <select value={granteeType} onChange={(e) => setGranteeType(e.target.value as any)} className="w-full px-3 py-2 border rounded">
              <option value="ROLE">A role</option>
              <option value="USER">A specific user</option>
            </select>
          </div>
          {granteeType === 'ROLE' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="w-full px-3 py-2 border rounded">
                <option value="">Select…</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.roleName}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">User ID</label>
              <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="UUID of the user" className="w-full px-3 py-2 border rounded" />
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
          Include children (cascade restriction/grant down to related entities)
        </label>

        <button onClick={handleGrant} disabled={!entityId || !clientId} className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-300 text-sm">
          Add grant
        </button>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <AppGrid
          rows={grants}
          columns={GRANT_COLUMNS}
          getRowId={(row) => row.id}
          autoHeight
          context={grantContext}
          emptyMessage="No restrictions on this entity — visible to all client members with entity.read"
        />
      </div>
    </div>
  );
}

const CLIENT_COLUMNS: ColDef[] = [
  {
    colId: 'client',
    headerName: 'Client',
    flex: 1.4,
    minWidth: 180,
    valueGetter: (params) => params.data?.clientName || '',
    cellRenderer: (params: any) => (
      <span className="font-medium">
        {params.data.clientName}
        {params.data.isInternal && <span className="ml-2 text-xs text-gray-400">(internal)</span>}
      </span>
    ),
  },
  {
    field: 'clientCode',
    headerName: 'Code',
    minWidth: 160,
    cellRenderer: (params: any) => <code className="text-sm bg-gray-100 px-2 py-1 rounded">{params.value}</code>,
  },
  {
    colId: 'status',
    headerName: 'Status',
    width: 130,
    valueGetter: (params) => (params.data?.isActive ? 'Active' : 'Inactive'),
    cellRenderer: (params: any) => (
      <span className={`px-2 py-1 text-xs font-medium rounded ${params.data.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
        {params.data.isActive ? 'Active' : 'Inactive'}
      </span>
    ),
  },
];

const MEMBER_COLUMNS: ColDef[] = [
  {
    colId: 'user',
    headerName: 'User',
    flex: 1.2,
    minWidth: 180,
    valueGetter: (params) => params.data?.profile?.displayName || params.data?.profile?.email || params.data?.userId || '',
  },
  {
    colId: 'roles',
    headerName: 'Roles',
    flex: 1.4,
    minWidth: 200,
    sortable: false,
    filter: false,
    autoHeight: true,
    cellRenderer: (params: any) => (
      <div className="flex flex-wrap gap-1">
        {params.data.roles.map((role: { id: string; roleName: string }) => (
          <span key={role.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
            {role.roleName}
            <button type="button" onClick={() => params.context.get().handleRevoke(params.data.userId, role.id)} className="text-blue-500 hover:text-blue-900">×</button>
          </span>
        ))}
      </div>
    ),
  },
  {
    colId: 'add',
    headerName: 'Add role',
    minWidth: 160,
    sortable: false,
    filter: false,
    cellRenderer: (params: any) => (
      <select
        defaultValue=""
        onChange={(event) => {
          params.context.get().handleAssign(params.data.userId, event.target.value);
          event.target.value = '';
        }}
        className="px-2 py-1 border rounded text-sm"
      >
        <option value="">+ role…</option>
        {params.context.get().roles
          .filter((role: { id: string }) => !params.data.roles.some((current: { id: string }) => current.id === role.id))
          .map((role: { id: string; roleName: string }) => <option key={role.id} value={role.id}>{role.roleName}</option>)}
      </select>
    ),
  },
  {
    colId: 'status',
    headerName: 'Status',
    width: 130,
    valueGetter: (params) => (params.data?.isActive ? 'Active' : 'Removed'),
    cellRenderer: (params: any) => (
      <span className={`px-2 py-1 text-xs font-medium rounded ${params.data.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
        {params.data.isActive ? 'Active' : 'Removed'}
      </span>
    ),
  },
  {
    colId: 'remove',
    headerName: '',
    width: 110,
    sortable: false,
    filter: false,
    cellRenderer: (params: any) => params.data.isActive
      ? <button type="button" onClick={() => params.context.get().handleDeactivate(params.data.userId)} className="text-red-600 hover:text-red-800">Remove</button>
      : null,
  },
];

const GRANT_COLUMNS: ColDef[] = [
  { colId: 'grantee', headerName: 'Grantee', flex: 1.4, valueGetter: (params) => params.data?.granteeLabel ?? params.data?.id ?? '' },
  { field: 'granteeType', headerName: 'Type', width: 120 },
  { field: 'accessLevel', headerName: 'Access', width: 120 },
  { colId: 'children', headerName: 'Children', width: 120, valueGetter: (params) => (params.data?.includeChildren ? 'Yes' : 'No') },
  {
    colId: 'revoke',
    headerName: '',
    width: 110,
    sortable: false,
    filter: false,
    cellRenderer: (params: any) => (
      <button type="button" onClick={() => params.context.get().handleRevoke(params.data.id)} className="text-red-600 hover:text-red-800">Revoke</button>
    ),
  },
];
