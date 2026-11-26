import { describe, expect, it } from 'vitest';
import { sessionLimits } from './tenancy';

describe('sessionLimits', () => {
  it('leaves out a limit the input leaves out, so an older form does not clear it', () => {
    expect(sessionLimits({})).toEqual({});
  });

  it('sets a limit, or clears it with null', () => {
    expect(sessionLimits({ maxSessionMinutes: 480, idleTimeoutMinutes: null })).toEqual({ max_session_minutes: 480, idle_timeout_minutes: null });
  });

  it('refuses limits outside what the database allows', () => {
    expect(() => sessionLimits({ maxSessionMinutes: 10 })).toThrow('15 to 43200');
    expect(() => sessionLimits({ idleTimeoutMinutes: 2000 })).toThrow('5 to 1440');
    expect(() => sessionLimits({ idleTimeoutMinutes: 7.5 })).toThrow('whole number');
  });
});
