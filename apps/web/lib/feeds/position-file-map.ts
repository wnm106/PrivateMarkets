import type { FeedMap } from './types';

/**
 * Column map for the Position File source. Headers are the file's own
 * names, including the source typos (Domai, Poition). Parent columns declare
 * which identity must exist before this domain is loaded.
 */
export const POSITION_FILE_MAP: FeedMap = {
  mapCode: 'POSITION_FILE',
  sourceCode: 'POSITION_FILE',
  name: 'Position File',
  description:
    'Flat position feed whose columns belong to Issuer, Fund, Security, and Position. Issuers load before securities. Funds and securities load before positions.',
  asOfHintColumn: 'valid from',
  rowFilter: { column: 'Domai', equals: 'POSITION' },
  domains: [
    {
      domainCode: 'ISSUER',
      templateCode: 'ISSUER_STANDARD',
      identityColumn: 'issuer code',
      nameColumn: 'issuer name',
      attributes: [
        { column: 'issuer lei', attributeCode: 'LEI' },
        { column: 'issuer country', attributeCode: 'COUNTRY' },
        { column: 'issuer sector', attributeCode: 'SECTOR' },
        { column: 'issuer industry', attributeCode: 'INDUSTRY' },
        { column: 'issuer market cap', attributeCode: 'MARKET_CAP' },
        { column: 'issuer credit rating', attributeCode: 'CREDIT_RATING' },
      ],
      parents: [],
    },
    {
      domainCode: 'FUND',
      templateCode: 'FUND_STANDARD',
      identityColumn: 'fund code',
      nameColumn: 'fund name',
      attributes: [
        { column: 'fund nav', attributeCode: 'NAV' },
        { column: 'fund nav currency', attributeCode: 'NAV_CURRENCY' },
        { column: 'fund nav date', attributeCode: 'NAV_DATE' },
        { column: 'fund inception date', attributeCode: 'INCEPTION_DATE' },
        { column: 'fund status', attributeCode: 'FUND_STATUS' },
        { column: 'fund type', attributeCode: 'FUND_TYPE' },
        { column: 'fund manager', attributeCode: 'MANAGER' },
        { column: 'fund aum', attributeCode: 'AUM' },
        { column: 'fund expense ratio', attributeCode: 'EXPENSE_RATIO' },
        { column: 'fund domicile', attributeCode: 'DOMICILE' },
      ],
      parents: [],
    },
    {
      domainCode: 'SECURITY',
      templateCode: 'SECURITY_STANDARD',
      identityColumn: 'security code',
      nameColumn: 'security name',
      attributes: [
        { column: 'security isin', attributeCode: 'ISIN' },
        { column: 'security cusip', attributeCode: 'CUSIP' },
        { column: 'security ticker', attributeCode: 'TICKER' },
        { column: 'security type', attributeCode: 'INSTRUMENT_TYPE' },
        { column: 'security currency', attributeCode: 'CURRENCY' },
        { column: 'security exchange', attributeCode: 'EXCHANGE' },
        { column: 'security price', attributeCode: 'PRICE' },
        { column: 'security price date', attributeCode: 'PRICE_DATE' },
      ],
      parents: [{ column: 'issuer code', parentDomainCode: 'ISSUER' }],
    },
    {
      domainCode: 'POSITION',
      templateCode: 'POSITION_STANDARD',
      identityColumn: 'Poition',
      nameColumn: 'Poition',
      attributes: [
        { column: 'Position Type', attributeCode: 'POSITION_TYPE' },
        { column: 'quantity', attributeCode: 'SHARE_QUANTITY' },
        { column: 'position currency', attributeCode: 'POSITION_CURRENCY' },
        { column: 'cost basis', attributeCode: 'CARRYING_AMORTIZED_COST_AMOUNT' },
        { column: 'market value', attributeCode: 'TOTAL_FAIR_MARKET_VALUE_AMOUNT' },
        { column: 'unrealized gain loss', attributeCode: 'UNREALIZED_GAIN_LOSS' },
        { column: 'daily return', attributeCode: 'DAILY_RETURN' },
        { column: 'ytd return', attributeCode: 'YTD_RETURN' },
        { column: 'metric date', attributeCode: 'METRIC_DATE' },
      ],
      parents: [
        { column: 'fund code', parentDomainCode: 'FUND' },
        { column: 'security code', parentDomainCode: 'SECURITY' },
      ],
    },
  ],
};
