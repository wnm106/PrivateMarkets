import { graphqlMutation, graphqlQuery } from './graphql';

export interface FundRecord {
  id: string;
  entityCode: string;
  entityName: string;
  description?: string | null;
}

export interface SurfaceDefinition {
  id: string;
  surfaceCode: string;
  surfaceName: string;
  domainCode: string;
  description?: string | null;
  isPrimary?: boolean;
  clientId?: string | null;
}

export interface SurfaceExperience {
  id: string;
  experienceCode: string;
  experienceName: string;
  description?: string | null;
  isBaseline: boolean;
  qualificationPriority: number;
  displayOrder: number;
  ruleSummary: string;
  applicabilityRules?: {
    logic?: string;
    conditions?: Array<{ attributeCode?: string; operator?: string; value?: unknown }>;
  };
}

export interface SurfacePageVariant {
  id: string;
  variantCode: string;
  variantName: string;
  description?: string | null;
  qualificationPriority: number;
  requiredExperienceCodes: string[];
}

export interface SurfacePageSlot {
  id: string;
  slotCode: string;
  slotName: string;
  description?: string | null;
  displayOrder: number;
  optionality: string;
  variants: SurfacePageVariant[];
}

export interface SurfaceComponentDefinition {
  id: string;
  componentCode: string;
  componentName: string;
  description?: string | null;
  slotCode?: string | null;
  variantCode?: string | null;
  experienceCode?: string | null;
  displayOrder: number;
  clientId?: string | null;
  panelKey?: string | null;
}

export interface SurfaceSampleProfile {
  id: string;
  profileCode: string;
  profileName: string;
  description?: string | null;
  templateCode?: string | null;
  facts: {
    attributes?: Record<string, string>;
    relationships?: string[];
  };
}

export interface SurfaceCatalog {
  surface: SurfaceDefinition;
  experiences: SurfaceExperience[];
  slots: SurfacePageSlot[];
  components: SurfaceComponentDefinition[];
  sampleProfiles: SurfaceSampleProfile[];
}

export interface SurfaceFact {
  key: string;
  value: string;
  source: string;
}

export interface ExperienceQualification {
  experienceCode: string;
  experienceName: string;
  status: string;
  ruleTrace: string;
}

export interface PageResolution {
  slotCode: string;
  slotName: string;
  optionality: string;
  status: string;
  variantCode?: string | null;
  variantName?: string | null;
  decision: string;
  panelKey?: string | null;
}

export interface ComponentResolution {
  componentCode: string;
  componentName: string;
  pageName: string;
  experienceName: string;
  status: string;
  ruleTrace: string;
  clientId?: string | null;
  panelKey?: string | null;
}

export interface SurfaceResolution {
  surfaceCode: string;
  surfaceName: string;
  domainCode: string;
  subjectName: string;
  subjectKind: string;
  templateCode?: string | null;
  note?: string | null;
  facts: SurfaceFact[];
  experiences: ExperienceQualification[];
  pages: PageResolution[];
  components: ComponentResolution[];
}

const SURFACE_FIELDS = `
  id surfaceCode surfaceName domainCode description isPrimary clientId
`;

export const SURFACES_QUERY = `
  query Surfaces {
    surfaces { ${SURFACE_FIELDS} }
  }
`;

export const SURFACE_CATALOG_QUERY = `
  query SurfaceCatalog($surfaceCode: String!) {
    surfaceCatalog(surfaceCode: $surfaceCode) {
      surface { ${SURFACE_FIELDS} isActive }
      experiences {
        id experienceCode experienceName description isBaseline qualificationPriority displayOrder ruleSummary applicabilityRules
      }
      slots {
        id slotCode slotName description displayOrder optionality
        variants { id variantCode variantName description qualificationPriority requiredExperienceCodes }
      }
      components {
        id componentCode componentName description slotCode variantCode experienceCode displayOrder clientId panelKey
      }
      sampleProfiles { id profileCode profileName description templateCode facts }
    }
  }
`;

const RESOLUTION_FIELDS = `
  surfaceCode surfaceName domainCode subjectName subjectKind templateCode note
  facts { key value source }
  experiences { experienceCode experienceName status ruleTrace }
  pages { slotCode slotName optionality status variantCode variantName decision panelKey }
  components { componentCode componentName pageName experienceName status ruleTrace clientId panelKey }
`;

export const RESOLVE_SURFACE_QUERY = `
  query ResolveSurface($surfaceCode: String!, $profileCode: String, $entityId: ID, $entityCode: String, $facts: JSON) {
    resolveSurface(surfaceCode: $surfaceCode, profileCode: $profileCode, entityId: $entityId, entityCode: $entityCode, facts: $facts) {
      ${RESOLUTION_FIELDS}
    }
  }
`;

