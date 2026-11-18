/**
 * Per-client enterprise sign-in: SAML 2.0, OpenID Connect, and Microsoft Entra ID.
 *
 * Identity-provider secrets are sent to the Auth server and are not stored on
 * the client row. Discovery responses are parsed through an allow-list so a
 * database payload cannot add fields the login page should not see.
 */

export type AuthProtocol = 'password' | 'azure' | 'saml' | 'oidc';

export type IdentityProviderKind = 'EMAIL' | 'AZURE' | 'SAML' | 'OIDC';

export type SignInMethod = {
  protocol: AuthProtocol;
  label: string;
  domain?: string;
  identifier?: string;
};

export type SignInDiscovery = {
  matched: boolean;
  password: boolean;
  mfa_required: boolean;
  organization: string | null;
  message: string | null;
  methods: SignInMethod[];
};

export type IdentityProviderWrite = {
  provider: IdentityProviderKind;
  displayName: string | null;
  emailDomain: string | null;
  azureTenantId: string | null;
  samlMetadataUrl: string | null;
  samlMetadataXml: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  isEnabled: boolean;
};

export type StoredIdentityProvider = {
  provider: IdentityProviderKind;
  emailDomain: string | null;
  samlMetadataUrl: string | null;
  samlMetadataXml: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  oidcIdentifier: string | null;
  ssoProviderId: string | null;
  displayName: string | null;
  isEnabled: boolean;
};

export type RegistrationResult = {
  registrationStatus: 'active' | 'error' | 'pending';
  ssoProviderId: string | null;
  oidcIdentifier: string | null;
  registrationError: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PROTOCOLS = new Set<AuthProtocol>(['password', 'azure', 'saml', 'oidc']);

export const PLATFORM_DISCOVERY: SignInDiscovery = {
  matched: false,
  password: true,
  mfa_required: false,
  organization: null,
  message: null,
  methods: [
    { protocol: 'password', label: 'Email and password' },
    { protocol: 'azure', label: 'Microsoft' },
  ],
};

export function normalizeEmailDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const domain = value.trim().toLowerCase().replace(/^@/, '');
  if (!domain || !DOMAIN_RE.test(domain)) {
    throw new Error('Enter a domain like acmecapital.com');
  }
  return domain;
}

export function normalizeEmailDomains(values: string[]): string[] {
  const domains = values.map((value) => normalizeEmailDomain(value)).filter((value): value is string => Boolean(value));
  return Array.from(new Set(domains)).sort();
}

export function oidcIdentifier(domain: string): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `custom:${slug || 'client'}`;
}

export function samlServiceProvider(supabaseUrl: string) {
  const base = supabaseUrl.replace(/\/$/, '');
  return {
    entityId: `${base}/auth/v1/sso/saml/metadata`,
    metadataUrl: `${base}/auth/v1/sso/saml/metadata`,
    acsUrl: `${base}/auth/v1/sso/saml/acs`,
    sloUrl: `${base}/auth/v1/sso/slo`,
    oidcRedirectUri: `${base}/auth/v1/callback`,
  };
}

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

export function assertIdentityProviderInput(input: IdentityProviderWrite, options?: { secretRequired?: boolean }): IdentityProviderWrite {
  const provider = input.provider;
  if (provider !== 'EMAIL' && provider !== 'AZURE' && provider !== 'SAML' && provider !== 'OIDC') {
    throw new Error('Choose Microsoft Entra ID, SAML 2.0, or OpenID Connect');
  }
  const emailDomain = input.emailDomain ? normalizeEmailDomain(input.emailDomain) : null;
  const displayName = clean(input.displayName);
  const azureTenantId = clean(input.azureTenantId);
  const samlMetadataUrl = clean(input.samlMetadataUrl);
  const samlMetadataXml = clean(input.samlMetadataXml);
  const oidcIssuer = clean(input.oidcIssuer);
  const oidcClientId = clean(input.oidcClientId);
  const oidcClientSecret = clean(input.oidcClientSecret);

  if (provider !== 'AZURE' && !emailDomain) {
    throw new Error('An email domain is required so people from that organization are routed here');
  }
  if (provider === 'AZURE') {
    if (!azureTenantId || !UUID_RE.test(azureTenantId)) {
      throw new Error('Microsoft Entra ID needs the directory (tenant) ID');
    }
  }
  if (provider === 'SAML') {
    if (!samlMetadataUrl && !samlMetadataXml) {
      throw new Error('SAML 2.0 needs a metadata URL or a metadata XML file');
    }
    if (samlMetadataUrl && !httpsUrl(samlMetadataUrl)) {
      throw new Error('The SAML metadata URL must start with https://');
    }
    if (samlMetadataXml && !/entitydescriptor/i.test(samlMetadataXml)) {
      throw new Error('The SAML metadata XML must contain an EntityDescriptor');
    }
    if (samlMetadataXml && samlMetadataXml.length > 200_000) {
      throw new Error('SAML metadata XML is too large');
    }
  }
  if (provider === 'OIDC') {
    if (!oidcIssuer || !httpsUrl(oidcIssuer)) {
      throw new Error('OpenID Connect needs an https issuer URL');
    }
    if (!oidcClientId) throw new Error('OpenID Connect needs a client ID');
    if (options?.secretRequired !== false && !oidcClientSecret) {
      throw new Error('OpenID Connect needs a client secret');
    }
  }

  return {
    provider,
    displayName,
    emailDomain,
    azureTenantId: azureTenantId ? azureTenantId.toLowerCase() : null,
    samlMetadataUrl,
    samlMetadataXml,
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    isEnabled: input.isEnabled !== false,
  };
}

