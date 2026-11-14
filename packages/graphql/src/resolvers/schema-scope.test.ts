import { describe, expect, it } from 'vitest';
import { inheritEntityClientId, type EntityClientCaller } from './schema-scope';

const client = 'client-1';
const other = 'client-2';

function caller(partial: Partial<EntityClientCaller> = {}): EntityClientCaller {
  return {
    isTenantAdmin: false,
    impersonatingId: null,
    memberIds: [client],
    ...partial,
  };
}

describe('entity client inheritance', () => {
  it('uses the simulated client when no client is requested', () => {
    expect(inheritEntityClientId(caller({ isTenantAdmin: true, impersonatingId: other, memberIds: [] }))).toBe(other);
  });

  it('keeps a simulated session on that client even if another id is sent', () => {
    expect(() => inheritEntityClientId(caller({ impersonatingId: other }), client)).toThrow(/that client/);
  });

  it('uses the only membership when the editor does not ask', () => {
    expect(inheritEntityClientId(caller())).toBe(client);
    expect(inheritEntityClientId(caller({ isTenantAdmin: true }))).toBe(client);
  });

  it('refuses to guess when the caller works in more than one client', () => {
    expect(() => inheritEntityClientId(caller({ memberIds: [client, other] }))).toThrow(/Open the client/);
  });
});
