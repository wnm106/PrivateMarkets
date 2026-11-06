/**
 * Turns a spreadsheet, CSV, or statement into one table plus column targets.
 * Positions stay row-oriented. NAV and financial statements become one row
 * whose columns are the statement lines.
 */

import { buildStatementTemplate } from '../statement-template/build';
import { normalizeLabel } from '../statement-template/normalize';
import { parseStatementSource, visionJsonToStatementText } from '../statement-template/parse';
import { SYNONYM_GROUPS } from '../statement-template/synonyms';
import type { CatalogAttribute } from '../statement-template/types';

export type ImportKind = 'POSITIONS' | 'NAV_STATEMENT' | 'FINANCIAL_STATEMENT' | 'TABULAR';
export type ImportFormat = 'csv' | 'xlsx' | 'pdf' | 'html' | 'json' | 'text';
export type ImportRole = 'ignore' | 'filter' | 'as_of' | 'identity' | 'name' | 'attribute' | 'parent';

export interface ImportTarget {
  column: string;
  role: ImportRole;
  domainCode: string | null;
  attributeCode: string | null;
  parentDomainCode: string | null;
  confidence: number;
  reason: string;
}

export interface InterpretedImport {
  format: ImportFormat;
  kind: ImportKind;
  mapCode: string;
  confidence: number;
  reason: string;
  headers: string[];
  rows: Record<string, string>[];
  targets: ImportTarget[];
  domains: string[];
  entityName: string | null;
  asOfDate: string | null;
  preserveSource: boolean;
}

export interface ImportSheet {
  name?: string;
  rows: string[][];
}

const CANONICAL_HEADERS = new Set([
  'Domai',
  'Poition',
  'issuer code',
  'issuer name',
  'fund code',
  'fund name',
  'security code',
  'security name',
  'valid from',
]);

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const NAV_CUES = /\b(nav|net asset value|net assets|partners capital|partner capital|investments at fair value|capital contributions|subscriptions)\b/i;
const FINANCIAL_CUES = /\b(revenue|net income|gross profit|operating income|ebitda|cost of goods|cost of sales|income statement|balance sheet|statement of operations|cash flow|profit and loss|total equity|earnings)\b/i;
const TITLE_CUES = /\b(statement of|consolidated|unaudited|confidential|for the (year|period|quarter|month)|as of|as at|period end(ing)?|valuation date)\b/i;
const KNOWN_SECTIONS = new Set([
  'assets', 'liabilities', 'equity', 'income', 'expenses', 'revenue', 'net asset value', 'net assets',
  'capital', 'cash flows', 'cash flow', 'operations', 'balance sheet', 'profit and loss',
  'gains and losses', 'partners capital', 'partner capital', 'statement of operations',
]);

type Slot =
  | 'fund_code' | 'fund_name'
  | 'security_code' | 'security_name' | 'isin' | 'cusip' | 'ticker'
  | 'issuer_code' | 'issuer_name' | 'lei'
  | 'position_code' | 'position_name'
  | 'quantity' | 'market_value' | 'cost' | 'currency' | 'as_of' | 'price';

const SLOT_RULES: Array<{ slot: Slot; test: (name: string) => boolean }> = [
  { slot: 'isin', test: (name) => /\bisin\b/.test(name) },
  { slot: 'cusip', test: (name) => /\bcusip\b/.test(name) },
  { slot: 'lei', test: (name) => /\blei\b/.test(name) || name === 'legal entity identifier' },
  { slot: 'ticker', test: (name) => /\b(ticker|symbol)\b/.test(name) && !/\b(fund|issuer|currency)\b/.test(name) },
  { slot: 'as_of', test: (name) => /^(as of( date)?|asof|valuation date|position date|metric date|price date|statement date|valid from|holding date)$/.test(name) },
  { slot: 'quantity', test: (name) => /^(qty|quantity|shares|share quantity|units|quantity held|position quantity|par|par amount)$/.test(name) || (/\b(shares|quantity)\b/.test(name) && !/\b(price|value)\b/.test(name)) },
  { slot: 'market_value', test: (name) => /\b(market value|mkt value|fair value|fair market value|fmv)\b/.test(name) || name === 'mv' || name === 'market val' },
  { slot: 'cost', test: (name) => /\b(cost basis|book cost|amortized cost|amortised cost|book value|carrying value)\b/.test(name) || name === 'cost' },
  { slot: 'currency', test: (name) => /^(ccy|currency|position currency|reporting currency|nav currency|base currency)$/.test(name) },
  { slot: 'fund_code', test: (name) => /\b(fund code|portfolio code|fund id|account number|account id|portfolio id)\b/.test(name) },
  { slot: 'fund_name', test: (name) => /\b(fund name|portfolio name|account name)\b/.test(name) },
  { slot: 'security_code', test: (name) => /\b(security code|instrument id|asset id|security id)\b/.test(name) },
  { slot: 'security_name', test: (name) => /\b(security name|instrument name|asset name|security description)\b/.test(name) },
  { slot: 'issuer_code', test: (name) => /\b(issuer code|issuer id|company code)\b/.test(name) },
  { slot: 'issuer_name', test: (name) => /\b(issuer name|company name|issuer)\b/.test(name) },
  { slot: 'position_code', test: (name) => /\b(position id|position code|holding id|lot id|poition)\b/.test(name) },
  { slot: 'position_name', test: (name) => /\b(position name|holding name)\b/.test(name) },
  { slot: 'price', test: (name) => /^(price|market price|last price|clean price)$/.test(name) },
];

