import { Context } from '../context';
import {
  addMonths,
  buildSeriesRows,
  DEFAULT_SERIES_PARAMETERS,
  effectiveControls,
  inferObservation,
  isGrain,
  recentPeriods,
  slotAttributeCodes,
  type DisplayPeriod,
  type Grain,
  type LayoutParameter,
  type SeriesAttribute,
  type SeriesObservation,
} from '../lib/display-layout';

const err = (message: string, code = 'DISPLAY_LAYOUT_FAILED') => ({ field: '', message, code });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function asDate(value: string | null | undefined): string {
  if (!value) return today();
  return String(value).slice(0, 10);
}

function asTimestamp(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return value.includes('T') ? value : `${value.slice(0, 10)}T23:59:59.999Z`;
}

function mapParameters(raw: unknown): LayoutParameter[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof (item as { name?: string }).name !== 'string') return [];
    const parameter = item as LayoutParameter & { defaultValue?: string };
    return [{
      name: parameter.name,
      label: parameter.label,
      type: parameter.type,
      binds: parameter.binds,
      multi: parameter.multi,
      default: parameter.default ?? parameter.defaultValue,
      options: parameter.options,
    }];
  });
}

function graphqlParameters(parameters: LayoutParameter[]) {
  const source = parameters.length > 0 ? parameters : DEFAULT_SERIES_PARAMETERS;
  return source.map((parameter) => ({
    name: parameter.name,
    label: parameter.label ?? null,
    type: parameter.type ?? 'select',
    binds: parameter.binds ?? null,
    multi: Boolean(parameter.multi),
    defaultValue: parameter.default ?? null,
    options: (parameter.options || []).map((option) => (
      typeof option === 'string'
        ? { value: option, label: option, sets: null }
        : { value: option.value, label: option.label || option.value, sets: option.sets ?? null }
    )),
  }));
}

function mapLayoutRecord(row: any) {
  return {
    id: row.id,
    layoutCode: row.layout_code,
    layoutName: row.layout_name,
    description: row.description,
    domainCode: row.domain_code,
    ownerDomainCode: row.owner_domain_code,
    relationshipCode: row.relationship_code,
    scope: row.scope,
    ownerEntityId: row.owner_entity_id,
    htmlTemplate: row.html_template || '',
    timeMode: row.time_mode,
    seriesAxis: row.series_axis,
    defaultViewGrain: row.default_view_grain,
    allowedViewGrains: row.allowed_view_grains || [],
    seriesWindow: row.series_window,
    parameters: row.parameters || [],
    isActive: row.is_active,
  };
}

function monthNumber(value: string | null | undefined): number {
  const parsed = Number(value);
  if (parsed >= 1 && parsed <= 12) return parsed;
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const index = names.indexOf(String(value || '').trim().toLowerCase());
  return index >= 0 ? index + 1 : 12;
}

function selectedControls(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) values[key] = value.map(String).join(',');
    else if (value != null) values[key] = String(value);
  }
  return values;
}

async function fiscalYearEndMonth(context: Context, entityIds: string[], asOf: string, knowledge: string): Promise<number> {
  if (entityIds.length === 0) return 12;
  const { data: attributes } = await context.supabase
    .from('attribute_register')
    .select('id, attribute_code')
    .in('attribute_code', ['FISCAL_YEAR_END_MONTH', 'FISCAL_YEAR_END']);
  const attribute = (attributes || []).find((item) => item.attribute_code === 'FISCAL_YEAR_END_MONTH') || attributes?.[0];
  if (!attribute) return 12;
  const { data: values } = await context.supabase
    .from('entity_attribute_values')
    .select('golden_value, entity_id, valid_from')
    .in('entity_id', entityIds)
    .eq('attribute_id', attribute.id)
    .lte('valid_from', asOf)
    .gte('valid_to', asOf)
    .lte('system_from', knowledge)
    .gt('system_to', knowledge)
    .order('valid_from', { ascending: false });
  return monthNumber(values?.[0]?.golden_value);
}

