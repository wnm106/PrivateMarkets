import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SKILLS } from '@tapestrai/mcp-server/src/lib/chat-skills';
import { SKILL_NAV } from './skill-catalog';
import { publishedSkillDocument } from './skill-studio';

describe('skill studio', () => {
  it('lists every skill the chat can start', () => {
    assert.deepEqual(SKILL_NAV.map((item) => item.id).sort(), SKILLS.map((skill) => skill.id).sort());
  });

  it('describes each skill from its own definition, with its write tools held to the apply phase', () => {
    for (const skill of SKILLS) {
      const doc = publishedSkillDocument(skill.id);
      assert.equal(doc.slots.length, skill.slots.length, `${skill.id} slots`);
      for (const tool of skill.writeTools) {
        const listed = doc.tools.find((item) => item.name === tool);
        if (skill.id === 'create-entity' || skill.id.startsWith('design-')) continue;
        assert.ok(listed, `${skill.id} lists ${tool}`);
        assert.equal(doc.phases.find((phase) => phase.id === listed.phase)?.name, 'Apply');
      }
    }
  });
});
