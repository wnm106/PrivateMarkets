/**
 * Reading the access and configuration audit log (tenancy.audit_log through
 * public.audit_log_entries). Pure helpers, so the screen and what it tells the
 * assistant are worked out the same way.
 */

export type AuditKind = 'access' | 'configuration';
export type AuditOperation = 'INSERT' | 'UPDATE' | 'DELETE';

export interface AuditEntry {
  id: number | string;
  occurredAt: string;
  actorUserId: string | null;
  actorLabel: string;
  actorEmail: string | null;
  actorRole: string | null;
  supportMode: boolean;
  clientId: string | null;
  clientName: string | null;
  kind: AuditKind;
  schemaName: string;
  tableName: string;
  operation: AuditOperation;
  rowId: string | null;
  changedFields: string[] | null;
  oldRow: Record<string, unknown> | null;
  newRow: Record<string, unknown> | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  hasMore: boolean;
}

/** Columns that only record when a row was touched. Shown, but not as the change. */
const BOOKKEEPING = new Set(['updated_at', 'updated_by']);

/** Columns the log never stores. They show as changed, with no values. */
const SECRET_COLUMNS = new Set(['client_secret', 'secret', 'metadata_xml', 'inbound_token', 'token_hash', 'auth_config', 'endpoint_headers']);

/** Names for the tables people change most. Anything else is named from its table name. */
const TABLE_NAMES: Record<string, string> = {
  'tenancy.clients': 'Client',
  'tenancy.profiles': 'User profile',
  'tenancy.client_users': 'Client membership',
  'tenancy.roles': 'Role',
  'tenancy.role_permissions': 'Role permission',
  'tenancy.user_roles': 'Role assignment',
  'tenancy.entity_grants': 'Record access grant',
  'tenancy.client_identity_providers': 'Sign-in provider',
  'tenancy.client_auth_requirements': 'Sign-in rule',
  'tenancy.impersonation_sessions': 'Support session',
  'tenancy.client_modules': 'Client module',
  'tenancy.client_module_grants': 'Module grant',
  'metadata_register.domain_types': 'Entity type',
  'metadata_register.attribute_register': 'Attribute',
  'metadata_register.domain_templates': 'Template',
  'metadata_register.template_attribute_assignments': 'Template field',
  'metadata_register.reference_lists': 'Reference list',
  'metadata_register.reference_list_values': 'Reference list value',
  'metadata_register.precedence_rules': 'Precedence rule',
  'metadata_register.precedence_rule_chain': 'Precedence order',
  'metadata_register.calc_definitions': 'Calculation',
  'metadata_register.calc_inputs': 'Calculation input',
  'metadata_register.match_rules': 'Match rule',
  'data_quality.dq_rules': 'Data quality rule',
  'compliance.rules': 'Compliance rule',
  'compliance.rule_versions': 'Compliance rule version',
  'compliance.rule_thresholds': 'Fund threshold',
  'compliance.rule_conditions': 'Compliance rule condition',
  'compliance.rule_measure_lines': 'Compliance measure line',
  'compliance.rule_scope_assignments': 'Compliance rule scope',
  'entity_instances.source_registry': 'Data source',
  'entity_instances.import_maps': 'Import map',
  'entity_instances.feed_maps': 'Feed map',
  'ops.connections': 'Feed connection',
  'ops.feeds': 'Feed',
  'ops.job_schedules': 'Job schedule',
  'ops.workflows': 'Workflow',
  'ops.workflow_versions': 'Workflow version',
  'ops.workflow_triggers': 'Workflow trigger',
  'ops.agents': 'Agent',
  'ops.assistant_mcp_servers': 'Assistant connection',
  'public.surface_definitions': 'Surface',
  'public.narrative_templates': 'Narrative template',
  'docs.templates': 'Document template',
};

export const OPERATION_LABEL: Record<AuditOperation, string> = {
  INSERT: 'Added',
  UPDATE: 'Changed',
  DELETE: 'Removed',
};

