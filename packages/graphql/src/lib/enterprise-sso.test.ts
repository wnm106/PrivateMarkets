import { describe, expect, it } from 'vitest';
import {
  assertIdentityProviderInput,
  oidcIdentifier,
  parseSignInDiscovery,
  PLATFORM_DISCOVERY,
  removeRegisteredProvider,
  samlRegistrationBody,
  samlServiceProvider,
  syncIdentityProvider,
  toIdentityProviderRow,
} from './enterprise-sso';

describe('enterprise sign-in', () => {
  it('builds a SAML registration without a client secret', () => {
    const body = samlRegistrationBody({
      metadataUrl: 'https://idp.acme.com/metadata',
      metadataXml: null,
      domain: 'acme.com',
    });
    expect(body).toEqual({ type: 'saml', metadata_url: 'https://idp.acme.com/metadata', domains: ['acme.com'] });
    expect(body).not.toHaveProperty('client_secret');
  });

  it('stores the OIDC client id and never the secret', () => {
    const write = assertIdentityProviderInput({
      provider: 'OIDC',
      displayName: 'Acme Okta',
      emailDomain: 'Acme.com',
      azureTenantId: null,
      samlMetadataUrl: null,
      samlMetadataXml: null,
      oidcIssuer: 'https://acme.okta.com',
      oidcClientId: 'client-1',
      oidcClientSecret: 'super-secret',
      isEnabled: true,
    });
    const row = toIdentityProviderRow(write, oidcIdentifier('acme.com'));
    expect(row.email_domain).toBe('acme.com');
    expect(row.oidc_client_id).toBe('client-1');
    expect(row.oidc_identifier).toBe('custom:acme-com');
    expect(row).not.toHaveProperty('oidc_client_secret');
    expect(JSON.stringify(row)).not.toContain('super-secret');
  });

  it('rejects an Entra directory that is not a tenant id', () => {
    expect(() => assertIdentityProviderInput({
      provider: 'AZURE',
      displayName: null,
      emailDomain: 'acme.com',
      azureTenantId: 'not-a-guid',
      samlMetadataUrl: null,
      samlMetadataXml: null,
      oidcIssuer: null,
      oidcClientId: null,
      oidcClientSecret: null,
      isEnabled: true,
    })).toThrow(/directory/);
  });

  it('registers SAML with the Auth server and keeps the provider id', async () => {
    const sent: { current: { url: string; body: Record<string, unknown>; authorization: string } | null } = { current: null };
    const result = await syncIdentityProvider({
      supabaseUrl: 'https://example.supabase.co/',
      serviceRoleKey: 'service-key',
      row: {
        provider: 'SAML',
        emailDomain: 'acme.com',
        samlMetadataUrl: 'https://idp.acme.com/metadata',
        samlMetadataXml: null,
        oidcIssuer: null,
        oidcClientId: null,
        oidcClientSecret: null,
        oidcIdentifier: null,
        ssoProviderId: null,
        displayName: 'Acme',
        isEnabled: true,
      },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        sent.current = {
          url,
          body: JSON.parse(String(init?.body)),
          authorization: (init?.headers as Record<string, string>).Authorization,
        };
        return new Response(JSON.stringify({ id: '21648a9d-8d5a-4555-a9d1-d6375dc14e92' }), { status: 200 });
      }) as typeof fetch,
    });
    expect(sent.current?.url).toBe('https://example.supabase.co/auth/v1/admin/sso/providers');
    expect(sent.current?.authorization).toBe('Bearer service-key');
    expect(sent.current?.body.type).toBe('saml');
    expect(sent.current?.body).not.toHaveProperty('client_secret');
    expect(result).toMatchObject({ registrationStatus: 'active', ssoProviderId: '21648a9d-8d5a-4555-a9d1-d6375dc14e92' });
  });

  it('redacts a client secret echoed in an Auth server error', async () => {
    const result = await syncIdentityProvider({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-key',
      row: {
        provider: 'OIDC',
        emailDomain: 'acme.com',
        samlMetadataUrl: null,
        samlMetadataXml: null,
        oidcIssuer: 'https://acme.okta.com',
        oidcClientId: 'client-1',
        oidcClientSecret: 'super-secret',
        oidcIdentifier: null,
        ssoProviderId: null,
        displayName: 'Acme',
        isEnabled: true,
      },
      fetchImpl: (async () => new Response(JSON.stringify({ message: 'rejected client_secret":"super-secret" from issuer' }), { status: 422 })) as typeof fetch,
    });
    expect(result.registrationStatus).toBe('error');
    expect(result.registrationError).not.toContain('super-secret');
    expect(result.registrationError).toContain('[redacted]');
  });

  it('treats a missing Auth provider as already removed', async () => {
    await expect(removeRegisteredProvider({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-key',
      provider: 'SAML',
      ssoProviderId: '21648a9d-8d5a-4555-a9d1-d6375dc14e92',
      oidcIdentifier: null,
      fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    })).resolves.toBeUndefined();
  });

  it('drops secrets and client ids from the sign-in discovery payload', () => {
    const parsed = parseSignInDiscovery({
      matched: true,
      password: false,
      mfa_required: true,
      organization: 'Acme Capital',
      message: null,
      client_id: 'secret-client',
      client_secret: 'nope',
      methods: [
        { protocol: 'saml', label: 'Okta', domain: 'ACME.com', metadata_xml: '<xml/>' },
        { protocol: 'oidc', label: 'Ping', identifier: 'custom:acme-com', client_secret: 'nope' },
        { protocol: 'password', label: '' },
      ],
    });
    expect(parsed).toEqual({
      matched: true,
      password: false,
      mfa_required: true,
      organization: 'Acme Capital',
      message: null,
      methods: [
        { protocol: 'saml', label: 'Okta', domain: 'acme.com' },
        { protocol: 'oidc', label: 'Ping', identifier: 'custom:acme-com' },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('nope');
    expect(JSON.stringify(parsed)).not.toContain('secret-client');
  });

  it('parses a discovery payload that arrived as a JSON string', () => {
    const parsed = parseSignInDiscovery(JSON.stringify({
      matched: true,
      password: false,
      mfa_required: false,
      organization: 'Acme',
      methods: [{ protocol: 'saml', label: 'Okta', domain: 'acme.com' }],
    }));
    expect(parsed.matched).toBe(true);
    expect(parsed.methods).toEqual([{ protocol: 'saml', label: 'Okta', domain: 'acme.com' }]);
  });

  it('keeps the platform default when a domain has no client', () => {
    expect(parseSignInDiscovery({ matched: false, methods: [] })).toEqual(PLATFORM_DISCOVERY);
  });

  it('publishes the SAML service-provider URLs from the project URL', () => {
    expect(samlServiceProvider('https://example.supabase.co/')).toEqual({
      entityId: 'https://example.supabase.co/auth/v1/sso/saml/metadata',
      metadataUrl: 'https://example.supabase.co/auth/v1/sso/saml/metadata',
      acsUrl: 'https://example.supabase.co/auth/v1/sso/saml/acs',
      sloUrl: 'https://example.supabase.co/auth/v1/sso/slo',
      oidcRedirectUri: 'https://example.supabase.co/auth/v1/callback',
    });
  });
});
