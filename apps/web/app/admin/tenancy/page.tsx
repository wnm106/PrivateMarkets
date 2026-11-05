'use client';

import { useEffect, useState } from 'react';
import { graphqlClient } from '@/lib/graphql';
import {
  CLIENTS_QUERY,
  CLIENT_USERS_QUERY,
  ROLES_QUERY,
  PERMISSIONS_CATALOG_QUERY,
  CREATE_CLIENT_MUTATION,
  CREATE_ROLE_MUTATION,
  INVITE_USER_MUTATION,
  ASSIGN_ROLE_MUTATION,
  REVOKE_ROLE_MUTATION,
  DEACTIVATE_CLIENT_USER_MUTATION,
  ENTITY_ACCESS_ROSTER_QUERY,
  ME_QUERY,
} from '@/lib/graphql';
import { EntityRoleAccess, type AccessGrant } from '@/components/security/EntityRoleAccess';

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
interface AccessRecord {
  entityId: string;
  clientId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  restricted: boolean;
  grants: AccessGrant[];
}

interface SessionAccess {
  isTenantAdmin: boolean;
  canManageEntityAccess: boolean;
}

type Tab = 'clients' | 'members' | 'entity-access';

export default function TenancyAdminPage() {
  const [tab, setTab] = useState<Tab>('clients');
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<SessionAccess | null>(null);

  const loadClients = async () => {
    const result = await graphqlClient.query(CLIENTS_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
    if (result.error) setError(result.error.message);
    const list: Client[] = result.data?.clients ?? [];
    setClients(list);
    if (!selectedClientId && list.length) setSelectedClientId(list.find((c) => !c.isInternal)?.id ?? list[0].id);
  };

  useEffect(() => {
    Promise.all([
      loadClients(),
      graphqlClient.query(ME_QUERY, {}, { requestPolicy: 'network-only' }).toPromise(),
    ]).then(([, meResult]) => {
      const session = meResult.data?.me;
      setMe(session ? { isTenantAdmin: session.isTenantAdmin, canManageEntityAccess: session.canManageEntityAccess } : null);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Security</h1>
        <p className="text-gray-600">
          Tenants never see each other&apos;s entities. Inside a client, assign roles to an entity to close it — and every child under it — to everyone else.
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
          ...(me?.canManageEntityAccess ? [['entity-access', 'Entity Access'] as [Tab, string]] : []),
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
        <ClientsTab clients={clients} onChanged={loadClients} onError={setError} canProvision={!!me?.isTenantAdmin} />
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

function ClientsTab({ clients, onChanged, onError, canProvision }: { clients: Client[]; onChanged: () => void; onError: (e: string | null) => void; canProvision: boolean }) {
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
      {canProvision && (
      <div className="flex justify-end mb-4">
        <button onClick={() => setShowForm(!showForm)} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm">
          + Add Client
        </button>
      </div>
      )}

      {canProvision && showForm && (
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
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {clients.map((c) => (
              <tr key={c.id}>
                <td className="px-6 py-4 whitespace-nowrap font-medium">{c.clientName}{c.isInternal && <span className="ml-2 text-xs text-gray-400">(internal)</span>}</td>
                <td className="px-6 py-4 whitespace-nowrap"><code className="text-sm bg-gray-100 px-2 py-1 rounded">{c.clientCode}</code></td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 text-xs font-medium rounded ${c.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                    {c.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Roles</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Add role</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="px-6 py-4 whitespace-nowrap">{m.profile?.displayName || m.profile?.email || m.userId}</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {m.roles.map((r) => (
                          <span key={r.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
                            {r.roleName}
                            <button onClick={() => handleRevoke(m.userId, r.id)} className="text-blue-500 hover:text-blue-900">×</button>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <select defaultValue="" onChange={(e) => { handleAssign(m.userId, e.target.value); e.target.value = ''; }} className="px-2 py-1 border rounded text-sm">
                        <option value="">+ role…</option>
                        {roles.filter((r) => !m.roles.some((mr) => mr.id === r.id)).map((r) => <option key={r.id} value={r.id}>{r.roleName}</option>)}
                      </select>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${m.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                        {m.isActive ? 'Active' : 'Removed'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm">
                      {m.isActive && <button onClick={() => handleDeactivate(m.userId)} className="text-red-600 hover:text-red-800">Remove</button>}
                    </td>
                  </tr>
                ))}
                {members.length === 0 && (
                  <tr><td colSpan={5} className="text-center py-8 text-gray-500">No members yet</td></tr>
                )}
              </tbody>
            </table>
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
  const [clientId, setClientId] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<AccessRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);

  const load = async (nextSearch = search) => {
    if (!clientId) return;
    setLoadingRows(true);
    const result = await graphqlClient
      .query(ENTITY_ACCESS_ROSTER_QUERY, { clientId, search: nextSearch || null }, { requestPolicy: 'network-only' })
      .toPromise();
    setLoadingRows(false);
    if (result.error) {
      onError(result.error.message);
      setRows([]);
      return;
    }
    const list: AccessRecord[] = result.data?.entityAccessRoster ?? [];
    setRows(list);
    setSelectedId((current) => (current && list.some((row) => row.entityId === current) ? current : list[0]?.entityId ?? null));
  };

  useEffect(() => {
    if (clientId || clients.length === 0) return;
    setClientId(clients.find((c) => !c.isInternal)?.id ?? clients[0].id);
  }, [clients, clientId]);

  useEffect(() => {
    if (!clientId) return;
    load('');
    // Reload when the client changes. Search is applied explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const selected = rows.find((row) => row.entityId === selectedId) ?? null;

  return (
    <div>
      <p className="text-sm text-gray-600 mb-4">
        Pick an entity and choose which roles may open it. Saving a role closes the entity to everyone else in the
        client, and to every child entity under it. Leave every role on &quot;No access&quot; and save to open it again
        to anyone who can view entities.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="px-3 py-2 border rounded">
          {clients.map((c) => <option key={c.id} value={c.id}>{c.clientName}</option>)}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(search); }}
          placeholder="Search by name or code"
          className="flex-1 min-w-[16rem] px-3 py-2 border rounded"
        />
        <button onClick={() => load(search)} className="px-4 py-2 bg-gray-200 rounded text-sm">Search</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {loadingRows ? (
            <div className="p-6 text-gray-500">Loading entities…</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
              {rows.map((row) => {
                const roleLabels = row.grants.filter((g) => g.granteeType === 'ROLE').map((g) => g.granteeLabel || 'Role');
                return (
                  <li key={row.entityId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(row.entityId)}
                      className={`w-full text-left px-4 py-3 ${selectedId === row.entityId ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      <div className="font-medium">{row.entityName}</div>
                      <div className="text-xs text-gray-500">{row.entityCode} · {row.domainCode}</div>
                      <div className="text-xs mt-1">
                        {row.restricted
                          ? <span className="text-amber-700">Closed{roleLabels.length ? `: ${roleLabels.join(', ')}` : ' by a parent'}</span>
                          : <span className="text-gray-500">Open to the client</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
              {rows.length === 0 && <li className="p-6 text-gray-500 text-sm">No entities match.</li>}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          {selected ? (
            <EntityRoleAccess
              clientId={selected.clientId}
              entityId={selected.entityId}
              entityName={selected.entityName}
              domainCode={selected.domainCode}
              restricted={selected.restricted}
              grants={selected.grants}
              onChanged={() => load(search)}
            />
          ) : (
            <div className="text-gray-500 text-sm">Select an entity to assign roles.</div>
          )}
        </div>
      </div>
    </div>
  );
}
