import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectCalcRefs,
  compileCalcExpression,
  decompileCalcExpression,
  enclosingCall,
  enclosingPerformanceCall,
  exprPullsLatest,
  relatedFieldText,
  tokenizeCalcDraft,
} from './calc-expression';

describe('latest pull-through', () => {
  it('compiles a latest read and a match on the LTM label', () => {
    const expr = compileCalcExpression('LATEST(PERIOD_EBITDA, PERIOD_LABEL, "LTM")') as {
      fn: string;
      args: Array<Record<string, unknown>>;
    };
    assert.equal(expr.fn, 'LATEST');
    assert.deepEqual(expr.args[0], { ref: 'PERIOD_EBITDA' });
    assert.deepEqual(expr.args[1], { ref: 'PERIOD_LABEL' });
    assert.deepEqual(expr.args[2], { const: 'LTM' });
    assert.deepEqual(collectCalcRefs(expr), ['PERIOD_EBITDA', 'PERIOD_LABEL']);
    assert.equal(decompileCalcExpression(expr), 'LATEST(PERIOD_EBITDA, PERIOD_LABEL, "LTM")');
  });

  it('compiles funded debt as the latest leverage times the latest EBITDA', () => {
    const source = 'LATEST(PERIOD_FUNDED_DEBT_TO_EBITDA, PERIOD_LABEL, "LTM") * LATEST(PERIOD_EBITDA, PERIOD_LABEL, "LTM")';
    const expr = compileCalcExpression(source);
    assert.equal(decompileCalcExpression(expr), source);
    assert.equal(exprPullsLatest(expr, 'PERIOD_EBITDA'), true);
    assert.equal(exprPullsLatest(expr, 'STATEMENT_CASH'), false);
  });

  it('wraps a related field and leaves a field typed inside LATEST alone', () => {
    assert.equal(relatedFieldText('STATEMENT_CASH'), 'LATEST(STATEMENT_CASH)');
    const tokens = tokenizeCalcDraft('LATEST(');
    assert.equal(enclosingCall(tokens, tokens.length, 'LATEST'), true);
    assert.equal(enclosingCall(tokenizeCalcDraft('PERIOD_EBITDA'), 1, 'LATEST'), false);
  });

  it('shows a statement formula as a calculation the editor can save', () => {
    const gross = { op: 'sub', args: [{ ref: 'STATEMENT_REVENUE' }, { ref: 'STATEMENT_COGS' }] };
    assert.equal(decompileCalcExpression(gross), 'STATEMENT_REVENUE - STATEMENT_COGS');
    assert.deepEqual(compileCalcExpression('STATEMENT_REVENUE - STATEMENT_COGS'), gross);

    const prior = { op: 'prior', args: [{ ref: 'STATEMENT_CASH' }] };
    assert.equal(decompileCalcExpression(prior), 'PRIOR(STATEMENT_CASH)');
    assert.deepEqual(compileCalcExpression('PRIOR(STATEMENT_CASH)'), { fn: 'PRIOR', args: [{ ref: 'STATEMENT_CASH' }] });

    const trail = { op: 'trail', periods: 4, args: [{ ref: 'STATEMENT_REVENUE' }] };
    assert.equal(decompileCalcExpression(trail), 'TRAIL(STATEMENT_REVENUE, 4)');
    assert.deepEqual(compileCalcExpression('TRAIL(STATEMENT_REVENUE, 4)'), {
      fn: 'TRAIL',
      args: [{ ref: 'STATEMENT_REVENUE' }, { const: 4 }],
    });

    const change = { op: 'sub', args: [{ op: 'prior', args: [{ ref: 'STATEMENT_AR' }] }, { ref: 'STATEMENT_AR' }] };
    assert.equal(decompileCalcExpression(change), 'PRIOR(STATEMENT_AR) - STATEMENT_AR');
    assert.deepEqual(collectCalcRefs(compileCalcExpression('PRIOR(STATEMENT_AR) - STATEMENT_AR')), ['STATEMENT_AR']);

    const capex = {
      op: 'neg',
      args: [{
        op: 'add',
        args: [
          { op: 'sub', args: [{ ref: 'STATEMENT_PPE' }, { op: 'prior', args: [{ ref: 'STATEMENT_PPE' }] }] },
          { ref: 'STATEMENT_DA' },
        ],
      }],
    };
    const capexText = '-((STATEMENT_PPE - PRIOR(STATEMENT_PPE)) + STATEMENT_DA)';
    assert.equal(decompileCalcExpression(capex), capexText);
    assert.equal(decompileCalcExpression(compileCalcExpression(capexText)), capexText);
  });

  it('shows an inception return as the fields it reads', () => {
    const source = 'XIRR(FLOWS(CASHFLOW_INVESTOR_AMOUNT, CASHFLOW_DATE), CLOSE(MARKET_VALUE))';
    assert.equal(decompileCalcExpression(compileCalcExpression(source)), source);
    assert.equal(
      decompileCalcExpression(compileCalcExpression(source.replace('XIRR', 'MOIC'))),
      source.replace('XIRR', 'MOIC'),
    );
  });

  it('compiles a performance formula that names each field and the quarter offset', () => {
    const source = 'XIRR(OPEN(MARKET_VALUE, QTD), FLOWS(CASHFLOW_INVESTOR_AMOUNT, CASHFLOW_DATE), FLOWS(FEE_AMOUNT, FEE_DATE), CLOSE(FUND_NAV))';
    const expr = compileCalcExpression(source);
    assert.equal(decompileCalcExpression(expr), source);
    assert.deepEqual(collectCalcRefs(expr), ['MARKET_VALUE', 'CASHFLOW_INVESTOR_AMOUNT', 'CASHFLOW_DATE', 'FEE_AMOUNT', 'FEE_DATE', 'FUND_NAV']);
    const tokens = tokenizeCalcDraft('XIRR(OPEN(');
    assert.equal(enclosingPerformanceCall(tokens, tokens.length), true);
    assert.equal(enclosingPerformanceCall(tokenizeCalcDraft('MARKET_VALUE'), 1), false);
  });

  it('keeps a quoted match as its own chip', () => {
    const tokens = tokenizeCalcDraft('LATEST(PERIOD_EBITDA, PERIOD_LABEL, "LTM")');
    assert.equal(tokens.find((token) => token.kind === 'string')?.text, '"LTM"');
  });
});
