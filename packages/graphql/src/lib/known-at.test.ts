import { describe, expect, it } from 'vitest';
import { knownAt } from './known-at';
import { assertWhatIfKnowledge } from './deal-compliance';

describe('knownAt', () => {
  const at = '2026-06-30T23:59:59.999Z';
  it('counts a row recorded by then and not yet ended', () => {
    expect(knownAt('2026-01-01T00:00:00Z', '9999-12-31T23:59:59+00:00', at)).toBe(true);
    expect(knownAt('2026-01-01T00:00:00Z', null, at)).toBe(true);
    expect(knownAt('2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z', at)).toBe(true);
  });

  it('leaves out a row recorded later, or ended by then', () => {
    expect(knownAt('2026-07-01T00:00:00Z', null, at)).toBe(false);
    expect(knownAt('2026-01-01T00:00:00Z', '2026-06-30T12:00:00Z', at)).toBe(false);
    expect(knownAt('2026-01-01T00:00:00Z', '2026-06-30T23:59:59.999Z', at)).toBe(false);
  });
});

describe('assertWhatIfKnowledge', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  it('scores unsaved changes against what is known now', () => {
    expect(() => assertWhatIfKnowledge('2026-11-22T12:00:00Z', now)).not.toThrow();
  });
  it('refuses an earlier Knowledge date and says what to do', () => {
    expect(() => assertWhatIfKnowledge('2026-06-30T23:59:59.999Z', now)).toThrow(/Knowledge date to today/);
  });
});
