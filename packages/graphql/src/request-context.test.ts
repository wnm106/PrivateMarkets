import { describe, expect, it } from 'vitest';
import { bearerToken, GRAPHQL_CORS, roleFromAppMetadata } from './request-context';

describe('request context', () => {
  it('takes the role from server-set app_metadata only, and defaults to readonly', () => {
    expect(roleFromAppMetadata({ role: 'steward' })).toBe('steward');
    expect(roleFromAppMetadata({ role: 'superuser' })).toBe('readonly');
    expect(roleFromAppMetadata({})).toBe('readonly');
    expect(roleFromAppMetadata(null)).toBe('readonly');
  });

  it('reads a bearer token and nothing else', () => {
    expect(bearerToken(new Request('https://x.test', { headers: { Authorization: 'Bearer abc' } }))).toBe('abc');
    expect(bearerToken(new Request('https://x.test', { headers: { Authorization: 'Basic abc' } }))).toBeNull();
    expect(bearerToken(new Request('https://x.test'))).toBeNull();
  });

  it('never asks the browser for credentials across origins', () => {
    expect(GRAPHQL_CORS.credentials).toBe(false);
  });
});
