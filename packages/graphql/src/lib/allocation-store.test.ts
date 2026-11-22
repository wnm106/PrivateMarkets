import { describe, expect, it } from 'vitest';
import { assertAllocationInputsOnDeal, previewFromDraft, stageAllocationWhatIf, type AllocationDraft } from './allocation-store';
import { fakeSupabase, filterValue } from '../testing/fake-supabase';

const ASOF = '2026-11-20';

function draft(overrides: Partial<AllocationDraft> = {}): AllocationDraft {
  return {
    dealId: 'deal-1',
    dealCode: 'DEAL-1',
    dealName: 'Deal One',
    asOf: ASOF,
    knowledge: '2026-01-01T00:00:00.000Z',
    request: {
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
        sleeves: [{ id: 'solo', name: 'Solo', nav: 100, cash: 50, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' }],
      }],
      adjustments: [{ fundId: 'solo', trancheId: 'tl', type: 'override', amount: 4 }],
    },
    tranches: [{ id: 'tl', code: 'TL', name: 'Term Loan', securityId: null }],
    positions: [
      { id: 'pos-main', code: 'P1', fundId: 'solo', trancheId: 'tl', role: 'PROPOSAL' },
      { id: 'pos-extra', code: 'P2', fundId: 'solo', trancheId: 'tl', role: 'PROPOSAL' },
      { id: 'pos-lock', code: 'L1', fundId: 'solo', trancheId: 'tl', role: 'LOCK' },
    ],
    portfolioIds: new Set(['solo']),
    clientId: 'client-a',
    facts: { description: '', stage: '', strategy: '', borrower: '', borrowerId: '', sponsor: '', sponsorId: '', pricing: '', oid: '', leverage: '', maturity: '', closeDate: '' },
    faces: {},
    ...overrides,
  };
}

describe('assertAllocationInputsOnDeal', () => {
  it('accepts tranches and funds on the deal, and the every-tranche marker', () => {
    expect(() => assertAllocationInputsOnDeal(draft(), [{ trancheId: 'tl', holdPct: 50 }], [
      { fundId: 'solo', trancheId: 'tl', type: 'override', amount: 1 },
      { fundId: 'solo', trancheId: '*', type: 'exclude' },
    ])).not.toThrow();
  });

  it('refuses a hold or adjustment that names another deal\'s tranche or another client\'s fund', () => {
    expect(() => assertAllocationInputsOnDeal(draft(), [{ trancheId: 'other-tranche', holdPct: 50 }], null)).toThrow(/tranche that is not on this deal/);
    expect(() => assertAllocationInputsOnDeal(draft(), null, [{ fundId: 'other-fund', trancheId: 'tl', type: 'override', amount: 1 }])).toThrow(/fund that is not on this deal/);
    expect(() => assertAllocationInputsOnDeal(draft(), null, [{ fundId: 'solo', trancheId: 'other-tranche', type: 'exclude' }])).toThrow(/tranche that is not on this deal/);
  });
});

