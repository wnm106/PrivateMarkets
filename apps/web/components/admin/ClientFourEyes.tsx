'use client';

import { useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';

/**
 * Staff turn four eyes on for a client: a second person approves manual
 * values, and workflow reviews always need someone other than the person
 * who started the run (20261126120000_four_eyes_approvals).
 */
export function ClientFourEyes({ clientId, onError }: { clientId: string; onError: (message: string | null) => void }) {
  const [required, setRequired] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    setRequired(null);
    void graphqlQuery<{ clientFourEyes: boolean }>(`query ClientFourEyes($clientId: ID!) { clientFourEyes(clientId: $clientId) }`, { clientId }, 'network-only').then((result) => {
      if (!live) return;
      if (result.error) onError(result.error.message);
      setRequired(result.data?.clientFourEyes ?? false);
    });
    return () => {
      live = false;
    };
  }, [clientId, onError]);

  const save = async (next: boolean) => {
    setSaving(true);
    const result = await graphqlMutation<{ setClientFourEyes: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation SetClientFourEyes($clientId: ID!, $required: Boolean!) { setClientFourEyes(clientId: $clientId, required: $required) { success errors { message } } }`,
      { clientId, required: next },
    );
    setSaving(false);
    const error = result.error?.message || result.data?.setClientFourEyes?.errors?.[0]?.message;
    if (error || !result.data?.setClientFourEyes?.success) {
      onError(error || 'Could not change the approval rule');
      return;
    }
    onError(null);
    setRequired(next);
  };

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3">
      <h3 className="font-semibold">Approvals</h3>
      <p className="text-sm text-gray-600">
        With four eyes on, a manual value entered by anyone in this client takes effect only when someone else with the approve manual values permission approves it under Approvals, and a workflow review always needs someone other than the person who started the run. Client administrators and data stewards hold the permission by default.
      </p>
      {required === null ? <div className="text-gray-500">Loading…</div> : (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={required} disabled={saving} onChange={(event) => save(event.target.checked)} />
          Require a second person to approve manual values and workflow reviews
        </label>
      )}
    </div>
  );
}
