import type { SupabaseClient } from '@supabase/supabase-js';
import type { Context } from '../context';
import {
  inheritingDomain,
  linkSupplies,
  resolveEffectiveTemplate,
  rulesForInheritor,
  rulesForSupplier,
  templateSide,
  type InheritanceRule,
  type TemplateChoice,
  type TemplateLink,
  type TemplateRecord,
} from '../lib/template-inheritance';

interface TemplateRow {
  id: string;
  template_code: string;
  template_name: string;
  domain_code: string;
  is_active: boolean | null;
}

/** The parts of an entity the template lookup reads. Accepts a resolved Entity. */
interface EntityLike {
  id: string;
  entityName?: string | null;
  domainCode: string;
  templateCode?: string | null;
  attributes?: Record<string, unknown> | null;
  parentRelationships?: Array<{ parentEntityId?: string | null; parentEntityName?: string | null; parentDomainCode?: string | null; relationshipCode?: string | null }> | null;
  childRelationships?: Array<{ childEntityId?: string | null; childEntityName?: string | null; childDomainCode?: string | null; relationshipCode?: string | null }> | null;
}

const CHUNK = 100;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += CHUNK) out.push(items.slice(index, index + CHUNK));
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayOf(raw: unknown): string {
  const value = raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
    ? (raw as Record<string, unknown>).value
    : raw;
  const text = value == null ? '' : String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/**
 * Rules are read on every lookup. A database that predates the column answers
 * with an error, which means no relationship passes a template along yet.
 */
async function loadRules(supabase: SupabaseClient): Promise<InheritanceRule[]> {
  const { data, error } = await supabase
    .from('relationship_types')
    .select('relationship_code, relationship_name, parent_domain_code, child_domain_code, template_from_side, is_active')
    .not('template_from_side', 'is', null);
  if (error) throw new Error(error.message);
  const rules: InheritanceRule[] = [];
  for (const row of data || []) {
    const side = templateSide(row.template_from_side);
    if (!side || row.is_active === false || !row.parent_domain_code || !row.child_domain_code) continue;
    rules.push({
      relationshipCode: row.relationship_code,
      relationshipName: row.relationship_name,
      parentDomainCode: row.parent_domain_code,
      childDomainCode: row.child_domain_code,
      templateFromSide: side,
    });
  }
  return rules;
}

async function loadTemplates(supabase: SupabaseClient, domainCodes: string[]): Promise<TemplateRow[]> {
  const domains = [...new Set(domainCodes.filter(Boolean))];
  if (domains.length === 0) return [];
  const { data, error } = await supabase
    .from('domain_templates')
    .select('id, template_code, template_name, domain_code, is_active')
    .in('domain_code', domains)
    .order('template_name');
  if (error) throw new Error(error.message);
  return (data || []) as TemplateRow[];
}

async function loadChoices(supabase: SupabaseClient, entityIds: string[]): Promise<TemplateChoice[]> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  const rows: TemplateChoice[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await supabase
      .from('entity_template_choices')
      .select('id, entity_id, relationship_code, template_id, valid_from, valid_to')
      .in('entity_id', part);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      rows.push({
        id: row.id,
        entityId: row.entity_id,
        relationshipCode: row.relationship_code || null,
        templateId: row.template_id,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      });
    }
  }
  return rows;
}

/** The date attribute a record is dated by: the first one on its entity type. */
async function loadDateCodes(supabase: SupabaseClient, domainCodes: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const domains = [...new Set(domainCodes.filter(Boolean))];
  if (domains.length === 0) return found;
  const { data, error } = await supabase
    .from('attribute_register')
    .select('attribute_code, domain_code, display_group')
    .eq('data_type', 'DATE')
    .in('domain_code', domains);
  if (error) throw new Error(error.message);
  const rows = [...(data || [])].sort((a: any, b: any) =>
    (a.display_group ?? Number.MAX_SAFE_INTEGER) - (b.display_group ?? Number.MAX_SAFE_INTEGER)
    || String(a.attribute_code).localeCompare(String(b.attribute_code)));
  for (const row of rows) {
    if (!found.has(row.domain_code)) found.set(row.domain_code, row.attribute_code);
  }
  return found;
}

function linksOf(entity: EntityLike): TemplateLink[] {
  const links: TemplateLink[] = [];
  for (const rel of entity.childRelationships || []) {
    if (!rel.childEntityId || !rel.relationshipCode) continue;
    links.push({ relationshipCode: rel.relationshipCode, side: 'CHILD', entityId: rel.childEntityId, entityName: rel.childEntityName || null, domainCode: rel.childDomainCode || null });
  }
  for (const rel of entity.parentRelationships || []) {
    if (!rel.parentEntityId || !rel.relationshipCode) continue;
    links.push({ relationshipCode: rel.relationshipCode, side: 'PARENT', entityId: rel.parentEntityId, entityName: rel.parentEntityName || null, domainCode: rel.parentDomainCode || null });
  }
  return links;
}

