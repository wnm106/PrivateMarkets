import { tablesFromLayout, azureAnalyzeUrl } from '../lib/feeds/azure-extract';
import { dependencyLoadOrder } from '../lib/feeds/load-order';
import { parseFlexibleTable, parseJsonRecords } from '../lib/feeds/parse-table';
import { columnsUsedByMap, readSource, type SpecialistCatalog } from '../lib/feeds/specialist';
import { feedMapFromAssignments } from '../lib/feeds/suggest';
import { POSITION_FILE_MAP } from '../lib/feeds/position-file-map';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const catalog: SpecialistCatalog = {
  attributes: [
    { attributeCode: 'LEI', attributeName: 'LEI', dataType: 'STRING', domainCode: 'ISSUER', referenceListCode: null },
    { attributeCode: 'COUNTRY', attributeName: 'Country', dataType: 'STRING', domainCode: 'ISSUER', referenceListCode: 'COUNTRY' },
    { attributeCode: 'NAV', attributeName: 'NAV', dataType: 'NUMBER', domainCode: 'FUND', referenceListCode: null },
    { attributeCode: 'NAV_CURRENCY', attributeName: 'NAV Currency', dataType: 'STRING', domainCode: 'FUND', referenceListCode: null },
    { attributeCode: 'ISIN', attributeName: 'ISIN', dataType: 'STRING', domainCode: 'SECURITY', referenceListCode: null },
    { attributeCode: 'SHARE_QUANTITY', attributeName: 'Share Quantity', dataType: 'NUMBER', domainCode: 'POSITION', referenceListCode: null },
  ],
  domains: [
    { code: 'ISSUER', name: 'Issuer' },
    { code: 'FUND', name: 'Fund' },
    { code: 'SECURITY', name: 'Security' },
    { code: 'POSITION', name: 'Position' },
  ],
  sources: [
    { code: 'POSITION_FILE', name: 'Position File' },
    { code: 'BLOOMBERG', name: 'Bloomberg' },
  ],
  relationships: [
    { code: 'SECURITY_ISSUER', name: 'Security issued by', parentDomain: 'SECURITY', childDomain: 'ISSUER' },
    { code: 'POSITION_FUND', name: 'Position held in fund', parentDomain: 'POSITION', childDomain: 'FUND' },
    { code: 'POSITION_SECURITY', name: 'Position in security', parentDomain: 'POSITION', childDomain: 'SECURITY' },
  ],
  maps: [POSITION_FILE_MAP],
};

function row(headers: string[], values: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    record[header] = values[index] ?? '';
  });
  return record;
}

const positionHeaders = columnsUsedByMap(POSITION_FILE_MAP);
const positionReading = readSource({
  fileName: 'Position_File.csv',
  headers: [...positionHeaders, 'zzz'],
  rows: [row([...positionHeaders, 'zzz'], positionHeaders.map((header) => {
    if (header === 'valid from') return '9/30/2026';
    if (header === 'Domai') return 'POSITION';
    return `${header}-1`;
  }).concat('sleeve'))],
  catalog,
  answers: {},
  acceptedRecommendationIds: [],
  dismissedRecommendationIds: [],
});

assert(positionReading.map?.mapCode === 'POSITION_FILE', `expected the position file map, got ${positionReading.map?.mapCode}`);
assert(positionReading.sourceCode === 'POSITION_FILE', 'position file keeps its source');
assert(positionReading.asOfDate === '2026-09-30', `expected 2026-09-30, got ${positionReading.asOfDate}`);
assert(positionReading.blockedReasons.length === 0, positionReading.blockedReasons.join(' | '));
const positionOrder = dependencyLoadOrder(positionReading.map!.domains);
assert(positionOrder.indexOf('ISSUER') < positionOrder.indexOf('SECURITY'), positionOrder.join(','));
assert(positionOrder.indexOf('FUND') < positionOrder.indexOf('POSITION'), positionOrder.join(','));
assert(positionOrder.indexOf('SECURITY') < positionOrder.indexOf('POSITION'), positionOrder.join(','));
assert(
  !positionReading.assignments.some((assignment) => assignment.sourceColumn === 'zzz' && assignment.role === 'attribute'),
  'an unrecognized column is not forced onto an attribute'
);
assert(
  positionReading.recommendations.some((item) => item.payload.column === 'zzz') || positionReading.findings.some((finding) => finding.includes('zzz')),
  'an unrecognized column is surfaced'
);

