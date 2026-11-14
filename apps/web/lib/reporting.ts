import type { DataQuerySpec, DataQueryResult } from '@tapestrai/graphql/src/lib/data-query-engine';
import { readBrowserAccessToken } from '@/lib/auth-token';
import type { RunReview, ReviewIssue } from '@tapestrai/graphql/src/lib/narrative-review';
import type {
  NarrativeBlock,
  NarrativeSection,
  OutputBlockSpec,
  OutputBlockType,
} from '@tapestrai/graphql/src/lib/narrative-spec';

export type { RunReview, ReviewIssue };
export type { DataQuerySpec, DataQueryResult, NarrativeBlock, NarrativeSection, OutputBlockSpec, OutputBlockType };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParameterType = 'text' | 'number' | 'date' | 'select' | 'boolean';

export interface ReportParameter {
  name: string;
  label?: string;
  type?: ParameterType;
  options?: string[];
  default?: any;
}

export interface DashboardTemplate {
  id: string;
  dashboardCode: string;
  dashboardName: string;
  description?: string | null;
  domainCode: string;
  htmlTemplate: string;
  dataQueries: DataQuerySpec[];
  parameters: ReportParameter[];
  isActive: boolean;
}

export interface NarrativeTemplate {
  id: string;
  narrativeCode: string;
  narrativeName: string;
  description?: string | null;
  domainCode: string;
  instructions: string;
  dataQueries: DataQuerySpec[];
  parameters: ReportParameter[];
  outputBlocks: OutputBlockSpec[];
  sections: NarrativeSection[];
  persona?: string | null;
  audience?: string | null;
  rules: string[];
  /** Entity types, besides domainCode, whose record pages offer this narrative. */
  exposedDomains: string[];
  allowExternalSearch: boolean;
  model?: string | null;
  isActive: boolean;
}

export type SectionStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface NarrativeRunSectionRecord {
  id?: string | null;
  runId?: string | null;
  sectionKey: string;
  ord: number;
  title?: string | null;
  status: SectionStatus;
  blocks: NarrativeBlock[];
  research?: { queries?: string[]; sources?: Array<{ title: string; url?: string }>; notes?: string };
  verification?: { checked?: number; matched?: number; unmatched?: Array<{ block: string; figure: string }> };
  notes?: string[];
  errorMessage?: string | null;
  model?: string | null;
}

export interface NarrativeRunRecord {
  id: string | null;
  narrativeId: string | null;
  entityId: string | null;
  parameters: Record<string, any>;
  blocks: NarrativeBlock[];
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  errorMessage?: string | null;
  model?: string | null;
  createdAt: string;
  asOfDate?: string | null;
  sources?: Array<{ title: string; url?: string; publisher?: string; date?: string }>;
  verification?: {
    checked?: number;
    matched?: number;
    notTraced?: Array<{ section: string; block: string; figure: string }>;
    /** A second reader's check of the finished report against its own evidence. */
    review?: RunReview;
  };
  origin?: string;
  createdByLabel?: string | null;
  publishedAt?: string | null;
  publishedBy?: string | null;
  publishedByLabel?: string | null;
  publishedLabel?: string | null;
  sections?: NarrativeRunSectionRecord[];
}

/** A run as listed: enough to choose between runs without loading their sections. */
export type NarrativeRunSummary = Pick<
  NarrativeRunRecord,
  'id' | 'narrativeId' | 'entityId' | 'status' | 'asOfDate' | 'createdAt' | 'origin' | 'createdByLabel'
  | 'publishedAt' | 'publishedByLabel' | 'publishedLabel' | 'errorMessage'
>;

