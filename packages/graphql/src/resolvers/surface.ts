import { Context } from '../context';
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
  };
}

async function loadCatalog(context: Context, surfaceCode: string): Promise<LoadedCatalog | null> {
  const { data: surface, error: surfaceError } = await context.supabase
    .from('surface_definitions')
    .select('*')
    .eq('surface_code', surfaceCode)
    .eq('is_active', true)
    .maybeSingle();
  if (surfaceError) throw new Error(`Failed to load surface: ${surfaceError.message}`);
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

  return {
    surface,
    experiences: experiences.data || [],
    slots: slots.data || [],
    variants,
    requirements,
    components: components.data || [],
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

  return {
    name: data.entity_name || data.entity_code,
    domainCode: data.domain_code,
    templateCode,
    facts: normalizeFacts({ attributes, relationships: [...relationships] }, templateCode),
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
    })),
    components: resolved.components.map((component) => ({
      componentCode: component.code,
      componentName: component.name,
      pageName: component.pageName,
      experienceName: component.experienceName,
      status: component.status,
      ruleTrace: component.ruleTrace,
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
    const note = entity.domainCode === catalog.surface.domain_code
      ? null
      : `This entity is a ${entity.domainCode} record. The ${catalog.surface.surface_name} expects ${catalog.surface.domain_code}. The facts were still evaluated.`;
    return presentResolution(catalog, entity.name, 'ENTITY', entity.templateCode, facts.labeled, facts.map, note);
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
    profile?.template_code ?? (typeof facts.map.TEMPLATE_CODE === 'string' ? facts.map.TEMPLATE_CODE : null),
    facts.labeled,
    facts.map,
    null,
  );
}

export const surfaceResolvers = {
  Query: {
    surfaces: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase
        .from('surface_definitions')
        .select('*')
        .eq('is_active', true)
        .order('surface_name');
      if (error) throw new Error(`Failed to list surfaces: ${error.message}`);
      return (data || []).map(mapSurface);
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
      const { data: surface, error } = await context.supabase
        .from('surface_definitions')
        .select('surface_code')
        .eq('domain_code', entity.domainCode)
        .eq('is_active', true)
        .order('surface_code')
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to find surface: ${error.message}`);
      if (!surface) return null;
      return resolveForSurface(context, {
        surfaceCode: surface.surface_code,
        entityId: args.entityId,
        entityCode: args.entityId ? null : args.entityCode,
      });
    },
  },
};
