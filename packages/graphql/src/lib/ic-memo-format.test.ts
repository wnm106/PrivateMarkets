import { describe, expect, it } from 'vitest';
import { couponYield, recommendationText, structurePhrase, unfundedFootnote } from './ic-memo-format';

const harbor = [
  { instrumentType: 'LOAN', equityLinked: false, unfunded: false, label: 'Term Loan' },
  { instrumentType: 'DELAYED_DRAW_TERM_LOAN', equityLinked: false, unfunded: true, label: 'DDTL' },
];

describe('IC memo wording', () => {
  it('prices a SOFR spread over the base rate the way the memo states it', () => {
    expect(couponYield('SOFR + 500', 4.3)).toBe(9.3);
    expect(couponYield('11.0% cash + 3.0% PIK', 4.3)).toBe(11);
  });

  it('describes a first-lien term loan plus delayed draw as a unitranche', () => {
    expect(structurePhrase(harbor)).toBe('unitranche with delayed draw');
  });

  it('writes the Project Harbor recommendation from the hold, the facility, and the allocation', () => {
    expect(recommendationText({
      dealName: 'Project Harbor',
      facilitySize: 260_000_000,
      targetHold: 169_000_000,
      unallocated: 0,
      fundCount: 4,
      tranches: harbor,
    })).toBe(
      "The deal team recommends that the committee approve a commitment of $169.0M to Project Harbor, a $260.0M unitranche with delayed draw, allocated across 4 funds. The full hold is placed within each fund's mandate and limits.",
    );
  });

  it('keeps unfunded tranches out of sources and uses', () => {
    expect(unfundedFootnote(harbor)).toBe(
      'Unfunded tranches (DDTL) are excluded from sources and are available for acquisitions and working capital.',
    );
  });
});
