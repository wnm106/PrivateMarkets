'use client';

import { useEffect, useState } from 'react';
import { samlServiceProvider } from '@tapestrai/graphql/src/lib/enterprise-sso';
import {
  CLIENT_AUTH_REQUIREMENTS_QUERY,
  DELETE_CLIENT_IDENTITY_PROVIDER_MUTATION,
  UPDATE_CLIENT_AUTH_REQUIREMENTS_MUTATION,
  UPSERT_CLIENT_IDENTITY_PROVIDER_MUTATION,
  graphqlClient,
} from '@/lib/graphql';

interface ClientOption {
  id: string;
  clientName: string;
}

interface Requirements {
  passwordEnabled: boolean;
  mfaRequired: boolean;
  emailDomains: string[];
}

interface IdentityProvider {
  id: string;
  provider: 'EMAIL' | 'AZURE' | 'SAML' | 'OIDC';
  displayName: string | null;
  emailDomain: string | null;
  azureTenantId: string | null;
  samlMetadataUrl: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  registrationStatus: string;
  registrationError: string | null;
  isEnabled: boolean;
}

const PROTOCOL_LABEL: Record<IdentityProvider['provider'], string> = {
  AZURE: 'Microsoft Entra ID',
  SAML: 'SAML 2.0',
  OIDC: 'OpenID Connect',
  EMAIL: 'Email domain',
};

const EMPTY_FORM = {
  id: '',
  provider: 'SAML' as IdentityProvider['provider'],
  displayName: '',
  emailDomain: '',
  azureTenantId: '',
  samlMetadataUrl: '',
  samlMetadataXml: '',
  oidcIssuer: '',
  oidcClientId: '',
  oidcClientSecret: '',
};