export async function effectiveTemplatesFor(
  context: Context,
  entities: EntityLike[],
  asOfDate?: string | null,
) {
  if (entities.length === 0) return [];
  const { supabase } = context;
  const fallbackDate = dayOf(asOfDate) || today();
  const rules = await loadRules(supabase);
  const inheritors = entities.filter((entity) => rulesForInheritor(entity.domainCode, rules).length > 0);
  const [templates, dateCodes] = await Promise.all([
    loadTemplates(supabase, entities.map((entity) => entity.domainCode)),
    loadDateCodes(supabase, inheritors.map((entity) => entity.domainCode)),
  ]);
  const byCode = new Map(templates.map((row) => [row.template_code, row]));
  const byId = new Map(templates.map((row) => [row.id, row]));

  const records: TemplateRecord[] = entities.map((entity) => {
    const dateCode = dateCodes.get(entity.domainCode);
    return {
      id: entity.id,
      domainCode: entity.domainCode,
      ownTemplateId: entity.templateCode ? byCode.get(entity.templateCode)?.id || null : null,
      onDate: (dateCode ? dayOf(entity.attributes?.[dateCode]) : '') || fallbackDate,
      links: linksOf(entity),
    };
  });

  const choiceOwners = new Set<string>();
  for (const record of records) {
    choiceOwners.add(record.id);
    for (const rule of rulesForInheritor(record.domainCode, rules)) {
      for (const link of record.links) {
        if (linkSupplies(link, rule)) choiceOwners.add(link.entityId);
      }
    }
  }
  const choices = await loadChoices(supabase, [...choiceOwners]);

  return records.map((record) => {
    const resolved = resolveEffectiveTemplate(record, rules, choices);
    const template = resolved.templateId ? byId.get(resolved.templateId) : null;
    // A choice that points at a template this caller cannot read falls back to the record's own.
    const usable = template || (record.ownTemplateId ? byId.get(record.ownTemplateId) : null) || null;
    return {
      entityId: resolved.entityId,
      templateId: usable?.id || null,
      templateCode: usable?.template_code || null,
      templateName: usable?.template_name || null,
      source: template ? resolved.source : usable ? 'OWN' : 'NONE',
      fromEntityId: resolved.fromEntityId,
      fromEntityName: resolved.fromEntityName,
      relationshipCode: resolved.relationshipCode,
      onDate: resolved.onDate,
    };
  });
}

async function loadEntities(supabase: SupabaseClient, entityIds: string[]): Promise<EntityLike[]> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  const found: EntityLike[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await supabase
      .from('entity_master')
      .select('entity_id, entity_name, domain_code, template_code, attributes, parent_relationships, child_relationships')
      .in('entity_id', part);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      found.push({
        id: row.entity_id,
        entityName: row.entity_name,
        domainCode: row.domain_code,
        templateCode: row.template_code,
        attributes: row.attributes || {},
        parentRelationships: (row.parent_relationships || []).map((rel: any) => ({
          parentEntityId: rel.parent_entity_id,
          parentEntityName: rel.parent_entity_name,
          parentDomainCode: rel.parent_domain_code,
          relationshipCode: rel.relationship_code,
        })),
        childRelationships: (row.child_relationships || []).map((rel: any) => ({
          childEntityId: rel.child_entity_id,
          childEntityName: rel.child_entity_name,
          childDomainCode: rel.child_domain_code,
          relationshipCode: rel.relationship_code,
        })),
      });
    }
  }
  return found;
}

function mapChoice(choice: TemplateChoice, templates: Map<string, TemplateRow>) {
  const template = templates.get(choice.templateId);
  return {
    id: choice.id || `${choice.entityId}:${choice.relationshipCode || ''}:${choice.validFrom}`,
    entityId: choice.entityId,
    relationshipCode: choice.relationshipCode,
    templateId: choice.templateId,
    templateCode: template?.template_code || '',
    templateName: template?.template_name || 'Unavailable template',
    validFrom: choice.validFrom <= '0001-01-01' ? null : choice.validFrom,
    validTo: choice.validTo >= '9999-12-31' ? null : choice.validTo,
  };
}

function mapOption(row: TemplateRow) {
  return { id: row.id, templateCode: row.template_code, templateName: row.template_name };
}

function fail(field: string, message: string, code: string) {
  return { success: false, choices: [], errors: [{ field, message, code }] };
}

