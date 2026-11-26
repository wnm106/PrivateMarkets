import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureErrorReporting, reportError, scrub, sentryEnvelope } from './error-report';

describe('scrub', () => {
  it('cuts tokens and email addresses out of the text', () => {
    const text = scrub('Bearer abc.def.ghi failed for jane@example.com with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
    expect(text).not.toMatch(/abc\.def|jane@|eyJhbGci/);
    expect(text).toContain('[removed]');
  });
});

describe('sentryEnvelope', () => {
  it('addresses the project from the DSN and names the person by id only', () => {
    const envelope = sentryEnvelope('https://publickey@o1.ingest.example.io/42', new TypeError('boom for a@b.co'), { source: 'graphql', where: 'Query.deal', userId: 'u1', reference: 'ABC123' }, { environment: 'staging', release: 'abc' }, new Date('2026-11-26T12:00:00Z'));
    expect(envelope.url).toBe('https://o1.ingest.example.io/api/42/envelope/');
    expect(envelope.headers['X-Sentry-Auth']).toContain('sentry_key=publickey');
    const [header, item, event] = envelope.body.split('\n').map((line) => JSON.parse(line));
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item).toEqual({ type: 'event' });
    expect(event).toMatchObject({ environment: 'staging', release: 'abc', user: { id: 'u1' }, tags: { source: 'graphql', where: 'Query.deal', reference: 'ABC123' } });
    expect(event.exception.values[0]).toEqual({ type: 'TypeError', value: 'boom for [removed]' });
  });

  it('refuses something that is not a DSN', () => {
    expect(() => sentryEnvelope('https://o1.ingest.example.io/', new Error('x'), { source: 'graphql' }, {})).toThrow('not a DSN');
  });
});

describe('reportError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    configureErrorReporting({});
  });

  it('logs one JSON line, and sends nothing without a DSN', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.spyOn(globalThis, 'fetch');
    configureErrorReporting({});
    await reportError(new Error('it broke'), { source: 'route', where: '/api/chat' });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ level: 'error', source: 'route', where: '/api/chat', message: 'it broke' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to the tracker when a DSN is set, and never throws when it cannot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    configureErrorReporting({ dsn: 'https://k@host.example/7' });
    await expect(reportError(new Error('it broke'), { source: 'graphql' })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith('https://host.example/api/7/envelope/', expect.objectContaining({ method: 'POST' }));
  });
});
