import { afterEach, describe, expect, it } from 'vitest';
import {
  bindAgentContext,
  invokeAgent,
  runWithAgentContext,
  setAgentAuditSink,
  takeAgentAudits,
  usageForClient,
  type AuditRow,
} from './harness';
import { formatTokens, formatUsd, priceFor, priceUsage } from './pricing';
import { extractUsage, geminiAnswerText } from './usage';

const rows: AuditRow[] = [];

afterEach(() => {
  rows.length = 0;
  setAgentAuditSink(null);
});

function sink() {
  setAgentAuditSink({
    record: async (row) => {
      rows.push(row);
      return `call-${rows.length}`;
    },
  });
}

describe('priceUsage', () => {
  it('bills Gemini thinking apart from the answer', () => {
    const priced = priceUsage('gemini-2.0-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      thinkingTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      thinkingIncludedInOutput: false,
    });
    expect(priced.costUsd).toBe(0.9);
    expect(priced.totalTokens).toBe(3_000_000);
  });

  it('does not bill Claude thinking twice, and discounts a cache read', () => {
    const priced = priceUsage('claude-opus-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      thinkingTokens: 500_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      thinkingIncludedInOutput: true,
    });
    // 1M input at $5, 1M cache read at $0.50, 2M output at $25. Thinking is already in the output.
    expect(priced.costUsd).toBe(55.5);
    expect(priced.totalTokens).toBe(4_000_000);
  });

  it('uses the longest matching model name', () => {
    expect(priceFor('claude-opus-5-5-20261101').inputPerMillion).toBe(5);
    expect(priceFor('claude-opus-4').inputPerMillion).toBe(15);
    expect(priceFor('some-new-model').inputPerMillion).toBe(1);
  });

  it('lets a catalog replace a rate', () => {
    const priced = priceUsage(
      'gemini-3.8-flash',
      { inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, thinkingIncludedInOutput: false },
      { 'gemini-3.8-flash': { inputPerMillion: 2 } },
    );
    expect(priced.costUsd).toBe(2);
    expect(priced.priceOutputPerMillion).toBe(5);
  });
});

describe('extractUsage', () => {
  it('reads Gemini thoughts and keeps them out of the answer', () => {
    const data = {
      modelVersion: 'gemini-3.8-flash',
      candidates: [{ content: { parts: [{ text: 'Look at the tie-out first.', thought: true }, { text: '{"points":[]}' }] } }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 15, totalTokenCount: 135 },
    };
    const extracted = extractUsage('gemini', data);
    expect(extracted.thinking).toBe('Look at the tie-out first.');
    expect(extracted.usage).toMatchObject({ inputTokens: 60, cachedInputTokens: 40, outputTokens: 20, thinkingTokens: 15, thinkingIncludedInOutput: false });
    expect(geminiAnswerText(data)).toBe('{"points":[]}');
  });

  it('reads Claude thinking blocks and cache tokens', () => {
    const extracted = extractUsage('claude', {
      model: 'claude-opus-5-5',
      content: [
        { type: 'thinking', thinking: 'The maturity is missing.' },
        { type: 'text', text: 'Ask for the date.' },
      ],
      usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 12, cache_creation_input_tokens: 4 },
    });
    expect(extracted.thinking).toBe('The maturity is missing.');
    expect(extracted.usage).toMatchObject({ inputTokens: 80, outputTokens: 30, cachedInputTokens: 12, cacheWriteTokens: 4, thinkingIncludedInOutput: true });
  });

  it('reads OpenAI reasoning tokens as already included in the output', () => {
    const extracted = extractUsage('openai', {
      model: 'gpt-5',
      usage: { prompt_tokens: 50, completion_tokens: 22, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 7 } },
      choices: [{ message: { content: 'Done.', reasoning_content: 'The figure is in the pack.' } }],
    });
    expect(extracted.thinking).toBe('The figure is in the pack.');
    expect(extracted.usage).toMatchObject({ inputTokens: 40, cachedInputTokens: 10, outputTokens: 22, thinkingTokens: 7, thinkingIncludedInOutput: true });
  });
});

