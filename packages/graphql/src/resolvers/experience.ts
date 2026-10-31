import { Context } from '../context';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function mapSection(raw: any) {
  return {
    key: String(raw?.key || ''),
    title: String(raw?.title || raw?.key || 'Section'),
    kind: String(raw?.kind || 'FORM'),
    placement: String(raw?.placement || 'CANVAS'),
    domainCode: raw?.domainCode ?? null,
    relationshipCode: raw?.relationshipCode ?? null,
    direction: raw?.direction ?? null,
    columns: asArray<string>(raw?.columns).map((code) => String(code)),
    dashboardCode: raw?.dashboardCode ?? null,
    templateCode: raw?.templateCode ?? null,
  };
}

function mapPipeline(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    stageAttribute: String(raw.stageAttribute || ''),
    stages: asArray<any>(raw.stages).map((stage) => ({
      code: String(stage?.code || ''),
      label: String(stage?.label || stage?.code || ''),
    })).filter((stage) => stage.code),
    cardAttributes: asArray<string>(raw.cardAttributes).map((code) => String(code)),
  };
}

function mapExperience(row: any) {
  return {
    id: row.id,
    experienceCode: row.experience_code,
    experienceName: row.experience_name,
    description: row.description,
    anchorDomainCode: row.anchor_domain_code,
    sections: asArray(row.sections).map(mapSection).filter((section) => section.key),
    pipeline: mapPipeline(row.pipeline),
    isDefault: row.is_default === true,
    isActive: row.is_active !== false,
  };
}

export const experienceResolvers = {
  Query: {
    recordExperiences: async (
      _: unknown,
      args: { anchorDomainCode?: string; isActive?: boolean },
      { supabase }: Context,
    ) => {
      let query = supabase.from('record_experiences').select('*').order('experience_name');
      if (args.anchorDomainCode) query = query.eq('anchor_domain_code', args.anchorDomainCode);
      if (args.isActive !== undefined) query = query.eq('is_active', args.isActive);
      const { data, error } = await query;
      if (error) throw new Error(`Failed to fetch record experiences: ${error.message}`);
      return (data || []).map(mapExperience);
    },

    recordExperience: async (
      _: unknown,
      args: { experienceCode: string },
      { supabase }: Context,
    ) => {
      const { data, error } = await supabase
        .from('record_experiences')
        .select('*')
        .eq('experience_code', args.experienceCode)
        .maybeSingle();
      if (error) throw new Error(`Failed to fetch record experience: ${error.message}`);
      return data ? mapExperience(data) : null;
    },
  },
};
