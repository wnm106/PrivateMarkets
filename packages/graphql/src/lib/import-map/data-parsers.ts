/**
 * Data Parsing Layer for Import Maps
 * Supports XLSX, CSV, JSON, HTML, and XML formats
 */

import * as XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import * as xml2js from 'xml2js';
import { extractPdfText, interpretMatrices, interpretText, type InterpretedImport } from '../import-intake';

export interface ParsedField {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'unknown';
  sampleValues: any[];
  nonNullCount: number;
  totalCount: number;
  uniqueValues?: any[];
}

export interface ParsedData {
  fields: ParsedField[];
  records: Record<string, any>[];
  recordCount: number;
  format: 'xlsx' | 'csv' | 'json' | 'html' | 'xml' | 'pdf';
  documentKind?: string;
  suggestedDomains?: string[];
}

/**
 * Parse incoming data from various formats
 */
export async function parseData(
  data: Buffer | string,
  format: 'xlsx' | 'csv' | 'json' | 'html' | 'xml' | 'pdf' | 'auto',
  options?: {
    sheetName?: string;
    delimiter?: string;
    tableSelector?: string;
    rootElement?: string;
    fileName?: string;
  }
): Promise<ParsedData> {
  const detected = format === 'auto' ? detectDataFormat(data, options?.fileName) : format;
  switch (detected) {
    case 'xlsx':
      return parseXLSX(data, options?.sheetName, options?.fileName);
    case 'csv':
      return parsedFromImport(interpretText(options?.fileName || 'import.csv', asText(data), 'csv'), 'csv');
    case 'pdf':
      return parsedFromImport(interpretText(options?.fileName || 'import.pdf', await extractPdfText(asBytes(data)), 'pdf'), 'pdf');
    case 'json':
      return parseJSON(asText(data));
    case 'html':
      return parseHTML(asText(data), options?.tableSelector);
    case 'xml':
      return parseXML(asText(data), options?.rootElement);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

/**
 * Parse Excel/Spreadsheet files
 */
async function parseXLSX(data: Buffer | string, sheetName?: string, fileName?: string): Promise<ParsedData> {
  const workbook = XLSX.read(asBytes(data), { type: 'buffer', cellDates: true });
  const names = sheetName ? [sheetName] : workbook.SheetNames;
  const sheets = names.filter((name) => workbook.Sheets[name]).map((name) => ({
    name,
    rows: sheetMatrix(workbook.Sheets[name]),
  }));
  return parsedFromImport(interpretMatrices(fileName || sheetName || 'workbook.xlsx', sheets, 'xlsx'), 'xlsx');
}

function sheetMatrix(sheet: XLSX.WorkSheet): string[][] {
  const matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });
  return matrix.map((row) => (row || []).map((cell) => {
    if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
      return `${cell.getUTCMonth() + 1}/${cell.getUTCDate()}/${cell.getUTCFullYear()}`;
    }
    return cell === null || cell === undefined ? '' : String(cell).trim();
  }));
}

function parsedFromImport(doc: InterpretedImport, format: ParsedData['format']): ParsedData {
  const statement = doc.kind === 'NAV_STATEMENT' || doc.kind === 'FINANCIAL_STATEMENT';
  const records = statement
    ? doc.rows.map((row) => {
      const record: Record<string, any> = {};
      for (const target of doc.targets) {
        const key = target.attributeCode
          || (target.role === 'identity' ? 'ENTITY_CODE' : target.role === 'name' ? 'ENTITY_NAME' : target.role === 'as_of' ? 'AS_OF_DATE' : target.column);
        record[key] = row[target.column] ?? '';
      }
      return record;
    })
    : doc.rows;
  return {
    fields: extractFieldMetadata(records),
    records,
    recordCount: records.length,
    format,
    documentKind: doc.kind,
    suggestedDomains: doc.domains,
  };
}

function asText(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('utf8') : data;
}

function asBytes(data: Buffer | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  const compact = data.replace(/\s/g, '');
  if (compact.length > 16 && compact.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    const decoded = Buffer.from(compact, 'base64');
    if (decoded.subarray(0, 5).toString() === '%PDF-' || (decoded[0] === 0x50 && decoded[1] === 0x4b)) return decoded;
  }
  return Buffer.from(data);
}

