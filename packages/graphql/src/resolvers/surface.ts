import { Context } from '../context';
import { activeSurfaceClientId } from './schema-scope';
import {
  mergeClientComponents,
  panelKeyForSlot,
  preferClientScope,
} from '../lib/surface-composition/client-scope';
import {
  ApplicabilityRules,
  CatalogComponent,
  CatalogExperience,
  CatalogSlot,
  CatalogVariant,
  mergeFacts,
  normalizeFacts,
  resolveSurfaceComposition,
  describeRules,
  SurfaceFact,
} from '../lib/surface-composition/resolve';

interface SurfaceRow {
  id: string;
  surface_code: string;
  surface_name: string;
  domain_code: string;
  description: string | null;
  is_active: boolean;
  is_primary?: boolean;
  client_id?: string | null;
}

interface ExperienceRow {
  id: string;
  experience_code: string;
  experience_name: string;
  description: string | null;
  is_baseline: boolean;
  qualification_priority: number;
  display_order: number;
  applicability_rules: ApplicabilityRules | null;
}

interface SlotRow {
  id: string;
  slot_code: string;
  slot_name: string;
  description: string | null;
  display_order: number;
  optionality: 'always' | 'when_qualified';
}

interface VariantRow {
  id: string;
  slot_id: string;
  variant_code: string;
  variant_name: string;
  description: string | null;
  qualification_priority: number;
}

interface RequirementRow {
  variant_id: string;
  experience_id: string;
}

interface ComponentRow {
  id: string;
  slot_id: string;
  variant_id: string | null;
  experience_id: string | null;
  component_code: string;
  component_name: string;
  description: string | null;
  display_order: number;
  client_id?: string | null;
  panel_key?: string | null;
  is_active?: boolean;
}

interface ProfileRow {
  id: string;
  profile_code: string;
  profile_name: string;
  description: string | null;
  template_code: string | null;
  facts: unknown;
  display_order: number;
}

interface LoadedCatalog {
  surface: SurfaceRow;
  experiences: ExperienceRow[];
  slots: SlotRow[];
  variants: VariantRow[];
  requirements: RequirementRow[];
  components: ComponentRow[];
  profiles: ProfileRow[];
}

function mapSurface(row: SurfaceRow) {
  return {
    id: row.id,
    surfaceCode: row.surface_code,
    surfaceName: row.surface_name,
    domainCode: row.domain_code,
    description: row.description,
    isActive: row.is_active,
    isPrimary: row.is_primary === true,
    clientId: row.client_id ?? null,
  };
}

function scopedSurface<T extends SurfaceRow>(rows: T[], clientId: string | null): T | null {
  return preferClientScope(
    rows.map((row) => ({ ...row, code: row.surface_code, clientId: row.client_id ?? null })),
    clientId,
  )[0] ?? null;
}

