/**
 * Turns the tabs the surface editor sends into the payload for
 * public.save_surface_catalog. Pure: every row is named by code, so the
 * database can write the whole catalog in one transaction.
 */

export interface ConditionInput {
  attribute?: string;
  operator?: string;
  value?: string;
}

export interface LayoutInput {
  name?: string;
  mode?: string;
  logic?: string;
  conditions?: ConditionInput[];
  recordNames?: string[];
}

export interface TabInput {
  slotCode?: string | null;
  name?: string;
  appearance?: string;
  logic?: string;
  conditions?: ConditionInput[];
  layouts?: LayoutInput[];
}

/** Another client's component on this surface. It is written back unchanged after a save. */
export interface ComponentOverlay {
  clientId: string;
  componentCode: string;
  componentName: string;
  description: string | null;
  displayOrder: number;
  panelKey: string | null;
  isActive: boolean;
  slotCode: string;
  variantCode: string | null;
  experienceCode: string | null;
}

interface RuleCondition {
  attributeCode: string;
  operator: 'equals' | 'not_equals';
  value: string;
}

export interface CatalogPayload {
  experiences: Array<{
    code: string;
    name: string;
    description: string;
    is_baseline: boolean;
    priority: number;
    display_order: number;
    rules: { logic: 'AND' | 'OR'; conditions: RuleCondition[] };
  }>;
  slots: Array<{
    code: string;
    name: string;
    description: string;
    display_order: number;
    optionality: 'always' | 'when_qualified';
  }>;
  variants: Array<{
    slot_code: string;
    code: string;
    name: string;
    description: string;
    priority: number;
    required: string[];
  }>;
  components: Array<{
    slot_code: string;
    variant_code: string | null;
    experience_code: string | null;
    code: string;
    name: string;
    description: string | null;
    display_order: number;
    client_id: string | null;
    panel_key: string | null;
    is_active: boolean;
  }>;
}

const BASELINE = 'BASELINE';

export function asTabs(raw: unknown): TabInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('A surface needs at least one tab.');
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('A tab is missing its definition.');
    return entry as TabInput;
  });
}

function ruleLogic(value: string | undefined): 'AND' | 'OR' {
  return value === 'OR' ? 'OR' : 'AND';
}

function ruleConditions(conditions: ConditionInput[] | undefined): RuleCondition[] {
  return (conditions || [])
    .filter((condition) => condition.attribute && condition.value)
    .map((condition) => ({
      attributeCode: String(condition.attribute),
      operator: condition.operator === 'is_not' ? 'not_equals' as const : 'equals' as const,
      value: String(condition.value),
    }));
}

function uniqueCode(preferred: string | null | undefined, name: string, used: Set<string>): string {
  const raw = (preferred || name || 'TAB').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  let code = raw || 'TAB';
  let suffix = 2;
  while (used.has(code)) {
    code = `${raw || 'TAB'}_${suffix++}`.slice(0, 100);
  }
  used.add(code);
  return code;
}

export function buildCatalogPayload(
  tabs: TabInput[],
  options: {
    /** Owner of the surface being saved. Its components carry this client. */
    surfaceClientId: string | null;
    /** Host panel each component or slot code mounted before the save. */
    panelByCode: ReadonlyMap<string, string | null>;
    overlays: readonly ComponentOverlay[];
  },
): CatalogPayload {
  const payload: CatalogPayload = {
    experiences: [{
      code: BASELINE,
      name: 'Baseline',
      description: 'On every record.',
      is_baseline: true,
      priority: 100,
      display_order: 1,
      rules: { logic: 'AND', conditions: [] },
    }],
    slots: [],
    variants: [],
    components: [],
  };

  const usedSlots = new Set<string>();
  const usedExperiences = new Set<string>([BASELINE]);

  for (const [index, tab] of tabs.entries()) {
    const name = (tab.name || '').trim() || `Tab ${index + 1}`;
    const slotCode = uniqueCode(tab.slotCode, name, usedSlots);
    const optionality = tab.appearance === 'when' ? 'when_qualified' as const : 'always' as const;
    const layouts: LayoutInput[] = Array.isArray(tab.layouts) && tab.layouts.length > 0
      ? tab.layouts
      : [{ name, mode: 'everyone', logic: 'AND', conditions: [], recordNames: [] }];

    let gateCode: string | null = null;
    if (optionality === 'when_qualified') {
      gateCode = uniqueCode(`GATE_${slotCode}`, name, usedExperiences);
      payload.experiences.push({
        code: gateCode,
        name,
        description: 'Decides whether this tab is open.',
        is_baseline: false,
        priority: 10,
        display_order: index + 2,
        rules: { logic: ruleLogic(tab.logic), conditions: ruleConditions(tab.conditions) },
      });
    }

    payload.slots.push({
      code: slotCode,
      name,
      description: optionality === 'when_qualified' ? 'Only when the rule qualifies.' : 'On every record.',
      display_order: index + 1,
      optionality,
    });

    for (const [layoutIndex, layout] of layouts.entries()) {
      const layoutName = (layout.name || '').trim() || name;
      const mode = layout.mode === 'records' || layout.mode === 'rule' ? layout.mode : 'everyone';
      const recordNames = (layout.recordNames || []).map((record) => String(record)).filter(Boolean);
      const conditions: RuleCondition[] = mode === 'records'
        ? recordNames.map((record) => ({ attributeCode: 'ENTITY_NAME', operator: 'equals' as const, value: record }))
        : mode === 'rule' ? ruleConditions(layout.conditions) : [];

      let layoutCode: string | null = null;
      if (conditions.length > 0) {
        layoutCode = uniqueCode(`LAYOUT_${slotCode}_${layoutIndex + 1}`, layoutName, usedExperiences);
        payload.experiences.push({
          code: layoutCode,
          name: layoutName,
          description: 'Decides which layout fills this tab.',
          is_baseline: false,
          priority: 10,
          display_order: 100 + index * 10 + layoutIndex,
          rules: { logic: mode === 'records' ? 'OR' : ruleLogic(layout.logic), conditions },
        });
      }

      const code = layouts.length === 1 ? slotCode : `${slotCode}_${layoutIndex + 1}`;
      payload.variants.push({
        slot_code: slotCode,
        code,
        name: layoutName,
        description: layoutName,
        priority: mode === 'everyone' ? 100 : 10 + layoutIndex,
        required: [gateCode, layoutCode].filter((entry): entry is string => Boolean(entry)),
      });
      payload.components.push({
        slot_code: slotCode,
        variant_code: code,
        experience_code: layoutCode ?? gateCode ?? BASELINE,
        code,
        name: layoutName,
        description: layoutName,
        display_order: layoutIndex + 1,
        client_id: options.surfaceClientId,
        panel_key: options.panelByCode.get(code) ?? options.panelByCode.get(slotCode) ?? null,
        is_active: true,
      });
    }
  }

  for (const overlay of options.overlays) {
    payload.components.push({
      slot_code: overlay.slotCode,
      variant_code: overlay.variantCode,
      experience_code: overlay.experienceCode,
      code: overlay.componentCode,
      name: overlay.componentName,
      description: overlay.description,
      display_order: overlay.displayOrder,
      client_id: overlay.clientId,
      panel_key: overlay.panelKey,
      is_active: overlay.isActive,
    });
  }

  return payload;
}