export const ENTITY_SURFACE_QUERY = `
  query EntitySurface($entityId: ID, $entityCode: String) {
    entitySurface(entityId: $entityId, entityCode: $entityCode) {
      ${RESOLUTION_FIELDS}
    }
  }
`;

const FUND_RECORDS_QUERY = `
  query FundRecords($filter: EntityFilter, $pagination: PaginationInput) {
    entities(filter: $filter, pagination: $pagination) {
      edges { node { id entityCode entityName description } }
    }
  }
`;

export function loadDomainRecords(domainCode: string) {
  return graphqlQuery<
    { entities: { edges: Array<{ node: FundRecord }> } },
    { filter: { domainCode: string }; pagination: { first: number } }
  >(FUND_RECORDS_QUERY, { filter: { domainCode }, pagination: { first: 200 } }, 'network-only');
}

export function loadSurfaces() {
  return graphqlQuery<{ surfaces: SurfaceDefinition[] }, Record<string, never>>(
    SURFACES_QUERY,
    undefined,
    'network-only',
  );
}

export function loadSurfaceCatalog(surfaceCode: string) {
  return graphqlQuery<{ surfaceCatalog: SurfaceCatalog | null }, { surfaceCode: string }>(
    SURFACE_CATALOG_QUERY,
    { surfaceCode },
    'network-only',
  );
}

export function loadSurfaceResolution(variables: {
  surfaceCode: string;
  profileCode?: string;
  entityId?: string;
  entityCode?: string;
  facts?: Record<string, unknown>;
}) {
  return graphqlQuery<{ resolveSurface: SurfaceResolution | null }, {
    surfaceCode: string;
    profileCode?: string;
    entityId?: string;
    entityCode?: string;
    facts?: Record<string, unknown>;
  }>(
    RESOLVE_SURFACE_QUERY,
    variables,
    'network-only',
  );
}

export interface SurfaceTabWrite {
  slotCode: string | null;
  name: string;
  appearance: 'always' | 'when';
  logic: 'AND' | 'OR';
  conditions: Array<{ attribute: string; operator: 'is' | 'is_not'; value: string }>;
  layouts: Array<{
    name: string;
    mode: 'everyone' | 'rule' | 'records';
    logic: 'AND' | 'OR';
    conditions: Array<{ attribute: string; operator: 'is' | 'is_not'; value: string }>;
    recordNames: string[];
  }>;
}

const SAVE_SURFACE_CATALOG = `
  mutation SaveSurfaceCatalog($surfaceCode: String!, $tabs: JSON!) {
    saveSurfaceCatalog(surfaceCode: $surfaceCode, tabs: $tabs) {
      surface { ${SURFACE_FIELDS} isActive }
      experiences {
        id experienceCode experienceName description isBaseline qualificationPriority displayOrder ruleSummary applicabilityRules
      }
      slots {
        id slotCode slotName description displayOrder optionality
        variants { id variantCode variantName description qualificationPriority requiredExperienceCodes }
      }
      components {
        id componentCode componentName description slotCode variantCode experienceCode displayOrder clientId panelKey
      }
      sampleProfiles { id profileCode profileName description templateCode facts }
    }
  }
`;

export function saveSurfaceCatalog(surfaceCode: string, tabs: SurfaceTabWrite[]) {
  return graphqlMutation<{ saveSurfaceCatalog: SurfaceCatalog | null }, { surfaceCode: string; tabs: SurfaceTabWrite[] }>(
    SAVE_SURFACE_CATALOG,
    { surfaceCode, tabs },
  );
}

export function loadEntitySurface(entityId: string) {
  return graphqlQuery<{ entitySurface: SurfaceResolution | null }, { entityId: string }>(
    ENTITY_SURFACE_QUERY,
    { entityId },
    'network-only',
  );
}

export function optionalityLabel(optionality: string): string {
  return optionality === 'when_qualified' ? 'Only when an experience qualifies' : 'Always on the surface';
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'QUALIFIED':
      return 'Qualified';
    case 'SUPERSEDED':
      return 'Superseded';
    case 'NOT_QUALIFIED':
      return 'Not qualified';
    case 'RENDERED':
      return 'Rendered';
    case 'HIDDEN':
      return 'Hidden';
    default:
      return status;
  }
}

export function statusStyle(status: string): { background: string; color: string } {
  switch (status) {
    case 'QUALIFIED':
    case 'RENDERED':
      return { background: '#e1f1e7', color: '#047857' };
    case 'SUPERSEDED':
      return { background: '#fef6e8', color: '#92400e' };
    default:
      return { background: 'var(--bg-alt)', color: 'var(--ink-3)' };
  }
}
