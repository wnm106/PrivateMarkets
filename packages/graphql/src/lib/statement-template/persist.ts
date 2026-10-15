import type { SupabaseClient } from '@supabase/supabase-js';
import { loadStatementCatalog } from './catalog';
import { labelsEquivalent, toAttributeCode } from './normalize';
import type { StatementSourceKind } from './types';

export { loadStatementCatalog };

const ATTRIBUTE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const DATA_TYPES = new Set(['STRING', 'NUMBER', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON', 'REFERENCE']);
const SOURCE_KINDS = new Set<StatementSourceKind>(['image', 'file', 'paste']);

export interface ApplyStatementLineInput {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  displayOrder: number;
  displayLabel: string;
  matchKind: string;
  isNew: boolean;
  required: boolean;
  aliases?: string[];
}

export interface ApplyStatementSectionInput {
  sectionCode: string;
  sectionName: string;
  displayOrder: number;
  lines: ApplyStatementLineInput[];
}

export interface ApplyStatementSourceInput {
  sourceName: string;
  sourceKind: string;
  excerpt?: string | null;
}

export interface ApplyStatementTemplateInput {
  templateCode: string;
  templateName: string;
  domainCode: string;
  description?: string | null;
  statementKind: string;
  entityCode?: string | null;
  existingTemplateId?: string | null;
  sections: ApplyStatementSectionInput[];
  sources?: ApplyStatementSourceInput[];
}

export interface ApplyStatementTemplateOutput {
  template: {
    id: string;
    templateCode: string;
    domainCode: string;
    templateName: string;
    description: string | null;
    isActive: boolean;
    applicabilityRules: Record<string, unknown>;
  } | null;
  aliasCount: number;
  sectionCount: number;
  errors: Array<{ field: string; message: string; code: string }>;
}

function fail(field: string, message: string, code = 'INVALID'): ApplyStatementTemplateOutput {
  return { template: null, aliasCount: 0, sectionCount: 0, errors: [{ field, message, code }] };
}

export async function applyStatementTemplate(
  supabase: SupabaseClient,
  input: ApplyStatementTemplateInput,
): Promise<ApplyStatementTemplateOutput> {
  const templateCode = String(input.templateCode || '').trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
  const templateName = String(input.templateName || '').trim();
  const domainCode = String(input.domainCode || '').trim().toUpperCase();
  const statementKind = String(input.statementKind || 'CUSTOM').trim().toUpperCase();
  const entityCode = String(input.entityCode || '').trim();
  const sections = input.sections || [];

  if (!ATTRIBUTE_CODE.test(templateCode)) return fail('templateCode', 'Template code must start with a letter and use only letters, numbers, and underscores.');
  if (!templateName) return fail('templateName', 'Template name is required.');
  if (!domainCode) return fail('domainCode', 'Choose the entity type this template belongs to.');
  if (!['NAV', 'FINANCIAL', 'CUSTOM'].includes(statementKind)) return fail('statementKind', 'Statement kind must be NAV, FINANCIAL, or CUSTOM.');
  if (sections.length === 0 || sections.every((section) => (section.lines || []).length === 0)) {
    return fail('sections', 'Add at least one section with a line before saving.');
  }

  for (const section of sections) {
    if (!String(section.sectionName || '').trim()) return fail('sectionName', 'Every section needs a name.');
    for (const line of section.lines || []) {
      const code = String(line.attributeCode || '').trim().toUpperCase();
      if (!ATTRIBUTE_CODE.test(code)) return fail('attributeCode', `“${line.displayLabel || code}” needs a valid attribute code.`);
      if (!DATA_TYPES.has(String(line.dataType || '').toUpperCase())) return fail('dataType', `${code} has an unsupported data type.`);
    }
  }

  const applicabilityRules = {
    statementKind,
    entityCode: entityCode || null,
    conditions: entityCode ? [{ attributeCode: 'ENTITY_CODE', operator: 'equals', value: entityCode }] : [],
    logic: 'AND',
  };
  const description = String(input.description || '').trim()
    || `${statementKind === 'NAV' ? 'NAV statement' : statementKind === 'FINANCIAL' ? 'Financial statement' : 'Statement'} template aggregated from ${(input.sources || []).length || sections.length} source${(input.sources || []).length === 1 ? '' : 's'}.`;

  const template = await upsertTemplate(supabase, {
    existingTemplateId: input.existingTemplateId || null,
    templateCode,
    templateName,
    domainCode,
    description,
    applicabilityRules,
  });
  if ('error' in template) return fail('template', template.error, 'SAVE_FAILED');

  const cleared = await clearTemplateChildren(supabase, template.id);
  if (cleared) return fail('template', cleared, 'SAVE_FAILED');

  const attributeIds = await ensureAttributes(supabase, domainCode, sections);
  if ('error' in attributeIds) return fail('attribute', attributeIds.error, 'SAVE_FAILED');

  const sectionIds = await insertSections(supabase, template.id, sections);
  if ('error' in sectionIds) return fail('section', sectionIds.error, 'SAVE_FAILED');

  const assigned = await insertAssignments(supabase, template.id, sections, attributeIds.ids, sectionIds.ids);
  if (assigned) return fail('assignment', assigned, 'SAVE_FAILED');

  const aliasCount = await insertAliases(supabase, domainCode, sections, attributeIds.ids);
  if (typeof aliasCount !== 'number') return fail('alias', aliasCount, 'SAVE_FAILED');

  const sourced = await insertSources(supabase, template.id, input.sources || []);
  if (sourced) return fail('source', sourced, 'SAVE_FAILED');

  return {
    template: {
      id: template.id,
      templateCode: template.template_code,
      domainCode: template.domain_code,
      templateName: template.template_name,
      description: template.description,
      isActive: template.is_active,
      applicabilityRules,
    },
    aliasCount,
    sectionCount: sections.length,
    errors: [],
  };
}

async function upsertTemplate(supabase: SupabaseClient, input: {
  existingTemplateId: string | null;
  templateCode: string;
  templateName: string;
  domainCode: string;
  description: string;
  applicabilityRules: Record<string, unknown>;
}): Promise<{ id: string; template_code: string; domain_code: string; template_name: string; description: string | null; is_active: boolean } | { error: string }> {
  const payload = {
    template_name: input.templateName,
    description: input.description,
    applicability_rules: input.applicabilityRules,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  if (input.existingTemplateId) {
    const { data, error } = await supabase.from('domain_templates').update(payload).eq('id', input.existingTemplateId).select('id, template_code, domain_code, template_name, description, is_active').single();
    if (error || !data) return { error: error?.message || 'Template was not found.' };
    return data;
  }

  const { data: existing, error: lookupError } = await supabase.from('domain_templates').select('id').eq('template_code', input.templateCode).maybeSingle();
  if (lookupError) return { error: lookupError.message };
  if (existing?.id) {
    const { data, error } = await supabase.from('domain_templates').update(payload).eq('id', existing.id).select('id, template_code, domain_code, template_name, description, is_active').single();
    if (error || !data) return { error: error?.message || 'Template could not be updated.' };
    return data;
  }

  const { data, error } = await supabase.from('domain_templates').insert({
    template_code: input.templateCode,
    domain_code: input.domainCode,
    ...payload,
  }).select('id, template_code, domain_code, template_name, description, is_active').single();
  if (error || !data) return { error: error?.message || 'Template could not be created.' };
  return data;
}

async function clearTemplateChildren(supabase: SupabaseClient, templateId: string): Promise<string | null> {
  const steps = [
    supabase.from('template_attribute_assignments').delete().eq('template_id', templateId),
    supabase.from('template_sources').delete().eq('template_id', templateId),
    supabase.from('attribute_aliases').delete().eq('template_id', templateId),
    supabase.from('template_sections').delete().eq('template_id', templateId),
  ];
  for (const step of steps) {
    const { error } = await step;
    if (error) return error.message;
  }
  return null;
}

async function ensureAttributes(
  supabase: SupabaseClient,
  domainCode: string,
  sections: ApplyStatementSectionInput[],
): Promise<{ ids: Map<string, string> } | { error: string }> {
  const wanted = new Map<string, { name: string; dataType: string; sectionName: string; isNew: boolean }>();
  for (const section of sections) {
    for (const line of section.lines || []) {
      const code = line.attributeCode.trim().toUpperCase();
      if (!wanted.has(code)) {
        wanted.set(code, {
          name: line.attributeName.trim() || line.displayLabel.trim(),
          dataType: line.dataType.toUpperCase(),
          sectionName: section.sectionName.trim(),
          isNew: line.isNew,
        });
      }
    }
  }

  const codes = [...wanted.keys()];
  const { data: existing, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', codes);
  if (error) return { error: error.message };
  const ids = new Map<string, string>((existing || []).map((row: { id: string; attribute_code: string }) => [row.attribute_code, row.id]));

  for (const [code, spec] of wanted) {
    if (ids.has(code)) continue;
    const { data, error: insertError } = await supabase.from('attribute_register').insert({
      attribute_code: code,
      attribute_name: spec.name.slice(0, 200),
      data_type: spec.dataType,
      description: `Captured from a ${spec.sectionName} statement line.`,
      domain_code: domainCode,
      display_section: spec.sectionName.slice(0, 100),
      is_required: false,
    }).select('id').single();
    if (insertError || !data) return { error: insertError?.message || `Could not create ${code}.` };
    ids.set(code, data.id);
  }
  return { ids };
}

async function insertSections(
  supabase: SupabaseClient,
  templateId: string,
  sections: ApplyStatementSectionInput[],
): Promise<{ ids: Map<string, string> } | { error: string }> {
  const ids = new Map<string, string>();
  const usedCodes = new Set<string>();
  for (const section of [...sections].sort((left, right) => left.displayOrder - right.displayOrder)) {
    let code = toAttributeCode(section.sectionCode || section.sectionName).slice(0, 100);
    if (usedCodes.has(code)) {
      let index = 2;
      while (usedCodes.has(`${code}_${index}`)) index += 1;
      code = `${code}_${index}`.slice(0, 100);
    }
    usedCodes.add(code);
    const { data, error } = await supabase.from('template_sections').insert({
      template_id: templateId,
      section_code: code,
      section_name: section.sectionName.trim().slice(0, 200),
      display_order: section.displayOrder,
    }).select('id').single();
    if (error || !data) return { error: error?.message || 'A section could not be saved.' };
    ids.set(section.sectionCode || code, data.id);
    ids.set(code, data.id);
  }
  return { ids };
}

async function insertAssignments(
  supabase: SupabaseClient,
  templateId: string,
  sections: ApplyStatementSectionInput[],
  attributeIds: Map<string, string>,
  sectionIds: Map<string, string>,
): Promise<string | null> {
  const rows: Array<Record<string, unknown>> = [];
  const assigned = new Set<string>();
  let order = 1;
  for (const section of [...sections].sort((left, right) => left.displayOrder - right.displayOrder)) {
    const sectionId = sectionIds.get(section.sectionCode) || sectionIds.get(toAttributeCode(section.sectionCode || section.sectionName));
    for (const line of [...(section.lines || [])].sort((left, right) => left.displayOrder - right.displayOrder)) {
      const code = line.attributeCode.trim().toUpperCase();
      if (assigned.has(code)) continue;
      assigned.add(code);
      const attributeId = attributeIds.get(code);
      if (!attributeId) return `Missing attribute ${line.attributeCode}.`;
      rows.push({
        template_id: templateId,
        attribute_id: attributeId,
        section_id: sectionId || null,
        is_required: Boolean(line.required),
        display_order: order,
        display_label: (line.displayLabel || line.attributeName).slice(0, 200),
      });
      order += 1;
    }
  }
  if (rows.length === 0) return null;
  const { error } = await supabase.from('template_attribute_assignments').insert(rows);
  return error ? error.message : null;
}

async function insertAliases(
  supabase: SupabaseClient,
  domainCode: string,
  sections: ApplyStatementSectionInput[],
  attributeIds: Map<string, string>,
): Promise<number | string> {
  const pending = new Map<string, { attributeId: string; aliasLabel: string; aliasCode: string; matchKind: string }>();
  for (const section of sections) {
    for (const line of section.lines || []) {
      const attributeId = attributeIds.get(line.attributeCode.trim().toUpperCase());
      if (!attributeId) continue;
      const labels = [...(line.aliases || [])];
      if (line.displayLabel) labels.push(line.displayLabel);
      for (const label of labels) {
        const aliasLabel = label.trim();
        if (!aliasLabel) continue;
        if (labelsEquivalent(aliasLabel, line.attributeName) || labelsEquivalent(aliasLabel, line.attributeCode.replace(/_/g, ' '))) continue;
        const aliasCode = toAttributeCode(aliasLabel);
        const key = `${domainCode}:${aliasCode}`;
        const matchKind = line.matchKind === 'manual' ? 'manual' : 'semantic';
        pending.set(key, { attributeId, aliasLabel: aliasLabel.slice(0, 300), aliasCode, matchKind });
      }
    }
  }
  if (pending.size === 0) return 0;

  let count = 0;
  for (const alias of pending.values()) {
    const { data: existing, error: lookupError } = await supabase
      .from('attribute_aliases')
      .select('id, attribute_id')
      .eq('alias_code', alias.aliasCode)
      .eq('domain_code', domainCode)
      .is('template_id', null)
      .maybeSingle();
    if (lookupError) return lookupError.message;
    if (existing?.id) {
      const { error } = await supabase.from('attribute_aliases').update({
        attribute_id: alias.attributeId,
        alias_label: alias.aliasLabel,
        match_kind: alias.matchKind,
        confidence: 1,
        is_active: true,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
      if (error) return error.message;
      count += 1;
      continue;
    }
    const { error } = await supabase.from('attribute_aliases').insert({
      attribute_id: alias.attributeId,
      alias_label: alias.aliasLabel,
      alias_code: alias.aliasCode,
      domain_code: domainCode,
      match_kind: alias.matchKind,
      confidence: 1,
      is_active: true,
    });
    if (error) return error.message;
    count += 1;
  }
  return count;
}

async function insertSources(
  supabase: SupabaseClient,
  templateId: string,
  sources: ApplyStatementSourceInput[],
): Promise<string | null> {
  const rows = sources
    .filter((source) => SOURCE_KINDS.has(source.sourceKind as StatementSourceKind))
    .map((source) => ({
      template_id: templateId,
      source_kind: source.sourceKind,
      source_name: String(source.sourceName || 'Statement').slice(0, 300),
      excerpt: source.excerpt ? String(source.excerpt).slice(0, 4000) : null,
    }));
  if (rows.length === 0) return null;
  const { error } = await supabase.from('template_sources').insert(rows);
  return error ? error.message : null;
}