export function interpretText(fileName: string, text: string, format: ImportFormat = 'text'): InterpretedImport {
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) return emptyImport(fileName, format, 'The file is empty.');
  if (format === 'html' || /<table[\s>]/i.test(source)) {
    const matrix = htmlToMatrix(source);
    if (matrix.length > 0) return interpretMatrices(fileName, [{ rows: matrix }], 'html');
  }
  if (source.startsWith('{') || source.startsWith('[')) {
    const fromJson = interpretJson(fileName, source);
    if (fromJson) return fromJson;
  }
  const grid = parseDelimitedGrid(source);
  if (grid.length >= 2) return interpretMatrices(fileName, [{ rows: grid }], format === 'text' ? 'csv' : format);
  return statementFromText(fileName, source, format, []);
}

export function interpretMatrices(fileName: string, sheets: ImportSheet[], format: ImportFormat = 'xlsx'): InterpretedImport {
  const candidates = sheets
    .map((sheet) => ({ sheet, rows: compactRows(sheet.rows) }))
    .filter((sheet) => sheet.rows.length > 0);
  if (candidates.length === 0) return emptyImport(fileName, format, 'The workbook has no rows.');

  let best: InterpretedImport | null = null;
  for (const candidate of candidates) {
    const interpreted = interpretMatrix(fileName, candidate.rows, format, candidate.sheet.name);
    if (!best || rank(interpreted) > rank(best)) best = interpreted;
  }
  return best || emptyImport(fileName, format, 'The workbook has no readable sheet.');
}

export function parseDelimitedGrid(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  if (!delimiter) return [];
  return parseGrid(text, delimiter).map((row) => row.map((cell) => cell.trim())).filter((row) => row.some(Boolean));
}

export function findDate(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (us) return validDate(Number(us[3]), Number(us[1]), Number(us[2]));
  const named = text.match(/\b(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})\b/);
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    const year = expandYear(Number(named[3]));
    if (month) return validDate(year, month, Number(named[1]));
  }
  const monthFirst = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month) return validDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  const yearOnly = text.match(/\b(?:fy|fiscal|year)\s*(20\d{2}|19\d{2})\b/i) || text.match(/\b(20\d{2}|19\d{2})\b/);
  if (yearOnly && text.length < 40) return `${yearOnly[1]}-12-31`;
  return null;
}

function interpretMatrix(fileName: string, rows: string[][], format: ImportFormat, sheetName?: string): InterpretedImport {
  const headerIndex = findHeaderIndex(rows);
  const headers = headerIndex === null ? [] : rows[headerIndex].filter(Boolean);
  if (isCanonicalPositionFile(headers)) {
    const table = tableFromGrid(rows, headerIndex || 0);
    return finishTabular(fileName, format, 'POSITIONS', 'POSITION_FILE', table.headers, table.rows, [], 0.99, 'Recognized the position file column map. Source values are unchanged.', true, sheetName);
  }

  const positionHeaders = headerIndex === null ? [] : headers;
  const body = headerIndex === null ? rows : rows.slice(headerIndex + 1);
  const positions = positionScore(positionHeaders, body);
  const statement = statementScore(rows);
  if (positions >= 3 && positions >= statement) {
    return positionsFromGrid(fileName, format, rows, headerIndex || 0, sheetName);
  }
  if (statement >= 3 || (statement >= 2 && positions === 0)) {
    const interpreted = statementFromMatrix(fileName, rows, format, sheetName);
    if (interpreted && interpreted.rows.length > 0 && interpreted.targets.some((target) => target.role === 'attribute')) return interpreted;
  }
  if (headerIndex !== null) {
    const partial = positionsFromGrid(fileName, format, rows, headerIndex, sheetName, positions > 0 ? 'POSITIONS' : 'TABULAR');
    if (partial.targets.length > 0) return partial;
    const table = tableFromGrid(rows, headerIndex);
    return finishTabular(fileName, format, 'TABULAR', 'DATA_TABLE', table.headers, table.rows, [], 0.4, 'Read the sheet as a table. Column names did not match a position, NAV, or financial statement.', false, sheetName);
  }
  const fallback = statementFromMatrix(fileName, rows, format, sheetName);
  if (fallback) return fallback;
  return emptyImport(fileName, format, 'No table or statement lines were found.');
}

