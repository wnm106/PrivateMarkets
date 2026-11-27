import { describe, expect, it } from 'vitest';
import {
  artifactBlock,
  completeAssistantTurn,
  emptySkillState,
  ingestUserTurn,
  skillAllowsTool,
  skillById,
  skillFromUserText,
  skillPhase,
  skillSystemAddendum,
  type SkillState,
} from './chat-skills';

const dashboard = skillById('design-dashboard')!;
const entity = skillById('create-entity')!;

function readyDashboard(): SkillState {
  const state = emptySkillState(dashboard);
  for (const slot of dashboard.slots) {
    if (slot.id === 'specAccepted') continue;
    state.slots[slot.id] = { status: slot.identity ? 'confirmed' : 'resolved', value: slot.label };
  }
  state.discoveries = ['get_template_metadata', 'get_relationship_types', 'find_sample_entities'];
  return state;
}

describe('chat skills', () => {
  it('starts a skill from a create request and ignores a casual mention', () => {
    expect(skillFromUserText('Please design a dashboard for covenant breaches')?.id).toBe('design-dashboard');
    expect(skillFromUserText('Build a narrative on this fund')?.id).toBe('design-narrative');
    expect(skillFromUserText('Add an entity type for capital calls')?.id).toBe('create-entity');
    expect(skillFromUserText('What does the dashboard show?')).toBeNull();
  });

  it('stops on two matches and confirms the one the user names', () => {
    const state = emptySkillState(dashboard);
    const asked = completeAssistantTurn(
      dashboard,
      state,
      'You asked for rating.\n```skill\n{"updates":[{"id":"measures","status":"ambiguous","candidates":[{"id":"ISSUER_RATING","label":"Issuer rating","why":"text on the issuer"},{"id":"SECURITY_RATING","label":"Security rating","why":"text on the security"}]}]}\n```',
      [],
      'group the dashboard by rating'
    );
    expect(asked.state.slots.measures.status).toBe('ambiguous');
    expect(asked.view.open?.id).toBe('anchor');

    const picked = ingestUserTurn(dashboard, asked.state, 'Use issuer rating');
    expect(picked.slots.measures).toMatchObject({ status: 'confirmed', value: 'ISSUER_RATING' });
  });

  it('does not treat a single tool match as confirmation of an identity slot', () => {
    const state = emptySkillState(entity);
    const turn = completeAssistantTurn(
      entity,
      state,
      '```skill\n{"updates":[{"id":"domain","status":"confirmed","value":"FUND"}]}\n```',
      [],
      'let us add a type'
    );
    expect(turn.state.slots.domain.status).toBe('resolved');
    expect(skillAllowsTool(entity, turn.state, 'create_domain_type')).toBe(false);
  });

  it('accepts the spec only after the required answers and discovery are done', () => {
    const partial = readyDashboard();
    partial.slots.measures = { status: 'empty' };
    const early = ingestUserTurn(dashboard, partial, 'yes');
    expect(early.slots.specAccepted.status).not.toBe('confirmed');

    const discovered = readyDashboard();
    const accepted = ingestUserTurn(dashboard, discovered, 'yes');
    expect(skillPhase(dashboard, accepted)).toBe('build');
    expect(skillAllowsTool(dashboard, accepted, 'preview_data_queries')).toBe(true);

    const built = completeAssistantTurn(
      dashboard,
      accepted,
      '```json\n{"dashboardName":"Breaches","htmlTemplate":"<div></div>","dataQueries":[]}\n```',
      [],
      'yes'
    );
    expect(built.text).not.toContain('dashboardName');
    expect(built.view.phase).toBe('build');

    const applied = completeAssistantTurn(
      dashboard,
      accepted,
      'Here is the draft.\n```json\n{"dashboardName":"Breaches","htmlTemplate":"<div></div>","dataQueries":[]}\n```\n```skill\n{"updates":[]}\n```',
      ['preview_data_queries'],
      'yes'
    );
    expect(applied.view.phase).toBe('apply');
    expect(applied.text).toContain('dashboardName');
    expect(applied.text).not.toContain('```skill');
  });

  it('clears later answers when an earlier one changes', () => {
    const state = readyDashboard();
    state.slots.specAccepted = { status: 'confirmed', value: 'yes' };
    const changed = completeAssistantTurn(
      dashboard,
      state,
      '```skill\n{"updates":[{"id":"anchor","status":"confirmed","value":"POSITION"}]}\n```',
      state.discoveries,
      'actually the anchor is positions'
    );
    expect(changed.state.slots.anchor.value).toBe('POSITION');
    expect(changed.state.slots.measures.status).toBe('stated');
    expect(changed.state.slots.specAccepted.status).not.toBe('confirmed');
    expect(skillAllowsTool(entity, changed.state, 'create_attribute')).toBe(false);
  });

  it('asks the open question when the reply never does', () => {
    const turn = completeAssistantTurn(dashboard, emptySkillState(dashboard), 'Understood.', [], 'design a dashboard');
    expect(turn.text).toContain('Which entity type');
    expect(turn.view.open?.id).toBe('anchor');
    expect(turn.view.decidedCount).toBe(0);
  });

  it('withholds entity writes until the user confirms a finished spec', () => {
    const state = emptySkillState(entity);
    for (const slot of entity.slots) {
      if (slot.id === 'specAccepted') continue;
      state.slots[slot.id] = { status: 'confirmed', value: slot.label };
    }
    state.discoveries = ['list_domain_types', 'search_attributes', 'get_relationship_types', 'get_template_metadata'];
    expect(skillPhase(entity, state)).toBe('spec');
    expect(skillAllowsTool(entity, state, 'create_attribute')).toBe(false);
    const accepted = ingestUserTurn(entity, state, 'create it');
    expect(skillPhase(entity, accepted)).toBe('apply');
    expect(skillAllowsTool(entity, accepted, 'create_attribute')).toBe(true);
    expect(skillAllowsTool(entity, accepted, 'create_entity')).toBe(false);
  });

  it('keeps reference artifacts out of the interview and injects them when producing output', () => {
    const early = skillSystemAddendum(dashboard, emptySkillState(dashboard));
    expect(early).toContain('Held until output: Dashboard shell');
    expect(early).not.toContain('class="primary"');

    const ready = readyDashboard();
    ready.slots.specAccepted = { status: 'confirmed', value: 'yes' };
    ready.discoveries.push('preview_data_queries');
    expect(skillPhase(dashboard, ready)).toBe('apply');
    const producing = skillSystemAddendum(dashboard, ready);
    expect(producing).toContain('class="primary"');
    expect(artifactBlock(dashboard, 'apply')).toContain('Match this shell');

    const spec = emptySkillState(entity);
    for (const slot of entity.slots) {
      if (slot.id === 'specAccepted') continue;
      spec.slots[slot.id] = { status: 'confirmed', value: slot.label };
    }
    spec.discoveries = ['list_domain_types', 'search_attributes', 'get_relationship_types', 'get_template_metadata'];
    expect(skillSystemAddendum(entity, spec)).toContain('CAPITAL_CALL');
  });
});