export interface DataQueryPayload {
  entity: Record<string, any> | null;
  data: Record<string, DataQueryResult>;
  params: Record<string, any>;
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const DASHBOARD_FIELDS = `
  id dashboardCode dashboardName description domainCode htmlTemplate dataQueries parameters isActive createdAt updatedAt
`;

const NARRATIVE_FIELDS = `
  id narrativeCode narrativeName description domainCode instructions dataQueries parameters outputBlocks
  sections persona audience rules exposedDomains allowExternalSearch model isActive createdAt updatedAt
`;

export const DASHBOARDS_QUERY = `
  query Dashboards($domainCode: String, $isActive: Boolean) {
    dashboards(domainCode: $domainCode, isActive: $isActive) { ${DASHBOARD_FIELDS} }
  }
`;

export const DASHBOARD_QUERY = `
  query Dashboard($dashboardCode: String) {
    dashboard(dashboardCode: $dashboardCode) { ${DASHBOARD_FIELDS} }
  }
`;

export const CREATE_DASHBOARD_MUTATION = `
  mutation CreateDashboard($input: CreateDashboardInput!) {
    createDashboard(input: $input) { dashboard { ${DASHBOARD_FIELDS} } errors { field message code } }
  }
`;

export const UPDATE_DASHBOARD_MUTATION = `
  mutation UpdateDashboard($id: ID!, $input: UpdateDashboardInput!) {
    updateDashboard(id: $id, input: $input) { dashboard { ${DASHBOARD_FIELDS} } errors { field message code } }
  }
`;

export const DELETE_DASHBOARD_MUTATION = `
  mutation DeleteDashboard($id: ID!) {
    deleteDashboard(id: $id) { success errors { field message code } }
  }
`;

export const NARRATIVES_QUERY = `
  query Narratives($domainCode: String, $isActive: Boolean) {
    narratives(domainCode: $domainCode, isActive: $isActive) { ${NARRATIVE_FIELDS} }
  }
`;

export const NARRATIVE_QUERY = `
  query Narrative($narrativeCode: String) {
    narrative(narrativeCode: $narrativeCode) { ${NARRATIVE_FIELDS} }
  }
`;

export const CREATE_NARRATIVE_MUTATION = `
  mutation CreateNarrative($input: CreateNarrativeInput!) {
    createNarrative(input: $input) { narrative { ${NARRATIVE_FIELDS} } errors { field message code } }
  }
`;

export const UPDATE_NARRATIVE_MUTATION = `
  mutation UpdateNarrative($id: ID!, $input: UpdateNarrativeInput!) {
    updateNarrative(id: $id, input: $input) { narrative { ${NARRATIVE_FIELDS} } errors { field message code } }
  }
`;

export const DELETE_NARRATIVE_MUTATION = `
  mutation DeleteNarrative($id: ID!) {
    deleteNarrative(id: $id) { success errors { field message code } }
  }
`;

const RUN_SUMMARY_FIELDS = `
  id narrativeId entityId status asOfDate createdAt origin createdByLabel publishedAt publishedByLabel publishedLabel errorMessage
`;

/** Finished runs for one record, newest first. Sections are loaded separately for the run being shown. */
export const NARRATIVE_RUNS_QUERY = `
  query NarrativeRuns($narrativeId: ID!, $entityId: ID, $first: Int, $statuses: [String!]) {
    narrativeRuns(narrativeId: $narrativeId, entityId: $entityId, first: $first, statuses: $statuses) {
      ${RUN_SUMMARY_FIELDS}
    }
  }
`;

export const NARRATIVE_RUN_QUERY = `
  query NarrativeRun($id: ID!) {
    narrativeRun(id: $id) {
      ${RUN_SUMMARY_FIELDS}
      parameters blocks model sources verification
      sections { sectionKey ord title status blocks research verification notes errorMessage model }
    }
  }
`;

export const PUBLISH_NARRATIVE_RUN_MUTATION = `
  mutation PublishNarrativeRun($id: ID!, $label: String) {
    publishNarrativeRun(id: $id, label: $label) { ${RUN_SUMMARY_FIELDS} }
  }
`;

export const UNPUBLISH_NARRATIVE_RUN_MUTATION = `
  mutation UnpublishNarrativeRun($id: ID!) {
    unpublishNarrativeRun(id: $id) { ${RUN_SUMMARY_FIELDS} }
  }
`;

export { ageOf, chooseRun } from './narrative-runs';

export const RUN_DATA_QUERIES_QUERY = `
  query RunDataQueries($queries: JSON!, $entityId: ID, $params: JSON, $asOfDate: String) {
    runDataQueries(queries: $queries, entityId: $entityId, params: $params, asOfDate: $asOfDate) {
      anchor results warnings validationErrors asOfDate
    }
  }
`;

export const GRID_QUERY = `
  query GridQuery($input: GridQueryInput!) {
    gridQuery(input: $input) {
      mode level groupField total matched rows summary groupBy asOfDate entityCount
      columns { code name kind aggregation unit precision }
    }
  }
`;

export interface GridResultPayload {
  mode: 'rows' | 'groups' | 'aggregate';
  level?: number;
  groupField?: string | null;
  total: number;
  matched: number;
  rows: Array<Record<string, any>>;
  summary?: Record<string, any> | null;
  groupBy: string[];
  asOfDate?: string;
  entityCount?: number;
  columns: Array<{ code: string; name?: string; kind?: string; aggregation?: string; unit?: string; precision?: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function authHeaders(): Record<string, string> {
  const token = readBrowserAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function defaultParams(parameters: ReportParameter[] | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of parameters || []) {
    if (p.default !== undefined && p.default !== null) out[p.name] = p.default;
  }
  return out;
}

export function slugCode(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export async function runNarrative(args: {
  narrativeId?: string;
  entityId?: string;
  params?: Record<string, any>;
  draft?: Partial<NarrativeTemplate>;
}): Promise<NarrativeRunRecord> {
  const res = await fetch('/api/narratives/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Run failed (${res.status})`);
  return body.run as NarrativeRunRecord;
}

async function postRun(body: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/narratives/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Run failed (${res.status})`);
  return json;
}

export interface StartedRun {
  run: NarrativeRunRecord;
  order: string[];
  sections: Array<{ key: string; title: string; purpose?: string; dependsOn: string[]; batched: boolean; research: boolean; agentic: boolean }>;
  allowExternalSearch: boolean;
}

export const startNarrativeRun = (args: { narrativeId: string; entityId?: string; asOfDate?: string; params?: Record<string, any> }): Promise<StartedRun> =>
  postRun({ action: 'start', ...args });

export interface SectionResponse {
  section: NarrativeRunSectionRecord;
  batch: { index: number; count: number; done: boolean } | null;
  /** Draft runs only: this batch's blocks, for the caller to merge. */
  batchBlocks?: NarrativeBlock[];
}

export const runNarrativeSection = (args: {
  runId?: string;
  draft?: Partial<NarrativeTemplate>;
  sectionKey: string;
  batchIndex?: number;
  entityId?: string;
  asOfDate?: string;
  params?: Record<string, any>;
  prior?: Array<{ key: string; title: string; markdown: string }>;
  /** Problems a reviewer found in this section's earlier version, which the new version must fix. */
  reviewNotes?: string;
}): Promise<SectionResponse> => postRun({ action: 'section', ...args });

/** Asks a second reader to check a finished run for contradictions and unsupported claims. */
export const reviewNarrativeRun = (runId: string): Promise<{ review: RunReview; saved: boolean }> => postRun({ action: 'review', runId });

export const finishNarrativeRun = (runId: string): Promise<{ run: NarrativeRunRecord }> => postRun({ action: 'finish', runId });

/** Only allow http(s)/mailto/relative links in model-authored markdown. */
export function sanitizeHtmlLinks(html: string): string {
  return html.replace(/href="(?!https?:|mailto:|\/|#)[^"]*"/gi, 'href="#"');
}