const discovered = readSource({
  fileName: 'Position_File.csv',
  headers: positionHeaders,
  rows: positionReading.sampleRows.length ? [row(positionHeaders, positionHeaders.map(() => 'x'))] : [row(positionHeaders, positionHeaders.map(() => 'x'))],
  catalog,
  answers: { reuse_map: 'discover', as_of: 'date:2026-09-30' },
  acceptedRecommendationIds: [],
  dismissedRecommendationIds: [],
});
assert(discovered.map?.mapCode !== 'POSITION_FILE', 'discover does not reuse the position file map code');

const fundReading = readSource({
  fileName: 'funds.csv',
  headers: ['fund code', 'fund name', 'nav', 'nav currency', 'as of'],
  rows: [
    { 'fund code': 'F1', 'fund name': 'Alpha', nav: '1,000', 'nav currency': 'USD', 'as of': '1/15/2026' },
    { 'fund code': 'F2', 'fund name': 'Beta', nav: '2,000', 'nav currency': 'EUR', 'as of': '1/15/2026' },
  ],
  catalog,
  answers: {},
  acceptedRecommendationIds: [],
  dismissedRecommendationIds: [],
});
assert(fundReading.map?.domains.some((domain) => domain.domainCode === 'FUND'), 'fund file maps to FUND');
assert(fundReading.map?.domains.length === 1, `fund file should be one entity, got ${fundReading.map?.domains.map((domain) => domain.domainCode).join(',')}`);
assert(fundReading.map?.domains[0].identityColumn === 'fund code', 'fund code is the entity id');
assert(fundReading.map?.domains[0].attributes.some((attribute) => attribute.attributeCode === 'NAV'), 'nav maps to NAV');
assert(fundReading.asOfDate === '2026-01-15', `fund as-of ${fundReading.asOfDate}`);
assert(fundReading.sourceCode === 'FUNDS', `new source from the file name, got ${fundReading.sourceCode}`);
assert(fundReading.blockedReasons.length === 0, fundReading.blockedReasons.join(' | '));

const securityReading = readSource({
  fileName: 'securities.csv',
  headers: ['security code', 'security name', 'isin', 'issuer code'],
  rows: [{ 'security code': 'S1', 'security name': 'Bond', isin: 'US0000000001', 'issuer code': 'I1' }],
  catalog,
  answers: { as_of: 'date:2026-04-01' },
  acceptedRecommendationIds: [],
  dismissedRecommendationIds: [],
});
const securityOrder = dependencyLoadOrder(securityReading.map!.domains);
assert(securityOrder.indexOf('ISSUER') < securityOrder.indexOf('SECURITY'), `issuer before security, got ${securityOrder.join(',')}`);
assert(securityReading.blockedReasons.length === 0, securityReading.blockedReasons.join(' | '));

const custodian = readSource({
  fileName: 'custodians.csv',
  headers: ['custodian code', 'custodian name', 'custodian city'],
  rows: [{ 'custodian code': 'C1', 'custodian name': 'Northern', 'custodian city': 'Chicago' }],
  catalog,
  answers: { as_of: 'date:2026-01-31' },
  acceptedRecommendationIds: [],
  dismissedRecommendationIds: [],
});
const domainRec = custodian.recommendations.find((item) => item.kind === 'domain' && item.payload.domainCode === 'CUSTODIAN');
assert(domainRec, `expected a custodian entity recommendation, got ${custodian.recommendations.map((item) => item.title).join(' | ')} findings ${custodian.findings.join(' ')}`);
assert(!custodian.map?.domains.some((domain) => domain.domainCode === 'CUSTODIAN'), 'a new entity is not created before it is accepted');

