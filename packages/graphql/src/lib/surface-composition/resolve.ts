/**
 * Surface composition.
 *
 * A surface is the stable shell for a domain (the fund surface, the deal
 * pipeline). Experiences qualify independently from the entity profile.
 * Page slots then pick one variant, and components render only when the
 * granting experience qualified and their variant won the slot.
 *
 * The traces returned here are the supporting logic shown in the management
 * view. They name the attribute or relationship that decided each row.
 */

export type FactValue = string | number | boolean | null;

export type FactSource = 'ATTRIBUTE' | 'RELATIONSHIP' | 'TEMPLATE';

export type ApplicabilityOperator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
  | 'is_null'
  | 'is_not_null'
  | 'relationship_present'
  | 'relationship_absent';

export interface ApplicabilityCondition {
  attributeCode: string;
  operator: ApplicabilityOperator;
  value?: unknown;
}

export interface ApplicabilityRules {
  logic?: 'AND' | 'OR';
  conditions?: ApplicabilityCondition[];
}

export interface SurfaceFact {
  key: string;
  value: string;
  source: FactSource;
}

export interface CatalogExperience {
  id: string;
  code: string;
  name: string;
  isBaseline: boolean;
  priority: number;
  displayOrder: number;
  rules: ApplicabilityRules;
}

export interface CatalogSlot {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  optionality: 'always' | 'when_qualified';
}

export interface CatalogVariant {
  id: string;
  slotId: string;
  code: string;
  name: string;
  priority: number;
  requiredExperienceIds: string[];
}

export interface CatalogComponent {
  id: string;
  code: string;
  name: string;
  slotId: string;
  variantId: string | null;
  experienceId: string | null;
  displayOrder: number;
}

export interface SurfaceCatalogInput {
  experiences: CatalogExperience[];
  slots: CatalogSlot[];
  variants: CatalogVariant[];
  components: CatalogComponent[];
}

export interface ResolvedExperience {
  experienceId: string;
  code: string;
  name: string;
  status: 'QUALIFIED' | 'NOT_QUALIFIED';
  ruleTrace: string;
}

export interface ResolvedPage {
  slotId: string;
  slotCode: string;
  slotName: string;
  optionality: 'always' | 'when_qualified';
  status: 'RENDERED' | 'HIDDEN';
  variantId: string | null;
  variantCode: string | null;
  variantName: string | null;
  decision: string;
}

export interface ResolvedComponent {
  componentId: string;
  code: string;
  name: string;
  pageName: string;
  experienceName: string;
  status: 'QUALIFIED' | 'SUPERSEDED' | 'NOT_QUALIFIED';
  ruleTrace: string;
  displayOrder: number;
}

export interface SurfaceComposition {
  experiences: ResolvedExperience[];
  pages: ResolvedPage[];
  components: ResolvedComponent[];
}

interface ConditionResult {
  matched: boolean;
  trace: string;
}

function hasOwn(facts: Record<string, FactValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(facts, key);
}

function isPresent(value: FactValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = value.trim().toLowerCase();
  return text !== '' && text !== 'false' && text !== '0' && text !== 'absent' && text !== 'no';
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'present' : 'absent';
  if (Array.isArray(value)) return value.map((entry) => displayValue(entry)).join(', ');
  return String(value);
}

function valuesEqual(actual: FactValue | undefined, expected: unknown): boolean {
  if (actual === undefined || actual === null || actual === '') {
    return expected === undefined || expected === null || expected === '';
  }
  return String(actual) === String(expected);
}

function listIncludes(expected: unknown, actual: FactValue | undefined): boolean {
  if (!Array.isArray(expected)) return false;
  return expected.some((entry) => valuesEqual(actual, entry));
}

export function describeCondition(condition: ApplicabilityCondition): string {
  const code = condition.attributeCode;
  switch (condition.operator) {
    case 'equals':
      return `${code} equals ${displayValue(condition.value)}`;
    case 'not_equals':
      return `${code} does not equal ${displayValue(condition.value)}`;
    case 'in':
      return `${code} is one of ${displayValue(condition.value)}`;
    case 'not_in':
      return `${code} is not one of ${displayValue(condition.value)}`;
    case 'is_null':
      return `${code} is empty`;
    case 'is_not_null':
      return `${code} is present`;
    case 'relationship_present':
      return `${code} relationship is present`;
    case 'relationship_absent':
      return `${code} relationship is absent`;
    default:
      return `${code} ${condition.operator}`;
  }
}