function detectDataFormat(data: Buffer | string, fileName?: string): 'xlsx' | 'csv' | 'json' | 'html' | 'xml' | 'pdf' {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.xml')) return 'xml';
  const bytes = asBytes(data);
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx';
  const text = bytes.subarray(0, 200).toString('utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (/^<\?xml/.test(text) || (text.startsWith('<') && !/^<(!doctype|html|table)/i.test(text))) return 'xml';
  if (/^<(?:!doctype|html|table)/i.test(text)) return 'html';
  return 'csv';
}

/**
 * Parse JSON files
 */
async function parseJSON(data: string): Promise<ParsedData> {
  const parsed = JSON.parse(data);
  
  // Handle both array and single object
  const records = Array.isArray(parsed) ? parsed : [parsed];
  
  if (records.length === 0) {
    return { fields: [], records: [], recordCount: 0, format: 'json' };
  }

  const fields = extractFieldMetadata(records);
  
  return {
    fields,
    records,
    recordCount: records.length,
    format: 'json',
  };
}

/**
 * Parse HTML tables
 */
async function parseHTML(data: string, tableSelector = 'table'): Promise<ParsedData> {
  const $ = cheerio.load(data);
  const table = $(tableSelector).first();
  
  if (table.length === 0) {
    throw new Error(`No table found with selector: ${tableSelector}`);
  }

  // Extract headers
  const headers: string[] = [];
  table.find('thead th, thead td').each((_, el) => {
    headers.push($(el).text().trim());
  });

  // Extract rows
  const records: Record<string, any>[] = [];
  table.find('tbody tr').each((_, row) => {
    const record: Record<string, any> = {};
    $(row).find('td').each((i, cell) => {
      if (i < headers.length) {
        record[headers[i]] = $(cell).text().trim();
      }
    });
    records.push(record);
  });

  if (records.length === 0) {
    return { fields: [], records: [], recordCount: 0, format: 'html' };
  }

  const fields = extractFieldMetadata(records);
  
  return {
    fields,
    records,
    recordCount: records.length,
    format: 'html',
  };
}

/**
 * Parse XML files
 */
async function parseXML(data: string, rootElement?: string): Promise<ParsedData> {
  const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
  const result = await parser.parseStringPromise(data);
  
  // Find root element
  let root = result;
  if (rootElement) {
    root = result[rootElement];
    if (!root) {
      throw new Error(`Root element not found: ${rootElement}`);
    }
  } else {
    // Get first key as root
    const keys = Object.keys(root);
    if (keys.length > 0) {
      root = root[keys[0]];
    }
  }

  // Extract records (handle both array and single object)
  let records: Record<string, any>[] = [];
  
  if (Array.isArray(root)) {
    records = root;
  } else if (typeof root === 'object') {
    // Try to find repeating child elements
    const childKeys = Object.keys(root);
    for (const key of childKeys) {
      if (Array.isArray(root[key])) {
        records = root[key];
        break;
      }
    }
    
    // If no arrays found, treat root as single record
    if (records.length === 0) {
      records = [root];
    }
  }

  if (records.length === 0) {
    return { fields: [], records: [], recordCount: 0, format: 'xml' };
  }

  const fields = extractFieldMetadata(records);
  
  return {
    fields,
    records,
    recordCount: records.length,
    format: 'xml',
  };
}

/**
 * Extract field metadata from records
 */
function extractFieldMetadata(records: Record<string, any>[]): ParsedField[] {
  if (records.length === 0) return [];

  const fieldMap = new Map<string, ParsedField>();
  
  // Collect all field names
  const allFields = new Set<string>();
  records.forEach(record => {
    Object.keys(record).forEach(key => allFields.add(key));
  });

  // Analyze each field
  allFields.forEach(fieldName => {
    const values: any[] = [];
    let nonNullCount = 0;
    const uniqueSet = new Set<any>();

    records.forEach(record => {
      const value = record[fieldName];
      values.push(value);
      
      if (value !== null && value !== undefined && value !== '') {
        nonNullCount++;
        uniqueSet.add(value);
      }
    });

    // Infer type from sample values
    const type = inferDataType(values);
    
    // Get sample values (up to 5)
    const sampleValues = values
      .filter(v => v !== null && v !== undefined && v !== '')
      .slice(0, 5);

    // Get unique values if cardinality is low
    const uniqueValues = uniqueSet.size <= 20 ? Array.from(uniqueSet) : undefined;

    fieldMap.set(fieldName, {
      name: fieldName,
      type,
      sampleValues,
      nonNullCount,
      totalCount: records.length,
      uniqueValues,
    });
  });

  return Array.from(fieldMap.values());
}

/**
 * Infer data type from values
 */
function inferDataType(values: any[]): ParsedField['type'] {
  const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
  
  if (nonNullValues.length === 0) return 'unknown';

  // Check if all values are numbers
  const allNumbers = nonNullValues.every(v => {
    if (typeof v === 'number') return true;
    if (typeof v === 'string') {
      return !isNaN(Number(v)) && v.trim() !== '';
    }
    return false;
  });

  if (allNumbers) return 'number';

  // Check if all values are booleans
  const allBooleans = nonNullValues.every(v => {
    if (typeof v === 'boolean') return true;
    if (typeof v === 'string') {
      const lower = v.toLowerCase();
      return lower === 'true' || lower === 'false' || lower === 'yes' || lower === 'no';
    }
    return false;
  });

  if (allBooleans) return 'boolean';

  // Check if all values are dates
  const allDates = nonNullValues.every(v => {
    if (v instanceof Date) return true;
    if (typeof v === 'string') {
      // Common date patterns
      const datePattern = /^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}|^\d{2}-\d{2}-\d{4}/;
      return datePattern.test(v);
    }
    return false;
  });

  if (allDates) return 'date';

  return 'string';
}
