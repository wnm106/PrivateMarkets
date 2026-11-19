import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanServerInput, suggestedWriteTools } from './assistant-connections';

const TOOLS = [
  { name: 'read', description: '', inputSchema: {}, readOnly: true, destructive: false },
  { name: 'write', description: '', inputSchema: {}, readOnly: false, destructive: false },
  { name: 'wipe', description: '', inputSchema: {}, readOnly: null, destructive: true },
];

test('a new server needs a name, a public https address and its credential', () => {
  const { value, errors } = cleanServerInput({ serverName: '', url: 'http://10.0.0.1', authType: 'BEARER' }, null, []);
  assert.equal(value, null);
  assert.deepEqual(errors.map((e) => e.field).sort(), ['secret', 'serverName', 'url']);
});

test('the code is made from the name, and tools can be turned on only once listed', () => {
  const { value } = cleanServerInput(
    { serverName: 'DealCloud CRM', url: 'https://mcp.dealcloud.example/mcp', authType: 'BEARER', secret: 't', enabledTools: ['read', 'unknown'] },
    null,
    TOOLS,
  );
  assert.equal(value?.serverCode, 'DEALCLOUD_CRM');
  assert.deepEqual(value?.enabledTools, ['read']);
  assert.equal(value?.secret, 't');
});

test('a blank secret keeps the stored one, and dropping sign-in removes it', () => {
  const existing = { serverCode: 'CRM', hasSecret: true };
  const kept = cleanServerInput({ serverName: 'CRM', url: 'https://x.example', authType: 'BEARER', secret: null }, existing, []);
  assert.equal(kept.value?.secret, null);
  const removed = cleanServerInput({ serverName: 'CRM', url: 'https://x.example', authType: 'NONE', secret: null }, existing, []);
  assert.equal(removed.value?.secret, '');
});

test('a header sign-in needs a usable header name', () => {
  const bad = cleanServerInput({ serverName: 'CRM', url: 'https://x.example', authType: 'HEADER', headerName: 'Host', secret: 'k' }, null, []);
  assert.equal(bad.errors[0]?.field, 'headerName');
  const good = cleanServerInput({ serverName: 'CRM', url: 'https://x.example', authType: 'HEADER', headerName: 'X-Api-Key', secret: 'k' }, null, []);
  assert.equal(good.value?.headerName, 'X-Api-Key');
});

test('tools the server says change data are suggested as write tools', () => {
  assert.deepEqual(suggestedWriteTools(TOOLS), ['write', 'wipe']);
});