function sentenceCase(words: string): string {
  const spaced = words.replace(/_/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : spaced;
}

/** What kind of thing the entry is about, in words. */
export function tableLabel(schemaName: string, tableName: string): string {
  return TABLE_NAMES[`${schemaName}.${tableName}`] ?? sentenceCase(tableName);
}

/** A column's name in words. */
export function fieldLabel(column: string): string {
  return sentenceCase(column);
}

/** The best name the stored row carries for itself, or its id. */
export function recordLabel(entry: Pick<AuditEntry, 'oldRow' | 'newRow' | 'rowId'>): string {
  const row = entry.newRow ?? entry.oldRow ?? {};
  const keys = Object.keys(row);
  const pick = (test: (key: string) => boolean) => {
    const key = keys.find((candidate) => test(candidate) && typeof row[candidate] === 'string' && (row[candidate] as string).trim());
    return key ? (row[key] as string).trim() : null;
  };
  return (
    pick((key) => key === 'display_name' || key === 'name' || key === 'title') ??
    pick((key) => key.endsWith('_name') && key !== 'table_name') ??
    pick((key) => key.endsWith('_code')) ??
    entry.rowId ??
    '—'
  );
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The columns an entry changed. Entries written since 2026-11-25 carry the
 * list; older ones are worked out from the rows. Inserts and deletes list every
 * column the row has.
 */
export function changedColumns(entry: Pick<AuditEntry, 'operation' | 'changedFields' | 'oldRow' | 'newRow'>): string[] {
  if (entry.operation !== 'UPDATE') {
    return Object.keys(entry.newRow ?? entry.oldRow ?? {}).sort();
  }
  if (entry.changedFields) return [...entry.changedFields].sort();
  const oldRow = entry.oldRow ?? {};
  const newRow = entry.newRow ?? {};
  return [...new Set([...Object.keys(oldRow), ...Object.keys(newRow)])].filter((key) => !same(oldRow[key], newRow[key])).sort();
}

/** The columns worth naming as the change: bookkeeping left out unless it is all there is. */
export function meaningfulColumns(entry: Pick<AuditEntry, 'operation' | 'changedFields' | 'oldRow' | 'newRow'>): string[] {
  const all = changedColumns(entry);
  const kept = all.filter((column) => !BOOKKEEPING.has(column));
  return kept.length ? kept : all;
}

export interface FieldChange {
  column: string;
  label: string;
  before: string;
  after: string;
  secret: boolean;
}

/** Writes a stored value the way the panel shows it. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Each changed column with its value before and after. Secrets show as changed, without values. */
export function fieldChanges(entry: Pick<AuditEntry, 'operation' | 'changedFields' | 'oldRow' | 'newRow'>): FieldChange[] {
  return meaningfulColumns(entry).map((column) => {
    const secret = SECRET_COLUMNS.has(column);
    return {
      column,
      label: fieldLabel(column),
      before: secret ? 'hidden' : entry.operation === 'INSERT' ? '—' : formatValue(entry.oldRow?.[column]),
      after: secret ? 'hidden' : entry.operation === 'DELETE' ? '—' : formatValue(entry.newRow?.[column]),
      secret,
    };
  });
}

/** One line for the list: "Changed Attribute: Fund name (attribute name, description)". */
export function entrySummary(entry: AuditEntry): string {
  const what = `${OPERATION_LABEL[entry.operation]} ${tableLabel(entry.schemaName, entry.tableName).toLowerCase()}`;
  const name = recordLabel(entry);
  if (entry.operation !== 'UPDATE') return `${what}: ${name}`;
  const columns = meaningfulColumns(entry);
  const shown = columns.slice(0, 3).map(fieldLabel).map((label) => label.toLowerCase());
  const more = columns.length > 3 ? ` and ${columns.length - 3} more` : '';
  return `${what}: ${name} (${shown.join(', ')}${more})`;
}

/** Who made the change, with support mode called out. */
export function actorText(entry: Pick<AuditEntry, 'actorLabel' | 'supportMode'>): string {
  return entry.supportMode ? `${entry.actorLabel} (support mode)` : entry.actorLabel;
}

/** The entries as the assistant reads them: newest first, capped, no raw rows. */
export function auditStory(entries: AuditEntry[], limit = 60) {
  return entries.slice(0, limit).map((entry) => ({
    when: entry.occurredAt,
    who: actorText(entry),
    client: entry.clientName ?? (entry.clientId ? null : 'Shared'),
    kind: entry.kind,
    what: entrySummary(entry),
    changes: entry.operation === 'UPDATE' ? fieldChanges(entry).slice(0, 8).map(({ label, before, after }) => ({ field: label, before, after })) : undefined,
  }));
}

/** CSV of the entries on screen, for an auditor. Before and after are JSON. */
export function auditCsv(entries: AuditEntry[]): string {
  const header = ['id', 'occurred_at', 'actor', 'actor_email', 'support_mode', 'client', 'kind', 'table', 'operation', 'record', 'record_id', 'changed_fields', 'before', 'after'];
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = entries.map((entry) =>
    [
      entry.id,
      entry.occurredAt,
      entry.actorLabel,
      entry.actorEmail,
      entry.supportMode ? 'yes' : 'no',
      entry.clientName ?? (entry.clientId ? entry.clientId : 'Shared'),
      entry.kind,
      `${entry.schemaName}.${entry.tableName}`,
      entry.operation,
      recordLabel(entry),
      entry.rowId,
      changedColumns(entry).join(' '),
      entry.oldRow,
      entry.newRow,
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}
