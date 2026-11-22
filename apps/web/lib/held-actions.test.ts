import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MINUTES, holdAction, releaseAction } from './held-actions';

const secret = 'test-secret';
const ada = { userId: 'user-ada', clientId: 'client-a' };
const call = { name: 'ext__CRM__update_stage', args: { company_id: 'C-1', stage: 'won' }, serverName: 'CRM', tool: 'update_stage' };

describe('held actions', () => {
  it('releases the exact call it held, for the person it was held for', () => {
    const held = holdAction(call, ada, { secret, now: 0 });
    assert.deepEqual(releaseAction(held.token, ada, { secret, now: 60_000 }), { id: held.id, ...call });
  });

  it('refuses a call whose tool or arguments were changed after it was held', () => {
    const held = holdAction(call, ada, { secret, now: 0 });
    const [body, signature] = held.token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.a.stage = 'lost';
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    assert.throws(() => releaseAction(forged, ada, { secret, now: 0 }), /not valid/);
  });

  it('refuses a call signed with another key, or not signed at all', () => {
    const held = holdAction(call, ada, { secret: 'other', now: 0 });
    assert.throws(() => releaseAction(held.token, ada, { secret, now: 0 }), /not valid/);
    assert.throws(() => releaseAction(held.token.split('.')[0], ada, { secret, now: 0 }), /not valid/);
    assert.throws(() => releaseAction('', ada, { secret, now: 0 }), /not valid/);
  });

  it('refuses another person or client, and an expired hold', () => {
    const held = holdAction(call, ada, { secret, now: 0 });
    assert.throws(() => releaseAction(held.token, { ...ada, userId: 'user-bob' }, { secret, now: 0 }), /someone else/);
    assert.throws(() => releaseAction(held.token, { ...ada, clientId: 'client-b' }, { secret, now: 0 }), /someone else/);
    assert.throws(() => releaseAction(held.token, ada, { secret, now: HOLD_MINUTES * 60_000 + 1 }), /expired/);
  });

  it('refuses to hold anything without a key', () => {
    assert.throws(() => holdAction(call, ada, { secret: '', now: 0 }), /service role key/);
  });
});
