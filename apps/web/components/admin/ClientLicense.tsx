'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { graphqlClient, CLIENT_LICENSE_QUERY, LICENSE_WORKFLOWS_QUERY, SET_CLIENT_LICENSE_SWITCH_MUTATION } from '@/lib/graphql';
import { SURFACES } from '@/lib/surface-registry';
import { LICENSED_PAGES } from '@/lib/tool-pages';
import { TOOL_GROUPS, TOOL_GROUP_CODES } from '@tapestrai/mcp-server/src/lib/tool-groups';

type Kind = 'surface' | 'workflow' | 'tool' | 'assistant_tool';

interface LicenseClient {
  id: string;
  clientName: string;
  curatedModules: boolean;
}

interface CatalogItem {
  kind: Kind;
  code: string;
  name: string;
  description?: string;
}

interface LicenseState {
  kind: Kind;
  code: string;
  planEnabled: boolean;
  switchEnabled: boolean | null;
  note: string | null;
  enabled: boolean;
}

const SECTIONS: { kind: Kind; title: string; help: string }[] = [
  { kind: 'surface', title: 'Surfaces', help: 'Screens mounted at /s/<code>. Off hides the surface from the sidebar and home page, and its address shows not found.' },
  { kind: 'workflow', title: 'Shared workflows', help: 'Off hides the workflow and refuses new runs, including runs started by a trigger. Runs already going finish. Workflows the client built itself are not licensed.' },
  { kind: 'tool', title: 'Pages', help: 'Off hides the page from the sidebar and home page, and its address goes back to home.' },
  { kind: 'assistant_tool', title: 'Assistant tool groups', help: 'Used by the chat assistant, the MCP endpoint and workflow agent steps. Off means the tools are not offered and a call to one is refused.' },
];

const key = (kind: string, code: string) => `${kind}:${code}`;

function choiceOf(state: LicenseState | undefined): 'plan' | 'on' | 'off' {
  if (!state || state.switchEnabled === null) return 'plan';
  return state.switchEnabled ? 'on' : 'off';
}

