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
