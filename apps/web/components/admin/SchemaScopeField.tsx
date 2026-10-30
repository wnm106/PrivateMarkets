'use client';

import { useEffect, useState } from 'react';
import { CLIENTS_QUERY, ME_QUERY, graphqlClient } from '@/lib/graphql';

interface ScopeOption {
  id: string;
  name: string;
}

export function SchemaScopeBadge({
  clientId,
  clientName,
}: {
  clientId?: string | null;
  clientName?: string | null;
}) {
  const label = clientId ? clientName || 'Client' : 'Global';
  return (
    <span
      style={{
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'none',
        padding: '2px 6px',
        border: '1px solid var(--line)',
        color: clientId ? 'var(--accent-2)' : 'var(--ink-3)',
      }}
    >
      {label}
    </span>
  );
}

export function SchemaScopeField({
  value,
  onChange,
  owner,
  allowGlobal = true,
}: {
  value: string | null;
  onChange: (clientId: string | null) => void;
  owner?: { id: string; name: string } | null;
  allowGlobal?: boolean;
}) {
  const [lockedLabel, setLockedLabel] = useState<string | null>(null);
  const [options, setOptions] = useState<ScopeOption[]>([]);
  const [showGlobal, setShowGlobal] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadScope() {
      if (owner?.id) {
        setLockedLabel(owner.name || 'This client');
        setShowGlobal(false);
        onChange(owner.id);
        setReady(true);
        return;
      }

      const meResult = await graphqlClient.query(ME_QUERY, {}).toPromise();
      const me = meResult.data?.me;
      if (!me || cancelled) return;

      if (me.impersonating?.clientId) {
        setLockedLabel(me.impersonating.clientName || 'This client');
        setShowGlobal(false);
        onChange(me.impersonating.clientId);
        setReady(true);
        return;
      }

      if (me.isTenantAdmin) {
        const clientsResult = await graphqlClient.query(CLIENTS_QUERY, {}).toPromise();
        const clients = (clientsResult.data?.clients || []).filter((client: { isActive?: boolean }) => client.isActive !== false);
        if (cancelled) return;
        setOptions(clients.map((client: { id: string; clientName: string }) => ({ id: client.id, name: client.clientName })));
        setShowGlobal(allowGlobal);
        onChange(allowGlobal ? null : clients[0]?.id ?? null);
        setReady(true);
        return;
      }

      const clients = me.clients || [];
      if (clients.length <= 1) {
        setLockedLabel(clients[0]?.clientName || 'This client');
        onChange(clients[0]?.id ?? null);
        setReady(true);
        return;
      }

      setOptions(clients.map((client: { id: string; clientName: string }) => ({ id: client.id, name: client.clientName })));
      setShowGlobal(false);
      onChange(clients[0].id);
      setReady(true);
    }

    loadScope();
    return () => {
      cancelled = true;
    };
    // Publish the initial scope once. The parent setter is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.id, owner?.name, allowGlobal]);

  if (!ready) {
    return (
      <div className="field">
        <label>Scope</label>
        <input className="text-input" value="Loading scope..." disabled />
      </div>
    );
  }

  if (lockedLabel) {
    return (
      <div className="field">
        <label>Scope</label>
        <input className="text-input" value={lockedLabel} disabled />
      </div>
    );
  }

  return (
    <div className="field">
      <label>Scope</label>
      <select
        className="select"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {showGlobal && <option value="">Global</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
        {showGlobal
          ? 'Global definitions are shared. A client scope is visible only to that client. Codes stay unique across the platform.'
          : 'This record belongs to the selected client. Codes stay unique across the platform.'}
      </div>
    </div>
  );
}