describe('stageAllocationWhatIf', () => {
  const defs = [
    { id: 'attr-mv', attribute_code: 'MARKET_VALUE', default_precedence_rank: 100 },
    { id: 'attr-fp', attribute_code: 'FUNDED_PAR_AMOUNT', default_precedence_rank: 100 },
    { id: 'attr-uc', attribute_code: 'UNFUNDED_COMMITMENT_AMOUNT', default_precedence_rank: 100 },
  ];
  // What a rule reads today: the saved engine amount and a saved manual override.
  const visible = [
    { id: 'v1', entity_id: 'pos-main', attribute_id: 'attr-mv', source_id: 'src-engine', golden_value: '10', golden_value_numeric: 10, precedence_rank: 100, valid_from: '2026-11-01', system_from: '2026-11-01T00:00:00+00:00' },
    { id: 'v2', entity_id: 'pos-main', attribute_id: 'attr-mv', source_id: 'src-manual', golden_value: '7', golden_value_numeric: 7, precedence_rank: 1, valid_from: '2026-11-01', system_from: '2026-11-01T00:00:00+00:00' },
    { id: 'v3', entity_id: 'pos-main', attribute_id: 'attr-fp', source_id: 'src-engine', golden_value: '10', golden_value_numeric: 10, precedence_rank: 100, valid_from: '2026-11-01', system_from: '2026-11-01T00:00:00+00:00' },
    { id: 'v4', entity_id: 'pos-extra', attribute_id: 'attr-mv', source_id: 'src-engine', golden_value: '3', golden_value_numeric: 3, precedence_rank: 100, valid_from: '2026-11-01', system_from: '2026-11-01T00:00:00+00:00' },
  ];
  // The database clock is ahead of this server's: the knowledge instant must follow it.
  const databaseLatest = '2099-01-01T00:00:00.123456+00:00';

  function database() {
    return fakeSupabase((call) => {
      if (call.table === 'attribute_register') return { data: defs };
      if (call.table === 'source_registry') return { data: { id: 'src-engine' } };
      if (call.table === 'entity_relationships') return { data: [] };
      if (call.table === 'entity_attribute_values' && call.op === 'select' && call.columns === 'system_from') {
        return { data: [{ system_from: databaseLatest }] };
      }
      if (call.table === 'entity_attribute_values' && call.op === 'select') {
        const ids = filterValue(call, 'in', 'entity_id') as string[];
        return { data: visible.filter((row) => ids.includes(row.entity_id)) };
      }
      return undefined;
    });
  }

  it('adds rows readable only at one knowledge instant and on the as-of date, and changes no saved row', async () => {
    const db = database();
    const staged = draft();
    const { preview, knowledgeDate } = await stageAllocationWhatIf(db.client, staged, 'user-1');
    const amount = preview.rows.find((row) => row.fundId === 'solo')!.cells[0].amount;
    expect(amount).toBeCloseTo(4, 6);

    // Nothing saved is updated, closed, replaced or removed.
    expect(db.calls.filter((call) => ['update', 'delete', 'upsert'].includes(call.op))).toEqual([]);
    expect(knowledgeDate.startsWith('2099-01-01T00:00:00.124')).toBe(true);

    const inserted = db.calls.filter((call) => call.op === 'insert').flatMap((call) => call.payload as any[]);
    for (const row of inserted) {
      expect(row).toMatchObject({ system_from: knowledgeDate, system_to: knowledgeDate, valid_from: ASOF, valid_to: ASOF });
    }
    const byKey = new Map(inserted.map((row) => [`${row.entity_id}|${row.attribute_id}|${row.source_id}`, row]));
    // Each source that holds the amount reads the what-if, at its own precedence, so the winner does too.
    expect(byKey.get('pos-main|attr-mv|src-engine')).toMatchObject({ golden_value_numeric: amount, precedence_rank: 100 });
    expect(byKey.get('pos-main|attr-mv|src-manual')).toMatchObject({ golden_value_numeric: amount, precedence_rank: 1 });
    expect(byKey.get('pos-main|attr-fp|src-engine')).toMatchObject({ golden_value_numeric: amount });
    // A second saved proposal on the same cell counts as nothing in this score.
    expect(byKey.get('pos-extra|attr-mv|src-engine')).toMatchObject({ golden_value_numeric: 0 });
    // A portfolio lock is left out of compliance and is not touched.
    expect(inserted.some((row) => row.entity_id === 'pos-lock')).toBe(false);
    expect(inserted).toHaveLength(4);
  });

  it('writes nothing when the what-if matches what is saved', async () => {
    const db = database();
    const same = draft();
    same.request.adjustments = [{ fundId: 'solo', trancheId: 'tl', type: 'override', amount: 10 }];
    visible[1].golden_value_numeric = 10;
    visible[3].golden_value_numeric = 0;
    try {
      expect(previewFromDraft(same).rows[0].cells[0].amount).toBeCloseTo(10, 6);
      await stageAllocationWhatIf(db.client, same, 'user-1');
      expect(db.calls.filter((call) => call.op !== 'select')).toEqual([]);
    } finally {
      visible[1].golden_value_numeric = 7;
      visible[3].golden_value_numeric = 3;
    }
  });

  it('refuses the open end date, where a what-if row would read as current', async () => {
    const db = database();
    await expect(stageAllocationWhatIf(db.client, draft({ asOf: '9999-12-31' }), 'user-1')).rejects.toThrow(/before 9999-12-31/);
    expect(db.calls).toHaveLength(0);
  });
});
