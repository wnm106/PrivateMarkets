import { describe, expect, it } from 'vitest';
import {
  evaluateOperator,
  matchPopulationEntity,
  targetsAlongPath,
  type PopulationCondition,
  type RelationshipHopRef,
} from './compliance-population';

describe('targetsAlongPath', () => {
  it('follows the opposite direction when the declared direction has no links', () => {
    const hopMaps = new Map<string, Map<string, string[]>>([
      ['UP:SECURITY_ISSUER', new Map([['sec1', ['iss1']]])],
    ]);
    expect(
      targetsAlongPath('sec1', [{ relationshipCode: 'SECURITY_ISSUER', direction: 'DOWN' }], hopMaps),
    ).toEqual(['iss1']);
  });
});

const securityHop: RelationshipHopRef = { relationshipCode: 'POSITION_SECURITY', direction: 'UP' };
const issuerHop: RelationshipHopRef = { relationshipCode: 'SECURITY_ISSUER', direction: 'UP' };
const cashflowHop: RelationshipHopRef = { relationshipCode: 'POSITION_CASHFLOW', direction: 'DOWN' };

function maps(entries: Record<string, Record<string, string[]>>) {
  const hopMaps = new Map<string, Map<string, string[]>>();
  for (const [key, rel] of Object.entries(entries)) {
    hopMaps.set(key, new Map(Object.entries(rel)));
  }
  return hopMaps;
}

describe('evaluateOperator', () => {
  it('treats null as a failed equality and a successful is_null', () => {
    expect(evaluateOperator(null, 'equals', 'Banks')).toBe(false);
    expect(evaluateOperator(null, 'is_null', null)).toBe(true);
    expect(evaluateOperator('Banks', 'in', 'Banks, Insurers')).toBe(true);
    expect(evaluateOperator('A+', 'in', '["A+","BBB"]')).toBe(true);
    expect(evaluateOperator('10', 'gt', '2')).toBe(true);
  });
});

describe('matchPopulationEntity', () => {
  const hopMaps = maps({
    'UP:POSITION_SECURITY': { pos1: ['sec1'], pos2: ['sec2'] },
    'UP:SECURITY_ISSUER': { sec1: ['iss1'], sec2: ['iss2'] },
    'DOWN:POSITION_CASHFLOW': { pos1: ['cf1', 'cf2'], pos2: [] },
  });
  const attrs: Record<string, Record<string, { value: string }>> = {
    pos1: { MARKET_VALUE: { value: '100' } },
    pos2: { MARKET_VALUE: { value: '5' } },
    sec1: { INDUSTRY: { value: 'Banks' } },
    sec2: { INDUSTRY: { value: 'Energy' } },
    iss1: { CREDIT_RATING: { value: 'A+' } },
    iss2: { CREDIT_RATING: { value: 'B' } },
    cf1: { AMOUNT: { value: '0' } },
    cf2: { AMOUNT: { value: '25' } },
  };
  const read = (id: string, code: string) => attrs[id]?.[code]?.value ?? null;
  const resolve = (id: string, path: RelationshipHopRef[]) => targetsAlongPath(id, path, hopMaps);

  it('matches a position by its security and issuer attributes', () => {
    const conditions: PopulationCondition[] = [
      { attributeCode: 'INDUSTRY', operator: 'equals', value: 'Banks', attributePath: [securityHop] },
      {
        attributeCode: 'CREDIT_RATING',
        operator: 'equals',
        value: 'A+',
        attributePath: [securityHop, issuerHop],
        logicOperator: 'AND',
      },
    ];
    expect(matchPopulationEntity('pos1', conditions, resolve, read).match).toBe(true);
    expect(matchPopulationEntity('pos2', conditions, resolve, read).match).toBe(false);
  });

  it('matches when any related cash flow satisfies the condition', () => {
    const conditions: PopulationCondition[] = [
      { attributeCode: 'AMOUNT', operator: 'gt', value: '10', attributePath: [cashflowHop] },
    ];
    const hit = matchPopulationEntity('pos1', conditions, resolve, read);
    expect(hit.match).toBe(true);
    expect(hit.values['DOWN:POSITION_CASHFLOW\u001fAMOUNT']).toBe('25');
    expect(matchPopulationEntity('pos2', conditions, resolve, read).match).toBe(false);
  });

  it('treats a missing related entity as null', () => {
    const conditions: PopulationCondition[] = [
      { attributeCode: 'AMOUNT', operator: 'is_null', attributePath: [cashflowHop] },
    ];
    expect(matchPopulationEntity('pos2', conditions, resolve, read).match).toBe(true);
    expect(matchPopulationEntity('pos1', conditions, resolve, read).match).toBe(false);
  });

  it('ORs condition groups and keeps an empty filter as match-all', () => {
    const conditions: PopulationCondition[] = [
      { conditionGroup: 1, attributeCode: 'INDUSTRY', operator: 'equals', value: 'Energy', attributePath: [securityHop] },
      { conditionGroup: 2, attributeCode: 'MARKET_VALUE', operator: 'gt', value: '50' },
    ];
    expect(matchPopulationEntity('pos1', conditions, resolve, read).match).toBe(true);
    expect(matchPopulationEntity('pos2', conditions, resolve, read).match).toBe(true);
    expect(matchPopulationEntity('pos1', [], resolve, read).match).toBe(true);
  });
});
