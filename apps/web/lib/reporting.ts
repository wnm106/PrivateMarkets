import type { DataQuerySpec, DataQueryResult } from '@tapestrai/graphql/src/lib/data-query-engine';

export type { DataQuerySpec, DataQueryResult };

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

export type OutputBlockType = 'markdown' | 'table' | 'chart' | 'insights';

export interface OutputBlockSpec {
  type: OutputBlockType;
  key: string;
  title?: string;
  guidance?: string;
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
  model?: string | null;
  isActive: boolean;
}

export type NarrativeBlock =
  | { type: 'markdown'; key: string; title?: string; text: string }
  | { type: 'table'; key: string; title?: string; columns: string[]; rows: any[][] }
  | { type: 'chart'; key: string; title?: string; chartType: 'bar' | 'line' | 'pie'; labels: string[]; series: Array<{ name: string; values: number[] }> }
  | { type: 'insights'; key: string; title?: string; items: Array<{ title: string; detail: string; severity: 'info' | 'positive' | 'warning' | 'critical' }> };

export interface NarrativeRunRecord {
  id: string | null;
  narrativeId: string | null;
  entityId: string | null;
  parameters: Record<string, any>;
  blocks: NarrativeBlock[];
  status: 'COMPLETED' | 'FAILED';
  errorMessage?: string | null;
  model?: string | null;
  createdAt: string;
}

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
  id narrativeCode narrativeName description domainCode instructions dataQueries parameters outputBlocks model isActive createdAt updatedAt
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

export const NARRATIVE_RUNS_QUERY = `
  query NarrativeRuns($narrativeId: ID!, $entityId: ID, $first: Int) {
    narrativeRuns(narrativeId: $narrativeId, entityId: $entityId, first: $first) {
      id narrativeId entityId parameters blocks status errorMessage model createdAt
    }
  }
`;

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
  const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
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

/** Only allow http(s)/mailto/relative links in model-authored markdown. */
export function sanitizeHtmlLinks(html: string): string {
  return html.replace(/href="(?!https?:|mailto:|\/|#)[^"]*"/gi, 'href="#"');
}
