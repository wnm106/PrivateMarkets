'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { usePublishPageData, usePublishViewContext } from '@/lib/view-context';
import {
  actorText,
  auditCsv,
  auditStory,
  entrySummary,
  fieldChanges,
  OPERATION_LABEL,
  recordLabel,
  tableLabel,
  type AuditEntry,
  type AuditPage,
} from '@/lib/audit-log';

/**
 * Who changed access or configuration, and when. Reads tenancy.audit_log
 * through public.audit_log_entries, which keeps each reader to the clients
 * they may see. Access and Configuration are a filter over one list, not tabs.
 */

const QUERY = `query AuditLog($kind: String, $from: String, $to: String, $table: String, $rowId: String, $search: String, $limit: Int, $beforeId: String) {
  auditLog(kind: $kind, from: $from, to: $to, table: $table, rowId: $rowId, search: $search, limit: $limit, beforeId: $beforeId)
}`;

const PAGE_SIZE = 100;

type Kind = '' | 'access' | 'configuration';

const KINDS: Array<{ id: Kind; label: string }> = [
  { id: '', label: 'Everything' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'access', label: 'Access' },
];

function when(value: string): string {
  return new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** The start of a calendar date, or of the day after it, in the reader's zone. */
function dayStart(date: string, nextDay = false): string | null {
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

export default function AuditLogPage() {
  const [kind, setKind] = useState<Kind>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [record, setRecord] = useState<{ table: string; rowId: string; label: string } | null>(null);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  // Right-click on a value says where it comes from: the audit entry that stored it.
  const explain = (event: React.MouseEvent, title: string, lines: string[]) => {
    event.preventDefault();
    event.stopPropagation();
    setNote({ x: Math.min(event.clientX, window.innerWidth - 380), y: Math.min(event.clientY + 8, window.innerHeight - 160), title, lines });
  };
  useEffect(() => {
    if (!note) return;
    const close = () => setNote(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [note]);

  // Typing settles before the log is read again.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const variables = useMemo(
    () => ({
      kind: kind || null,
      from: dayStart(fromDate),
      to: dayStart(toDate, true),
      table: record?.table ?? null,
      rowId: record?.rowId ?? null,
      search: search || null,
      limit: PAGE_SIZE,
    }),
    [kind, fromDate, toDate, record, search],
  );

  useEffect(() => {
    let live = true;
    setEntries(null);
    setMessage(null);
    void graphqlQuery<{ auditLog: AuditPage }>(QUERY, { ...variables, beforeId: null }, 'network-only').then((result) => {
      if (!live) return;
      if (result.error) {
        setMessage(result.error.message);
        setEntries([]);
        setHasMore(false);
        return;
      }
      setEntries(result.data?.auditLog.entries ?? []);
      setHasMore(result.data?.auditLog.hasMore ?? false);
    });
    return () => {
      live = false;
    };
  }, [variables]);

  const loadMore = useCallback(() => {
    if (!entries?.length) return;
    setLoadingMore(true);
    const beforeId = String(entries[entries.length - 1].id);
    void graphqlQuery<{ auditLog: AuditPage }>(QUERY, { ...variables, beforeId }, 'network-only').then((result) => {
      setLoadingMore(false);
      if (result.error) {
        setMessage(result.error.message);
        return;
      }
      setEntries((current) => [...(current ?? []), ...(result.data?.auditLog.entries ?? [])]);
      setHasMore(result.data?.auditLog.hasMore ?? false);
    });
  }, [entries, variables]);

  const selected = entries?.find((entry) => String(entry.id) === selectedId) ?? null;

  const download = () => {
    if (!entries?.length) return;
    const blob = new Blob([auditCsv(entries)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  usePublishViewContext({ activity: 'viewing', kind: 'audit log', label: 'Audit log', summary: 'Who changed access or configuration, and when' });
  usePublishPageData({
    auditLog: {
      purpose: 'Who changed access (users, roles, grants, sign-in rules, support mode) or configuration (entity types, attributes, templates, rules, maps, feeds, workflows, surfaces), and when.',
      howToRead:
        'Newest first. "Shared" entries change platform configuration every client uses and are shown to staff only. "Database (…)" or "Platform service" means no signed-in person made the change: a migration, a job or the service. Support mode means platform staff acted inside the client. Secrets are named as changed but never stored. Only the entries loaded on screen are listed; more may exist.',
      filters: { kind: kind || 'everything', from: fromDate || null, to: toDate || null, search: search || null, record: record?.label ?? null },
      entries: entries === null ? null : auditStory(entries),
      moreNotLoaded: hasMore,
      selected: selected ? { what: entrySummary(selected), who: actorText(selected), when: selected.occurredAt, changes: fieldChanges(selected).slice(0, 30) } : null,
    },
  });

  return (
    <div className="da x-audit view-fade">
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Audit</span>
          <h1>Audit log</h1>
          <p>Every change to who can do what, and to how the platform is set up: who made it, when, and the values before and after. Entries are never changed or removed.</p>
        </div>
      </header>

      <div className="da-sec">
        <div className="da-sechead">
          <div>
            <h2>Changes</h2>
            <p>Dates are in your time zone. Search matches a record&apos;s name, code or id.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="da-tabs" role="group" aria-label="What changed" style={{ margin: 0 }}>
              {KINDS.map((item) => (
                <button key={item.id || 'all'} type="button" aria-pressed={kind === item.id} className={kind === item.id ? 'on' : ''} onClick={() => setKind(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
            <input className="text-input" type="date" aria-label="From" value={fromDate} onChange={(event) => setFromDate(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }} />
            <input className="text-input" type="date" aria-label="To" value={toDate} onChange={(event) => setToDate(event.target.value)} style={{ padding: '7px 8px', fontSize: 12 }} />
            <input className="text-input" type="search" aria-label="Search" placeholder="Search records" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} style={{ padding: '7px 8px', fontSize: 12, minWidth: 200 }} />
            <button type="button" className="btn" onClick={download} disabled={!entries?.length} style={{ fontSize: 12 }}>
              Download CSV
            </button>
          </div>
        </div>

        {record && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', fontSize: 13 }}>
            <span className="da-chip">Record</span>
            <span>{record.label}</span>
            <button type="button" className="btn" onClick={() => setRecord(null)} style={{ fontSize: 12 }}>Show all</button>
          </div>
        )}
        {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0' }}>{message}</div>}
        {entries === null && !message && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Reading the audit log…</div>}

        {entries !== null && (
          <div className="da-main" style={{ display: 'grid', gridTemplateColumns: selected ? 'minmax(0, 1.4fr) minmax(320px, 0.9fr)' : '1fr', gap: 16, marginTop: 12 }}>
            <div>
              {entries.length === 0 ? (
                <div style={{ padding: 16, border: '1px dashed var(--line-strong)', borderRadius: 8, color: 'var(--ink-3)', fontSize: 13 }}>
                  No changes match. Widen the dates or clear the search.
                </div>
              ) : (
                <div className="da-gridwrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
                  <table className="da-grid">
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        <th className="num">Entry</th><th>When</th><th>Who</th><th>Client</th><th>What changed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => {
                        const id = String(entry.id);
                        return (
                          <tr
                            key={id}
                            className={selectedId === id ? 'sel' : ''}
                            onClick={() => setSelectedId(selectedId === id ? null : id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedId(selectedId === id ? null : id);
                              }
                            }}
                            tabIndex={0}
                            style={{ cursor: 'pointer' }}
                          >
                            <td className="num">
                              <span
                                data-derived="audit-entry"
                                title="Right-click: where this entry comes from"
                                onContextMenu={(event) =>
                                  explain(event, `Audit entry ${id}`, [
                                    `Written by the database when ${entry.schemaName}.${entry.tableName} changed, in the same transaction as the change.`,
                                    'Numbered in the order changes were committed. Entries are never edited or removed.',
                                    'The CSV download keys each row by this number.',
                                  ])
                                }
                              >
                                {id}
                              </span>
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>{when(entry.occurredAt)}</td>
                            <td className="x-audit-who">{entry.actorLabel}{entry.supportMode ? <small>Support mode</small> : entry.actorEmail && entry.actorEmail !== entry.actorLabel ? <small>{entry.actorEmail}</small> : null}</td>
                            <td>{entry.clientName ?? (entry.clientId ? '—' : 'Shared')}</td>
                            <td>{entrySummary(entry)}<small>{entry.kind === 'access' ? 'Access' : 'Configuration'} · {entry.schemaName}.{entry.tableName}</small></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {hasMore && (
                <button type="button" className="btn" onClick={loadMore} disabled={loadingMore} style={{ fontSize: 12, marginTop: 12 }}>
                  {loadingMore ? 'Reading…' : 'Show older changes'}
                </button>
              )}
            </div>

            {selected && (
              <aside className="da-panel" aria-label="Change details">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <h3 style={{ fontSize: 15, margin: 0 }}>
                    {OPERATION_LABEL[selected.operation]} {tableLabel(selected.schemaName, selected.tableName).toLowerCase()}: {recordLabel(selected)}
                  </h3>
                  <button type="button" className="btn" onClick={() => setSelectedId(null)} style={{ fontSize: 12 }} aria-label="Close details">
                    Close
                  </button>
                </div>
                <p>{actorText(selected)} · {when(selected.occurredAt)}</p>
                <p>
                  {selected.clientName ?? (selected.clientId ? 'Client not found' : 'Shared configuration')}
                  {selected.actorRole && selected.actorRole !== 'authenticated' ? ` · acting as ${selected.actorRole}` : ''}
                </p>
                {selected.rowId && (
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 12, marginBottom: 12 }}
                    onClick={() => {
                      setRecord({ table: `${selected.schemaName}.${selected.tableName}`, rowId: selected.rowId!, label: `${tableLabel(selected.schemaName, selected.tableName)}: ${recordLabel(selected)}` });
                      setSelectedId(null);
                    }}
                  >
                    Show every change to this record
                  </button>
                )}
                <table className="da-grid">
                  <thead>
                    <tr><th>Field</th><th>Before</th><th>After</th></tr>
                  </thead>
                  <tbody>
                    {fieldChanges(selected).map((change) => (
                      <tr key={change.column}>
                        <td>{change.label}{change.secret ? <small>Secret: not stored</small> : null}</td>
                        {(['before', 'after'] as const).map((side) => (
                          <td key={side} className="x-audit-value">
                            <span
                              data-derived="audit-value"
                              title="Right-click: where this value comes from"
                              onContextMenu={(event) =>
                                explain(event, `${change.label}, ${side} the change`, [
                                  change.secret
                                    ? 'A secret. The log records that it changed and never stores its value.'
                                    : `The value stored in ${selected.schemaName}.${selected.tableName} ${side === 'before' ? 'just before' : 'just after'} this change, copied into audit entry ${selected.id} when it was committed.`,
                                  `Record: ${recordLabel(selected)}${selected.rowId ? ` (${selected.rowId})` : ''}.`,
                                ])
                              }
                            >
                              {change[side]}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </aside>
            )}
          </div>
        )}
        {note && (
          <div className="x-audit-note" role="dialog" aria-label={note.title} style={{ left: note.x, top: note.y }} onClick={(event) => event.stopPropagation()}>
            <strong>{note.title}</strong>
            {note.lines.map((line) => <p key={line}>{line}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}