describe('guided skills for configuration and operations', () => {
  const ids = ['add-field', 'create-compliance-rule', 'change-compliance-rule', 'start-workflow', 'create-relationship-type', 'create-dq-rule', 'manual-override'] as const;

  function readyState(id: (typeof ids)[number]): SkillState {
    const skill = skillById(id)!;
    const state = emptySkillState(skill);
    for (const slot of skill.slots) {
      if (slot.id === 'specAccepted') continue;
      state.slots[slot.id] = { status: slot.identity ? 'confirmed' : 'resolved', value: slot.label };
    }
    state.discoveries = [...new Set(skill.discovery.map((group) => group[0]))];
    return state;
  }

  it('starts the right skill from a plain request', () => {
    expect(skillFromUserText('Add a field for maturity date to the deal type')?.id).toBe('add-field');
    expect(skillFromUserText('I need to add a new attribute for rating')?.id).toBe('add-field');
    expect(skillFromUserText('Create a compliance rule for issuer concentration')?.id).toBe('create-compliance-rule');
    expect(skillFromUserText('Add a concentration limit of 5% per issuer')?.id).toBe('create-compliance-rule');
    expect(skillFromUserText('Tighten the issuer concentration limit to 4%')?.id).toBe('change-compliance-rule');
    expect(skillFromUserText('Stop the leverage compliance rule for Fund II')?.id).toBe('change-compliance-rule');
    expect(skillFromUserText('Start the quarterly close workflow for Fund I')?.id).toBe('start-workflow');
    expect(skillFromUserText('Create a relationship type between fund and position')?.id).toBe('create-relationship-type');
    expect(skillFromUserText('Create a data quality rule for negative prices')?.id).toBe('create-dq-rule');
    expect(skillFromUserText('Override the NAV on this fund')?.id).toBe('manual-override');
    expect(skillFromUserText('Submit an override for the reporting date')?.id).toBe('manual-override');
    expect(skillFromUserText('Add an entity type for capital calls')?.id).toBe('create-entity');
  });

  it('does not start a skill from a question or a casual mention', () => {
    expect(skillFromUserText('What overrides exist on this fund?')).toBeNull();
    expect(skillFromUserText('How many workflows ran last week?')).toBeNull();
    expect(skillFromUserText('Which compliance rules are breached?')).toBeNull();
    expect(skillFromUserText('Show me the data quality rules')).toBeNull();
    expect(skillFromUserText('Which concentration limit was updated last week?')).toBeNull();
  });

  it('holds every write tool until the user accepts the spec, for each skill', () => {
    for (const id of ids) {
      const skill = skillById(id)!;
      expect(skill.writeTools.length).toBeGreaterThan(0);
      const early = emptySkillState(skill);
      for (const tool of skill.writeTools) expect(skillAllowsTool(skill, early, tool)).toBe(false);

      const state = readyState(id);
      if (skill.previewTools.length) state.discoveries.push(...skill.previewTools);
      expect(skillPhase(skill, state)).toBe('spec');
      for (const tool of skill.writeTools) expect(skillAllowsTool(skill, state, tool)).toBe(false);

      const accepted = ingestUserTurn(skill, state, 'yes, go ahead');
      expect(skillPhase(skill, accepted)).toBe('apply');
      for (const tool of skill.writeTools) expect(skillAllowsTool(skill, accepted, tool)).toBe(true);
      for (const tool of skill.denyTools) expect(skillAllowsTool(skill, accepted, tool)).toBe(false);
    }
  });

  it('will not ask for confirmation before the lookups have run', () => {
    for (const id of ids) {
      const skill = skillById(id)!;
      const state = readyState(id);
      state.discoveries = [];
      expect(skillPhase(skill, state)).toBe('guided');
      expect(skillSystemAddendum(skill, state)).toContain('Do not ask the user to confirm');
    }
  });

  it('requires the rule to be tried on real records before a data quality rule is created', () => {
    const skill = skillById('create-dq-rule')!;
    const state = readyState('create-dq-rule');
    state.slots.specAccepted = { status: 'confirmed', value: 'yes' };
    expect(skillPhase(skill, state)).toBe('build');
    expect(skillAllowsTool(skill, state, 'create_dq_rule')).toBe(false);
    state.discoveries.push('preview_dq_rule');
    expect(skillPhase(skill, state)).toBe('apply');
    expect(skillAllowsTool(skill, state, 'create_dq_rule')).toBe(true);
  });

  it('keeps each skill to the tools it needs', () => {
    expect(skillById('start-workflow')!.toolContext).toBe('workflow');
    expect(skillById('create-compliance-rule')!.denyTools).toContain('delete_compliance_rule');
    expect(skillById('change-compliance-rule')!.denyTools).toContain('delete_compliance_rule');
    expect(skillById('change-compliance-rule')!.writeTools).toContain('create_compliance_rule_version');
    expect(skillById('create-relationship-type')!.denyTools).toContain('create_relationship');
    expect(skillById('add-field')!.denyTools).toContain('create_domain_type');
  });
});