function positionsFromGrid(
  fileName: string,
  format: ImportFormat,
  rows: string[][],
  headerIndex: number,
  sheetName?: string,
  forcedKind?: ImportKind,
): InterpretedImport {
  const table = tableFromGrid(rows, headerIndex);
  const samples = columnSamples(table.headers, table.rows);
  const slots = new Map<string, Slot>();
  for (const header of table.headers) {
    const slot = classifyHeader(header, samples.get(header) || []);
    if (slot) slots.set(header, slot);
  }
  const holding = [...slots.values()].some((slot) => slot === 'quantity' || slot === 'market_value' || slot === 'cost' || slot === 'position_code' || slot === 'position_name');
  const hasSecurity = [...slots.values()].some((slot) => slot === 'isin' || slot === 'cusip' || slot === 'ticker' || slot === 'security_code' || slot === 'security_name');
  const hasFund = [...slots.values()].some((slot) => slot === 'fund_code' || slot === 'fund_name');
  const kind: ImportKind = forcedKind || (holding || (hasFund && hasSecurity) ? 'POSITIONS' : 'TABULAR');
  const enriched = enrichPositions(table.headers, table.rows, slots, kind === 'POSITIONS');
  const domains = [...new Set(enriched.targets.map((target) => target.domainCode).filter((domain): domain is string => Boolean(domain)))];
  const sheetNote = sheetName && sheetName !== 'Sheet1' ? ` Sheet “${sheetName}”.` : '';
  return {
    format,
    kind,
    mapCode: kind === 'POSITIONS' ? 'POSITION_FILE' : 'DATA_TABLE',
    confidence: kind === 'POSITIONS' ? 0.9 : 0.55,
    reason: (kind === 'POSITIONS'
      ? 'Read the file as positions. Funds and securities are identified before each holding.'
      : 'Read the file as a table and mapped the columns that match known attributes.') + sheetNote,
    headers: enriched.headers,
    rows: enriched.rows,
    targets: enriched.targets,
    domains,
    entityName: null,
    asOfDate: asOfFromTargets(enriched.headers, enriched.rows, enriched.targets),
    preserveSource: false,
  };
}

function statementFromMatrix(fileName: string, rows: string[][], format: ImportFormat, sheetName?: string): InterpretedImport | null {
  const pivoted = pivotSectionTable(rows);
  if (pivoted) {
    const { prologue, body } = splitStatement(pivoted);
    const text = matrixToStatementText(body.length > 0 ? body : pivoted);
    if (!text.trim()) return null;
    return statementFromText(fileName, text, format, prologue, null, null, sheetName);
  }
  const collapsed = collapsePeriods(rows);
  const { prologue, body } = splitStatement(collapsed.rows);
  const text = body.length > 0 ? matrixToStatementText(body) : matrixToStatementText(collapsed.rows);
  if (!text.trim()) return null;
  return statementFromText(fileName, text, format, prologue, collapsed.asOf, collapsed.note, sheetName);
}

function pivotSectionTable(rows: string[][]): string[][] | null {
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map((cell) => cell.toLowerCase());
    const hasSection = cells.some((cell) => /section|group|category/.test(cell));
    const hasLabel = cells.some((cell) => /\b(line|item|account|description|label|caption)\b/.test(cell));
    const hasValue = cells.some((cell) => /\b(amount|value|balance|total|figure)\b/.test(cell));
    return hasLabel && (hasSection || hasValue) && row.filter(isNumeric).length === 0;
  });
  if (headerIndex < 0) return null;
  const header = rows[headerIndex].map((cell) => cell.toLowerCase());
  const sectionIndex = header.findIndex((cell) => /section|group|category/.test(cell));
  const labelIndex = header.findIndex((cell) => /\b(line|item|account|description|label|caption)\b/.test(cell));
  const valueIndex = header.findIndex((cell) => /\b(amount|value|balance|total|figure)\b/.test(cell));
  if (labelIndex < 0) return null;
  const pivoted: string[][] = [];
  let current = '';
  for (const row of rows.slice(headerIndex + 1)) {
    const section = sectionIndex >= 0 ? (row[sectionIndex] || '').trim() : '';
    if (section && section !== current) {
      pivoted.push([section]);
      current = section;
    }
    const label = (row[labelIndex] || '').trim();
    if (!label) continue;
    const value = valueIndex >= 0
      ? (row[valueIndex] || '')
      : (row.find((cell, index) => index !== labelIndex && index !== sectionIndex && isNumeric(cell)) || '');
    pivoted.push([label, value]);
  }
  return pivoted.length > 0 ? pivoted : null;
}

