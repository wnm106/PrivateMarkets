import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageOf, chooseRun, type RunLike } from './narrative-runs';

const run = (id: string, over: Partial<RunLike> & { id?: string } = {}): RunLike & { id: string } => ({
  id,
  status: 'COMPLETED',
  asOfDate: '2026-11-13',
  createdAt: '2026-11-13T10:00:00Z',
  publishedAt: null,
  ...over,
});

describe('chooseRun', () => {
  it('shows the published run for the date over a newer unpublished one', () => {
    const chosen = chooseRun(
      [run('new', { createdAt: '2026-11-13T12:00:00Z' }), run('published', { createdAt: '2026-11-13T09:00:00Z', publishedAt: '2026-11-13T09:30:00Z' })],
      '2026-11-13',
    );
    assert.equal(chosen.run?.id, 'published');
    assert.equal(chosen.sameDate, true);
  });

  it('shows the newest run for the date when none is published', () => {
    const chosen = chooseRun(
      [run('old', { createdAt: '2026-11-13T08:00:00Z' }), run('new', { createdAt: '2026-11-13T11:00:00Z' })],
      '2026-11-13',
    );
    assert.equal(chosen.run?.id, 'new');
  });

  it('never shows a run that is not finished', () => {
    const chosen = chooseRun([run('running', { status: 'RUNNING' }), run('failed', { status: 'FAILED' })], '2026-11-13');
    assert.equal(chosen.run, null);
  });

  it('shows a partial run, since its finished sections are still useful', () => {
    assert.equal(chooseRun([run('partial', { status: 'PARTIAL' })], '2026-11-13').run?.id, 'partial');
  });

  it('falls back to another date and says so', () => {
    const chosen = chooseRun(
      [run('june', { asOfDate: '2026-06-30', createdAt: '2026-07-01T00:00:00Z' }), run('sept', { asOfDate: '2026-09-30', createdAt: '2026-10-01T00:00:00Z', publishedAt: '2026-10-02T00:00:00Z' })],
      '2026-11-13',
    );
    assert.equal(chosen.run?.id, 'sept');
    assert.equal(chosen.sameDate, false);
  });

  it('prefers a run on the selected date even if a published one exists on another date', () => {
    const chosen = chooseRun(
      [run('today'), run('published-old', { asOfDate: '2026-09-30', publishedAt: '2026-10-02T00:00:00Z' })],
      '2026-11-13',
    );
    assert.equal(chosen.run?.id, 'today');
    assert.equal(chosen.sameDate, true);
  });

  it('returns nothing when there are no runs', () => {
    assert.deepEqual(chooseRun([], '2026-11-13'), { run: null, sameDate: false });
  });
});

describe('ageOf', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  it('speaks in the largest whole unit', () => {
    assert.deepEqual(ageOf('2026-11-13T11:59:30Z', now), { text: 'just now', days: 0 });
    assert.deepEqual(ageOf('2026-11-13T11:15:00Z', now), { text: '45 minutes ago', days: 0 });
    assert.deepEqual(ageOf('2026-11-13T10:00:00Z', now), { text: '2 hours ago', days: 0 });
    assert.deepEqual(ageOf('2026-11-12T11:00:00Z', now), { text: '1 day ago', days: 1 });
    assert.deepEqual(ageOf('2026-11-03T12:00:00Z', now), { text: '10 days ago', days: 10 });
  });
});