function coversAsOf(row: { valid_from: string; valid_to: string }, asOf: string): boolean {
  return row.valid_from <= asOf && row.valid_to >= asOf;
}

export const displayLayoutResolvers = {
  Query: {
    displayLayouts: async (_: unknown, args: { domainCode?: string }, context: Context) => {
      let query = context.supabase.from('display_layouts').select('*').order('layout_name');
      if (args.domainCode) query = query.eq('domain_code', args.domainCode);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(mapLayoutRecord);
    },

    entityDisplay: async (
      _: unknown,
      args: { entityId: string; asOfDate?: string; knowledgeDate?: string; controls?: unknown },
      context: Context,
    ) => {
      const asOf = asDate(args.asOfDate);
      const knowledge = asTimestamp(args.knowledgeDate);
      const { data: entity, error: entityError } = await context.supabase
        .from('master_entities')
        .select('id, domain_code, template_id, entity_name')
        .eq('id', args.entityId)
        .single();
      if (entityError || !entity) throw entityError || new Error('Entity not found');

      const layouts = await resolveLayouts(context, entity, asOf);
      const ownerIds = Array.from(new Set(layouts.flatMap((item) => [entity.id, item.ownerEntityId].filter(Boolean)))) as string[];
      const fiscalMonth = await fiscalYearEndMonth(context, ownerIds, asOf, knowledge);
      const resolved = [];
      for (const layout of layouts) {
        resolved.push(await resolveOne(context, entity, layout, asOf, knowledge, fiscalMonth, selectedControls(args.controls)));
      }
      return { fiscalYearEndMonth: fiscalMonth, layouts: resolved };
    },
  },

  Mutation: {
    upsertDisplayLayout: async (_: unknown, args: { input: any }, context: Context) => {
      const input = args.input;
      const row = {
        layout_code: input.layoutCode,
        layout_name: input.layoutName,
        description: input.description ?? null,
        domain_code: input.domainCode,
        owner_domain_code: input.ownerDomainCode ?? null,
        relationship_code: input.relationshipCode ?? null,
        scope: input.scope || 'DOMAIN',
        owner_entity_id: input.ownerEntityId ?? null,
        html_template: input.htmlTemplate || '',
        time_mode: input.timeMode || 'POINT',
        series_axis: input.seriesAxis || 'VALID_TIME',
        default_view_grain: input.defaultViewGrain ?? null,
        allowed_view_grains: input.allowedViewGrains || [],
        series_window: input.seriesWindow || 8,
        parameters: input.parameters || [],
        is_active: input.isActive !== false,
        updated_at: new Date().toISOString(),
      };
      const query = input.id
        ? context.supabase.from('display_layouts').update(row).eq('id', input.id)
        : context.supabase.from('display_layouts').insert(row);
      const { data, error } = await query.select('*').single();
      if (error) return { success: false, layout: null, errors: [err(error.message)] };
      return { success: true, layout: mapLayoutRecord(data), errors: [] };
    },

    upsertEntityTemplateBinding: async (_: unknown, args: { input: any }, context: Context) => {
      const input = args.input;
      const row = {
        owner_entity_id: input.ownerEntityId,
        relationship_code: input.relationshipCode || '',
        data_template_id: input.dataTemplateId ?? null,
        layout_id: input.layoutId,
        valid_from: asDate(input.validFrom),
        valid_to: input.validTo ? asDate(input.validTo) : '9999-12-31',
        updated_at: new Date().toISOString(),
      };
      const query = input.id
        ? context.supabase.from('entity_template_bindings').update(row).eq('id', input.id)
        : context.supabase.from('entity_template_bindings').insert(row);
      const { data, error } = await query.select('id').single();
      if (error) return { success: false, id: null, errors: [err(error.message)] };
      return { success: true, id: data.id, errors: [] };
    },

    saveDisplayValue: async (_: unknown, args: { input: any }, context: Context) => {
      const input = args.input;
      try {
        const { data: attribute, error: attributeError } = await context.supabase
          .from('attribute_register')
          .select('id, default_precedence_rank')
          .eq('attribute_code', input.attributeCode)
          .single();
        if (attributeError || !attribute) throw attributeError || new Error(`Attribute not found: ${input.attributeCode}`);

        const { data: manualSource, error: sourceError } = await context.supabase
          .schema('entity_instances')
          .from('source_registry')
          .select('id, precedence_rank')
          .eq('source_code', 'MANUAL')
          .single();
        if (sourceError || !manualSource) throw sourceError || new Error('MANUAL source is not registered');

        const now = new Date().toISOString();
        const periodGrain = isGrain(input.periodGrain) ? input.periodGrain : null;
        const statementBasis = input.statementBasis ? String(input.statementBasis).toUpperCase() : null;
        const validFrom = periodGrain ? asDate(input.periodStart) : asDate(input.periodEnd);
        const validTo = periodGrain ? asDate(input.periodEnd) : '9999-12-31';

        let expire = context.supabase
          .from('entity_attribute_values')
          .update({ system_to: now })
          .eq('entity_id', input.entityId)
          .eq('attribute_id', attribute.id)
          .eq('source_id', manualSource.id)
          .eq('system_to', '9999-12-31 23:59:59');
        expire = periodGrain
          ? expire.eq('period_grain', periodGrain).eq('valid_to', validTo)
          : expire.eq('valid_to', '9999-12-31');
        if (statementBasis) expire = expire.eq('statement_basis', statementBasis);
        const { error: expireError } = await expire;
        if (expireError) throw expireError;

        const { data, error } = await context.supabase
          .from('entity_attribute_values')
          .insert({
            entity_id: input.entityId,
            attribute_id: attribute.id,
            source_id: manualSource.id,
            golden_value: input.value,
            valid_from: validFrom,
            valid_to: validTo,
            system_from: now,
            system_to: '9999-12-31 23:59:59',
            precedence_rank: manualSource.precedence_rank ?? attribute.default_precedence_rank ?? 1,
            is_manual_override: true,
            period_grain: periodGrain,
            statement_basis: statementBasis,
            created_by: context.user?.id,
          })
          .select('id')
          .single();
        if (error) throw error;
        return { success: true, id: data.id, errors: [] };
      } catch (error: any) {
        return { success: false, id: null, errors: [err(error.message, 'SAVE_DISPLAY_VALUE_FAILED')] };
      }
    },
  },
};

