import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeFromName, describeCron, duration, parsePayload, platformFor } from './jobs';

describe('codeFromName', () => {
  it('makes an upper-case code and never returns an empty one', () => {
    assert.equal(codeFromName('  Morning compliance check (NY) '), 'MORNING_COMPLIANCE_CHECK_NY');
    assert.equal(codeFromName('***'), 'SCHEDULE');
  });
});

describe('parsePayload', () => {
  it('accepts an object and treats an empty box as an empty object', () => {
    assert.deepEqual(parsePayload('{"limit": 500}'), { ok: true, value: { limit: 500 } });
    assert.deepEqual(parsePayload('   '), { ok: true, value: {} });
  });

  it('rejects broken JSON and values that are not objects', () => {
    assert.equal(parsePayload('{limit: 500}').ok, false);
    assert.equal(parsePayload('[1, 2]').ok, false);
    assert.equal(parsePayload('null').ok, false);
  });
});

describe('platformFor', () => {
  it('keeps platform jobs for tenant admins and client jobs with a client', () => {
    assert.equal(platformFor({ scope: 'PLATFORM' }, true, false), true);
    assert.equal(platformFor({ scope: 'PLATFORM' }, false, false), null);
    assert.equal(platformFor({ scope: 'CLIENT' }, true, true), false);
  });

  it('lets only a tenant admin choose for a job that can be either', () => {
    assert.equal(platformFor({ scope: 'ANY' }, true, true), true);
    assert.equal(platformFor({ scope: 'ANY' }, true, false), false);
    assert.equal(platformFor({ scope: 'ANY' }, false, true), false);
  });
});

describe('describeCron', () => {
  const now = new Date('2026-11-14T12:00:00Z');

  it('names the zone and says when nothing matches', () => {
    assert.match(describeCron('0 6 * * 1-5', 'America/New_York', now), /^Next run: .*\(America\/New_York\)$/);
    assert.match(describeCron('0 0 30 2 *', 'UTC', now), /never runs/);
  });

  it('throws on an expression it cannot read', () => {
    assert.throws(() => describeCron('every day', 'UTC', now), /five fields/);
  });
});

describe('duration', () => {
  it('formats seconds, minutes, and hours', () => {
    assert.equal(duration('2026-11-14T12:00:00Z', '2026-11-14T12:00:00.200Z'), 'Under 1s');
    assert.equal(duration('2026-11-14T12:00:00Z', '2026-11-14T12:00:42Z'), '42s');
    assert.equal(duration('2026-11-14T12:00:00Z', '2026-11-14T12:03:05Z'), '3m 5s');
    assert.equal(duration('2026-11-14T12:00:00Z', '2026-11-14T14:10:00Z'), '2h 10m');
  });

  it('counts up to now for a run still going, and is empty before it starts', () => {
    assert.equal(duration('2026-11-14T12:00:00Z', null, new Date('2026-11-14T12:00:30Z')), '30s');
    assert.equal(duration(null, null), '');
  });
});