export function ClientAuthentication({
  clients,
  selectedClientId,
  onSelectClient,
  onError,
}: {
  clients: ClientOption[];
  selectedClientId: string;
  onSelectClient: (id: string) => void;
  onError: (message: string | null) => void;
}) {
  const [requirements, setRequirements] = useState<Requirements>({ passwordEnabled: true, mfaRequired: false, emailDomains: [] });
  const [domains, setDomains] = useState('');
  const [providers, setProviders] = useState<IdentityProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const service = samlServiceProvider(process.env.NEXT_PUBLIC_SUPABASE_URL || '');

  const load = async (clientId: string) => {
    if (!clientId) return;
    setLoading(true);
    const result = await graphqlClient.query(CLIENT_AUTH_REQUIREMENTS_QUERY, { clientId }, { requestPolicy: 'network-only' }).toPromise();
    setLoading(false);
    if (result.error) {
      onError(result.error.message);
      return;
    }
    const next = result.data?.clientAuthRequirements;
    const loaded = {
      passwordEnabled: next?.passwordEnabled ?? true,
      mfaRequired: next?.mfaRequired ?? false,
      emailDomains: next?.emailDomains ?? [],
    };
    setRequirements(loaded);
    setDomains(loaded.emailDomains.join(', '));
    setProviders(result.data?.clientIdentityProviders ?? []);
  };

  useEffect(() => {
    load(selectedClientId);
  }, [selectedClientId]);

  const saveRequirements = async () => {
    setSaving(true);
    const emailDomains = domains.split(/[,\s]+/).map((domain) => domain.trim()).filter(Boolean);
    const result = await graphqlClient.mutation(UPDATE_CLIENT_AUTH_REQUIREMENTS_MUTATION, {
      input: {
        clientId: selectedClientId,
        passwordEnabled: requirements.passwordEnabled,
        mfaRequired: requirements.mfaRequired,
        emailDomains,
      },
    }).toPromise();
    setSaving(false);
    const payload = result.data?.updateClientAuthRequirements;
    if (result.error || !payload?.success) {
      onError(result.error?.message ?? payload?.errors?.[0]?.message ?? 'Could not save authentication');
      return;
    }
    onError(null);
    load(selectedClientId);
  };

  const saveProvider = async () => {
    setSaving(true);
    const result = await graphqlClient.mutation(UPSERT_CLIENT_IDENTITY_PROVIDER_MUTATION, {
      input: {
        id: form.id || null,
        clientId: selectedClientId,
        provider: form.provider,
        displayName: form.displayName || null,
        emailDomain: form.emailDomain || null,
        azureTenantId: form.provider === 'AZURE' ? form.azureTenantId : null,
        samlMetadataUrl: form.provider === 'SAML' ? form.samlMetadataUrl || null : null,
        samlMetadataXml: form.provider === 'SAML' ? form.samlMetadataXml || null : null,
        oidcIssuer: form.provider === 'OIDC' ? form.oidcIssuer || null : null,
        oidcClientId: form.provider === 'OIDC' ? form.oidcClientId || null : null,
        oidcClientSecret: form.provider === 'OIDC' ? form.oidcClientSecret || null : null,
        isEnabled: true,
      },
    }).toPromise();
    setSaving(false);
    const payload = result.data?.upsertClientIdentityProvider;
    if (result.error || !payload?.success) {
      onError(result.error?.message ?? payload?.errors?.[0]?.message ?? 'Could not save the identity provider');
      load(selectedClientId);
      return;
    }
    onError(null);
    setShowForm(false);
    setForm(EMPTY_FORM);
    load(selectedClientId);
  };

  const removeProvider = async (id: string) => {
    const result = await graphqlClient.mutation(DELETE_CLIENT_IDENTITY_PROVIDER_MUTATION, { id }).toPromise();
    const payload = result.data?.deleteClientIdentityProvider;
    if (result.error || !payload?.success) {
      onError(result.error?.message ?? payload?.errors?.[0]?.message ?? 'Could not remove the identity provider');
      return;
    }
    load(selectedClientId);
  };

  const activeSso = providers.some((provider) => provider.isEnabled && provider.registrationStatus === 'active' && provider.provider !== 'EMAIL');
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <div className="space-y-4">
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
        <select value={selectedClientId} onChange={(event) => onSelectClient(event.target.value)} className="px-3 py-2 border rounded">
          {clients.map((client) => <option key={client.id} value={client.id}>{client.clientName}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <h3 className="font-semibold">Sign-in requirements</h3>
        <p className="text-sm text-gray-600">
          People are routed by email domain. Microsoft Entra ID uses the shared directory app and is limited to the tenant id you enter. SAML 2.0 and OpenID Connect register that client&apos;s own identity provider. Local auth already enforces these rules. On a hosted project, enable the Postgres hook <span className="font-mono">tenancy.custom_access_token_hook</span> once under Authentication hooks.
        </p>
        {loading ? <div className="text-gray-500">Loading…</div> : (
          <>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Email domains</span>
              <input value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="acmecapital.com, acme.com" className="mt-1 w-full px-3 py-2 border rounded" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={requirements.passwordEnabled} onChange={(event) => setRequirements((current) => ({ ...current, passwordEnabled: event.target.checked }))} />
              Allow email and password
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={requirements.mfaRequired} onChange={(event) => setRequirements((current) => ({ ...current, mfaRequired: event.target.checked }))} />
              Require an authenticator app
            </label>
            {!requirements.passwordEnabled && !activeSso && (
              <p className="text-sm text-amber-800">Password is off and no identity provider is active, so people at these domains cannot sign in until a connection succeeds.</p>
            )}
            {!requirements.passwordEnabled && (
              <p className="text-sm text-gray-600">Email invites are turned off for this client. People join the first time they sign in with the identity provider.</p>
            )}
            <button type="button" className="btn btn-primary" disabled={saving || !selectedClientId} onClick={saveRequirements}>
              {saving ? 'Saving…' : 'Save requirements'}
            </button>
          </>
        )}
      </div>

      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Identity providers</h3>
          <button type="button" className="btn" onClick={() => { setForm(EMPTY_FORM); setShowForm((open) => !open); }}>
            Add a connection
          </button>
        </div>
        <ul className="space-y-2">
          {providers.map((provider) => (
            <li key={provider.id} className="border rounded p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <strong>{provider.displayName || PROTOCOL_LABEL[provider.provider]}</strong>
                  <span className="text-gray-500"> · {PROTOCOL_LABEL[provider.provider]}</span>
                  <div className="text-gray-600">
                    {provider.emailDomain || 'No domain'}
                    {provider.azureTenantId ? ` · tenant ${provider.azureTenantId}` : ''}
                    {provider.registrationStatus !== 'active' ? ` · ${provider.registrationStatus}` : ''}
                  </div>
                  {provider.registrationError && <div className="text-red-700 mt-1">{provider.registrationError}</div>}
                </div>
                <div className="flex gap-2">
                  {provider.provider !== 'EMAIL' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setForm({
                          id: provider.id,
                          provider: provider.provider,
                          displayName: provider.displayName || '',
                          emailDomain: provider.emailDomain || '',
                          azureTenantId: provider.azureTenantId || '',
                          samlMetadataUrl: provider.samlMetadataUrl || '',
                          samlMetadataXml: '',
                          oidcIssuer: provider.oidcIssuer || '',
                          oidcClientId: provider.oidcClientId || '',
                          oidcClientSecret: '',
                        });
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" onClick={() => removeProvider(provider.id)}>Remove</button>
                </div>
              </div>
            </li>
          ))}
          {providers.length === 0 && <li className="text-sm text-gray-500">No identity provider yet.</li>}
        </ul>

        {showForm && (
          <div className="border-t pt-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <select value={form.provider} onChange={(event) => set({ provider: event.target.value as IdentityProvider['provider'] })} className="px-3 py-2 border rounded text-sm" disabled={Boolean(form.id)}>
                <option value="AZURE">Microsoft Entra ID</option>
                <option value="SAML">SAML 2.0</option>
                <option value="OIDC">OpenID Connect</option>
              </select>
              <input value={form.displayName} onChange={(event) => set({ displayName: event.target.value })} placeholder="Name people see, e.g. Acme Okta" className="px-3 py-2 border rounded text-sm" />
            </div>
            <input value={form.emailDomain} onChange={(event) => set({ emailDomain: event.target.value })} placeholder="Email domain, e.g. acmecapital.com" className="w-full px-3 py-2 border rounded text-sm" />
            {form.provider === 'AZURE' && (
              <input value={form.azureTenantId} onChange={(event) => set({ azureTenantId: event.target.value })} placeholder="Directory (tenant) ID" className="w-full px-3 py-2 border rounded text-sm" />
            )}
            {form.provider === 'SAML' && (
              <>
                <input value={form.samlMetadataUrl} onChange={(event) => set({ samlMetadataUrl: event.target.value })} placeholder="https://idp.example.com/metadata" className="w-full px-3 py-2 border rounded text-sm" />
                <textarea value={form.samlMetadataXml} onChange={(event) => set({ samlMetadataXml: event.target.value })} placeholder="Or paste SAML metadata XML" rows={4} className="w-full px-3 py-2 border rounded text-sm font-mono" />
                <p className="text-xs text-gray-500">Give the client these service-provider values. NameID must be an email address.</p>
                <dl className="text-xs text-gray-700 space-y-1">
                  <div><dt className="inline font-medium">Entity ID </dt><dd className="inline break-all">{service.entityId}</dd></div>
                  <div><dt className="inline font-medium">ACS URL </dt><dd className="inline break-all">{service.acsUrl}</dd></div>
                  <div><dt className="inline font-medium">Metadata </dt><dd className="inline break-all">{service.metadataUrl}</dd></div>
                </dl>
              </>
            )}
            {form.provider === 'OIDC' && (
              <>
                <input value={form.oidcIssuer} onChange={(event) => set({ oidcIssuer: event.target.value })} placeholder="https://issuer.example.com" className="w-full px-3 py-2 border rounded text-sm" />
                <input value={form.oidcClientId} onChange={(event) => set({ oidcClientId: event.target.value })} placeholder="Client ID" className="w-full px-3 py-2 border rounded text-sm" />
                <input type="password" value={form.oidcClientSecret} onChange={(event) => set({ oidcClientSecret: event.target.value })} placeholder="Client secret" autoComplete="new-password" className="w-full px-3 py-2 border rounded text-sm" />
                <p className="text-xs text-gray-500">The secret is sent to the Auth server and is not stored in the client record. Register this redirect URI with the identity provider: {service.oidcRedirectUri}</p>
              </>
            )}
            <button type="button" className="btn btn-primary" disabled={saving} onClick={saveProvider}>
              {saving ? 'Saving…' : 'Save connection'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