async function resolveLayouts(context: Context, entity: { id: string; domain_code: string; template_id: string | null }, asOf: string) {
  const { data: ownBindings, error: ownError } = await context.supabase
    .from('entity_template_bindings')
    .select('*')
    .eq('owner_entity_id', entity.id)
    .lte('valid_from', asOf)
    .gte('valid_to', asOf);
  if (ownError) throw ownError;

  const { data: parentLinks, error: parentError } = await context.supabase
    .from('entity_relationships')
    .select('parent_entity_id, relationship_code')
    .eq('child_entity_id', entity.id)
    .lte('valid_from', asOf)
    .gte('valid_to', asOf);
  if (parentError) throw parentError;

  const parentBindings = [];
  for (const link of parentLinks || []) {
    const { data, error } = await context.supabase
      .from('entity_template_bindings')
      .select('*')
      .eq('owner_entity_id', link.parent_entity_id)
      .eq('relationship_code', link.relationship_code)
      .lte('valid_from', asOf)
      .gte('valid_to', asOf);
    if (error) throw error;
    parentBindings.push(...(data || []).map((binding) => ({ ...binding, owner_entity_id: link.parent_entity_id })));
  }

  const bindings = [...(ownBindings || []), ...parentBindings];
  const layoutIds = Array.from(new Set(bindings.map((binding) => binding.layout_id)));
  let layouts: any[] = [];
  if (layoutIds.length > 0) {
    const { data, error } = await context.supabase.from('display_layouts').select('*').in('id', layoutIds).eq('is_active', true);
    if (error) throw error;
    layouts = data || [];
  }

  if (layouts.length === 0 && entity.template_id) {
    const { data: template } = await context.supabase
      .from('domain_templates')
      .select('default_layout_id')
      .eq('id', entity.template_id)
      .maybeSingle();
    if (template?.default_layout_id) {
      const { data } = await context.supabase.from('display_layouts').select('*').eq('id', template.default_layout_id).eq('is_active', true);
      layouts = data || [];
    }
  }

  return layouts.map((layout) => {
    const binding = bindings.find((item) => item.layout_id === layout.id);
    return { ...layout, relationship_code: binding?.relationship_code || layout.relationship_code, ownerEntityId: binding?.owner_entity_id || entity.id };
  });
}

