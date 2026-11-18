import { describe, expect, it } from 'vitest';
import { asTabs, buildCatalogPayload, type ComponentOverlay } from './catalog-payload';

const none = { surfaceClientId: null, panelByCode: new Map<string, string | null>(), overlays: [] };

describe('asTabs', () => {
  it('refuses an empty surface', () => {
    expect(() => asTabs([])).toThrow('at least one tab');
  });
});

describe('buildCatalogPayload', () => {
  it('writes an always-on tab against the baseline and keeps its panel', () => {
    const payload = buildCatalogPayload(
      [{ slotCode: 'NAV', name: 'NAV' }],
      { ...none, panelByCode: new Map([['NAV', 'nav']]) },
    );
    expect(payload.experiences.map((row) => row.code)).toEqual(['BASELINE']);
    expect(payload.slots).toEqual([
      { code: 'NAV', name: 'NAV', description: 'On every record.', display_order: 1, optionality: 'always' },
    ]);
    expect(payload.variants[0]).toMatchObject({ slot_code: 'NAV', code: 'NAV', priority: 100, required: [] });
    expect(payload.components[0]).toMatchObject({
      slot_code: 'NAV', variant_code: 'NAV', experience_code: 'BASELINE', panel_key: 'nav', client_id: null,
    });
  });

  it('gates a conditional tab and requires the gate on every layout', () => {
    const payload = buildCatalogPayload(
      [{
        slotCode: 'ACCOUNTS',
        name: 'Capital accounts',
        appearance: 'when',
        conditions: [{ attribute: 'FUND_STRUCTURE', operator: 'is', value: 'CLOSED_END' }],
        layouts: [
          { name: 'Standard', mode: 'everyone' },
          { name: 'Named funds', mode: 'records', recordNames: ['Fund A', 'Fund B'] },
        ],
      }],
      none,
    );
    expect(payload.experiences.map((row) => row.code)).toEqual(['BASELINE', 'GATE_ACCOUNTS', 'LAYOUT_ACCOUNTS_2']);
    expect(payload.experiences[2].rules).toEqual({
      logic: 'OR',
      conditions: [
        { attributeCode: 'ENTITY_NAME', operator: 'equals', value: 'Fund A' },
        { attributeCode: 'ENTITY_NAME', operator: 'equals', value: 'Fund B' },
      ],
    });
    expect(payload.variants.map((row) => [row.code, row.priority, row.required])).toEqual([
      ['ACCOUNTS_1', 100, ['GATE_ACCOUNTS']],
      ['ACCOUNTS_2', 11, ['GATE_ACCOUNTS', 'LAYOUT_ACCOUNTS_2']],
    ]);
    expect(payload.components.map((row) => row.experience_code)).toEqual(['GATE_ACCOUNTS', 'LAYOUT_ACCOUNTS_2']);
  });

  it('keeps written descriptions and component order, and refreshes generated ones', () => {
    const payload = buildCatalogPayload(
      [
        { slotCode: 'CLOSING', name: 'Closing' },
        { slotCode: 'FUNDING', name: 'Funding test', appearance: 'when', conditions: [{ attribute: 'A', value: 'B' }] },
      ],
      {
        ...none,
        prior: {
          slotDescriptions: new Map([['CLOSING', 'Closing checklist and funds flow.'], ['FUNDING', 'On every record.']]),
          variants: new Map([
            ['CLOSING/CLOSING', { name: 'Closing', description: 'Checklist.' }],
            ['FUNDING/FUNDING', { name: 'Funding', description: 'Funding' }],
          ]),
          components: new Map([
            ['CLOSING', { name: 'Closing', description: 'Checklist.', displayOrder: 8 }],
            ['FUNDING', { name: 'Funding', description: 'Funding', displayOrder: 1 }],
          ]),
        },
      },
    );
    expect(payload.slots.map((row) => row.description)).toEqual([
      'Closing checklist and funds flow.',
      'Only when the rule qualifies.',
    ]);
    expect(payload.variants.map((row) => row.description)).toEqual(['Checklist.', 'Funding test']);
    expect(payload.components.map((row) => [row.description, row.display_order])).toEqual([
      ['Checklist.', 8],
      ['Funding test', 1],
    ]);
  });

  it('gives two tabs with the same name different codes', () => {
    const payload = buildCatalogPayload([{ name: 'Notes' }, { name: 'Notes' }], none);
    expect(payload.slots.map((row) => row.code)).toEqual(['NOTES', 'NOTES_2']);
  });

  it('carries the surface owner and writes other clients’ components back', () => {
    const overlay: ComponentOverlay = {
      clientId: 'client-b', componentCode: 'NAV', componentName: 'NAV', description: null, displayOrder: 1,
      panelKey: 'nav-custom', isActive: true, slotCode: 'NAV', variantCode: 'NAV', experienceCode: 'BASELINE',
    };
    const gone: ComponentOverlay = { ...overlay, componentCode: 'OLD', slotCode: 'REMOVED' };
    const payload = buildCatalogPayload(
      [{ slotCode: 'NAV', name: 'NAV' }],
      { surfaceClientId: 'client-a', panelByCode: new Map(), overlays: [overlay, gone] },
    );
    expect(payload.components.map((row) => [row.code, row.client_id, row.panel_key])).toEqual([
      ['NAV', 'client-a', null],
      ['NAV', 'client-b', 'nav-custom'],
      ['OLD', 'client-b', 'nav-custom'],
    ]);
  });
});
