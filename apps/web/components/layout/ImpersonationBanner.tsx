'use client';

import { useEffect, useState } from 'react';
import { graphqlClient } from '@/lib/graphql';
import { ME_QUERY, CLIENTS_QUERY, START_IMPERSONATION_MUTATION, STOP_IMPERSONATION_MUTATION } from '@/lib/graphql';

interface Me {
  id: string;
  isTenantAdmin: boolean;
  clients: { id: string; clientName: string }[];
  impersonating: { clientId: string; clientName: string | null; reason: string | null } | null;
}

/**
 * Shown only to tenant admins (tapestr.ai support staff). Lets them "simulate"
 * a specific client's experience -- all subsequent reads/writes are scoped to
 * that client via RLS (tenancy.current_client_ids()) until they stop.
 */
export function ImpersonationBanner() {
  const [me, setMe] = useState<Me | null>(null);
  const [clients, setClients] = useState<{ id: string; clientName: string }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const result = await graphqlClient.query(ME_QUERY, {}).toPromise();
    const meData = result.data?.me ?? null;
    setMe(meData);
    if (meData?.isTenantAdmin) {
      const clientsResult = await graphqlClient.query(CLIENTS_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      setClients(clientsResult.data?.clients ?? []);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!me?.isTenantAdmin) return null;

  const handleStart = async () => {
    if (!selected) return;
    setBusy(true);
    await graphqlClient.mutation(START_IMPERSONATION_MUTATION, { clientId: selected, reason: 'support' }).toPromise();
    setBusy(false);
    await load();
    window.location.reload();
  };

  const handleStop = async () => {
    setBusy(true);
    await graphqlClient.mutation(STOP_IMPERSONATION_MUTATION, {}).toPromise();
    setBusy(false);
    await load();
    window.location.reload();
  };

  return (
    <div
      style={{
        background: me.impersonating ? '#7c2d12' : 'var(--brand-navy)',
        color: '#fff',
        padding: '6px 16px',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        borderBottom: '1px solid var(--line-strong)',
      }}
    >
      {me.impersonating ? (
        <>
          <span>
            🛟 Support mode: viewing as <strong>{me.impersonating.clientName}</strong>
          </span>
          <button
            disabled={busy}
            onClick={handleStop}
            style={{ background: '#fff', color: '#7c2d12', border: 'none', borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
          >
            Stop impersonating
          </button>
        </>
      ) : (
        <>
          <span>Tenant admin:</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, border: 'none' }}
          >
            <option value="">Select a client to simulate…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientName}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !selected}
            onClick={handleStart}
            style={{ background: 'var(--accent-2, #4ade80)', color: '#111', border: 'none', borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
          >
            Simulate client
          </button>
        </>
      )}
    </div>
  );
}