function statementFromText(
  fileName: string,
  text: string,
  format: ImportFormat,
  prologue: string[],
  periodAsOf?: string | null,
  periodNote?: string | null,
  sheetName?: string,
): InterpretedImport {
  const kindName = classifyStatement(text, prologue);
  const statementKind = kindName === 'FINANCIAL_STATEMENT' ? 'FINANCIAL' : 'NAV';
  const draft = buildStatementTemplate(
    [{ sourceName: fileName, sourceKind: 'file', text }],
    synonymCatalog(),
    { statementKind },
  );
  const lines = draft.sections.flatMap((section) => section.lines).filter((line) => line.sampleValue);
  if (lines.length === 0) {
    return emptyImport(fileName, format, draft.warnings[0] || 'No statement lines were found.');
  }

  const domain = kindName === 'FINANCIAL_STATEMENT' ? 'ISSUER' : 'FUND';
  const prologueText = prologue.join('\n');
  const entityName = entityNameFrom(prologue) || entityNameFrom(text.split('\n').slice(0, 8)) || nameFromFile(fileName);
  const asOf = periodAsOf || findDate(prologueText) || dateFromLines(lines) || findDate(text.slice(0, 500));
  const currency = currencyFrom(prologueText) || currencyFrom(text);
  const headers = ['Entity Code', 'Entity Name'];
  const targets: ImportTarget[] = [
    target('Entity Code', 'identity', domain, null, 0.94, `${entityName || 'The entity'} is the ${domain === 'FUND' ? 'fund' : 'company'} on the statement.`),
    target('Entity Name', 'name', domain, null, 0.94, 'Statement title used as the entity name.'),
  ];
  const row: Record<string, string> = {
    'Entity Code': entityCodeFromName(entityName || fileName),
    'Entity Name': entityName || nameFromFile(fileName),
  };
  if (asOf) {
    headers.push('As of Date');
    row['As of Date'] = asOf;
    targets.push(target('As of Date', 'as_of', null, null, 0.9, periodNote || 'Statement date used as the as-of date. You can change it before processing.'));
  }
  if (currency && !lines.some((line) => line.attributeCode === 'NAV_CURRENCY' || line.attributeCode === 'REPORTING_CURRENCY')) {
    headers.push('Currency');
    row.Currency = currency;
    const code = kindName === 'NAV_STATEMENT' ? 'NAV_CURRENCY' : 'REPORTING_CURRENCY';
    targets.push(target('Currency', 'attribute', domain, code, 0.86, `Reporting currency mapped to ${code}.`));
  }

  const usedHeaders = new Set(headers);
  for (const line of lines) {
    if (line.attributeCode === 'NAV_DATE' && asOf) continue;
    let header = line.displayLabel.trim() || line.attributeName;
    if (usedHeaders.has(header)) header = `${header} (${line.attributeCode})`;
    usedHeaders.add(header);
    headers.push(header);
    row[header] = line.dataType === 'DATE' ? (findDate(line.sampleValue || '') || line.sampleValue || '') : (line.sampleValue || '');
    targets.push(target(
      header,
      'attribute',
      domain,
      line.attributeCode,
      line.confidence,
      line.isNew
        ? `New ${domain === 'FUND' ? 'fund' : 'company'} attribute from “${line.displayLabel}”.`
        : `“${line.displayLabel}” matches ${line.attributeName}.`,
    ));
  }

  const label = kindName === 'NAV_STATEMENT' ? 'NAV statement' : 'financial statement';
  const where = sheetName && sheetName !== 'Sheet1' ? ` from sheet “${sheetName}”` : '';
  return {
    format,
    kind: kindName,
    mapCode: kindName === 'NAV_STATEMENT' ? 'NAV_STATEMENT' : 'FINANCIAL_STATEMENT',
    confidence: 0.88,
    reason: `Read a ${label}${where} for ${row['Entity Name']}.${periodNote ? ` ${periodNote}` : ''} ${lines.length} line${lines.length === 1 ? '' : 's'} mapped onto ${domain}.`,
    headers,
    rows: [row],
    targets,
    domains: [domain],
    entityName: row['Entity Name'],
    asOfDate: asOf,
    preserveSource: false,
  };
}

