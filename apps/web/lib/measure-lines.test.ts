import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignPathToPicker, columnsFromMeasureLines, domainAfterPath, sameAttributeRoute, stripCompositeMetadata } from './measure-lines';

describe('measure lines', () => {
  it('drops the hidden composite keys and keeps the rest', () => {
    const next = stripCompositeMetadata({
      logic: 'composite_ratio',
      numerator_terms: [{ label: 'CCC' }],
      denominator_terms: [],
      limit_term: { attribute: 'CLO_MAX_CCC_PCT' },
      scenario_mode: 'strict',
      pre_trade: true,
      limitMode: 'UNIFORM',
    });
    assert.deepEqual(next, { scenario_mode: 'strict', pre_trade: true, limitMode: 'UNIFORM' });
  });

  it('keeps a legal aggregation and stores a weighted average as a sum on the version row', () => {
    const columns = columnsFromMeasureLines([
      { side: 'NUMERATOR', kind: 'WAVG', attributeCode: 'CLO_RATING_FACTOR' },
      { side: 'DENOMINATOR', kind: 'SUM', attributeCode: 'FUNDED_PAR_AMOUNT' },
      { side: 'LIMIT', kind: 'MAX', attributeCode: 'CLO_MAX_CCC_PCT' },
    ]);
    assert.equal(columns.numeratorAttributeCode, 'CLO_RATING_FACTOR');
    assert.equal(columns.numeratorAggregation, 'SUM');
    assert.equal(columns.denominatorAttributeCode, 'FUNDED_PAR_AMOUNT');
    assert.equal(columns.hasDenominator, true);
    assert.equal(columns.hasLimit, true);
  });

  it('walks a fund down to its positions and then to the security', () => {
    const relationships = [
      { relationshipCode: 'POSITION_FUND', parentDomainCode: 'FUND', childDomainCode: 'POSITION' },
      { relationshipCode: 'POSITION_SECURITY', parentDomainCode: 'SECURITY', childDomainCode: 'POSITION' },
    ];
    assert.equal(
      domainAfterPath('FUND', [{ relationshipCode: 'POSITION_FUND', direction: 'UP' }], relationships),
      'POSITION',
    );
    assert.equal(
      domainAfterPath(
        'FUND',
        [
          { relationshipCode: 'POSITION_FUND', direction: 'UP' },
          { relationshipCode: 'POSITION_SECURITY', direction: 'DOWN' },
        ],
        relationships,
      ),
      'SECURITY',
    );
    const stored = [{ relationshipCode: 'POSITION_FUND', direction: 'UP' }];
    const picked = [{ relationshipCode: 'POSITION_FUND', direction: 'DOWN' }];
    assert.equal(sameAttributeRoute(stored, picked), true);
    assert.deepEqual(
      alignPathToPicker('FUND', [{ relationshipCode: 'POSITION_FUND', direction: 'UP' }], relationships),
      [{ relationshipCode: 'POSITION_FUND', direction: 'DOWN' }],
    );
    assert.deepEqual(
      alignPathToPicker('POSITION', [{ relationshipCode: 'POSITION_SECURITY', direction: 'DOWN' }], relationships),
      [{ relationshipCode: 'POSITION_SECURITY', direction: 'UP' }],
    );
  });
});