describe('invokeAgent', () => {
  it('audits the user, the client, the feature, the tokens, and the thinking', async () => {
    sink();
    const result = await runWithAgentContext(
      { userId: 'user-1', clientId: 'client-1', feature: 'narrative', activity: 'narrative.section', agent: 'overview' },
      () =>
        invokeAgent({
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          activity: 'narrative.compose',
          apiKey: 'test-key',
          fetchImpl: async () =>
            ({
              ok: true,
              text: async () =>
                JSON.stringify({
                  modelVersion: 'gemini-3.8-flash',
                  candidates: [{ content: { parts: [{ thought: true, text: 'The cushion is thin.' }, { text: '[]' }] } }],
                  usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 10, thoughtsTokenCount: 30 },
                }),
            }) as unknown as Response,
        }),
    );

    expect(result.audit).toMatchObject({
      id: 'call-1',
      userId: 'user-1',
      clientId: 'client-1',
      feature: 'narrative',
      activity: 'narrative.compose',
      agent: 'overview',
      model: 'gemini-3.8-flash',
      inputTokens: 200,
      outputTokens: 10,
      thinkingTokens: 30,
      thinking: 'The cushion is thin.',
      status: 'ok',
      persisted: true,
    });
    expect(result.audit.costUsd).toBeCloseTo((200 / 1e6) * 0.15 + (10 / 1e6) * 0.6 + (30 / 1e6) * 0.6, 6);
    expect(rows).toHaveLength(1);
    expect(usageForClient([result.audit]).calls).toBe(1);
    expect(usageForClient([result.audit]).audits[0].thinking).toBe('The cushion is thin.');
  });

  it('records a failed call and still raises the error', async () => {
    sink();
    await expect(
      invokeAgent({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        feature: 'chat',
        activity: 'chat.turn',
        userId: 'user-2',
        clientId: 'client-2',
        apiKey: 'test-key',
        fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'slow down key=secret' }) as unknown as Response,
      }),
    ).rejects.toThrow(/429/);
    expect(rows[0]).toMatchObject({ status: 'error', userId: 'user-2', clientId: 'client-2', feature: 'chat', inputTokens: 0 });
    expect(rows[0].error).toContain('key');
    expect(rows[0].error).not.toContain('secret');
  });

  it('audits a caller-supplied SDK call', async () => {
    sink();
    const { audit } = await invokeAgent({
      provider: 'claude',
      model: 'claude-opus-5-5',
      feature: 'workflow',
      activity: 'workflow.agent',
      agent: 'Clean the issuer',
      userId: 'user-3',
      clientId: 'client-3',
      execute: async () => ({
        model: 'claude-opus-5-5',
        content: [{ type: 'thinking', thinking: 'The sector is not on the list.' }, { type: 'text', text: 'Propose a list value.' }],
        usage: { input_tokens: 1000, output_tokens: 80 },
      }),
    });
    expect(audit.thinking).toBe('The sector is not on the list.');
    expect(audit.inputTokens).toBe(1000);
    expect(audit.outputTokens).toBe(80);
    expect(audit.costUsd).toBeCloseTo((1000 / 1e6) * 5 + (80 / 1e6) * 25, 6);
  });

  it('keeps a caller bound for the rest of the request on a later model call', async () => {
    sink();
    bindAgentContext({ userId: 'user-5', clientId: 'client-5', feature: 'chat', activity: 'chat.turn' });
    const { audit } = await invokeAgent({
      provider: 'claude',
      model: 'claude-haiku',
      feature: 'feed-intake',
      activity: 'feed.extract-table',
      execute: async () => ({ model: 'claude-haiku', content: [], usage: { input_tokens: 3, output_tokens: 1 } }),
    });
    expect(audit).toMatchObject({ userId: 'user-5', clientId: 'client-5', feature: 'feed-intake', activity: 'feed.extract-table' });
  });

  it('keeps a nested feed call on the client and on the outer receipt', async () => {
    sink();
    await runWithAgentContext({ userId: 'user-4', clientId: 'client-4', feature: 'chat', activity: 'chat.turn' }, async () => {
      await runWithAgentContext({ feature: 'feed-intake', activity: 'feed.import', clientId: 'client-4' }, () =>
        invokeAgent({
          provider: 'openai',
          model: 'gpt-5',
          activity: 'feed.extract-table',
          apiKey: 'sk-test',
          fetchImpl: async () =>
            ({
              ok: true,
              json: async () => ({
                model: 'gpt-5',
                usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } },
                choices: [{ message: { content: '{}', reasoning_content: 'One table.' } }],
              }),
            }) as unknown as Response,
        }),
      );
      expect(takeAgentAudits()).toHaveLength(1);
      expect(takeAgentAudits()[0]).toMatchObject({ feature: 'feed-intake', activity: 'feed.extract-table', userId: 'user-4', clientId: 'client-4', thinking: 'One table.' });
    });
  });
});

describe('turns and subjects', () => {
  const claudeCall = () =>
    invokeAgent({
      provider: 'claude',
      model: 'claude-haiku',
      execute: async () => ({ model: 'claude-haiku', content: [], usage: { input_tokens: 3, output_tokens: 1 } }),
    });

  it('puts every call in one request, nested ones too, in the same turn', async () => {
    sink();
    await runWithAgentContext(
      { userId: 'user-6', clientId: 'client-6', feature: 'chat', activity: 'chat.turn', conversationId: 'conv-1' },
      async () => {
        await claudeCall();
        await claudeCall();
        await runWithAgentContext({ feature: 'documents', subject: { type: 'document', id: 'doc-1', label: 'Q3 letter' } }, claudeCall);
      },
    );
    expect(rows).toHaveLength(3);
    const turns = new Set(rows.map((row) => row.metadata.turnId));
    expect(turns.size).toBe(1);
    expect(rows.every((row) => row.metadata.conversationId === 'conv-1')).toBe(true);
    expect(rows[2].metadata).toMatchObject({ subjectType: 'document', subjectId: 'doc-1', subjectLabel: 'Q3 letter' });
    expect(rows[0].metadata.subjectType).toBeUndefined();
  });

  it('starts a new turn for each top-level request', async () => {
    sink();
    const first = await runWithAgentContext({ feature: 'chat' }, claudeCall);
    const second = await runWithAgentContext({ feature: 'chat' }, claudeCall);
    expect(first.audit.turnId).toBeTruthy();
    expect(first.audit.turnId).not.toBe(second.audit.turnId);
    expect(usageForClient([first.audit]).audits[0].turnId).toBe(first.audit.turnId);
  });

  it('keeps the turn and subject when other metadata is too large to store', async () => {
    sink();
    await runWithAgentContext(
      { feature: 'feed-intake', subject: { type: 'feed', id: 'feed-9' }, metadata: { blob: 'x'.repeat(10_000) } },
      claudeCall,
    );
    expect(rows[0].metadata).toMatchObject({ note: 'metadata truncated', subjectType: 'feed', subjectId: 'feed-9' });
    expect(typeof rows[0].metadata.turnId).toBe('string');
  });
});

describe('formatting', () => {
  it('writes small costs and token counts for the dashboard', () => {
    expect(formatUsd(0.00234)).toBe('$0.0023');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});