function enrichPositions(
  headers: string[],
  rows: Record<string, string>[],
  slots: Map<string, Slot>,
  createPosition: boolean,
): { headers: string[]; rows: Record<string, string>[]; targets: ImportTarget[] } {
  const nextHeaders = [...headers];
  const nextRows = rows.map((row) => ({ ...row }));
  const targets: ImportTarget[] = [];
  const columnFor = (slot: Slot) => [...slots.entries()].find((entry) => entry[1] === slot)?.[0];

  const addDerived = (header: string, values: string[], slot: Slot) => {
    if (nextHeaders.includes(header)) return header;
    nextHeaders.push(header);
    nextRows.forEach((row, index) => {
      row[header] = values[index] || '';
    });
    slots.set(header, slot);
    return header;
  };

  let fundCode = columnFor('fund_code');
  const fundName = columnFor('fund_name') || bareNameColumn(slots, 'fund');
  if (!fundCode && fundName) {
    fundCode = addDerived('Fund Code', nextRows.map((row) => entityCodeFromName(row[fundName] || '')), 'fund_code');
  }
  if (fundCode) targets.push(target(fundCode, 'identity', 'FUND', null, 0.92, 'Fund identifier.'));
  if (fundName && fundName !== fundCode) targets.push(target(fundName, 'name', 'FUND', null, 0.9, 'Fund name.'));

  let issuerCode = columnFor('issuer_code');
  const issuerName = columnFor('issuer_name');
  const lei = columnFor('lei');
  if (!issuerCode && lei) issuerCode = addDerived('Issuer Code', nextRows.map((row) => (row[lei] || '').toUpperCase()), 'issuer_code');
  if (!issuerCode && issuerName) issuerCode = addDerived('Issuer Code', nextRows.map((row) => entityCodeFromName(row[issuerName] || '')), 'issuer_code');
  if (issuerCode) targets.push(target(issuerCode, 'identity', 'ISSUER', null, 0.9, 'Issuer identifier.'));
  if (issuerName && issuerName !== issuerCode) targets.push(target(issuerName, 'name', 'ISSUER', null, 0.86, 'Issuer name.'));
  if (lei) targets.push(target(lei, 'attribute', 'ISSUER', 'LEI', 0.95, 'Legal entity identifier.'));

  let securityCode = columnFor('security_code');
  const securityName = columnFor('security_name') || bareNameColumn(slots, 'security');
  const isin = columnFor('isin');
  const cusip = columnFor('cusip');
  const ticker = columnFor('ticker');
  if (!securityCode) {
    const source = isin || cusip || ticker;
    if (source) securityCode = addDerived('Security Code', nextRows.map((row) => (row[source] || '').toUpperCase()), 'security_code');
    else if (securityName) securityCode = addDerived('Security Code', nextRows.map((row) => entityCodeFromName(row[securityName] || '')), 'security_code');
  }
  if (securityCode) targets.push(target(securityCode, 'identity', 'SECURITY', null, 0.92, 'Security identifier.'));
  if (securityName && securityName !== securityCode) targets.push(target(securityName, 'name', 'SECURITY', null, 0.88, 'Security name.'));
  if (isin) targets.push(target(isin, 'attribute', 'SECURITY', 'ISIN', 0.98, 'Values match ISIN.'));
  if (cusip) targets.push(target(cusip, 'attribute', 'SECURITY', 'CUSIP', 0.95, 'CUSIP identifier.'));
  if (ticker) targets.push(target(ticker, 'attribute', 'SECURITY', 'TICKER', 0.9, 'Ticker symbol.'));
  const price = columnFor('price');
  if (price) targets.push(target(price, 'attribute', 'SECURITY', 'PRICE', 0.84, 'Security price.'));

  const quantity = columnFor('quantity');
  const marketValue = columnFor('market_value');
  const cost = columnFor('cost');
  const currency = columnFor('currency');
  const asOf = columnFor('as_of');
  let positionCode = columnFor('position_code');
  const positionName = columnFor('position_name');
  if (createPosition && !positionCode && (quantity || marketValue || cost || fundCode || securityCode)) {
    positionCode = addDerived('Position Code', nextRows.map((row) => {
      const fund = fundCode ? row[fundCode] : '';
      const security = securityCode ? row[securityCode] : '';
      return [fund, security].filter(Boolean).join('|') || entityCodeFromName(row[positionName || ''] || 'POSITION');
    }), 'position_code');
  }
  if (positionCode) targets.push(target(positionCode, 'identity', 'POSITION', null, 0.9, 'One position per fund and security.'));
  if (positionName && positionName !== positionCode) targets.push(target(positionName, 'name', 'POSITION', null, 0.8, 'Position name.'));
  if (quantity) targets.push(target(quantity, 'attribute', 'POSITION', 'SHARE_QUANTITY', 0.92, 'Share or unit quantity.'));
  if (marketValue) targets.push(target(marketValue, 'attribute', 'POSITION', 'TOTAL_FAIR_MARKET_VALUE_AMOUNT', 0.9, 'Market value of the holding.'));
  if (cost) targets.push(target(cost, 'attribute', 'POSITION', 'CARRYING_AMORTIZED_COST_AMOUNT', 0.86, 'Cost or book value of the holding.'));
  if (currency) {
    const domain = positionCode ? 'POSITION' : securityCode ? 'SECURITY' : 'FUND';
    const code = domain === 'POSITION' ? 'POSITION_CURRENCY' : domain === 'SECURITY' ? 'CURRENCY' : 'NAV_CURRENCY';
    targets.push(target(currency, 'attribute', domain, code, 0.84, 'Currency of the amounts.'));
  }
  if (asOf) targets.push(target(asOf, 'as_of', null, null, 0.9, 'Row date used as the as-of date when every row shares it.'));

  return { headers: nextHeaders, rows: nextRows, targets };
}