/** Columns written to tenancy.client_identity_providers. The client secret is never included. */
export function toIdentityProviderRow(input: IdentityProviderWrite, oidcId: string | null) {
  return {
    provider: input.provider,
    display_name: input.displayName,
    email_domain: input.emailDomain,
    azure_tenant_id: input.provider === 'AZURE' ? input.azureTenantId : null,
    saml_metadata_url: input.provider === 'SAML' ? input.samlMetadataUrl : null,
    saml_metadata_xml: input.provider === 'SAML' ? input.samlMetadataXml : null,
    oidc_issuer: input.provider === 'OIDC' ? input.oidcIssuer : null,
    oidc_client_id: input.provider === 'OIDC' ? input.oidcClientId : null,
    oidc_identifier: input.provider === 'OIDC' ? oidcId : null,
    is_enabled: input.isEnabled,
  };
}

export function samlRegistrationBody(input: { metadataUrl: string | null; metadataXml: string | null; domain: string }) {
  const body: Record<string, unknown> = { type: 'saml', domains: [input.domain] };
  if (input.metadataUrl) body.metadata_url = input.metadataUrl;
  if (input.metadataXml) body.metadata_xml = input.metadataXml;
  return body;
}

export function oidcRegistrationBody(input: {
  identifier: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string | null;
}) {
  const body: Record<string, unknown> = {
    provider_type: 'oidc',
    identifier: input.identifier,
    name: input.name,
    issuer: input.issuer,
    client_id: input.clientId,
    scopes: ['openid', 'email', 'profile'],
  };
  if (input.clientSecret) body.client_secret = input.clientSecret;
  return body;
}

function authHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

function safeError(text: string): string {
  return text
    .replace(/client_secret\\?"\s*:\s*\\?"[^"\\]*\\?"/gi, 'client_secret":"[redacted]"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `Auth server returned ${response.status}`;
  try {
    const body = JSON.parse(text) as { message?: string; msg?: string; error?: string; error_description?: string };
    return safeError(body.message || body.msg || body.error_description || body.error || text);
  } catch {
    return safeError(text);
  }
}

export async function syncIdentityProvider(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  row: StoredIdentityProvider;
  fetchImpl?: typeof fetch;
}): Promise<RegistrationResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const base = args.supabaseUrl.replace(/\/$/, '');
  if (args.row.provider === 'AZURE' || args.row.provider === 'EMAIL') {
    return { registrationStatus: 'active', ssoProviderId: null, oidcIdentifier: null, registrationError: null };
  }
  if (!base || !args.serviceRoleKey) {
    return {
      registrationStatus: 'error',
      ssoProviderId: args.row.ssoProviderId,
      oidcIdentifier: args.row.oidcIdentifier,
      registrationError: 'The Auth admin key is not configured, so this identity provider could not be registered.',
    };
  }

  if (args.row.provider === 'SAML') {
    if (!args.row.emailDomain) {
      return { registrationStatus: 'error', ssoProviderId: null, oidcIdentifier: null, registrationError: 'SAML needs an email domain.' };
    }
    const endpoint = args.row.ssoProviderId
      ? `${base}/auth/v1/admin/sso/providers/${args.row.ssoProviderId}`
      : `${base}/auth/v1/admin/sso/providers`;
    const response = await fetchImpl(endpoint, {
      method: args.row.ssoProviderId ? 'PUT' : 'POST',
      headers: authHeaders(args.serviceRoleKey),
      body: JSON.stringify(samlRegistrationBody({
        metadataUrl: args.row.samlMetadataUrl,
        metadataXml: args.row.samlMetadataXml,
        domain: args.row.emailDomain,
      })),
    });
    if (!response.ok) {
      return {
        registrationStatus: 'error',
        ssoProviderId: args.row.ssoProviderId,
        oidcIdentifier: null,
        registrationError: await readError(response),
      };
    }
    const created = await response.json() as { id?: string };
    return {
      registrationStatus: 'active',
      ssoProviderId: created.id ?? args.row.ssoProviderId,
      oidcIdentifier: null,
      registrationError: null,
    };
  }

  const identifier = args.row.oidcIdentifier || (args.row.emailDomain ? oidcIdentifier(args.row.emailDomain) : null);
  if (!identifier || !args.row.oidcIssuer || !args.row.oidcClientId) {
    return { registrationStatus: 'error', ssoProviderId: null, oidcIdentifier: identifier, registrationError: 'OpenID Connect is missing an issuer or client ID.' };
  }
  if (!args.row.oidcClientSecret && !args.row.oidcIdentifier) {
    return { registrationStatus: 'error', ssoProviderId: null, oidcIdentifier: identifier, registrationError: 'OpenID Connect needs a client secret the first time it is saved.' };
  }
  const endpoint = args.row.oidcIdentifier
    ? `${base}/auth/v1/admin/custom-providers/${encodeURIComponent(identifier)}`
    : `${base}/auth/v1/admin/custom-providers`;
  const response = await fetchImpl(endpoint, {
    method: args.row.oidcIdentifier ? 'PUT' : 'POST',
    headers: authHeaders(args.serviceRoleKey),
    body: JSON.stringify(oidcRegistrationBody({
      identifier,
      name: args.row.displayName || args.row.emailDomain || 'OpenID Connect',
      issuer: args.row.oidcIssuer,
      clientId: args.row.oidcClientId,
      clientSecret: args.row.oidcClientSecret,
    })),
  });
  if (!response.ok && args.row.oidcIdentifier && response.status === 405) {
    return {
      registrationStatus: 'error',
      ssoProviderId: null,
      oidcIdentifier: identifier,
      registrationError: 'This Auth server cannot update an OpenID Connect provider in place. Remove the connection and add it again.',
    };
  }
  if (!response.ok) {
    return { registrationStatus: 'error', ssoProviderId: null, oidcIdentifier: identifier, registrationError: await readError(response) };
  }
  return { registrationStatus: 'active', ssoProviderId: null, oidcIdentifier: identifier, registrationError: null };
}