async function loadCatalog(context: Context, surfaceCode: string): Promise<LoadedCatalog | null> {
  const clientId = await activeSurfaceClientId(context);
  const { data: surfaces, error: surfaceError } = await context.supabase
    .from('surface_definitions')
    .select('*')
    .eq('surface_code', surfaceCode)
    .eq('is_active', true);
  if (surfaceError) throw new Error(`Failed to load surface: ${surfaceError.message}`);
  const surface = scopedSurface((surfaces || []) as SurfaceRow[], clientId);
  if (!surface) return null;

  const [experiences, slots, components, profiles] = await Promise.all([
    context.supabase
      .from('surface_experiences')
      .select('*')
      .eq('surface_id', surface.id)
      .eq('is_active', true)
      .order('display_order'),
    context.supabase
      .from('surface_page_slots')
      .select('*')
      .eq('surface_id', surface.id)
      .order('display_order'),
    context.supabase
      .from('surface_components')
      .select('*')
      .eq('surface_id', surface.id)
      .eq('is_active', true)
      .order('display_order'),
    context.supabase
      .from('surface_sample_profiles')
      .select('*')
      .eq('surface_id', surface.id)
      .order('display_order'),
  ]);

  for (const result of [experiences, slots, components, profiles]) {
    if (result.error) throw new Error(`Failed to load surface catalog: ${result.error.message}`);
  }

  const slotIds = (slots.data || []).map((slot: SlotRow) => slot.id);
  let variants: VariantRow[] = [];
  let requirements: RequirementRow[] = [];
  if (slotIds.length > 0) {
    const variantResult = await context.supabase
      .from('surface_page_variants')
      .select('*')
      .in('slot_id', slotIds)
      .eq('is_active', true);
    if (variantResult.error) throw new Error(`Failed to load page variants: ${variantResult.error.message}`);
    variants = variantResult.data || [];
    const variantIds = variants.map((variant) => variant.id);
    if (variantIds.length > 0) {
      const requirementResult = await context.supabase
        .from('surface_variant_requirements')
        .select('variant_id, experience_id')
        .in('variant_id', variantIds);
      if (requirementResult.error) throw new Error(`Failed to load variant requirements: ${requirementResult.error.message}`);
      requirements = requirementResult.data || [];
    }
  }

  const componentRows = mergeClientComponents(
    ((components.data || []) as ComponentRow[]).map((row) => ({
      ...row,
      code: row.component_code,
      clientId: row.client_id ?? null,
    })),
    clientId,
  );

  return {
    surface,
    experiences: experiences.data || [],
    slots: slots.data || [],
    variants,
    requirements,
    components: componentRows,
    profiles: profiles.data || [],
  };
}

function toEngineCatalog(catalog: LoadedCatalog) {
  const requirementsByVariant = new Map<string, string[]>();
  for (const requirement of catalog.requirements) {
    const list = requirementsByVariant.get(requirement.variant_id) ?? [];
    list.push(requirement.experience_id);
    requirementsByVariant.set(requirement.variant_id, list);
  }

  const experiences: CatalogExperience[] = catalog.experiences.map((row) => ({
    id: row.id,
    code: row.experience_code,
    name: row.experience_name,
    isBaseline: row.is_baseline,
    priority: row.qualification_priority,
    displayOrder: row.display_order,
    rules: row.applicability_rules ?? {},
  }));
  const slots: CatalogSlot[] = catalog.slots.map((row) => ({
    id: row.id,
    code: row.slot_code,
    name: row.slot_name,
    displayOrder: row.display_order,
    optionality: row.optionality,
  }));
  const variants: CatalogVariant[] = catalog.variants.map((row) => ({
    id: row.id,
    slotId: row.slot_id,
    code: row.variant_code,
    name: row.variant_name,
    priority: row.qualification_priority,
    requiredExperienceIds: requirementsByVariant.get(row.id) ?? [],
  }));
  const components: CatalogComponent[] = catalog.components.map((row) => ({
    id: row.id,
    code: row.component_code,
    name: row.component_name,
    slotId: row.slot_id,
    variantId: row.variant_id,
    experienceId: row.experience_id,
    displayOrder: row.display_order,
  }));
  return { experiences, slots, variants, components };
}

function attributeValue(raw: unknown): string | number | boolean | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'object' && raw && 'value' in raw) {
    const value = (raw as { value: unknown }).value;
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return String(value);
  }
  return String(raw);
}

