export interface FundTypePack {
  structure: 'PUBLIC_BDC' | 'CLOSED_END';
  listing: string;
  basis: string;
  template: string;
  label: string;
}

export const PUBLIC_BDC: FundTypePack = {
  structure: 'PUBLIC_BDC',
  listing: 'LISTED',
  basis: 'GAAP',
  template: 'FUND_NAV_BDC',
  label: 'public BDC',
};

export const CLOSED_END: FundTypePack = {
  structure: 'CLOSED_END',
  listing: 'PRIVATE',
  basis: 'FAIR_VALUE',
  template: 'FUND_NAV_PE',
  label: 'closed-end',
};

/** Funds from the fund register used to show each custom surface. */
export const FLUID_SURFACE_FUNDS = ['Harbor Senior Income', 'Halyard Senior Credit Fund II'];
export const CONDITIONAL_PAGE_FUNDS = ['Pioneer Opportunistic Credit', 'Meridian Credit Fund I'];

const ASSIGNED: Record<string, FundTypePack> = {
  'Harbor Senior Income': PUBLIC_BDC,
  'Halyard Senior Credit Fund II': CLOSED_END,
  'Pioneer Opportunistic Credit': CLOSED_END,
  'Meridian Credit Fund I': PUBLIC_BDC,
  'Cascade Credit Opportunities II': CLOSED_END,
  'Cascade CO II: Main Fund': CLOSED_END,
  'Pioneer OC: Main Fund': CLOSED_END,
};

export function featuredFunds(surfaceCode: string): string[] {
  if (surfaceCode === 'FUND_CONDITIONAL_PAGE') return CONDITIONAL_PAGE_FUNDS;
  if (surfaceCode === 'FUND_FLUID_SURFACE' || surfaceCode === 'FUND_SURFACE') return FLUID_SURFACE_FUNDS;
  return [];
}

export function assignedFundType(name: string): FundTypePack {
  if (ASSIGNED[name]) return ASSIGNED[name];
  if (/income|\bbdc\b/i.test(name)) return PUBLIC_BDC;
  return CLOSED_END;
}

export function oppositeFundType(pack: FundTypePack): FundTypePack {
  return pack.structure === 'PUBLIC_BDC' ? CLOSED_END : PUBLIC_BDC;
}

export function factsForPack(pack: FundTypePack) {
  return {
    attributes: {
      FUND_STRUCTURE: pack.structure,
      LISTING_STATUS: pack.listing,
      ACCOUNTING_BASIS: pack.basis,
      TEMPLATE_CODE: pack.template,
    },
    relationships: [] as string[],
  };
}
