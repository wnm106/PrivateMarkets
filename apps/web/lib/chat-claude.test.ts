import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SKILLS } from '@tapestrai/mcp-server/src/lib/chat-skills';
import { claudeFor, toClaudeMessages } from './chat-claude';

describe('chat on Claude', () => {
  it('runs dashboard and narrative design on Opus 5.5 and every other skill on the default model', () => {
    const named = SKILLS.filter((skill) => skill.model).map((skill) => skill.id).sort();
    assert.deepEqual(named, ['design-dashboard', 'design-narrative']);
    for (const id of named) {
      const skill = SKILLS.find((item) => item.id === id)!;
      assert.equal(skill.model?.provider, 'claude');
      assert.equal(skill.model?.model, 'claude-opus-5-5');
    }
  });

  it('falls back to the default model when there is no Anthropic key', () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, cwd: process.cwd() };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.chdir('/');
    try {
      assert.equal(claudeFor(SKILLS.find((skill) => skill.id === 'design-dashboard')!.model), null);
      assert.equal(claudeFor(undefined), null);
    } finally {
      process.chdir(saved.cwd);
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });

  it('starts the thread with the user, drops empty turns, and adds this turn\'s files to the last user message', () => {
    const messages = toClaudeMessages(
      [
        { role: 'model', content: 'Hello' },
        { role: 'user', content: 'Design a dashboard' },
        { role: 'model', content: '' },
        { role: 'model', content: 'Who uses it?' },
        { role: 'user', content: 'Portfolio managers' },
      ],
      [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }, { text: 'Attached file "a.csv"' }, { inlineData: { mimeType: 'application/pdf', data: 'x' } }],
    );
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user']);
    const last = messages[2].content as any[];
    assert.deepEqual(last.map((part) => part.type), ['text', 'image', 'text']);
  });
});
