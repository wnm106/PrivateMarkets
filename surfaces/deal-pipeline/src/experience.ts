// The slice of the record-experience API the pipeline reads. Owned by the surface
// so it depends only on the public GraphQL schema, not on host code.

export interface PipelineStage {
  code: string;
  label: string;
}

export interface RecordExperience {
  pipeline?: {
    stageAttribute: string;
    stages: PipelineStage[];
    cardAttributes: string[];
  } | null;
}

export const RECORD_EXPERIENCES_QUERY = `
  query PipelineExperiences($anchorDomainCode: String, $isActive: Boolean) {
    recordExperiences(anchorDomainCode: $anchorDomainCode, isActive: $isActive) {
      pipeline {
        stageAttribute
        cardAttributes
        stages { code label }
      }
    }
  }
`;

/** Attribute values arrive either bare or wrapped as { value }. */
export function attributeText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
    const value = (raw as { value: unknown }).value;
    return value == null ? '' : String(value);
  }
  return String(raw);
}
