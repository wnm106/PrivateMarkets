import { describe, expect, it } from 'vitest';
import { mergeClientComponents, panelKeyForSlot, preferClientScope } from './client-scope';

const globalFund = { code: 'FUND_SURFACE', clientId: null, surfaceName: 'Fund surface' };
const clientFund = { code: 'FUND_SURFACE', clientId: 'client-a', surfaceName: 'Client fund' };
const otherFund = { code: 'FUND_SURFACE', clientId: 'client-b', surfaceName: 'Other fund' };
const deal = { code: 'DEAL_PIPELINE', clientId: null, surfaceName: 'Deal record' };

describe('preferClientScope', () => {
  it('keeps the global row when the caller has no client', () => {
    const chosen = preferClientScope([globalFund, clientFund, otherFund, deal], null);
    expect(chosen.map((row) => row.surfaceName)).toEqual(['Fund surface', 'Deal record']);
  });

  it('replaces the global row with the caller’s surface and ignores other clients', () => {
    const chosen = preferClientScope([globalFund, otherFund, clientFund, deal], 'client-a');
    expect(chosen.map((row) => row.surfaceName)).toEqual(['Client fund', 'Deal record']);
  });
});

describe('mergeClientComponents', () => {
  const nav = { code: 'NAV', clientId: null, panelKey: 'nav' };
  const navOverride = { code: 'NAV', clientId: 'client-a', panelKey: 'nav-custom' };
  const otherNav = { code: 'NAV', clientId: 'client-b', panelKey: 'nav-other' };
  const filings = { code: 'FILINGS', clientId: 'client-a', panelKey: 'filings' };

  it('returns global components when the caller has no client', () => {
    expect(mergeClientComponents([nav, navOverride, filings], null)).toEqual([nav]);
  });

  it('lets the caller’s component replace the global one and keeps a client-only component', () => {
    expect(mergeClientComponents([nav, otherNav, navOverride, filings], 'client-a')).toEqual([
      navOverride,
      filings,
    ]);
  });
});

describe('panelKeyForSlot', () => {
  it('uses the first qualified component that names a panel', () => {
    const panels = panelKeyForSlot([
      { slotCode: 'NAV', status: 'NOT_QUALIFIED', panelKey: 'hidden' },
      { slotCode: 'NAV', status: 'QUALIFIED', panelKey: 'nav' },
      { slotCode: 'FUNDING', status: 'QUALIFIED', panelKey: null },
      { slotCode: 'MEMO', status: 'QUALIFIED', panelKey: 'memo' },
    ]);
    expect(panels.get('NAV')).toBe('nav');
    expect(panels.has('FUNDING')).toBe(false);
    expect(panels.get('MEMO')).toBe('memo');
  });
});
