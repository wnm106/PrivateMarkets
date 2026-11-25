import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCsv, auditStory, changedColumns, entrySummary, fieldChanges, recordLabel, tableLabel, type AuditEntry } from './audit-log';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 7,
    occurredAt: '2026-11-25T10:00:00Z',
    actorUserId: 'u1',
    actorLabel: 'Alex Admin',
    actorEmail: 'alex@example.test',
    actorRole: 'authenticated',
    supportMode: false,
    clientId: 'c1',
    clientName: 'Client One',
    kind: 'configuration',
    schemaName: 'metadata_register',
    tableName: 'attribute_register',
    operation: 'UPDATE',
    rowId: 'a1',
    changedFields: ['attribute_name', 'updated_at'],
    oldRow: { attribute_code: 'FUND_NAME', attribute_name: 'Fund name', updated_at: '2026-11-24' },
    newRow: { attribute_code: 'FUND_NAME', attribute_name: 'Fund legal name', updated_at: '2026-11-25' },
    ...overrides,
  };
}

test('names tables people know, and any other table from its name', () => {
  assert.equal(tableLabel('metadata_register', 'attribute_register'), 'Attribute');
  assert.equal(tableLabel('ops', 'notification_settings'), 'Notification settings');
});

test('names the record from its name, then its code, then its id', () => {
  assert.equal(recordLabel(entry()), 'Fund legal name');
  assert.equal(recordLabel(entry({ newRow: { rule_code: 'R1' }, oldRow: null })), 'R1');
  assert.equal(recordLabel(entry({ newRow: { list_id: 'x' }, oldRow: null })), 'a1');
});

test('a change names what moved, not the bookkeeping', () => {
  assert.equal(entrySummary(entry()), 'Changed attribute: Fund legal name (attribute name)');
  assert.deepEqual(
    fieldChanges(entry()).map(({ column, before, after }) => ({ column, before, after })),
    [{ column: 'attribute_name', before: 'Fund name', after: 'Fund legal name' }],
  );
});

test('older entries without a changed list are worked out from the rows', () => {
  const old = entry({ changedFields: null });
  assert.deepEqual(changedColumns(old), ['attribute_name', 'updated_at']);
});

test('a secret shows as changed, never with a value', () => {
  const rotated = entry({
    schemaName: 'ops',
    tableName: 'connections',
    changedFields: ['inbound_token'],
    oldRow: { connection_name: 'Inbox' },
    newRow: { connection_name: 'Inbox' },
  });
  const [change] = fieldChanges(rotated);
  assert.equal(change.secret, true);
  assert.equal(change.before, 'hidden');
  assert.equal(change.after, 'hidden');
});

test('adds and removals list the record, not each column', () => {
  assert.equal(entrySummary(entry({ operation: 'INSERT', oldRow: null, changedFields: null })), 'Added attribute: Fund legal name');
  assert.equal(entrySummary(entry({ operation: 'DELETE', newRow: null, changedFields: null })), 'Removed attribute: Fund name');
});

test('the assistant gets the story, capped, with shared entries named', () => {
  const story = auditStory([entry(), entry({ id: 8, clientId: null, clientName: null, supportMode: true })], 1);
  assert.equal(story.length, 1);
  assert.equal(story[0].who, 'Alex Admin');
  const shared = auditStory([entry({ clientId: null, clientName: null, supportMode: true })]);
  assert.equal(shared[0].client, 'Shared');
  assert.equal(shared[0].who, 'Alex Admin (support mode)');
});

test('CSV quotes what needs quoting and keeps before and after as JSON', () => {
  const csv = auditCsv([entry({ actorLabel: 'Admin, Alex' })]);
  const [header, line] = csv.split('\n');
  assert.ok(header.startsWith('id,occurred_at,actor'));
  assert.ok(line.includes('"Admin, Alex"'));
  assert.ok(line.includes('""attribute_name"":""Fund legal name""'));
});
