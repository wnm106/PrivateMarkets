import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pinnedFetch } from './pinned-fetch';
import { assertPublicHost } from './url-guard';

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest' });
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${request.headers.host} ${request.method} ${body}\n\n`);
      setTimeout(() => response.end('data: done\n\n'), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('pinnedFetch', () => {
  it('connects to the checked address whatever the name resolves to now, and streams the reply', async () => {
    // rebind.invalid never resolves: the request can only arrive through the pinned address.
    const response = await pinnedFetch(`http://rebind.invalid:${port}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0"}' }, ['127.0.0.1']);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`rebind.invalid:${port} POST {"jsonrpc":"2.0"}`);
    expect(text).toContain('data: done');
  });

  it('does not follow a redirect to an address nobody checked', async () => {
    await expect(pinnedFetch(`http://rebind.invalid:${port}/redirect`, {}, ['127.0.0.1'])).rejects.toThrow(/redirect/);
  });
});

describe('assertPublicHost', () => {
  it('returns the addresses it checked, resolving the name once', async () => {
    let lookups = 0;
    const resolve = async () => { lookups += 1; return ['93.184.216.34']; };
    expect(await assertPublicHost('https://mcp.example.com/mcp', false, resolve)).toEqual(['93.184.216.34']);
    expect(lookups).toBe(1);
  });

  it('refuses a name that resolves to a private address', async () => {
    await expect(assertPublicHost('https://mcp.example.com/mcp', false, async () => ['10.0.0.5'])).rejects.toThrow(/private network/);
  });
});
