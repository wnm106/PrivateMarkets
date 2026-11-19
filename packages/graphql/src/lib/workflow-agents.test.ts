import { describe, expect, it } from 'vitest';
import {
  agentCharter,
  agentCodeOf,
  agentProposable,
  agentReadTools,
  agentReviewActivity,
  outsideAgentDomains,
  toAgentDef,
  type AgentDef,
} from './workflow-agents';

const reconciler: AgentDef = {
  code: 'RECONCILER',
  name: 'Reconciler',
  description: 'Works breaks.',
  charter: 'Find the cause first.',
  activityCodes: ['RECONCILIATION'],
  domainCodes: ['FUND', 'POSITION'],
  toolNames: ['get_cash_reconciliation', 'get_entity', 'approve_cash_match'],
  isActive: true,
  shared: true,
};

const open: AgentDef = { ...reconciler, code: 'OPEN', domainCodes: [], toolNames: [] };
const WRITE = ['approve_cash_match', 'create_entity', 'submit_manual_override'];

describe('workflow agents', () => {
  it('reads an agent from its row', () => {
    expect(toAgentDef(null)).toBeNull();
    expect(toAgentDef({ agent_name: 'No code' })).toBeNull();
    expect(
      toAgentDef({ agent_code: 'STEWARD', agent_name: 'Steward', client_id: null, activity_codes: ['data_quality', ''], tool_names: ['get_entity'], is_active: false }),
    ).toEqual({
      code: 'STEWARD',
      name: 'Steward',
      description: '',
      charter: '',
      activityCodes: ['DATA_QUALITY'],
      domainCodes: [],
      toolNames: ['get_entity'],
      isActive: false,
      shared: true,
    });
  });

  it('reads the agent a step names', () => {
    expect(agentCodeOf({})).toBe('');
    expect(agentCodeOf({ agent: ' reconciler ' })).toBe('RECONCILER');
    expect(agentCodeOf({ agent: 7 })).toBe('');
  });

  it('narrows what a step reads with, and never widens it', () => {
    expect(agentReadTools(null, ['get_entity', 'create_entity'])).toEqual(['get_entity']);
    expect(agentReadTools(open, ['get_entity', 'list_entities'])).toEqual(['get_entity', 'list_entities']);
    expect(agentReadTools(reconciler, [])).toEqual(['get_cash_reconciliation', 'get_entity']);
    expect(agentReadTools(reconciler, ['get_entity', 'list_entities'])).toEqual(['get_entity']);
  });

  it('narrows what a step may propose', () => {
    expect(agentProposable(null, [], WRITE)).toEqual(WRITE);
    expect(agentProposable(null, ['create_entity'], WRITE)).toEqual(['create_entity']);
    expect(agentProposable(reconciler, [], WRITE)).toEqual(['approve_cash_match']);
    expect(agentProposable(reconciler, ['create_entity'], WRITE)).toEqual([]);
    expect(agentProposable({ ...reconciler, toolNames: ['get_entity'] }, [], WRITE)).toEqual([]);
  });

  it('writes the charter', () => {
    expect(agentCharter(null)).toBe('');
    const text = agentCharter(reconciler);
    expect(text).toContain('You are Reconciler. Works breaks.');
    expect(text).toContain('Find the cause first.');
    expect(text).toContain('FUND, POSITION');
    expect(agentCharter(open)).not.toContain('kinds of record only');
  });

  it('refuses a change outside the agent’s domains', () => {
    const item = (domainCode: string | undefined, args: Record<string, unknown> = {}) => ({ summary: 'Set sector', target: { domainCode }, args });
    expect(outsideAgentDomains(null, item('ISSUER'))).toBeNull();
    expect(outsideAgentDomains(open, item('ISSUER'))).toBeNull();
    expect(outsideAgentDomains(reconciler, item('fund'))).toBeNull();
    expect(outsideAgentDomains(reconciler, item(undefined))).toBeNull();
    expect(outsideAgentDomains(reconciler, item('ISSUER'))).toMatch(/ISSUER record/);
    expect(outsideAgentDomains(reconciler, item(undefined, { domainCode: 'ISSUER' }))).toMatch(/Reconciler works on FUND, POSITION only/);
  });

  it('routes a review by the agent’s activity only when it has one', () => {
    expect(agentReviewActivity(null)).toBeNull();
    expect(agentReviewActivity(reconciler)).toBe('RECONCILIATION');
    expect(agentReviewActivity({ activityCodes: ['DATA_QUALITY', 'DATA_STEWARDSHIP'] })).toBeNull();
  });
});