function bareNameColumn(slots: Map<string, Slot>, kind: 'fund' | 'security'): string | undefined {
  for (const [header, slot] of slots) {
    if (kind === 'fund' && (slot === 'fund_name' || slot === 'fund_code')) return slot === 'fund_name' ? header : undefined;
    if (kind === 'security' && slot === 'security_name') return header;
  }
  return undefined;
}

function classifyHeader(header: string, samples: string[]): Slot | null {
  const name = header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!name) return null;
  if (name === 'fund' || name === 'portfolio' || name === 'account') {
    return looksLikeCode(samples) ? 'fund_code' : 'fund_name';
  }
  if (name === 'security' || name === 'instrument' || name === 'asset') {
    return looksLikeCode(samples) ? 'security_code' : 'security_name';
  }
  if (name === 'position' || name === 'holding' || name === 'poition') {
    return looksLikeCode(samples) ? 'position_code' : 'position_name';
  }
  for (const rule of SLOT_RULES) {
    if (rule.test(name)) return rule.slot;
  }
  const filled = samples.map((sample) => sample.trim()).filter(Boolean);
  if (filled.length >= 1 && filled.every(isIsin)) return 'isin';
  if (filled.length >= 1 && filled.every(isCusip)) return 'cusip';
  if (filled.length >= 1 && filled.every(isLei)) return 'lei';
  return null;
}

function positionScore(headers: string[], rows: string[][]): number {
  const slots = new Set<Slot>();
  headers.forEach((header, index) => {
    const samples = rows.slice(0, 8).map((row) => row[index] || '');
    const slot = classifyHeader(header, samples);
    if (slot) slots.add(slot);
  });
  let score = slots.size;
  if (slots.has('quantity') || slots.has('market_value') || slots.has('position_code')) score += 1;
  if (rows.some((row) => row.some(isIsin))) score += 2;
  return score;
}

function statementScore(rows: string[][]): number {
  const filled = rows.filter((row) => row.some(Boolean));
  if (filled.length < 2) return 0;
  const narrow = filled.filter((row) => row.filter(Boolean).length <= 3).length;
  const labelValue = filled.filter((row) => {
    const cells = row.filter(Boolean);
    return cells.length >= 2 && cells.length <= 6 && !isNumeric(cells[0]) && cells.slice(1).some(isNumeric);
  }).length;
  const lexicon = filled.reduce((sum, row) => sum + (NAV_CUES.test(row.join(' ')) || FINANCIAL_CUES.test(row.join(' ')) ? 1 : 0), 0);
  let score = 0;
  if (narrow / filled.length >= 0.55) score += 2;
  if (labelValue >= 3) score += 3;
  if (lexicon >= 1) score += 2;
  if (lexicon >= 3) score += 2;
  return score;
}

function collapsePeriods(rows: string[][]): { rows: string[][]; asOf: string | null; note: string | null } {
  const headerAt = rows.findIndex((row, index) => index < 12 && periodCells(row).length >= 2);
  if (headerAt < 0) return { rows, asOf: null, note: null };
  const periods = periodCells(rows[headerAt])
    .map((period) => ({ ...period, date: findDate(period.label) || '' }))
    .sort((left, right) => right.date.localeCompare(left.date) || left.index - right.index);
  const valueIndex = periods[0].index;
  const chosen = periods[0].label;
  const asOf = periods[0].date || null;
  const collapsed = rows.map((row, index) => {
    if (index === headerAt) return row;
    const cells = row.filter((cell) => cell.trim());
    if (cells.length <= 1) return row;
    const label = row.find((cell, cellIndex) => cell.trim() && !periods.some((period) => period.index === cellIndex)) || row[0] || '';
    return [label, row[valueIndex] || ''];
  });
  return {
    rows: collapsed,
    asOf,
    note: `Using the ${chosen} column. Earlier periods remain in the file and are not loaded.`,
  };
}

function periodCells(row: string[]): Array<{ index: number; label: string }> {
  return row.flatMap((cell, index) => {
    const label = cell.trim();
    if (!label) return [];
    if (/^(fy|fiscal)?\s*(19|20)\d{2}$/i.test(label) || /^q[1-4]\b/i.test(label) || /^(current|prior|ytd)$/i.test(label) || findDate(label)) {
      return [{ index, label }];
    }
    return [];
  });
}