export function describeRules(rules: ApplicabilityRules | null | undefined, isBaseline: boolean): string {
  if (isBaseline) return 'Always qualifies. No applicability rule.';
  const conditions = rules?.conditions ?? [];
  if (conditions.length === 0) return 'No applicability rule is defined, so this experience does not qualify.';
  const logic = rules?.logic === 'OR' ? ' OR ' : ' AND ';
  return conditions.map(describeCondition).join(logic) + '.';
}

export function evaluateCondition(
  condition: ApplicabilityCondition,
  facts: Record<string, FactValue>,
): ConditionResult {
  const actual = hasOwn(facts, condition.attributeCode) ? facts[condition.attributeCode] : undefined;
  const shown = displayValue(actual);

  switch (condition.operator) {
    case 'equals': {
      const matched = valuesEqual(actual, condition.value);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} equals ${displayValue(condition.value)}.`
          : `${condition.attributeCode} is ${shown}. Rule requires ${displayValue(condition.value)}.`,
      };
    }
    case 'not_equals': {
      const matched = !valuesEqual(actual, condition.value);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} is ${shown}, which does not equal ${displayValue(condition.value)}.`
          : `${condition.attributeCode} equals ${displayValue(condition.value)}. Rule requires a different value.`,
      };
    }
    case 'in': {
      const matched = listIncludes(condition.value, actual);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} is ${shown}, which is in ${displayValue(condition.value)}.`
          : `${condition.attributeCode} is ${shown}. Rule requires one of ${displayValue(condition.value)}.`,
      };
    }
    case 'not_in': {
      const matched = !listIncludes(condition.value, actual);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} is ${shown}, outside ${displayValue(condition.value)}.`
          : `${condition.attributeCode} is ${shown}, which is in ${displayValue(condition.value)}.`,
      };
    }
    case 'is_null': {
      const matched = !isPresent(actual);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} is empty.`
          : `${condition.attributeCode} is ${shown}. Rule requires it to be empty.`,
      };
    }
    case 'is_not_null': {
      const matched = isPresent(actual);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} is ${shown}.`
          : `${condition.attributeCode} is empty. Rule requires a value.`,
      };
    }
    case 'relationship_present': {
      const matched = isPresent(actual);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} relationship is present.`
          : `${condition.attributeCode} relationship is absent. Rule requires it.`,
      };
    }
    case 'relationship_absent': {
      const matched = !isPresent(actual);
      return {
        matched,
        trace: matched
          ? `${condition.attributeCode} relationship is absent.`
          : `${condition.attributeCode} relationship is present. Rule requires it to be absent.`,
      };
    }
    default:
      return { matched: false, trace: `${condition.attributeCode} uses an unknown operator.` };
  }
}

function qualifyExperience(
  experience: CatalogExperience,
  facts: Record<string, FactValue>,
): ResolvedExperience {
  if (experience.isBaseline) {
    return {
      experienceId: experience.id,
      code: experience.code,
      name: experience.name,
      status: 'QUALIFIED',
      ruleTrace: 'Surface baseline. No applicability rule.',
    };
  }

  const conditions = experience.rules?.conditions ?? [];
  if (conditions.length === 0) {
    return {
      experienceId: experience.id,
      code: experience.code,
      name: experience.name,
      status: 'NOT_QUALIFIED',
      ruleTrace: 'No applicability rule is defined, so this experience does not qualify.',
    };
  }

  const results = conditions.map((condition) => evaluateCondition(condition, facts));
  const logic = experience.rules.logic === 'OR' ? 'OR' : 'AND';
  const matched = logic === 'OR' ? results.some((result) => result.matched) : results.every((result) => result.matched);
  const relevant = matched
    ? (logic === 'OR' ? results.filter((result) => result.matched).slice(0, 1) : results)
    : results.filter((result) => !result.matched);

  return {
    experienceId: experience.id,
    code: experience.code,
    name: experience.name,
    status: matched ? 'QUALIFIED' : 'NOT_QUALIFIED',
    ruleTrace: relevant.map((result) => result.trace).join(' '),
  };
}

function comparePriority(left: { priority: number; code: string }, right: { priority: number; code: string }): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.code.localeCompare(right.code);
}

/**
 * Turn a sample profile, a live entity, or an ad-hoc overlay into the fact
 * map the resolver evaluates. Structured profiles keep attributes and
 * relationships apart. A flat object treats booleans as relationships.
 */
export function normalizeFacts(
  input: unknown,
  templateCode?: string | null,
): { map: Record<string, FactValue>; labeled: SurfaceFact[] } {
  const map: Record<string, FactValue> = {};
  const labeled: SurfaceFact[] = [];

  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const structured = record.attributes !== undefined || record.relationships !== undefined;

  if (structured) {
    const attributes = record.attributes && typeof record.attributes === 'object'
      ? record.attributes as Record<string, unknown>
      : {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === '') continue;
      map[key] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
      labeled.push({ key, value: displayValue(map[key]), source: 'ATTRIBUTE' });
    }
    const relationships = Array.isArray(record.relationships) ? record.relationships : [];
    for (const relationship of relationships) {
      if (typeof relationship !== 'string' || relationship.trim() === '') continue;
      map[relationship] = true;
      labeled.push({ key: relationship, value: 'Present', source: 'RELATIONSHIP' });
    }
  } else {
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'boolean') {
        map[key] = value;
        labeled.push({ key, value: value ? 'Present' : 'Absent', source: 'RELATIONSHIP' });
      } else if (typeof value === 'number') {
        map[key] = value;
        labeled.push({ key, value: displayValue(value), source: 'ATTRIBUTE' });
      } else if (typeof value === 'string') {
        map[key] = value;
        labeled.push({ key, value, source: 'ATTRIBUTE' });
      }
    }
  }

  if (templateCode && !hasOwn(map, 'TEMPLATE_CODE')) {
    map.TEMPLATE_CODE = templateCode;
    labeled.push({ key: 'TEMPLATE_CODE', value: templateCode, source: 'TEMPLATE' });
  }

  return { map, labeled };
}

export function mergeFacts(
  base: { map: Record<string, FactValue>; labeled: SurfaceFact[] },
  overlay: { map: Record<string, FactValue>; labeled: SurfaceFact[] },
): { map: Record<string, FactValue>; labeled: SurfaceFact[] } {
  const map = { ...base.map, ...overlay.map };
  const labeled = [...base.labeled];
  for (const fact of overlay.labeled) {
    const index = labeled.findIndex((existing) => existing.key === fact.key);
    if (index >= 0) labeled[index] = fact;
    else labeled.push(fact);
  }
  return { map, labeled };
}

export function resolveSurfaceComposition(
  catalog: SurfaceCatalogInput,
  facts: Record<string, FactValue>,
): SurfaceComposition {
  const experiences = [...catalog.experiences]
    .sort((left, right) => left.displayOrder - right.displayOrder || left.code.localeCompare(right.code))
    .map((experience) => qualifyExperience(experience, facts));

  const qualifiedIds = new Set(
    experiences.filter((experience) => experience.status === 'QUALIFIED').map((experience) => experience.experienceId),
  );
  const experienceById = new Map(experiences.map((experience) => [experience.experienceId, experience]));
  const variantById = new Map(catalog.variants.map((variant) => [variant.id, variant]));
  const slotById = new Map(catalog.slots.map((slot) => [slot.id, slot]));

  const pages: ResolvedPage[] = [...catalog.slots]
    .sort((left, right) => left.displayOrder - right.displayOrder || left.code.localeCompare(right.code))
    .map((slot) => {
      const variants = catalog.variants.filter((variant) => variant.slotId === slot.id);
      const eligible = variants
        .filter((variant) => variant.requiredExperienceIds.every((id) => qualifiedIds.has(id)))
        .sort(comparePriority);
      const winner = eligible[0] ?? null;

      if (!winner) {
        const reasons = variants
          .map((variant) => explainIneligible(variant, experienceById))
          .filter((reason) => reason.length > 0);
        const because = reasons.length > 0 ? ` ${reasons.join(' ')}` : '';
        return {
          slotId: slot.id,
          slotCode: slot.code,
          slotName: slot.name,
          optionality: slot.optionality,
          status: 'HIDDEN' as const,
          variantId: null,
          variantCode: null,
          variantName: null,
          decision: slot.optionality === 'when_qualified'
            ? `Hidden. No variant qualified.${because}`
            : `Hidden. This slot is always on the surface, but no variant qualified.${because}`,
        };
      }

      const superseded = eligible.slice(1);
      const ineligible = variants.filter((variant) => !eligible.some((candidate) => candidate.id === variant.id));
      const parts: string[] = [];
      if (winner.requiredExperienceIds.length === 0) {
        parts.push(`${winner.name} is the surface default at priority ${winner.priority}.`);
      } else {
        const grants = winner.requiredExperienceIds
          .map((id) => experienceById.get(id)?.ruleTrace)
          .filter((trace): trace is string => Boolean(trace));
        parts.push(`${winner.name} won at priority ${winner.priority}. ${grants.join(' ')}`.trim());
      }
      for (const loser of superseded) {
        parts.push(`${loser.name} at priority ${loser.priority} is superseded.`);
      }
      for (const variant of ineligible) {
        const reason = explainIneligible(variant, experienceById);
        if (reason) parts.push(reason);
      }

      return {
        slotId: slot.id,
        slotCode: slot.code,
        slotName: slot.name,
        optionality: slot.optionality,
        status: 'RENDERED' as const,
        variantId: winner.id,
        variantCode: winner.code,
        variantName: winner.name,
        decision: parts.join(' '),
      };
    });

  const pageBySlotId = new Map(pages.map((page) => [page.slotId, page]));
  const eligibleBySlot = new Map<string, Set<string>>();
  for (const slot of catalog.slots) {
    const eligible = catalog.variants.filter(
      (variant) => variant.slotId === slot.id && variant.requiredExperienceIds.every((id) => qualifiedIds.has(id)),
    );
    eligibleBySlot.set(slot.id, new Set(eligible.map((variant) => variant.id)));
  }

  const components = [...catalog.components]
    .sort((left, right) => {
      const leftSlot = slotById.get(left.slotId)?.displayOrder ?? 0;
      const rightSlot = slotById.get(right.slotId)?.displayOrder ?? 0;
      if (leftSlot !== rightSlot) return leftSlot - rightSlot;
      if (left.displayOrder !== right.displayOrder) return left.displayOrder - right.displayOrder;
      return left.code.localeCompare(right.code);
    })
    .map((component) => {
      const page = pageBySlotId.get(component.slotId);
      const experience = component.experienceId ? experienceById.get(component.experienceId) : undefined;
      const variant = component.variantId ? variantById.get(component.variantId) : undefined;
      const pageName = page?.slotName ?? 'Unassigned';
      const experienceName = experience?.name ?? 'Surface baseline';
      const outcome = decideComponent(component, page, experience, variant, pageBySlotId, eligibleBySlot, variantById);
      return {
        componentId: component.id,
        code: component.code,
        name: component.name,
        pageName,
        experienceName,
        status: outcome.status,
        ruleTrace: outcome.ruleTrace,
        displayOrder: component.displayOrder,
      };
    });

  return { experiences, pages, components };
}

function explainIneligible(
  variant: CatalogVariant,
  experienceById: Map<string, ResolvedExperience>,
): string {
  const missing = variant.requiredExperienceIds
    .map((id) => experienceById.get(id))
    .filter((experience): experience is ResolvedExperience => Boolean(experience && experience.status !== 'QUALIFIED'));
  if (missing.length === 0) return '';
  const detail = missing.map((experience) => `${experience.name}: ${experience.ruleTrace}`).join(' ');
  return `${variant.name} did not qualify. ${detail}`;
}

function decideComponent(
  component: CatalogComponent,
  page: ResolvedPage | undefined,
  experience: ResolvedExperience | undefined,
  variant: CatalogVariant | undefined,
  pageBySlotId: Map<string, ResolvedPage>,
  eligibleBySlot: Map<string, Set<string>>,
  variantById: Map<string, CatalogVariant>,
): { status: ResolvedComponent['status']; ruleTrace: string } {
  if (!page) {
    return { status: 'NOT_QUALIFIED', ruleTrace: 'Component is not attached to a page slot.' };
  }
  if (page.status === 'HIDDEN') {
    return { status: 'NOT_QUALIFIED', ruleTrace: page.decision };
  }

  if (variant && page.variantId !== variant.id) {
    const eligible = eligibleBySlot.get(component.slotId);
    const winner = page.variantId ? variantById.get(page.variantId) : undefined;
    if (eligible?.has(variant.id) && winner) {
      return {
        status: 'SUPERSEDED',
        ruleTrace: `${variant.name} at priority ${variant.priority} lost to ${winner.name} at priority ${winner.priority}.`,
      };
    }
    if (experience && experience.status === 'NOT_QUALIFIED') {
      return { status: 'NOT_QUALIFIED', ruleTrace: experience.ruleTrace };
    }
    return { status: 'NOT_QUALIFIED', ruleTrace: pageBySlotId.get(component.slotId)?.decision ?? 'Variant did not qualify.' };
  }

  if (experience && experience.status === 'NOT_QUALIFIED') {
    return { status: 'NOT_QUALIFIED', ruleTrace: experience.ruleTrace };
  }

  if (experience) {
    return { status: 'QUALIFIED', ruleTrace: `${experience.ruleTrace} Shown on ${page.slotName}.` };
  }
  return { status: 'QUALIFIED', ruleTrace: `Surface baseline. Shown on ${page.slotName}.` };
}