async function resolveOne(
  context: Context,
  entity: { id: string; entity_name: string },
  layout: any,
  asOf: string,
  knowledge: string,
  fiscalMonth: number,
  controlsInput: Record<string, string>,
) {
  const parameters = mapParameters(layout.parameters);
  const fallbackGrain: Grain = isGrain(layout.default_view_grain) ? layout.default_view_grain : 'QUARTERLY';
  const controls = effectiveControls(parameters, controlsInput, fallbackGrain);
  const allowed: string[] = layout.allowed_view_grains || [];
  if (allowed.length > 0 && !allowed.includes(controls.viewGrain)) {
    controls.viewGrain = isGrain(allowed[0]) ? allowed[0] : fallbackGrain;
  }

  const codes = slotAttributeCodes(layout.html_template || '');
  const { data: attributes } = codes.length === 0
    ? { data: [] as any[] }
    : await context.supabase
      .from('attribute_register')
      .select('id, attribute_code, attribute_name, reporting_grain, period_rollup')
      .in('attribute_code', codes);
  const attributeByCode = new Map((attributes || []).map((attribute) => [attribute.attribute_code, attribute]));
  const seriesAttributes: SeriesAttribute[] = codes.map((code) => {
    const attribute = attributeByCode.get(code);
    return {
      attributeCode: code,
      attributeName: attribute?.attribute_name || code,
      reportingGrain: isGrain(attribute?.reporting_grain) ? attribute.reporting_grain : null,
      periodRollup: attribute?.period_rollup || 'NONE',
    };
  });

  const childColumns = layout.time_mode === 'SERIES' && layout.series_axis === 'CHILD_ENTITIES' && layout.relationship_code;
  let periods: DisplayPeriod[] = [];
  let observations: SeriesObservation[] = [];
  const attributeIds = (attributes || []).map((attribute) => attribute.id);

  if (childColumns) {
    const { data: links } = await context.supabase
      .from('entity_relationships')
      .select('child_entity_id')
      .eq('parent_entity_id', layout.ownerEntityId)
      .eq('relationship_code', layout.relationship_code)
      .lte('valid_from', asOf)
      .gte('valid_to', asOf);
    const childIds = (links || []).map((link) => link.child_entity_id);
    const { data: children } = childIds.length === 0
      ? { data: [] as any[] }
      : await context.supabase.from('master_entities').select('id, entity_name').in('id', childIds);
    const ordered = [...(children || [])].sort((a, b) => String(a.entity_name).localeCompare(String(b.entity_name)));
    const viewingOneChild = layout.ownerEntityId !== entity.id && ordered.some((child) => child.id === entity.id);
    const shown = viewingOneChild ? ordered.filter((child) => child.id === entity.id) : ordered;
    periods = shown.map((child) => ({
      key: `entity:${child.id}`,
      grain: controls.viewGrain,
      label: child.entity_name,
      periodStart: asOf,
      periodEnd: asOf,
      entityId: child.id,
    }));
    observations = await loadObservations(context, shown.map((child) => child.id), attributeIds, attributes || [], asOf, knowledge, true, controls.viewGrain);
  } else if (layout.time_mode === 'SERIES') {
    periods = recentPeriods(controls.viewGrain, fiscalMonth, asOf, layout.series_window || 8);
    observations = await loadObservations(context, [entity.id], attributeIds, attributes || [], asOf, knowledge, false, controls.viewGrain);
  } else {
    periods = [{
      key: `point:${asOf}`,
      grain: 'DAILY',
      label: asOf,
      periodStart: asOf,
      periodEnd: asOf,
      entityId: entity.id,
    }];
    observations = await loadObservations(context, [entity.id], attributeIds, attributes || [], asOf, knowledge, true, 'DAILY');
  }

  const rows = buildSeriesRows(seriesAttributes, observations, periods, controls, fiscalMonth).map((row) => ({
    ...row,
    cells: layout.time_mode === 'POINT'
      ? row.cells.map((cell) => ({ ...cell, periodGrain: '', readOnly: false }))
      : row.cells,
  }));

  return {
    id: layout.id,
    layoutCode: layout.layout_code,
    layoutName: layout.layout_name,
    htmlTemplate: layout.html_template || '',
    timeMode: layout.time_mode,
    seriesAxis: layout.series_axis,
    relationshipCode: layout.relationship_code || null,
    parameters: graphqlParameters(parameters),
    effectiveControls: {
      ...controls.values,
      viewGrain: controls.viewGrain,
      statementBasis: controls.statementBasis.join(','),
      presentation: controls.presentation,
    },
    periods,
    rows,
  };
}