async function loadEntityFacts(
  context: Context,
  entityId?: string | null,
  entityCode?: string | null,
): Promise<{ name: string; domainCode: string; templateCode: string | null; facts: ReturnType<typeof normalizeFacts> } | null> {
  if (!entityId && !entityCode) return null;
  let query = context.supabase
    .from('entity_master')
    .select('entity_id, entity_code, entity_name, domain_code, template_id, attributes, parent_relationships, child_relationships');
  query = entityId ? query.eq('entity_id', entityId) : query.eq('entity_code', entityCode as string);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to load entity: ${error.message}`);
  if (!data) return null;

  let templateCode: string | null = null;
  if (data.template_id) {
    const { data: template, error: templateError } = await context.supabase
      .from('domain_templates')
      .select('template_code')
      .eq('id', data.template_id)
      .maybeSingle();
    if (templateError) throw new Error(`Failed to load template: ${templateError.message}`);
    templateCode = template?.template_code ?? null;
  }

  const attributes: Record<string, string | number | boolean> = {};
  const sourceAttributes = data.attributes && typeof data.attributes === 'object' ? data.attributes as Record<string, unknown> : {};
  for (const [code, raw] of Object.entries(sourceAttributes)) {
    const value = attributeValue(raw);
    if (value !== null) attributes[code] = value;
  }

  const relationships = new Set<string>();
  const parents = Array.isArray(data.parent_relationships) ? data.parent_relationships : [];
  const children = Array.isArray(data.child_relationships) ? data.child_relationships : [];
  for (const relationship of [...parents, ...children]) {
    if (!relationship || typeof relationship !== 'object') continue;
    const record = relationship as { relationship_type?: string; relationship_code?: string };
    const code = record.relationship_type || record.relationship_code;
    if (code) relationships.add(code);
  }

  const facts = normalizeFacts({ attributes, relationships: [...relationships] }, templateCode);
  const name = data.entity_name || data.entity_code;
  if (name && facts.map.ENTITY_NAME == null) {
    facts.map.ENTITY_NAME = name;
    facts.labeled.push({ key: 'ENTITY_NAME', value: String(name), source: 'ATTRIBUTE' });
  }

  return {
    name,
    domainCode: data.domain_code,
    templateCode,
    facts,
  };
}

function presentResolution(
  catalog: LoadedCatalog,
  subjectName: string,
  subjectKind: 'PROFILE' | 'ENTITY',
  templateCode: string | null,
  labeled: SurfaceFact[],
  map: Record<string, string | number | boolean | null>,
  note: string | null,
) {
  const resolved = resolveSurfaceComposition(toEngineCatalog(catalog), map);
  const componentById = new Map(catalog.components.map((row) => [row.id, row]));
  const slotCodeById = new Map(catalog.slots.map((slot) => [slot.id, slot.slot_code]));
  const components = resolved.components.map((component) => {
    const row = componentById.get(component.componentId);
    return {
      componentCode: component.code,
      componentName: component.name,
      pageName: component.pageName,
      experienceName: component.experienceName,
      status: component.status,
      ruleTrace: component.ruleTrace,
      clientId: row?.client_id ?? null,
      panelKey: row?.panel_key ?? null,
      slotCode: row ? slotCodeById.get(row.slot_id) ?? '' : '',
    };
  });
  const panelBySlot = panelKeyForSlot(components);
  return {
    surfaceCode: catalog.surface.surface_code,
    surfaceName: catalog.surface.surface_name,
    domainCode: catalog.surface.domain_code,
    subjectName,
    subjectKind,
    templateCode,
    note,
    facts: labeled,
    experiences: resolved.experiences.map((experience) => ({
      experienceCode: experience.code,
      experienceName: experience.name,
      status: experience.status,
      ruleTrace: experience.ruleTrace,
    })),
    pages: resolved.pages.map((page) => ({
      slotCode: page.slotCode,
      slotName: page.slotName,
      optionality: page.optionality,
      status: page.status,
      variantCode: page.variantCode,
      variantName: page.variantName,
      decision: page.decision,
      panelKey: panelBySlot.get(page.slotCode) ?? null,
    })),
    components: components.map((component) => ({
      componentCode: component.componentCode,
      componentName: component.componentName,
      pageName: component.pageName,
      experienceName: component.experienceName,
      status: component.status,
      ruleTrace: component.ruleTrace,
      clientId: component.clientId,
      panelKey: component.panelKey,
    })),
  };
}

async function resolveForSurface(
  context: Context,
  args: { surfaceCode: string; profileCode?: string | null; entityId?: string | null; entityCode?: string | null; facts?: unknown },
) {
  const catalog = await loadCatalog(context, args.surfaceCode);
  if (!catalog) return null;

  const overlay = args.facts ? normalizeFacts(args.facts) : null;
  if (args.entityId || args.entityCode) {
    const entity = await loadEntityFacts(context, args.entityId, args.entityCode);
    if (!entity) throw new Error(`No entity found for ${args.entityCode || args.entityId}.`);
    const facts = overlay ? mergeFacts(entity.facts, overlay) : entity.facts;
    const notes = [
      entity.domainCode === catalog.surface.domain_code
        ? null
        : `This entity is a ${entity.domainCode} record. The ${catalog.surface.surface_name} expects ${catalog.surface.domain_code}. The facts were still evaluated.`,
      typeSwapNote(entity.facts.map, facts.map),
    ].filter((note): note is string => Boolean(note));
    return presentResolution(
      catalog,
      entity.name,
      'ENTITY',
      effectiveTemplate(facts.map, entity.templateCode),
      facts.labeled,
      facts.map,
      notes.length > 0 ? notes.join(' ') : null,
    );
  }

  const profile = args.profileCode
    ? catalog.profiles.find((candidate) => candidate.profile_code === args.profileCode) ?? null
    : catalog.profiles[0] ?? null;
  if (!profile && !overlay) return null;

  const base = normalizeFacts(profile?.facts ?? {}, profile?.template_code ?? null);
  const facts = overlay ? mergeFacts(base, overlay) : base;
  return presentResolution(
    catalog,
    profile?.profile_name ?? 'Ad hoc profile',
    'PROFILE',
    effectiveTemplate(facts.map, profile?.template_code ?? null),
    facts.labeled,
    facts.map,
    typeSwapNote(base.map, facts.map),
  );
}

function effectiveTemplate(
  facts: Record<string, string | number | boolean | null>,
  fallback: string | null,
): string | null {
  return typeof facts.TEMPLATE_CODE === 'string' ? facts.TEMPLATE_CODE : fallback;
}

function typeSwapNote(
  before: Record<string, string | number | boolean | null>,
  after: Record<string, string | number | boolean | null>,
): string | null {
  const from = before.FUND_STRUCTURE;
  const to = after.FUND_STRUCTURE;
  if (!from || !to || String(from) === String(to)) return null;
  return `Fund type swapped from ${from} to ${to}. The same sample fund is resolved again under the new type.`;
}

interface ConditionInput {
  attribute?: string;
  operator?: string;
  value?: string;
}

interface LayoutInput {
  name?: string;
  mode?: string;
  logic?: string;
  conditions?: ConditionInput[];
  recordNames?: string[];
}

interface TabInput {
  slotCode?: string | null;
  name?: string;
  appearance?: string;
  logic?: string;
  conditions?: ConditionInput[];
  layouts?: LayoutInput[];
}

function asTabs(raw: unknown): TabInput[] {
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

function ruleConditions(conditions: ConditionInput[] | undefined) {
  return (conditions || [])
    .filter((condition) => condition.attribute && condition.value)
    .map((condition) => ({
      attributeCode: String(condition.attribute),
      operator: condition.operator === 'is_not' ? 'not_equals' as const : 'equals' as const,
      value: String(condition.value),
    }));
}

function slotCodeFor(preferred: string | null | undefined, name: string, used: Set<string>): string {
  const raw = (preferred || name || 'TAB').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  let code = raw || 'TAB';
  let suffix = 2;
  while (used.has(code)) {
    code = `${raw || 'TAB'}_${suffix++}`.slice(0, 100);
  }
  used.add(code);
  return code;
}

interface ComponentOverlay {
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

async function readComponentMemory(context: Context, surfaceId: string, surfaceClientId: string | null) {
  const { data: components, error } = await context.supabase
    .from('surface_components')
    .select('component_code, component_name, description, display_order, client_id, panel_key, is_active, slot_id, variant_id, experience_id')
    .eq('surface_id', surfaceId);
  if (error) throw new Error(`Failed to read components: ${error.message}`);
  const rows = (components || []) as ComponentRow[];
  const slotIds = [...new Set(rows.map((row) => row.slot_id))];
  const variantIds = [...new Set(rows.map((row) => row.variant_id).filter((id): id is string => Boolean(id)))];
  const experienceIds = [...new Set(rows.map((row) => row.experience_id).filter((id): id is string => Boolean(id)))];
  const [slots, variants, experiences] = await Promise.all([
    slotIds.length
      ? context.supabase.from('surface_page_slots').select('id, slot_code').in('id', slotIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? context.supabase.from('surface_page_variants').select('id, variant_code').in('id', variantIds)
      : Promise.resolve({ data: [], error: null }),
    experienceIds.length
      ? context.supabase.from('surface_experiences').select('id, experience_code').in('id', experienceIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [slots, variants, experiences]) {
    if (result.error) throw new Error(`Failed to read components: ${result.error.message}`);
  }
  const slotCode = new Map((slots.data || []).map((row: { id: string; slot_code: string }) => [row.id, row.slot_code]));
  const variantCode = new Map((variants.data || []).map((row: { id: string; variant_code: string }) => [row.id, row.variant_code]));
  const experienceCode = new Map((experiences.data || []).map((row: { id: string; experience_code: string }) => [row.id, row.experience_code]));
  const panelByCode = new Map<string, string | null>();
  const overlays: ComponentOverlay[] = [];
  for (const row of rows) {
    const code = slotCode.get(row.slot_id);
    if (!code) continue;
    const ownsRow = !row.client_id || row.client_id === surfaceClientId;
    if (ownsRow) {
      panelByCode.set(row.component_code, row.panel_key ?? null);
      if (!panelByCode.has(code)) panelByCode.set(code, row.panel_key ?? null);
      continue;
    }
    overlays.push({
      clientId: row.client_id as string,
      componentCode: row.component_code,
      componentName: row.component_name,
      description: row.description,
      displayOrder: row.display_order,
      panelKey: row.panel_key ?? null,
      isActive: row.is_active !== false,
      slotCode: code,
      variantCode: row.variant_id ? variantCode.get(row.variant_id) ?? null : null,
      experienceCode: row.experience_id ? experienceCode.get(row.experience_id) ?? null : null,
    });
  }
  return { panelByCode, overlays };
}

async function restoreOverlays(context: Context, surfaceId: string, overlays: ComponentOverlay[]) {
  if (overlays.length === 0) return;
  const { data: slots, error: slotError } = await context.supabase
    .from('surface_page_slots')
    .select('id, slot_code')
    .eq('surface_id', surfaceId);
  if (slotError) throw new Error(`Failed to restore client components: ${slotError.message}`);
  const slotByCode = new Map((slots || []).map((slot: { id: string; slot_code: string }) => [slot.slot_code, slot.id]));
  const slotIds = [...slotByCode.values()];
  const [{ data: variants, error: variantError }, { data: experiences, error: experienceError }] = await Promise.all([
    slotIds.length
      ? context.supabase.from('surface_page_variants').select('id, slot_id, variant_code').in('slot_id', slotIds)
      : Promise.resolve({ data: [], error: null }),
    context.supabase.from('surface_experiences').select('id, experience_code').eq('surface_id', surfaceId),
  ]);
  if (variantError) throw new Error(`Failed to restore client components: ${variantError.message}`);
  if (experienceError) throw new Error(`Failed to restore client components: ${experienceError.message}`);
  const experienceByCode = new Map((experiences || []).map((row: { id: string; experience_code: string }) => [row.experience_code, row.id]));
  for (const overlay of overlays) {
    const slotId = slotByCode.get(overlay.slotCode);
    if (!slotId) continue;
    const variant = (variants || []).find((row: { id: string; slot_id: string; variant_code: string }) =>
      row.slot_id === slotId && row.variant_code === overlay.variantCode);
    const inserted = await context.supabase.from('surface_components').insert({
      surface_id: surfaceId,
      slot_id: slotId,
      variant_id: variant?.id ?? null,
      experience_id: overlay.experienceCode ? experienceByCode.get(overlay.experienceCode) ?? null : null,
      component_code: overlay.componentCode,
      component_name: overlay.componentName,
      description: overlay.description,
      display_order: overlay.displayOrder,
      client_id: overlay.clientId,
      panel_key: overlay.panelKey,
      is_active: overlay.isActive,
    });
    if (inserted.error) throw new Error(`Failed to restore client components: ${inserted.error.message}`);
  }
}

async function saveSurfaceTabs(context: Context, surfaceCode: string, rawTabs: unknown) {
  const tabs = asTabs(rawTabs);
  const clientId = await activeSurfaceClientId(context);
  const { data: surfaces, error: surfaceError } = await context.supabase
    .from('surface_definitions')
    .select('*')
    .eq('surface_code', surfaceCode)
    .eq('is_active', true);
  if (surfaceError) throw new Error(`Failed to load surface: ${surfaceError.message}`);
  const surface = scopedSurface((surfaces || []) as SurfaceRow[], clientId);
  if (!surface) throw new Error(`No surface named ${surfaceCode}.`);
  const memory = await readComponentMemory(context, surface.id, surface.client_id ?? null);

  const componentDelete = await context.supabase.from('surface_components').delete().eq('surface_id', surface.id);
  if (componentDelete.error) throw new Error(`Failed to replace tabs: ${componentDelete.error.message}`);
  const slotDelete = await context.supabase.from('surface_page_slots').delete().eq('surface_id', surface.id);
  if (slotDelete.error) throw new Error(`Failed to replace tabs: ${slotDelete.error.message}`);
  const experienceDelete = await context.supabase.from('surface_experiences').delete().eq('surface_id', surface.id);
  if (experienceDelete.error) throw new Error(`Failed to replace rules: ${experienceDelete.error.message}`);

  const baseline = await context.supabase
    .from('surface_experiences')
    .insert({
      surface_id: surface.id,
      experience_code: 'BASELINE',
      experience_name: 'Baseline',
      description: 'On every record.',
      is_baseline: true,
      qualification_priority: 100,
      display_order: 1,
      applicability_rules: { logic: 'AND', conditions: [] },
    })
    .select('id')
    .single();
  if (baseline.error || !baseline.data) throw new Error(`Failed to save the baseline: ${baseline.error?.message}`);

  const usedSlots = new Set<string>();
  const usedExperiences = new Set<string>(['BASELINE']);

  for (const [index, tab] of tabs.entries()) {
    const name = (tab.name || '').trim() || `Tab ${index + 1}`;
    const slotCode = slotCodeFor(tab.slotCode, name, usedSlots);
    const appearance = tab.appearance === 'when' ? 'when_qualified' : 'always';
    const layouts = Array.isArray(tab.layouts) && tab.layouts.length > 0
      ? tab.layouts
      : [{ name, mode: 'everyone', logic: 'AND', conditions: [], recordNames: [] }];

    let gateId: string | null = null;
    if (appearance === 'when_qualified') {
      const gateCode = slotCodeFor(`GATE_${slotCode}`, name, usedExperiences);
      const gate = await context.supabase
        .from('surface_experiences')
        .insert({
          surface_id: surface.id,
          experience_code: gateCode,
          experience_name: name,
          description: 'Decides whether this tab is open.',
          is_baseline: false,
          qualification_priority: 10,
          display_order: index + 2,
          applicability_rules: { logic: ruleLogic(tab.logic), conditions: ruleConditions(tab.conditions) },
        })
        .select('id')
        .single();
      if (gate.error || !gate.data) throw new Error(`Failed to save the rule for ${name}: ${gate.error?.message}`);
      gateId = gate.data.id;
    }

    const slot = await context.supabase
      .from('surface_page_slots')
      .insert({
        surface_id: surface.id,
        slot_code: slotCode,
        slot_name: name,
        description: appearance === 'when_qualified' ? 'Only when the rule qualifies.' : 'On every record.',
        display_order: index + 1,
        optionality: appearance,
      })
      .select('id')
      .single();
    if (slot.error || !slot.data) throw new Error(`Failed to save ${name}: ${slot.error?.message}`);

    for (const [layoutIndex, layout] of layouts.entries()) {
      const layoutName = (layout.name || '').trim() || name;
      const mode = layout.mode === 'records' || layout.mode === 'rule' ? layout.mode : 'everyone';
      const recordNames = (layout.recordNames || []).map((record) => String(record)).filter(Boolean);
      const conditions = mode === 'records'
        ? recordNames.map((record) => ({ attributeCode: 'ENTITY_NAME', operator: 'equals' as const, value: record }))
        : mode === 'rule' ? ruleConditions(layout.conditions) : [];
      let experienceId: string | null = gateId;
      if (conditions.length > 0) {
        const experienceCode = slotCodeFor(`LAYOUT_${slotCode}_${layoutIndex + 1}`, layoutName, usedExperiences);
        const experience = await context.supabase
          .from('surface_experiences')
          .insert({
            surface_id: surface.id,
            experience_code: experienceCode,
            experience_name: layoutName,
            description: 'Decides which layout fills this tab.',
            is_baseline: false,
            qualification_priority: 10,
            display_order: 100 + index * 10 + layoutIndex,
            applicability_rules: { logic: mode === 'records' ? 'OR' : ruleLogic(layout.logic), conditions },
          })
          .select('id')
          .single();
        if (experience.error || !experience.data) throw new Error(`Failed to save the layout for ${name}: ${experience.error?.message}`);
        experienceId = experience.data.id;
      }

      const variantCode = layouts.length === 1 ? slotCode : `${slotCode}_${layoutIndex + 1}`;
      const variant = await context.supabase
        .from('surface_page_variants')
        .insert({
          slot_id: slot.data.id,
          variant_code: variantCode,
          variant_name: layoutName,
          description: layoutName,
          qualification_priority: mode === 'everyone' ? 100 : 10 + layoutIndex,
        })
        .select('id')
        .single();
      if (variant.error || !variant.data) throw new Error(`Failed to save the layout for ${name}: ${variant.error?.message}`);

      const required = [gateId, conditions.length > 0 ? experienceId : null].filter((id): id is string => Boolean(id));
      if (appearance === 'when_qualified' && gateId && !required.includes(gateId)) required.unshift(gateId);
      const uniqueRequired = [...new Set(required)];
      if (uniqueRequired.length > 0) {
        const requirement = await context.supabase.from('surface_variant_requirements').insert(
          uniqueRequired.map((experience) => ({ variant_id: variant.data.id, experience_id: experience })),
        );
        if (requirement.error) throw new Error(`Failed to save the rule for ${name}: ${requirement.error.message}`);
      }

      const componentCode = layouts.length === 1 ? slotCode : `${slotCode}_${layoutIndex + 1}`;
      const component = await context.supabase.from('surface_components').insert({
        surface_id: surface.id,
        slot_id: slot.data.id,
        variant_id: variant.data.id,
        experience_id: experienceId || baseline.data.id,
        component_code: componentCode,
        component_name: layoutName,
        description: layoutName,
        display_order: layoutIndex + 1,
        client_id: surface.client_id ?? null,
        panel_key: memory.panelByCode.get(componentCode) ?? memory.panelByCode.get(slotCode) ?? null,
      });
      if (component.error) throw new Error(`Failed to save the contents of ${name}: ${component.error.message}`);
    }
  }

  await restoreOverlays(context, surface.id, memory.overlays);
}

export const surfaceResolvers = {
  Query: {
    surfaces: async (_: unknown, __: unknown, context: Context) => {
      const clientId = await activeSurfaceClientId(context);
      const { data, error } = await context.supabase
        .from('surface_definitions')
        .select('*')
        .eq('is_active', true)
        .order('surface_name');
      if (error) throw new Error(`Failed to list surfaces: ${error.message}`);
      return preferClientScope(
        ((data || []) as SurfaceRow[]).map((row) => ({
          ...row,
          code: row.surface_code,
          clientId: row.client_id ?? null,
        })),
        clientId,
      ).map(mapSurface);
    },

    surfaceCatalog: async (_: unknown, args: { surfaceCode: string }, context: Context) => {
      const catalog = await loadCatalog(context, args.surfaceCode);
      if (!catalog) return null;
      const experienceCodeById = new Map(catalog.experiences.map((row) => [row.id, row.experience_code]));
      const slotCodeById = new Map(catalog.slots.map((row) => [row.id, row.slot_code]));
      const variantCodeById = new Map(catalog.variants.map((row) => [row.id, row.variant_code]));
      const requirementsByVariant = new Map<string, string[]>();
      for (const requirement of catalog.requirements) {
        const code = experienceCodeById.get(requirement.experience_id);
        if (!code) continue;
        const list = requirementsByVariant.get(requirement.variant_id) ?? [];
        list.push(code);
        requirementsByVariant.set(requirement.variant_id, list);
      }

      return {
        surface: mapSurface(catalog.surface),
        experiences: catalog.experiences.map((row) => ({
          id: row.id,
          experienceCode: row.experience_code,
          experienceName: row.experience_name,
          description: row.description,
          isBaseline: row.is_baseline,
          qualificationPriority: row.qualification_priority,
          displayOrder: row.display_order,
          applicabilityRules: row.applicability_rules ?? {},
          ruleSummary: describeRules(row.applicability_rules, row.is_baseline),
        })),
        slots: catalog.slots.map((slot) => ({
          id: slot.id,
          slotCode: slot.slot_code,
          slotName: slot.slot_name,
          description: slot.description,
          displayOrder: slot.display_order,
          optionality: slot.optionality,
          variants: catalog.variants
            .filter((variant) => variant.slot_id === slot.id)
            .sort((left, right) => left.qualification_priority - right.qualification_priority || left.variant_code.localeCompare(right.variant_code))
            .map((variant) => ({
              id: variant.id,
              variantCode: variant.variant_code,
              variantName: variant.variant_name,
              description: variant.description,
              qualificationPriority: variant.qualification_priority,
              requiredExperienceCodes: requirementsByVariant.get(variant.id) ?? [],
            })),
        })),
        components: catalog.components.map((component) => ({
          id: component.id,
          componentCode: component.component_code,
          componentName: component.component_name,
          description: component.description,
          slotCode: slotCodeById.get(component.slot_id) ?? null,
          variantCode: component.variant_id ? variantCodeById.get(component.variant_id) ?? null : null,
          experienceCode: component.experience_id ? experienceCodeById.get(component.experience_id) ?? null : null,
          displayOrder: component.display_order,
          clientId: component.client_id ?? null,
          panelKey: component.panel_key ?? null,
        })),
        sampleProfiles: catalog.profiles.map((profile) => ({
          id: profile.id,
          profileCode: profile.profile_code,
          profileName: profile.profile_name,
          description: profile.description,
          templateCode: profile.template_code,
          facts: profile.facts ?? {},
        })),
      };
    },

    resolveSurface: async (
      _: unknown,
      args: { surfaceCode: string; profileCode?: string | null; entityId?: string | null; entityCode?: string | null; facts?: unknown },
      context: Context,
    ) => resolveForSurface(context, args),

    entitySurface: async (
      _: unknown,
      args: { entityId?: string | null; entityCode?: string | null },
      context: Context,
    ) => {
      const entity = await loadEntityFacts(context, args.entityId, args.entityCode);
      if (!entity) return null;
      const clientId = await activeSurfaceClientId(context);
      const { data: surfaces, error } = await context.supabase
        .from('surface_definitions')
        .select('surface_code, client_id')
        .eq('domain_code', entity.domainCode)
        .eq('is_active', true)
        .eq('is_primary', true)
        .order('surface_code');
      if (error) throw new Error(`Failed to find surface: ${error.message}`);
      const surface = preferClientScope(
        (surfaces || []).map((row: { surface_code: string; client_id: string | null }) => ({
          code: row.surface_code,
          clientId: row.client_id ?? null,
        })),
        clientId,
      )[0];
      if (!surface) return null;
      return resolveForSurface(context, {
        surfaceCode: surface.code,
        entityId: args.entityId,
        entityCode: args.entityId ? null : args.entityCode,
      });
    },
  },

  Mutation: {
    saveSurfaceCatalog: async (
      _: unknown,
      args: { surfaceCode: string; tabs: unknown },
      context: Context,
    ) => {
      await saveSurfaceTabs(context, args.surfaceCode, args.tabs);
      return surfaceResolvers.Query.surfaceCatalog(_, { surfaceCode: args.surfaceCode }, context);
    },
  },
};
