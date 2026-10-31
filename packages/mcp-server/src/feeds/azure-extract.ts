import type { ParsedTable } from './types';

/**
 * Azure AI Document Intelligence (prebuilt layout) turns a PDF or scan into tables.
 * The specialist uses it only when the endpoint and key are configured.
 */

export class AzureExtractUnavailable extends Error {
  constructor() {
    super('Azure Document Intelligence is not configured');
    this.name = 'AzureExtractUnavailable';
  }
}

export function azureConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT && env.AZURE_DOCUMENT_INTELLIGENCE_KEY);
}

export function azureAnalyzeUrl(endpoint: string): string {
  const root = endpoint.replace(/\/$/, '');
  return `${root}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30`;
}

interface LayoutCell {
  rowIndex: number;
  columnIndex: number;
  content?: string;
  kind?: string;
}

export function tablesFromLayout(result: any): ParsedTable[] {
  const tables = result?.analyzeResult?.tables || result?.tables || [];
  return tables
    .map((table: { cells?: LayoutCell[] }) => layoutTable(table))
    .filter((table: ParsedTable) => table.headers.length > 0 && table.rows.length > 0);
}

function layoutTable(table: { cells?: LayoutCell[] }): ParsedTable {
  const cells = table.cells || [];
  if (cells.length === 0) return { headers: [], rows: [] };
  const marked = cells.filter((cell) => cell.kind === 'columnHeader');
  const headerCells = marked.length > 0 ? marked : cells.filter((cell) => cell.rowIndex === 0);
  const headerRows = new Set(headerCells.map((cell) => cell.rowIndex));
  const width = Math.max(0, ...cells.map((cell) => cell.columnIndex + 1));
  const headers: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const cell = headerCells.find((item) => item.columnIndex === index);
    const label = (cell?.content || '').trim();
    headers.push(label || `Column ${index + 1}`);
  }
  const rowIndexes = [...new Set(cells.map((cell) => cell.rowIndex))]
    .filter((index) => !headerRows.has(index))
    .sort((left, right) => left - right);
  const rows = rowIndexes.map((rowIndex) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      const cell = cells.find((item) => item.rowIndex === rowIndex && item.columnIndex === index);
      record[header] = (cell?.content || '').trim();
    });
    return record;
  }).filter((row) => Object.values(row).some(Boolean));
  return { headers, rows };
}

export async function extractTablesWithAzure(
  bytes: Buffer,
  mediaType: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<{ tables: ParsedTable[]; note: string }> {
  if (!azureConfigured(env)) throw new AzureExtractUnavailable();
  const endpoint = env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '';
  const key = env.AZURE_DOCUMENT_INTELLIGENCE_KEY || '';
  const start = await fetchImpl(azureAnalyzeUrl(endpoint), {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': mediaType || 'application/octet-stream',
    },
    body: new Uint8Array(bytes),
  });
  if (!start.ok) {
    const text = await start.text();
    throw new Error(`Azure Document Intelligence rejected the file (${start.status}). ${text.slice(0, 180)}`);
  }
  const operation = start.headers.get('operation-location');
  if (!operation) throw new Error('Azure Document Intelligence did not return an operation to poll');
  const started = Date.now();
  while (Date.now() - started < 25000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await fetchImpl(operation, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (!poll.ok) throw new Error(`Azure Document Intelligence poll failed (${poll.status})`);
    const body = await poll.json();
    if (body.status === 'succeeded') {
      const tables = tablesFromLayout(body);
      const note = tables.length
        ? `Azure Document Intelligence found ${tables.length} table${tables.length === 1 ? '' : 's'}.`
        : 'Azure Document Intelligence read the file but did not find a table.';
      return { tables, note };
    }
    if (body.status === 'failed') throw new Error(body.error?.message || 'Azure Document Intelligence failed to read the file');
  }
  throw new Error('Azure Document Intelligence did not finish in time. Try the file again, or upload a CSV or Excel extract.');
}
