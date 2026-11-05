'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  graphqlClient,
  ROLES_QUERY,
  SET_ENTITY_ROLE_ACCESS_MUTATION,
  REVOKE_ENTITY_ACCESS_MUTATION,
} from '@/lib/graphql';

export interface AccessGrant {
  id: string;
  granteeType: string;
  roleId: string | null;
  userId: string | null;
  granteeLabel: string | null;
  accessLevel: string;
  includeChildren: boolean;
}

interface RoleOption {
  id: string;
  roleName: string;
  roleCode: string;
}

export function EntityRoleAccess({
  clientId,
  entityId,
  entityName,
  domainCode,
  restricted,
  grants,
  onChanged,
  compact = false,
}: {
  clientId: string;
  entityId: string;
  entityName: string;
  domainCode?: string;
  restricted: boolean;
  grants: AccessGrant[];
  onChanged: () => void;
  compact?: boolean;
}) {
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [levels, setLevels] = useState<Record<string, '' | 'READ' | 'WRITE'>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    graphqlClient.query(ROLES_QUERY, { clientId }).toPromise().then((result) => {
      if (cancelled) return;
      setRoles(result.data?.roles ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    const next: Record<string, '' | 'READ' | 'WRITE'> = {};
    for (const grant of grants) {
      if (grant.granteeType === 'ROLE' && grant.roleId) {
        next[grant.roleId] = grant.accessLevel === 'WRITE' ? 'WRITE' : 'READ';
      }
    }
    setLevels(next);
  }, [grants]);

  const roleGrants = grants.filter((grant) => grant.granteeType === 'ROLE');
  const userGrants = grants.filter((grant) => grant.granteeType === 'USER');
  const inherited = restricted && grants.length === 0;

  const summary = useMemo(() => {
    if (inherited) {
      return 'A parent entity is closed. People who can open that parent can open this entity and everything under it. Roles you add here grant extra access; they do not widen past the parent.';
    }
    if (roleGrants.length > 0 || userGrants.length > 0) {
      return 'Only the roles below can open this entity. Everyone else in the client is blocked, including every child entity. Client administrators can still open it to change this list.';
    }
    return 'Open to anyone in the client who can view entities. Choose one or more roles to close this entity and its children.';
  }, [inherited, roleGrants.length, userGrants.length]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const selected = Object.entries(levels)
      .filter(([, level]) => level === 'READ' || level === 'WRITE')
      .map(([roleId, accessLevel]) => ({ roleId, accessLevel }));
    const result = await graphqlClient
      .mutation(SET_ENTITY_ROLE_ACCESS_MUTATION, { clientId, entityId, roles: selected })
      .toPromise();
    setSaving(false);
    if (result.error || !result.data?.setEntityRoleAccess?.success) {
      setMessage(result.error?.message ?? result.data?.setEntityRoleAccess?.errors?.[0]?.message ?? 'Could not save access');
      return;
    }
    setMessage(selected.length === 0 ? 'Role restriction removed.' : 'Access saved. Children follow this list.');
    onChanged();
  };

  const revokeUser = async (id: string) => {
    setMessage(null);
    const result = await graphqlClient.mutation(REVOKE_ENTITY_ACCESS_MUTATION, { id }).toPromise();
    if (result.error || !result.data?.revokeEntityAccess?.success) {
      setMessage(result.error?.message ?? 'Could not remove that grant');
      return;
    }
    onChanged();
  };

  return (
    <div>
      {!compact && (
        <div style={{ marginBottom: 8, fontWeight: 600 }}>
          {entityName}
          {domainCode ? <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}> · {domainCode}</span> : null}
        </div>
      )}
      <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.45, color: 'var(--ink-2)' }}>{summary}</p>
      <div style={{ display: 'grid', gap: 8 }}>
        {roles.map((role) => (
          <label key={role.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', fontSize: 13 }}>
            <span>{role.roleName}</span>
            <select
              value={levels[role.id] ?? ''}
              onChange={(event) => setLevels((prev) => ({ ...prev, [role.id]: event.target.value as '' | 'READ' | 'WRITE' }))}
              style={{ minWidth: 120, padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface)' }}
            >
              <option value="">No access</option>
              <option value="READ">Read</option>
              <option value="WRITE">Write</option>
            </select>
          </label>
        ))}
        {roles.length === 0 && <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>No roles for this client yet.</div>}
      </div>
      {userGrants.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <div style={{ marginBottom: 6, color: 'var(--ink-3)' }}>Also granted to specific people</div>
          {userGrants.map((grant) => (
            <div key={grant.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span>{grant.granteeLabel || grant.userId} · {grant.accessLevel}</span>
              <button type="button" className="btn" onClick={() => revokeUser(grant.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {message && <div style={{ marginTop: 10, fontSize: 13, color: message.includes('saved') || message.includes('removed') ? 'var(--accent)' : 'var(--red)' }}>{message}</div>}
      <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save access'}
      </button>
    </div>
  );
}
