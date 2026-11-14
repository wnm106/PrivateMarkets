import { describe, expect, it } from 'vitest';
import { addShares, compactEvidence, type SectionEvidence } from './narrative-engine';

describe('addShares', () => {
  const rows = [
    { 'iss.entity_name': 'A', exposure: 300, positions: 3 },
    { 'iss.entity_name': 'B', exposure: 100, positions: 1 },
    { 'iss.entity_name': 'C', exposure: null, positions: 1 },
  ];

  it('adds each group\'s share of the total and returns the total', () => {
    const out = addShares(rows, ['exposure']);
    expect(out.totals).toEqual({ exposure: 400 });
    expect(out.rows[0].exposure_share).toBeCloseTo(0.75);
    expect(out.rows[1].exposure_share).toBeCloseTo(0.25);
    expect(out.rows[2].exposure_share).toBeNull();
  });

  it('adds nothing when there is no positive total', () => {
    const out = addShares([{ x: 0 }, { x: null }], ['x']);
    expect(out.totals).toEqual({});
    expect(out.rows).toEqual([{ x: 0 }, { x: null }]);
  });
});

describe('compactEvidence', () => {
  const evidence: SectionEvidence = {
    sectionKey: 's',
    entity: null,
    asOfDate: '2026-09-30',
    asOf: [{ label: 'Current', date: '2026-09-30' }],
    datasets: {
      by_issuer: {
        key: 'by_issuer', asOfLabel: 'Current', asOfDate: '2026-09-30', mode: 'aggregate',
        columns: ['issuer', 'exposure', 'exposure_share'],
        rows: Array.from({ length: 10 }, (_, i) => ({ issuer: `I${i}`, exposure: 10, exposure_share: 0.1 })),
        matched: 10, total: 10, truncated: false, totals: { exposure: 100 },
      },
    },
    screens: [], scenarios: [], measures: [], notes: ['one gap'],
  };

  it('shows the complete totals even when only some rows are shown', () => {
    const out: any = compactEvidence(evidence, 3);
    expect(out.datasets.by_issuer.rowsShown).toBe(3);
    expect(out.datasets.by_issuer.totalsOverAllGroups).toEqual({ exposure: 100 });
    expect(out.mustDisclose).toEqual(['one gap']);
  });

  it('shows a chosen batch of rows for a batched section', () => {
    const batch = evidence.datasets.by_issuer.rows.slice(4, 6);
    const out: any = compactEvidence(evidence, 3, { query: 'by_issuer', rows: batch });
    expect(out.datasets.by_issuer.rows.map((r: any) => r.issuer)).toEqual(['I4', 'I5']);
  });
});