async function loadObservations(
  context: Context,
  entityIds: string[],
  attributeIds: string[],
  attributes: Array<{ id: string; attribute_code: string }>,
  asOf: string,
  knowledge: string,
  pointInTime: boolean,
  viewGrain: Grain,
): Promise<SeriesObservation[]> {
  if (entityIds.length === 0 || attributeIds.length === 0) return [];
  const windowStart = addMonths(asOf, -36);
  const { data, error } = await context.supabase
    .from('entity_attribute_values')
    .select('entity_id, attribute_id, golden_value, valid_from, valid_to, period_grain, statement_basis, precedence_rank, system_from')
    .in('entity_id', entityIds)
    .in('attribute_id', attributeIds)
    .lte('valid_from', asOf)
    .or(`valid_to.gte.${windowStart},valid_to.eq.9999-12-31`)
    .lte('system_from', knowledge)
    .gt('system_to', knowledge);
  if (error) throw error;

  const codeById = new Map(attributes.map((attribute) => [attribute.id, attribute.attribute_code]));
  const winners = new Map<string, SeriesObservation & { rank: number; systemFrom: string }>();
  for (const row of data || []) {
    if (pointInTime && !coversAsOf(row, asOf)) continue;
    const inferred = pointInTime
      ? { periodEnd: asOf, periodGrain: viewGrain }
      : inferObservation(row.valid_from, row.valid_to, row.period_grain);
    if (!pointInTime && (inferred.periodEnd > asOf || inferred.periodEnd < windowStart)) continue;
    const attributeCode = codeById.get(row.attribute_id);
    if (!attributeCode || row.golden_value == null || row.golden_value === '') continue;
    const observation: SeriesObservation & { rank: number; systemFrom: string } = {
      attributeCode,
      value: row.golden_value,
      periodEnd: inferred.periodEnd,
      periodGrain: inferred.periodGrain,
      statementBasis: row.statement_basis || 'ACTUAL',
      entityId: row.entity_id,
      rank: row.precedence_rank ?? 9999,
      systemFrom: row.system_from,
    };
    const key = [observation.entityId, observation.attributeCode, observation.periodEnd, observation.periodGrain, observation.statementBasis].join('|');
    const existing = winners.get(key);
    if (!existing || observation.rank < existing.rank || (observation.rank === existing.rank && observation.systemFrom > existing.systemFrom)) {
      winners.set(key, observation);
    }
  }
  return Array.from(winners.values());
}