export const templateInheritanceResolvers = {
  Query: {
    effectiveTemplates: async (
      _: unknown,
      args: { entityIds: string[]; asOfDate?: string | null },
      context: Context,
    ) => {
      const entities = await loadEntities(context.supabase, args.entityIds || []);
      return effectiveTemplatesFor(context, entities, args.asOfDate);
    },

    /** What a record can choose: a template for each kind of linked record, and its own override. */
    templateChoiceSlots: async (_: unknown, args: { entityId: string }, context: Context) => {
      const [entity] = await loadEntities(context.supabase, [args.entityId]);
      if (!entity) return [];
      const rules = await loadRules(context.supabase);
      const supplied = rulesForSupplier(entity.domainCode, rules);
      const inherits = rulesForInheritor(entity.domainCode, rules).length > 0;
      const domains = [...supplied.map(inheritingDomain), ...(inherits ? [entity.domainCode] : [])];
      const [templates, choices, names] = await Promise.all([
        loadTemplates(context.supabase, domains),
        loadChoices(context.supabase, [entity.id]),
        context.supabase.from('domain_types').select('domain_code, domain_name').in('domain_code', domains.length ? domains : ['']),
      ]);
      const byId = new Map(templates.map((row) => [row.id, row]));
      const domainName = new Map<string, string>((names.data || []).map((row: any) => [row.domain_code, row.domain_name]));
      const slot = (relationshipCode: string | null, relationshipName: string | null, domainCode: string) => ({
        entityId: entity.id,
        relationshipCode,
        relationshipName,
        domainCode,
        domainName: domainName.get(domainCode) || domainCode,
        templates: templates.filter((row) => row.domain_code === domainCode && row.is_active !== false).map(mapOption),
        choices: choices
          .filter((choice) => (choice.relationshipCode || null) === relationshipCode)
          .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
          .map((choice) => mapChoice(choice, byId)),
      });
      return [
        ...supplied.map((rule) => slot(rule.relationshipCode, rule.relationshipName || rule.relationshipCode, inheritingDomain(rule))),
        ...(inherits ? [slot(null, null, entity.domainCode)] : []),
      ];
    },
  },

  Mutation: {
    setEntityTemplateChoice: async (
      _: unknown,
      args: { input: { entityId: string; relationshipCode?: string | null; templateId?: string | null; effectiveFrom?: string | null } },
      context: Context,
    ) => {
      const input = args.input;
      const relationshipCode = (input.relationshipCode || '').trim() || null;
      const [entity] = await loadEntities(context.supabase, [input.entityId]);
      if (!entity) return fail('entityId', 'That record was not found.', 'NOT_FOUND');

      const rules = await loadRules(context.supabase);
      let targetDomain = entity.domainCode;
      if (relationshipCode) {
        const rule = rulesForSupplier(entity.domainCode, rules).find((item) => item.relationshipCode === relationshipCode);
        if (!rule) return fail('relationshipCode', 'That relationship does not pass a template along from this record.', 'NO_RULE');
        targetDomain = inheritingDomain(rule);
      } else if (rulesForInheritor(entity.domainCode, rules).length === 0) {
        return fail('relationshipCode', 'This record does not inherit a template, so there is nothing to override.', 'NO_RULE');
      }

      if (input.templateId) {
        const { data: template, error } = await context.supabase
          .from('domain_templates')
          .select('id, domain_code')
          .eq('id', input.templateId)
          .maybeSingle();
        if (error || !template) return fail('templateId', 'That template was not found.', 'NOT_FOUND');
        if (template.domain_code !== targetDomain) {
          return fail('templateId', `Choose a ${targetDomain} template.`, 'WRONG_DOMAIN');
        }
      }

      const effectiveFrom = dayOf(input.effectiveFrom) || null;
      const { error: saveError } = await context.supabase.rpc('set_entity_template_choice', {
        p_entity_id: entity.id,
        p_relationship_code: relationshipCode,
        p_template_id: input.templateId || null,
        p_effective_from: effectiveFrom,
      });
      if (saveError) return fail('general', saveError.message, 'SAVE_FAILED');

      const [templates, choices] = await Promise.all([
        loadTemplates(context.supabase, [targetDomain]),
        loadChoices(context.supabase, [entity.id]),
      ]);
      const byId = new Map(templates.map((row) => [row.id, row]));
      return {
        success: true,
        choices: choices
          .filter((choice) => (choice.relationshipCode || null) === relationshipCode)
          .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
          .map((choice) => mapChoice(choice, byId)),
        errors: [],
      };
    },
  },

  Entity: {
    effectiveTemplate: async (parent: EntityLike, args: { asOfDate?: string | null }, context: Context) => {
      const [resolved] = await effectiveTemplatesFor(context, [parent], args.asOfDate);
      return resolved || null;
    },
  },
};