export function ClientLicense({
  clients,
  selectedClientId,
  onSelectClient,
  onError,
}: {
  clients: LicenseClient[];
  selectedClientId: string;
  onSelectClient: (id: string) => void;
  onError: (message: string | null) => void;
}) {
  const [workflows, setWorkflows] = useState<CatalogItem[]>([]);
  const [states, setStates] = useState<Map<string, LicenseState>>(new Map());
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const client = clients.find((item) => item.id === selectedClientId) ?? null;

  useEffect(() => {
    graphqlClient.query(LICENSE_WORKFLOWS_QUERY, {}, { requestPolicy: 'network-only' }).toPromise().then((result) => {
      if (result.error) { onError(result.error.message); return; }
      const shared = ((result.data?.workflows ?? []) as { clientId: string | null; code: string; name: string }[])
        .filter((workflow) => !workflow.clientId)
        .map((workflow) => ({ kind: 'workflow' as const, code: workflow.code, name: workflow.name }));
      setWorkflows(shared);
    });
  }, []);

  const catalog = useMemo<CatalogItem[]>(() => [
    ...SURFACES.map(({ manifest }) => ({ kind: 'surface' as const, code: manifest.code, name: manifest.title, description: manifest.description })),
    ...workflows,
    ...LICENSED_PAGES.map((page) => ({ kind: 'tool' as const, code: page.href, name: page.label })),
    ...TOOL_GROUP_CODES.map((code) => ({ kind: 'assistant_tool' as const, code, name: TOOL_GROUPS[code].name, description: TOOL_GROUPS[code].description })),
  ], [workflows]);

  const load = useCallback(async () => {
    if (!selectedClientId) return;
    setLoading(true);
    try {
      const result = await graphqlClient.query(CLIENT_LICENSE_QUERY, {
        clientId: selectedClientId,
        items: catalog.map(({ kind, code }) => ({ kind, code })),
      }, { requestPolicy: 'network-only' }).toPromise();
      if (result.error) { onError(result.error.message); return; }
      const rows = (result.data?.clientLicense ?? []) as LicenseState[];
      setStates(new Map(rows.map((row) => [key(row.kind, row.code), row])));
    } finally {
      setLoading(false);
    }
  }, [selectedClientId, catalog]);

  useEffect(() => { void load(); }, [load]);

  const setSwitch = async (item: CatalogItem, choice: 'plan' | 'on' | 'off') => {
    if (!client) return;
    const itemKey = key(item.kind, item.code);
    setSavingKey(itemKey);
    onError(null);
    try {
      const result = await graphqlClient.mutation(SET_CLIENT_LICENSE_SWITCH_MUTATION, {
        clientId: client.id,
        kind: item.kind,
        code: item.code,
        enabled: choice === 'plan' ? null : choice === 'on',
      }).toPromise();
      if (result.error) { onError(result.error.message); return; }
      if (!result.data?.setClientLicenseSwitch?.success) {
        onError(result.data?.setClientLicenseSwitch?.errors?.[0]?.message ?? 'Could not change this license');
        return;
      }
      await load();
    } finally {
      setSavingKey(null);
    }
  };

  // A switch on an item this screen no longer lists (a removed surface, a retired workflow) is still shown, so it can be cleared.
  const listed = new Set(catalog.map((item) => key(item.kind, item.code)));
  const orphans: CatalogItem[] = [...states.values()]
    .filter((state) => !listed.has(key(state.kind, state.code)))
    .map((state) => ({ kind: state.kind, code: state.code, name: state.code, description: 'No longer in the product. Clear the switch to tidy up.' }));

  const offCount = [...states.values()].filter((state) => !state.enabled).length;
  const switchCount = [...states.values()].filter((state) => state.switchEnabled !== null).length;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <div>
          <div className="text-[13px] font-medium text-gray-900">License</div>
          <p className="text-[12px] text-gray-600 mt-1 max-w-3xl">
            Turn one surface, workflow, page or assistant tool group on or off for one client. A switch overrides the client&apos;s modules either way.
            Follow plan removes the switch, so the item goes back to what the modules give. Records are never deleted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedClientId}
            onChange={(event) => onSelectClient(event.target.value)}
            className="px-3 py-2 border rounded text-[13px]"
            aria-label="Client"
          >
            {clients.map((item) => (
              <option key={item.id} value={item.id}>{item.clientName}</option>
            ))}
          </select>
          {client && (
            <span className="text-[13px] text-gray-700">
              {client.curatedModules ? 'Curated: the plan is the modules saved on the Clients tab.' : 'Full catalog: the plan is everything on.'}
              {' '}{switchCount === 0 ? 'No switches.' : `${switchCount} switch${switchCount === 1 ? '' : 'es'}.`}
              {' '}{offCount === 0 ? 'Nothing off.' : `${offCount} item${offCount === 1 ? '' : 's'} off.`}
            </span>
          )}
        </div>
      </div>

      {loading && states.size === 0 ? (
        <div className="text-center py-8 text-[13px] text-gray-500">Loading…</div>
      ) : (
        [...SECTIONS, ...(orphans.length ? [{ kind: 'orphan' as const, title: 'Switches on retired items', help: '' }] : [])].map((section) => {
          const items = section.kind === 'orphan' ? orphans : catalog.filter((item) => item.kind === section.kind);
          return (
            <div key={section.kind} className="bg-white rounded-lg shadow overflow-x-auto">
              <div className="px-4 pt-4 pb-2">
                <div className="text-[13px] font-medium text-gray-900">{section.title}</div>
                {section.help && <p className="text-[12px] text-gray-600 mt-1">{section.help}</p>}
              </div>
              {items.length === 0 ? (
                <p className="px-4 pb-4 text-[13px] text-gray-500">None in the product yet.</p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-y border-gray-200 text-left text-gray-600">
                      <th className="px-4 py-2 font-medium">Item</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Plan</th>
                      <th className="px-4 py-2 font-medium">Switch</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const itemKey = key(item.kind, item.code);
                      const state = states.get(itemKey);
                      const choice = choiceOf(state);
                      return (
                        <tr key={itemKey} className="border-b border-gray-100 align-top">
                          <td className="px-4 py-2">
                            <div className="font-medium text-gray-900">{item.name}</div>
                            <div className="text-[12px] text-gray-500 break-all">{item.code}</div>
                            {item.description && <div className="text-[12px] text-gray-600">{item.description}</div>}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap text-gray-700">{state ? (state.planEnabled ? 'On' : 'Off') : '…'}</td>
                          <td className="px-4 py-2">
                            <select
                              value={choice}
                              disabled={!state || savingKey === itemKey}
                              onChange={(event) => void setSwitch(item, event.target.value as 'plan' | 'on' | 'off')}
                              className="px-2 py-1 border rounded text-[13px]"
                              aria-label={`License switch for ${item.name}`}
                            >
                              <option value="plan">Follow plan</option>
                              <option value="on">On</option>
                              <option value="off">Off</option>
                            </select>
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            {state ? (
                              <span className={`inline-block rounded px-2 py-0.5 text-[12px] font-medium ${state.enabled ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                                {state.enabled ? 'On' : 'Off'}
                              </span>
                            ) : '…'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
