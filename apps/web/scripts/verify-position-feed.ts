import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { executeFeed } from '../lib/feeds/feed-loader';
import { chooseRelationship, dependencyLoadOrder, relationshipEndpoints } from '../lib/feeds/load-order';
import { parseCsv } from '../lib/feeds/parse-table';
import { POSITION_FILE_MAP } from '../lib/feeds/position-file-map';

config({ path: resolve(__dirname, '../.env.local') });

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const order = dependencyLoadOrder(POSITION_FILE_MAP.domains);
assert(order.indexOf('ISSUER') < order.indexOf('SECURITY'), `issuer before security, got ${order.join(',')}`);
assert(order.indexOf('FUND') < order.indexOf('POSITION'), `fund before position, got ${order.join(',')}`);
assert(order.indexOf('SECURITY') < order.indexOf('POSITION'), `security before position, got ${order.join(',')}`);

const positionFund = chooseRelationship('POSITION', 'FUND', [
  { relationship_code: 'POSITION_FUND', parent_domain_code: 'POSITION', child_domain_code: 'FUND', is_required: false },
]);
assert(positionFund?.relationship_code === 'POSITION_FUND', 'position uses POSITION_FUND');
const endpoints = relationshipEndpoints(positionFund!, 'POSITION', 'position-id', 'FUND', 'fund-id');
assert(endpoints.parentEntityId === 'position-id' && endpoints.childEntityId === 'fund-id', 'catalog direction is preserved');

const issuerSecurity = chooseRelationship('SECURITY', 'ISSUER', [
  { relationship_code: 'SECURITY_ISSUER', parent_domain_code: 'SECURITY', child_domain_code: 'ISSUER', is_required: true },
  { relationship_code: 'ISSUER_SECURITY', parent_domain_code: 'ISSUER', child_domain_code: 'SECURITY', is_required: false },
]);
assert(issuerSecurity?.relationship_code === 'ISSUER_SECURITY', 'issuer is the relationship parent');

async function main() {
const csvPath = process.argv[2];
const xlsxPath = process.argv[3];
if (!csvPath || !xlsxPath) {
  console.log('Order checks passed. Pass csv and xlsx paths to load them.');
  return;
}

const csv = readFileSync(csvPath);
const parsed = parseCsv(csv.toString('utf8'));
assert(parsed.rows.length === 20, `expected 20 csv rows, got ${parsed.rows.length}`);
assert(parsed.headers.includes('Poition'), 'position identity column is present');

const fileDate = '2026-09-30';
const first = await executeFeed(POSITION_FILE_MAP, 'Position_FIle.csv', csv, fileDate);
console.log(JSON.stringify({
  domains: first.domains.map((domain) => ({
    domainCode: domain.domainCode,
    created: domain.created,
    matched: domain.matched,
    failed: domain.failed,
  })),
  relationships: first.relationships,
  attributes: first.attributes,
  errors: first.errors.slice(0, 8),
  warnings: first.warnings.slice(0, 8),
}, null, 2));

for (const expected of [
  ['ISSUER', 12],
  ['FUND', 4],
  ['SECURITY', 20],
  ['POSITION', 20],
] as const) {
  const stats = first.domains.find((domain) => domain.domainCode === expected[0]);
  assert(stats?.created === expected[1] && stats.failed === 0, `${expected[0]} created ${stats?.created}, failed ${stats?.failed}`);
}
assert(first.relationships.created === 60 && first.relationships.failed === 0, `relationships ${JSON.stringify(first.relationships)}`);

const rating = first.normalizations.find((hit) => hit.attributeCode === 'CREDIT_RATING' && hit.input === 'A-');
assert(rating?.canonicalCode === 'A_MINUS', `A- normalized to ${rating?.canonicalCode}`);
const bond = first.normalizations.find((hit) => hit.attributeCode === 'INSTRUMENT_TYPE' && hit.input === 'CORPORATE_BOND');
assert(bond?.canonicalCode === 'BOND', `CORPORATE_BOND normalized to ${bond?.canonicalCode}`);
const preferred = first.normalizations.find((hit) => hit.attributeCode === 'INSTRUMENT_TYPE' && hit.input === 'PREFERRED_STOCK');
assert(preferred?.canonicalCode === 'PREFERRED_EQUITY', `PREFERRED_STOCK normalized to ${preferred?.canonicalCode}`);

const second = await executeFeed(POSITION_FILE_MAP, 'Position_FIle.csv', csv, fileDate);
const secondCreated = second.domains.reduce((sum, domain) => sum + domain.created, 0);
assert(secondCreated === 0, `second load created ${secondCreated} entities`);
assert(second.domains.every((domain) => domain.matched === domain.distinctEntities && domain.failed === 0), 'second load did not match every entity');
assert(second.relationships.created === 0 && second.relationships.matched === 60, `second relationships ${JSON.stringify(second.relationships)}`);
assert(second.attributes.created === 0, `second load created ${second.attributes.created} attribute rows`);

const xlsx = readFileSync(xlsxPath);
const today = new Date().toISOString().slice(0, 10);
const third = await executeFeed(POSITION_FILE_MAP, 'Position_FIle.xlsx', xlsx, today);
const thirdCreated = third.domains.reduce((sum, domain) => sum + domain.created, 0);
assert(thirdCreated === 0, `xlsx reload created ${thirdCreated} entities`);
assert(third.attributes.created > 0, 'a different as-of date should version attributes');
assert(third.errors.length === 0, third.errors.slice(0, 5).join('; '));

const fourth = await executeFeed(POSITION_FILE_MAP, 'Position_FIle.xlsx', xlsx, today);
assert(fourth.domains.every((domain) => domain.created === 0), 'same as-of xlsx reload created entities');
assert(fourth.attributes.created === 0, `same as-of xlsx created ${fourth.attributes.created} attributes`);
assert(fourth.relationships.created === 0, `same as-of xlsx created ${fourth.relationships.created} relationships`);

console.log('Position file load verified.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