export async function removeRegisteredProvider(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  provider: IdentityProviderKind;
  ssoProviderId: string | null;
  oidcIdentifier: string | null;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (args.provider !== 'SAML' && args.provider !== 'OIDC') return;
  if (!args.supabaseUrl || !args.serviceRoleKey) {
    throw new Error('The Auth admin key is not configured, so the identity provider could not be removed.');
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const base = args.supabaseUrl.replace(/\/$/, '');
  const endpoint = args.provider === 'SAML'
    ? `${base}/auth/v1/admin/sso/providers/${args.ssoProviderId}`
    : `${base}/auth/v1/admin/custom-providers/${encodeURIComponent(args.oidcIdentifier || '')}`;
  if (args.provider === 'SAML' && !args.ssoProviderId) return;
  if (args.provider === 'OIDC' && !args.oidcIdentifier) return;
  const response = await fetchImpl(endpoint, { method: 'DELETE', headers: authHeaders(args.serviceRoleKey) });
  if (!response.ok && response.status !== 404) {
    throw new Error(await readError(response));
  }
}

function parseMethod(value: unknown): SignInMethod | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.protocol !== 'string' || !PROTOCOLS.has(row.protocol as AuthProtocol)) return null;
  if (typeof row.label !== 'string' || !row.label.trim()) return null;
  const method: SignInMethod = { protocol: row.protocol as AuthProtocol, label: row.label.trim() };
  if (typeof row.domain === 'string' && row.domain.trim()) method.domain = row.domain.trim().toLowerCase();
  if (typeof row.identifier === 'string' && row.identifier.startsWith('custom:')) method.identifier = row.identifier;
  return method;
}

/** Keeps only the fields the signed-out login page is allowed to see. */
export function parseSignInDiscovery(value: unknown): SignInDiscovery {
  if (typeof value === 'string') {
    try {
      return parseSignInDiscovery(JSON.parse(value));
    } catch {
      return PLATFORM_DISCOVERY;
    }
  }
  if (!value || typeof value !== 'object') return PLATFORM_DISCOVERY;
  const row = value as Record<string, unknown>;
  const methods = Array.isArray(row.methods) ? row.methods.map(parseMethod).filter((method): method is SignInMethod => Boolean(method)) : [];
  const matched = row.matched === true;
  if (!matched && methods.length === 0) return PLATFORM_DISCOVERY;
  return {
    matched,
    password: row.password === true || methods.some((method) => method.protocol === 'password'),
    mfa_required: row.mfa_required === true,
    organization: typeof row.organization === 'string' ? row.organization : null,
    message: typeof row.message === 'string' ? row.message : null,
    methods,
  };
}
