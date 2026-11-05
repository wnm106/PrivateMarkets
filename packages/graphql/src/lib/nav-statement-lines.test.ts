import { describe, expect, it } from 'vitest';
import { acceptedLineCodes } from './nav-statement-lines';

describe('accepted NAV lines', () => {
  it('reads a JSON list and a comma list', () => {
    expect([...acceptedLineCodes('')]).toEqual([]);
    expect([...acceptedLineCodes('[]')]).toEqual([]);
    expect([...acceptedLineCodes('["NAV_BS_CASH","NAV_BS_RECEIVABLE"]')]).toEqual(['NAV_BS_CASH', 'NAV_BS_RECEIVABLE']);
    expect([...acceptedLineCodes('NAV_BS_CASH, NAV_BS_RECEIVABLE')]).toEqual(['NAV_BS_CASH', 'NAV_BS_RECEIVABLE']);
  });
});