const accepted = readSource({
  fileName: 'custodians.csv',
  headers: ['custodian code', 'custodian name', 'custodian city'],
  rows: [{ 'custodian code': 'C1', 'custodian name': 'Northern', 'custodian city': 'Chicago' }],
  catalog,
  answers: { as_of: 'date:2026-01-31' },
  acceptedRecommendationIds: [domainRec!.id],
  dismissedRecommendationIds: [],
});
assert(accepted.map?.domains.some((domain) => domain.domainCode === 'CUSTODIAN'), 'accepting the entity puts it on the map');
assert(accepted.map?.domains[0].attributes.some((attribute) => attribute.column === 'custodian city'), 'custodian city becomes an attribute');

const linked = readSource({
  fileName: 'custodians.csv',
  headers: ['custodian code', 'custodian name', 'fund code'],
  rows: [{ 'custodian code': 'C1', 'custodian name': 'Northern', 'fund code': 'F1' }],
  catalog,
  answers: { as_of: 'date:2026-01-31' },
  acceptedRecommendationIds: ['domain:CUSTODIAN'],
  dismissedRecommendationIds: [],
});
const custodianDomain = linked.map?.domains.find((domain) => domain.domainCode === 'CUSTODIAN');
assert(custodianDomain?.parents.some((parent) => parent.parentDomainCode === 'FUND'), 'a new entity points at the fund code on the same row');
assert(linked.recommendations.some((item) => item.kind === 'relationship'), 'a missing relationship is recommended');
assert(linked.blockedReasons.some((reason) => reason.toLowerCase().includes('fund')), linked.blockedReasons.join(' | '));

const json = parseJsonRecords(JSON.stringify({
  records: [
    { fund: { code: 'F1', name: 'Alpha' }, nav: 10 },
    { fund: { code: 'F2', name: 'Beta' }, nav: 12 },
  ],
}));
assert(json.headers.includes('fund.code') && json.headers.includes('nav'), json.headers.join(','));
assert(json.rows.length === 2, 'json records become rows');
assert(json.rows[0]['fund.code'] === 'F1', 'nested fields are flattened');

const flexible = parseFlexibleTable('fund code;fund name\nF1;Alpha\n');
assert(flexible.headers.length === 2, 'semicolon files are read as tables');

const layout = tablesFromLayout({
  analyzeResult: {
    tables: [{
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Fund', kind: 'columnHeader' },
        { rowIndex: 0, columnIndex: 1, content: 'NAV', kind: 'columnHeader' },
        { rowIndex: 1, columnIndex: 0, content: 'F1' },
        { rowIndex: 1, columnIndex: 1, content: '10' },
      ],
    }],
  },
});
assert(layout.length === 1 && layout[0].rows[0].Fund === 'F1' && layout[0].rows[0].NAV === '10', 'azure layout becomes a table');
assert(azureAnalyzeUrl('https://example.cognitiveservices.azure.com/').includes('prebuilt-layout:analyze'), 'azure analyze url');

const externalOrder = dependencyLoadOrder([{
  domainCode: 'POSITION',
  templateCode: 'POSITION_STANDARD',
  identityColumn: 'position code',
  nameColumn: 'position code',
  attributes: [],
  parents: [{ column: 'fund code', parentDomainCode: 'FUND', existing: true }],
}]);
assert(externalOrder.join(',') === 'POSITION', `existing parents are not a load edge, got ${externalOrder.join(',')}`);

const untouched = feedMapFromAssignments([]);
assert(untouched.mapCode === 'POSITION_FILE' && untouched.sourceCode === 'POSITION_FILE', 'the position file map stays the default');

console.log('source specialist checks passed');
