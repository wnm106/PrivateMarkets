import { graphqlQuery } from './graphql';

export interface SurfaceDefinition {
  id: string;
  surfaceCode: string;
  surfaceName: string;
  domainCode: string;
  description?: string | null;
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
}

export interface ComponentResolution {
  componentCode: string;
  componentName: string;
  pageName: string;
  experienceName: string;
  status: string;
  ruleTrace: string;
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
  id surfaceCode surfaceName domainCode description
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
        id experienceCode experienceName description isBaseline qualificationPriority displayOrder ruleSummary
      }
      slots {
        id slotCode slotName description displayOrder optionality
        variants { id variantCode variantName description qualificationPriority requiredExperienceCodes }
      }
      components {
        id componentCode componentName description slotCode variantCode experienceCode displayOrder
      }
      sampleProfiles { id profileCode profileName description templateCode facts }
    }
  }
`;

const RESOLUTION_FIELDS = `
  surfaceCode surfaceName domainCode subjectName subjectKind templateCode note
  facts { key value source }
  experiences { experienceCode experienceName status ruleTrace }
  pages { slotCode slotName optionality status variantCode variantName decision }
  components { componentCode componentName pageName experienceName status ruleTrace }
`;

export const RESOLVE_SURFACE_QUERY = `
  query ResolveSurface($surfaceCode: String!, $profileCode: String, $entityId: ID, $entityCode: String) {
    resolveSurface(surfaceCode: $surfaceCode, profileCode: $profileCode, entityId: $entityId, entityCode: $entityCode) {
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
}) {
  return graphqlQuery<{ resolveSurface: SurfaceResolution | null }, {
    surfaceCode: string;
    profileCode?: string;
    entityId?: string;
    entityCode?: string;
  }>(
    RESOLVE_SURFACE_QUERY,
    variables,
    'network-only',
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
