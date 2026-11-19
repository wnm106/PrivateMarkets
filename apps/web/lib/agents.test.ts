import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentChoices, agentCodeFromName, agentDraftInput, agentDraftProblem, agentScopeLabel, draftFromAgent, emptyAgentDraft, type Agent } from './agents';

function agent(patch: Partial<Agent>): Agent {
  return {
    id: 'a-1',
    clientId: null,
    code: 'STEWARD',
    name: 'Steward',
    description: null,
    charter: '',
    activityCodes: [],
    activityNames: [],
    domainCodes: [],
    toolNames: [],
    isActive: true,
    isShared: true,
    canManage: false,
    updatedAt: null,
    ...patch,
  };
}

const isRead = (name: string) => name.startsWith('get_');

describe('agents', () => {
  it('makes a code from a name', () => {
    assert.equal(agentCodeFromName('Cash matcher'), 'CASH_MATCHER');
    assert.equal(agentCodeFromName('  3rd-party reader '), 'A_3RD_PARTY_READER');
    assert.equal(agentCodeFromName('!!'), '');
  });

  it('checks a draft and builds its input', () => {
    const draft = emptyAgentDraft('c-1');
    assert.match(agentDraftProblem(draft) || '', /name/);
    draft.name = ' Cash matcher ';
    assert.match(agentDraftProblem(draft) || '', /code/);
    draft.code = 'cash_matcher';
    assert.equal(agentDraftProblem(draft), null);
    assert.deepEqual(agentDraftInput(draft), {
      id: null,
      clientId: 'c-1',
      code: 'CASH_MATCHER',
      name: 'Cash matcher',
      description: null,
      charter: '',
      activityCodes: [],
      domainCodes: [],
      toolNames: [],
      isActive: true,
    });
  });

  it('copies a shared agent for a client under the same code', () => {
    const shared = agent({ toolNames: ['get_entity'] });
    assert.equal(draftFromAgent(shared).id, 'a-1');
    const copy = draftFromAgent(shared, 'c-1');
    assert.equal(copy.id, null);
    assert.equal(copy.clientId, 'c-1');
    assert.equal(copy.code, 'STEWARD');
    copy.toolNames.push('get_dq_summary');
    assert.deepEqual(shared.toolNames, ['get_entity']);
  });

  it('offers a client its own agent in place of the shared one', () => {
    const list = [
      agent({}),
      agent({ id: 'a-2', clientId: 'c-1', isShared: false, name: 'Our steward' }),
      agent({ id: 'a-3', clientId: 'c-2', isShared: false, name: 'Their steward' }),
      agent({ id: 'a-4', code: 'READER', name: 'Reader', isActive: false }),
      agent({ id: 'a-5', code: 'ANALYST', name: 'Analyst' }),
    ];
    assert.deepEqual(agentChoices(list, 'c-1').map((entry) => entry.id), ['a-5', 'a-2']);
    assert.deepEqual(agentChoices(list, null).map((entry) => entry.id), ['a-5', 'a-1']);
    assert.deepEqual(agentChoices(list, 'c-1', 'READER').map((entry) => entry.id), ['a-5', 'a-2', 'a-4']);
  });

  it('says what an agent is limited to', () => {
    assert.equal(agentScopeLabel(agent({}), isRead), 'any tool the step allows · any domain');
    assert.equal(agentScopeLabel(agent({ toolNames: ['get_entity'], domainCodes: ['FUND'] }), isRead), '1 read tool, proposes nothing · FUND');
    assert.equal(agentScopeLabel(agent({ toolNames: ['get_entity', 'get_x', 'create_entity'] }), isRead), '2 read tools, 1 kind of change · any domain');
  });
});