function splitStatement(rows: string[][]): { prologue: string[]; body: string[][] } {
  const start = rows.findIndex((row) => {
    const text = row.filter(Boolean).join(' ').trim();
    if (!text || TITLE_CUES.test(text)) return false;
    if (isKnownSection(text)) return true;
    const cells = row.filter(Boolean);
    return cells.length >= 2 && !isNumeric(cells[0]) && cells.slice(1).some(isNumeric);
  });
  if (start < 0) return { prologue: rows.map((row) => row.filter(Boolean).join(' ')).filter(Boolean), body: [] };
  return {
    prologue: rows.slice(0, start).map((row) => row.filter(Boolean).join(' ').trim()).filter(Boolean),
    body: rows.slice(start),
  };
}

function matrixToStatementText(rows: string[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.map((cell) => cell.trim()).filter((cell, index) => cell || index === 0);
    const text = cells.filter(Boolean).join(' ');
    if (!text) continue;
    if (cells.filter(Boolean).length === 1 && !isNumeric(text) && !findDate(text)) {
      lines.push(`# ${text.replace(/:$/, '')}`);
      continue;
    }
    lines.push(cells.filter(Boolean).join('\t'));
  }
  return lines.join('\n');
}

function classifyStatement(text: string, prologue: string[]): ImportKind {
  const blob = `${prologue.join('\n')}\n${text}`;
  const nav = countPattern(blob, NAV_CUES);
  const financial = countPattern(blob, FINANCIAL_CUES);
  if (financial > nav) return 'FINANCIAL_STATEMENT';
  if (nav > 0) return 'NAV_STATEMENT';
  return 'FINANCIAL_STATEMENT';
}

function countPattern(text: string, pattern: RegExp): number {
  return (text.match(new RegExp(pattern.source, 'gi')) || []).length;
}

function tableFromGrid(rows: string[][], headerIndex: number): { headers: string[]; rows: Record<string, string>[] } {
  const headers = rows[headerIndex].map((cell) => cell.trim()).filter(Boolean);
  const body = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => cell.trim()));
  return {
    headers,
    rows: body.map((row) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = (row[index] ?? '').trim();
      });
      return record;
    }),
  };
}

function findHeaderIndex(rows: string[][]): number | null {
  let bestIndex = -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, 15);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    const filled = row.filter(Boolean);
    if (filled.length < 2) continue;
    if (filled.filter(isNumeric).length / filled.length > 0.34) continue;
    let score = filled.length;
    const joined = filled.join(' ');
    if (SLOT_RULES.some((rule) => rule.test(joined.toLowerCase()))) score += 3;
    const next = rows[index + 1];
    if (next && next.filter(isNumeric).length >= 1) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex >= 0 ? bestIndex : null;
}

function isCanonicalPositionFile(headers: string[]): boolean {
  const names = new Set(headers);
  if (!names.has('Poition') && !names.has('Domai')) return false;
  return headers.filter((header) => CANONICAL_HEADERS.has(header)).length >= 3;
}

function finishTabular(
  fileName: string,
  format: ImportFormat,
  kind: ImportKind,
  mapCode: string,
  headers: string[],
  rows: Record<string, string>[],
  targets: ImportTarget[],
  confidence: number,
  reason: string,
  preserveSource: boolean,
  sheetName?: string,
): InterpretedImport {
  return {
    format,
    kind,
    mapCode,
    confidence,
    reason: sheetName && sheetName !== 'Sheet1' ? `${reason} Sheet “${sheetName}”.` : reason,
    headers,
    rows,
    targets,
    domains: [...new Set(targets.map((target) => target.domainCode).filter((domain): domain is string => Boolean(domain)))],
    entityName: null,
    asOfDate: asOfFromTargets(headers, rows, targets),
    preserveSource,
  };
}

function emptyImport(fileName: string, format: ImportFormat, reason: string): InterpretedImport {
  return {
    format,
    kind: 'TABULAR',
    mapCode: 'DATA_TABLE',
    confidence: 0,
    reason,
    headers: [],
    rows: [],
    targets: [],
    domains: [],
    entityName: nameFromFile(fileName),
    asOfDate: null,
    preserveSource: false,
  };
}

