import { describe, expect, it } from 'vitest';
import { allocate, type AllocationPortfolio, type AllocationRequest, type AllocationTranche } from './allocation-engine';

function sleeve(
  id: string,
  name: string,
  nav: number,
  cash: number,
  undrawn: number,
  line: number,
  reserve: number,
  allowed: string[],
  denyNote = '',
) {
  return { id, name, nav, cash: cash * 3, undrawn: undrawn * 3, line: line * 3, reserve: reserve * 3, allowed, denyNote };
}

const portfolios: AllocationPortfolio[] = [
  {
    id: 'mdl', name: 'Meridian Direct Lending IV', nav: 1200,
    issuerLimit: 0.05, sponsorLimit: 0.10, unfundedLimit: 0.10, sponsorExposure: 40, unfundedExposure: 95,
    allowed: ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT'],
    denyNote: 'Mandate limited to first lien senior secured debt',
    sleeves: [
      sleeve('mdl-on', 'Onshore LP', 700, 6, 20, 8, 4, ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT']),
      sleeve('mdl-off', 'Offshore Feeder', 330, 3, 10, 4, 2, ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT']),
      sleeve('mdl-sma', 'Pension SMA', 170, 2, 8, 0, 0, ['LOAN'], 'SMA guidelines prohibit unfunded commitments'),
    ],
  },
  {
    id: 'ccf', name: 'Cascade Credit Opportunities II', nav: 800,
    issuerLimit: 0.08, sponsorLimit: 0.10, unfundedLimit: 0.15, sponsorExposure: 20, unfundedExposure: 70,
    allowed: ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT', 'SECOND_LIEN_LOAN', 'MEZZANINE', 'WARRANT'],
    denyNote: 'Mandate does not permit preferred equity',
    sleeves: [
      sleeve('ccf-main', 'Main Fund', 520, 8, 18, 5, 3, ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT', 'SECOND_LIEN_LOAN', 'MEZZANINE', 'WARRANT']),
      sleeve('ccf-co', 'Co-Invest', 280, 2, 10, 0, 0, ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT', 'SECOND_LIEN_LOAN', 'MEZZANINE', 'WARRANT']),
    ],
  },
  {
    id: 'hsi', name: 'Harbor Senior Income', nav: 2000,
    issuerLimit: 0.03, sponsorLimit: 0.10, unfundedLimit: 0.05, sponsorExposure: 120, unfundedExposure: 92,
    allowed: ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT', 'WARRANT'],
    denyNote: 'Mandate limited to first lien senior secured debt',
    sleeves: [
      sleeve('hsi-inst', 'Institutional Sleeve', 1250, 18, 0, 30, 3, ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT', 'WARRANT']),
      sleeve('hsi-ret', 'Retail Sleeve', 750, 10, 0, 17, 2, ['LOAN', 'DELAYED_DRAW_TERM_LOAN', 'REVOLVING_CREDIT'], 'Retail sleeve cannot hold non-income securities'),
    ],
  },
  {
    id: 'poc', name: 'Pioneer Opportunistic Credit', nav: 600,
    issuerLimit: 0.10, sponsorLimit: 0.10, unfundedLimit: 0.20, sponsorExposure: 25, unfundedExposure: 30,
    allowed: ['LOAN', 'SECOND_LIEN_LOAN', 'MEZZANINE', 'WARRANT', 'PREFERRED_EQUITY'],
    denyNote: 'Mandate prohibits unfunded commitments',
    sleeves: [
      sleeve('poc-main', 'Main Fund', 430, 5, 14, 0, 1, ['LOAN', 'SECOND_LIEN_LOAN', 'MEZZANINE', 'WARRANT', 'PREFERRED_EQUITY']),
      sleeve('poc-ovs', 'Overseas Feeder', 170, 1, 7, 0, 1, ['LOAN', 'SECOND_LIEN_LOAN', 'MEZZANINE'], 'Tax: no equity-linked holdings in the offshore feeder'),
    ],
  },
];

const halyardTranches: AllocationTranche[] = [
  { id: 'tl', name: 'Term Loan', size: 150, holdPct: 60, unfunded: false, instrumentType: 'LOAN' },
  { id: 'ddtl', name: 'Delayed Draw Term Loan', size: 50, holdPct: 60, unfunded: true, instrumentType: 'DELAYED_DRAW_TERM_LOAN' },
  { id: 'w', name: 'Warrant', size: 10, holdPct: 60, unfunded: false, instrumentType: 'WARRANT' },
];

function halyard(adjustments: AllocationRequest['adjustments'] = []): AllocationRequest {
  return { tranches: halyardTranches, portfolios, adjustments };
}

function cell(result: ReturnType<typeof allocate>, fundId: string, trancheId: string) {
  const row = result.rows.find((item) => item.fundId === fundId);
  const found = row?.cells.find((item) => item.trancheId === trancheId);
  if (!row || !found) throw new Error(`Missing ${fundId} ${trancheId}`);
  return found;
}

describe('allocation engine', () => {
  it('lists a fund with no child funds as one row', () => {
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 10, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [{
        id: 'solo',
        name: 'Solo',
        nav: 100,
        issuerLimit: 1,
        sponsorLimit: 1,
        unfundedLimit: 1,
        sponsorExposure: 0,
        unfundedExposure: 0,
        allowed: ['LOAN'],
        denyNote: '',
        sleeves: [{
          id: 'solo', name: 'Solo', nav: 100, cash: 50, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '',
        }],
      }],
    });
    const rows = result.rows.filter((row) => row.fundId === 'solo');
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('PORTFOLIO');
    expect(rows[0].total).toBeCloseTo(10, 2);
  });

  it('places the Halyard hold inside each fund mandate and keeps sleeve amounts inside the portfolio', () => {
    const result = allocate(halyard());
    expect(result.facilitySize).toBe(210);
    expect(result.targetHold).toBeCloseTo(126, 2);
    expect(result.allocated).toBeLessThanOrEqual(result.targetHold + 0.02);
    expect(result.allocated).toBeGreaterThan(0);

    expect(cell(result, 'mdl', 'w').eligible).toBe(false);
    expect(cell(result, 'mdl', 'w').amount).toBe(0);
    expect(cell(result, 'mdl', 'w').exclusionKind).toBe('mandate');
    expect(cell(result, 'mdl-sma', 'ddtl').eligible).toBe(false);
    expect(cell(result, 'poc', 'ddtl').eligible).toBe(false);
    expect(cell(result, 'hsi-ret', 'w').eligible).toBe(false);
    expect(cell(result, 'hsi-inst', 'w').eligible).toBe(true);

    for (const portfolio of portfolios) {
      for (const tranche of halyardTranches) {
        const parent = cell(result, portfolio.id, tranche.id).amount;
        const children = portfolio.sleeves.reduce((total, sleeve) => total + cell(result, sleeve.id, tranche.id).amount, 0);
        expect(children).toBeCloseTo(parent, 2);
      }
    }
  });

  it('re-spreads a portfolio override and records the system amount beside it', () => {
    const clean = allocate(halyard());
    const system = cell(clean, 'mdl', 'tl').amount;
    const result = allocate(halyard([
      { fundId: 'mdl', trancheId: 'tl', type: 'override', amount: 10, reason: 'IC' },
    ]));
    const overridden = cell(result, 'mdl', 'tl');
    expect(overridden.amount).toBeCloseTo(10, 2);
    expect(overridden.overridden).toBe(true);
    expect(overridden.systemAmount).toBeCloseTo(system, 2);
    expect(overridden.reasonCode).toBe('IC');
    const moved = portfolios
      .filter((portfolio) => portfolio.id !== 'mdl')
      .reduce((total, portfolio) => total + cell(result, portfolio.id, 'tl').amount - cell(clean, portfolio.id, 'tl').amount, 0);
    expect(moved).toBeCloseTo(system - 10, 1);
  });

  it('caps a fund at its pro forma limit and spreads that tranche’s residual across the other eligible portfolios', () => {
    const tight: AllocationPortfolio = {
      id: 'tight',
      name: 'Tight Limit',
      nav: 1000,
      issuerLimit: 0.02,
      sponsorLimit: 1,
      unfundedLimit: 1,
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed: ['LOAN'],
      denyNote: '',
      sleeves: [{
        id: 'tight-main', name: 'Main', nav: 1000, cash: 400, undrawn: 0, line: 0, reserve: 0,
        allowed: ['LOAN'], denyNote: '',
      }],
    };
    const roomy: AllocationPortfolio = {
      id: 'roomy',
      name: 'Room to Spare',
      nav: 1000,
      issuerLimit: 0.5,
      sponsorLimit: 1,
      unfundedLimit: 1,
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed: ['LOAN'],
      denyNote: '',
      sleeves: [{
        id: 'roomy-main', name: 'Main', nav: 1000, cash: 400, undrawn: 0, line: 0, reserve: 0,
        allowed: ['LOAN'], denyNote: '',
      }],
    };
    const blocked: AllocationPortfolio = {
      id: 'blocked',
      name: 'Mandate Block',
      nav: 5000,
      issuerLimit: 0.5,
      sponsorLimit: 1,
      unfundedLimit: 1,
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed: ['WARRANT'],
      denyNote: 'Mandate does not permit loans',
      sleeves: [{
        id: 'blocked-main', name: 'Main', nav: 5000, cash: 2000, undrawn: 0, line: 0, reserve: 0,
        allowed: ['WARRANT'], denyNote: 'Mandate does not permit loans',
      }],
    };
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 100, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [tight, roomy, blocked],
    });

    expect(cell(result, 'tight', 'tl').amount).toBeCloseTo(20, 2);
    expect(cell(result, 'tight', 'tl').capReason).toBe('pro forma single-issuer limit');
    expect(cell(result, 'roomy', 'tl').amount).toBeCloseTo(80, 2);
    expect(cell(result, 'blocked', 'tl').amount).toBe(0);
    expect(cell(result, 'blocked', 'tl').eligible).toBe(false);
    expect(result.tranches[0].allocated).toBeCloseTo(100, 2);
    expect(result.unallocated).toBeCloseTo(0, 2);
  });

  it('splits a capped tranche’s residual across the remaining eligible portfolios in proportion to available capital', () => {
    const fund = (id: string, cash: number, issuerLimit: number): AllocationPortfolio => ({
      id,
      name: id,
      nav: 1000,
      issuerLimit,
      sponsorLimit: 1,
      unfundedLimit: 1,
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed: ['LOAN'],
      denyNote: '',
      sleeves: [{
        id: `${id}-main`, name: 'Main', nav: 1000, cash, undrawn: 0, line: 0, reserve: 0,
        allowed: ['LOAN'], denyNote: '',
      }],
    });
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 100, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [
        fund('small', 100, 0.01),
        fund('mid', 100, 0.5),
        fund('large', 300, 0.5),
      ],
    });

    expect(cell(result, 'small', 'tl').amount).toBeCloseTo(10, 2);
    expect(cell(result, 'small', 'tl').capReason).toBe('pro forma single-issuer limit');
    expect(cell(result, 'mid', 'tl').amount).toBeCloseTo(22.5, 2);
    expect(cell(result, 'large', 'tl').amount).toBeCloseTo(67.5, 2);
    expect(result.allocated).toBeCloseTo(100, 2);
  });

  it('keeps every Halyard portfolio inside its pro forma limit when the hold is the whole facility', () => {
    const result = allocate({
      tranches: halyardTranches.map((tranche) => ({ ...tranche, holdPct: 100 })),
      portfolios,
    });
    for (const portfolio of portfolios) {
      const row = result.rows.find((item) => item.fundId === portfolio.id);
      expect(row).toBeTruthy();
      expect(row!.total).toBeLessThanOrEqual(portfolio.issuerLimit * portfolio.nav + 0.02);
    }
    const placed = result.rows.filter((row) => row.level === 'PORTFOLIO').reduce((total, row) => total + row.total, 0);
    expect(placed).toBeCloseTo(result.allocated, 2);
    expect(result.allocated).toBeGreaterThan(result.targetHold * 0.9);
  });

  it('caps a fund at the lowest compliance-rule capacity and does not apply the fund limit on its own', () => {
    const sleeveFor = (id: string) => ({
      id, name: id, nav: 1000, cash: 400, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '',
    });
    const fund = (
      id: string,
      pools: AllocationPortfolio['capacityPools'],
    ): AllocationPortfolio => ({
      id,
      name: id,
      nav: 1000,
      issuerLimit: 0.01,
      sponsorLimit: 0.01,
      unfundedLimit: 0.01,
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed: ['LOAN'],
      denyNote: '',
      sleeves: [sleeveFor(`${id}-main`)],
      capacityPools: pools,
    });
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 100, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [
        fund('tight', [
          { trancheIds: ['tl'], capacity: 30, ruleName: 'Single-issuer share of NAV' },
          { trancheIds: ['tl'], capacity: 12, ruleName: 'Sector share of invested book' },
        ]),
        fund('roomy', [
          { trancheIds: ['tl'], capacity: 500, ruleName: 'Single-issuer share of NAV' },
        ]),
      ],
    });
    expect(cell(result, 'tight', 'tl').amount).toBeCloseTo(12, 2);
    expect(cell(result, 'tight', 'tl').capReason).toBe('Sector share of invested book');
    expect(cell(result, 'roomy', 'tl').amount).toBeCloseTo(88, 2);
    expect(result.allocated).toBeCloseTo(100, 2);
  });

  it('shares one compliance capacity across the securities in that rule and redistributes the residual', () => {
    const sleeveFor = (id: string) => ({
      id, name: id, nav: 1000, cash: 500, undrawn: 0, line: 0, reserve: 0,
      allowed: ['LOAN', 'DELAYED_DRAW_TERM_LOAN'], denyNote: '',
    });
    const fund = (id: string, pools: AllocationPortfolio['capacityPools']): AllocationPortfolio => ({
      id,
      name: id,
      nav: 1000,
      issuerLimit: 1,
      sponsorLimit: 1,
      unfundedLimit: 1,
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed: ['LOAN', 'DELAYED_DRAW_TERM_LOAN'],
      denyNote: '',
      sleeves: [sleeveFor(`${id}-main`)],
      capacityPools: pools,
    });
    const shared = { trancheIds: ['tl', 'ddtl'], capacity: 20, ruleName: 'Single-issuer share of NAV' };
    const unfunded = { trancheIds: ['ddtl'], capacity: 8, ruleName: 'Pro Forma Unfunded Commitments' };
    const result = allocate({
      tranches: [
        { id: 'tl', name: 'Term Loan', size: 40, holdPct: 100, unfunded: false, instrumentType: 'LOAN' },
        { id: 'ddtl', name: 'Delayed Draw', size: 40, holdPct: 100, unfunded: true, instrumentType: 'DELAYED_DRAW_TERM_LOAN' },
      ],
      portfolios: [
        fund('tight', [shared, unfunded]),
        fund('roomy', [
          { trancheIds: ['tl', 'ddtl'], capacity: 500, ruleName: 'Single-issuer share of NAV' },
          { trancheIds: ['ddtl'], capacity: 500, ruleName: 'Pro Forma Unfunded Commitments' },
        ]),
      ],
    });
    const tightLoan = cell(result, 'tight', 'tl').amount;
    const tightDraw = cell(result, 'tight', 'ddtl').amount;
    expect(tightDraw).toBeLessThanOrEqual(8.02);
    expect(tightLoan + tightDraw).toBeCloseTo(20, 1);
    expect(cell(result, 'roomy', 'tl').amount + cell(result, 'roomy', 'ddtl').amount).toBeCloseTo(60, 1);
    expect(result.allocated).toBeCloseTo(80, 2);
  });

  it('splits a child override across the children that were not overridden', () => {
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 100, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [{
        id: 'p', name: 'Parent', nav: 1000,
        issuerLimit: 1, sponsorLimit: 1, unfundedLimit: 1, sponsorExposure: 0, unfundedExposure: 0,
        allowed: ['LOAN'], denyNote: '',
        sleeves: [
          { id: 'a', name: 'A', nav: 500, cash: 200, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' },
          { id: 'b', name: 'B', nav: 500, cash: 200, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' },
        ],
      }],
      adjustments: [
        { fundId: 'p', trancheId: 'tl', type: 'override', amount: 100 },
        { fundId: 'a', trancheId: 'tl', type: 'override', amount: 40 },
      ],
    });
    expect(cell(result, 'p', 'tl').amount).toBeCloseTo(100, 2);
    expect(cell(result, 'p', 'tl').imbalance).toBe(false);
    expect(cell(result, 'a', 'tl').amount).toBeCloseTo(40, 2);
    expect(cell(result, 'b', 'tl').amount).toBeCloseTo(60, 2);
  });

  it('highlights the parent when every child override misses the parent amount', () => {
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 100, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [{
        id: 'p', name: 'Parent', nav: 1000,
        issuerLimit: 1, sponsorLimit: 1, unfundedLimit: 1, sponsorExposure: 0, unfundedExposure: 0,
        allowed: ['LOAN'], denyNote: '',
        sleeves: [
          { id: 'a', name: 'A', nav: 500, cash: 200, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' },
          { id: 'b', name: 'B', nav: 500, cash: 200, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' },
        ],
      }],
      adjustments: [
        { fundId: 'p', trancheId: 'tl', type: 'override', amount: 100 },
        { fundId: 'a', trancheId: 'tl', type: 'override', amount: 80 },
        { fundId: 'b', trancheId: 'tl', type: 'override', amount: 80 },
      ],
    });
    expect(cell(result, 'p', 'tl').amount).toBeCloseTo(100, 2);
    expect(cell(result, 'p', 'tl').imbalance).toBe(true);
    expect(cell(result, 'a', 'tl').amount).toBeCloseTo(80, 2);
    expect(cell(result, 'b', 'tl').amount).toBeCloseTo(80, 2);
  });

  it('shows saved sleeve amounts as they were saved, not as manual overrides', () => {
    const result = allocate({
      tranches: [{ id: 'tl', name: 'Term Loan', size: 100, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
      portfolios: [{
        id: 'p', name: 'Parent', nav: 1000,
        issuerLimit: 1, sponsorLimit: 1, unfundedLimit: 1, sponsorExposure: 0, unfundedExposure: 0,
        allowed: ['LOAN'], denyNote: '',
        sleeves: [
          { id: 'a', name: 'A', nav: 500, cash: 200, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' },
          { id: 'b', name: 'B', nav: 500, cash: 200, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' },
        ],
      }],
      adjustments: [
        { fundId: 'p', trancheId: 'tl', type: 'override', amount: 101, saved: true },
        { fundId: 'a', trancheId: 'tl', type: 'override', amount: 61, saved: true },
        { fundId: 'b', trancheId: 'tl', type: 'override', amount: 40, saved: true },
      ],
    });
    expect(cell(result, 'a', 'tl').amount).toBeCloseTo(61, 2);
    expect(cell(result, 'b', 'tl').amount).toBeCloseTo(40, 2);
    expect(cell(result, 'p', 'tl').amount).toBeCloseTo(101, 2);
    expect(cell(result, 'p', 'tl').imbalance).toBe(false);
    expect(cell(result, 'a', 'tl').overridden).toBe(false);
  });

  it('removes an excluded portfolio and leaves the warrant off a fund that cannot hold it', () => {
    const result = allocate(halyard([
      { fundId: 'poc', trancheId: '*', type: 'exclude', reason: 'MAND' },
    ]));
    expect(cell(result, 'poc', 'tl').amount).toBe(0);
    expect(cell(result, 'poc-main', 'tl').eligible).toBe(false);
    expect(cell(result, 'poc', 'tl').exclusionKind).toBe('manual');
    expect(cell(result, 'ccf', 'w').amount).toBeGreaterThan(0);
  });
});