function interpretJson(fileName: string, text: string): InterpretedImport | null {
  try {
    const parsed = JSON.parse(text);
    const statement = visionJsonToStatementText(parsed);
    if (statement.trim()) return statementFromText(fileName, statement, 'json', []);
    if (Array.isArray(parsed) && parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      const headers = [...new Set(parsed.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
      const grid = [
        headers,
        ...parsed.map((row) => headers.map((header) => stringify((row as Record<string, unknown>)[header]))),
      ];
      return interpretMatrices(fileName, [{ rows: grid }], 'json');
    }
  } catch {
    return null;
  }
  return null;
}

function synonymCatalog(): CatalogAttribute[] {
  return SYNONYM_GROUPS.map((group) => ({
    attributeCode: group.code,
    attributeName: group.name,
    dataType: group.dataType,
    aliases: group.phrases,
  }));
}

function target(
  column: string,
  role: ImportRole,
  domainCode: string | null,
  attributeCode: string | null,
  confidence: number,
  reason: string,
): ImportTarget {
  return {
    column,
    role,
    domainCode: role === 'as_of' || role === 'ignore' || role === 'filter' ? null : domainCode,
    attributeCode: role === 'attribute' ? attributeCode : null,
    parentDomainCode: null,
    confidence,
    reason,
  };
}

function asOfFromTargets(headers: string[], rows: Record<string, string>[], targets: ImportTarget[]): string | null {
  const column = targets.find((item) => item.role === 'as_of')?.column;
  if (!column) return null;
  const dates = new Set(rows.map((row) => findDate(row[column] || '')).filter((date): date is string => Boolean(date)));
  return dates.size === 1 ? [...dates][0] : null;
}

function dateFromLines(lines: Array<{ attributeCode: string; sampleValue: string | null; dataType: string }>): string | null {
  const dated = lines.find((line) => line.attributeCode === 'NAV_DATE' || line.dataType === 'DATE');
  return dated?.sampleValue ? findDate(dated.sampleValue) : null;
}

function currencyFrom(text: string): string | null {
  const labeled = text.match(/\b(?:currency|ccy)\b[:\s]+([A-Z]{3})\b/i);
  if (labeled) return labeled[1].toUpperCase();
  const bare = text.match(/\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|HKD|SGD)\b/);
  return bare ? bare[1] : null;
}

function entityNameFrom(lines: string[]): string | null {
  for (const line of lines) {
    const text = line.replace(/^#+\s*/, '').trim();
    if (!text || TITLE_CUES.test(text) || isKnownSection(text) || findDate(text) === text || /^[A-Z]{3}$/.test(text)) continue;
    if (text.length > 80 || isNumeric(text)) continue;
    return text.replace(/:$/, '').trim();
  }
  return null;
}

function entityCodeFromName(value: string): string {
  const code = value.toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return code || 'IMPORTED';
}

function nameFromFile(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported statement';
}

function isKnownSection(value: string): boolean {
  return KNOWN_SECTIONS.has(normalizeLabel(value).replace(/:$/, ''));
}

function looksLikeCode(samples: string[]): boolean {
  const filled = samples.map((sample) => sample.trim()).filter(Boolean);
  if (filled.length === 0) return false;
  const codes = filled.filter((sample) => sample.length <= 24 && !/\s/.test(sample));
  return codes.length / filled.length >= 0.7;
}

function columnSamples(headers: string[], rows: Record<string, string>[]): Map<string, string[]> {
  const samples = new Map<string, string[]>();
  for (const header of headers) {
    const values: string[] = [];
    for (const row of rows) {
      const value = (row[header] || '').trim();
      if (!value || values.includes(value)) continue;
      values.push(value);
      if (values.length === 6) break;
    }
    samples.set(header, values);
  }
  return samples;
}

function compactRows(rows: string[][]): string[][] {
  return rows
    .map((row) => (row || []).map((cell) => String(cell ?? '').trim()))
    .filter((row) => row.some(Boolean));
}

function detectDelimiter(text: string): string | null {
  const sample = text.replace(/(\d),(?=\d)/g, '$1').split(/\r?\n/).filter((line) => line.trim()).slice(0, 25);
  if (sample.length === 0) return null;
  let best: { delimiter: string; score: number } | null = null;
  for (const delimiter of [',', ';', '\t', '|']) {
    const counts = sample.map((line) => splitLoose(line, delimiter).length).filter((count) => count > 1);
    if (counts.length < Math.ceil(sample.length * 0.5)) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    const consistent = counts.filter((count) => count === mode).length;
    const score = consistent * 10 + mode;
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best ? best.delimiter : null;
}

function splitLoose(line: string, delimiter: string): string[] {
  return parseGrid(`${line}\n`, delimiter)[0] || [];
}

function parseGrid(text: string, delimiter: string): string[][] {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      grid.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    grid.push(row);
  }
  return grid;
}

function htmlToMatrix(html: string): string[][] {
  const rows: string[][] = [];
  const tr = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of tr) {
    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    rows.push(cells.map((cell) => cell.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()));
  }
  return rows.filter((row) => row.some(Boolean));
}

function isNumeric(value: string): boolean {
  const text = value.trim().replace(/\s/g, '');
  if (!text) return false;
  return /^\(?-?[$€£]?\d[\d,]*(?:\.\d+)?\)?%?$/.test(text);
}

function isIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i.test(value.trim());
}

function isCusip(value: string): boolean {
  return /^[A-Z0-9]{9}$/i.test(value.trim()) && !isIsin(value);
}

function isLei(value: string): boolean {
  return /^[A-Z0-9]{20}$/i.test(value.trim());
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function expandYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function rank(value: InterpretedImport): number {
  return value.confidence * 10 + value.rows.length + value.targets.length + (value.kind === 'TABULAR' ? 0 : 5);
}
