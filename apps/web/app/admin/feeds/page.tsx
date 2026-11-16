'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { describeCron } from '@/lib/jobs';
import { fileSize, feedStatusLabel, isLate, type FeedRow } from '@/lib/feeds-admin';

const CONNECTION_FIELDS = `id connectionCode connectionName kind config hasSecret isActive lastCheckedAt lastCheckOk lastCheckMessage inboxPath`;
const FEED_FIELDS = `
  id connectionId connectionName connectionKind feedCode feedName path filePattern mapCode sourceCode isActive
  pollCron pollTimezone nextPollAt expectedCron expectedTimezone graceMinutes lastPolledAt lastReceivedAt
  lastFileName lastFileStatus lastFileMessage
`;
const FEEDS_QUERY = `
  query Feeds {
    feedConnections { ${CONNECTION_FIELDS} }
    feeds { ${FEED_FIELDS} }
    receivedFiles(first: 50) { id feedId feedName fileName sizeBytes status attempts importInstanceId rowsCreated rowsMatched message receivedAt lastSeenAt }
    feedMaps { mapCode mapName }
  }
`;
const SAVE_CONNECTION = `mutation($input: SaveFeedConnectionInput!) { saveFeedConnection(input: $input) { connection { id } errors { field message } } }`;
const DELETE_CONNECTION = `mutation($id: ID!) { deleteFeedConnection(id: $id) { success errors { message } } }`;
const CHECK_CONNECTION = `mutation($id: ID!) { checkFeedConnection(id: $id) { run { id } errors { message } } }`;
const SAVE_FEED = `mutation($input: SaveFeedInput!) { saveFeed(input: $input) { feed { id } errors { field message } } }`;
const DELETE_FEED = `mutation($id: ID!) { deleteFeed(id: $id) { success errors { message } } }`;
const POLL_FEED = `mutation($id: ID!) { pollFeedNow(id: $id) { run { id } errors { message } } }`;

type ConnectionKind = 'STORAGE' | 'HTTP' | 'SFTP';

interface Connection {
  id: string;
  connectionCode: string;
  connectionName: string;
  kind: ConnectionKind;
  config: Record<string, string>;
  hasSecret: boolean;
  isActive: boolean;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  inboxPath: string | null;
}

interface ReceivedFile {
  id: string;
  feedId: string;
  feedName: string | null;
  fileName: string;
  sizeBytes: number | null;
  status: string;
  attempts: number;
  importInstanceId: string | null;
  rowsCreated: number | null;
  rowsMatched: number | null;
  message: string | null;
  receivedAt: string;
  lastSeenAt: string;
}

interface ConnectionDraft {
  id: string | null;
  connectionName: string;
  kind: ConnectionKind;
  folder: string;
  baseUrl: string;
  authType: string;
  username: string;
  headerName: string;
  host: string;
  port: string;
  hostKey: string;
  leaveFiles: boolean;
  secret: string;
  hasSecret: boolean;
  isActive: boolean;
}

interface FeedDraft {
  id: string | null;
  feedName: string;
  connectionId: string;
  path: string;
  filePattern: string;
  mapCode: string;
  sourceCode: string;
  pollCron: string;
  pollTimezone: string;
  expectedCron: string;
  expectedTimezone: string;
  graceMinutes: number;
  isActive: boolean;
}

type MutationErrors = Array<{ field?: string | null; message: string }>;

const AUTH_LABEL: Record<string, string> = { NONE: 'No sign-in', BEARER: 'Bearer token', BASIC: 'User name and password', HEADER: 'Key in a header' };
const SECRET_LABEL: Record<string, string> = { BEARER: 'Token', BASIC: 'Password', HEADER: 'Key', PASSWORD: 'Password', KEY: 'Private key' };
const KIND_LABEL: Record<ConnectionKind, string> = { STORAGE: 'Drop folder', HTTP: 'Web address', SFTP: 'SFTP server' };
const STATUS_COLOR: Record<string, string> = {
  LOADED: 'var(--success, #276749)',
  LOADING: 'var(--accent)',
  NEEDS_REVIEW: 'var(--warning, #975a16)',
  FAILED: 'var(--danger, #9b2c2c)',
};

function when(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function cronHint(expression: string, zone: string): string {
  if (!expression.trim()) return '';
  try {
    return describeCron(expression, zone);
  } catch (error) {
    return error instanceof Error ? error.message : 'The schedule is not valid.';
  }
}

export default function FeedsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [files, setFiles] = useState<ReceivedFile[]>([]);
  const [maps, setMaps] = useState<Array<{ mapCode: string; mapName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [feedDraft, setFeedDraft] = useState<FeedDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);

  usePublishViewContext({ activity: 'viewing', kind: 'feeds', label: 'Feeds', summary: 'Connections, feeds and received files' });

  const load = useCallback(async () => {
    const result = await graphqlQuery<
      { feedConnections: Connection[]; feeds: FeedRow[]; receivedFiles: ReceivedFile[]; feedMaps: Array<{ mapCode: string; mapName: string }> },
      Record<string, never>
    >(FEEDS_QUERY, {}, 'network-only');
    if (result.aborted) return;
    if (result.error) {
      setMessage(result.error.message);
    } else if (result.data) {
      setConnections(result.data.feedConnections);
      setFeeds(result.data.feeds);
      setFiles(result.data.receivedFiles);
      setMaps(result.data.feedMaps);
      setMessage('');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
  const feedConnection = feedDraft ? connectionById.get(feedDraft.connectionId) : undefined;

  const editConnection = (connection?: Connection) => {
    setDraftError('');
    setFeedDraft(null);
    setConnectionDraft({
      id: connection?.id || null,
      connectionName: connection?.connectionName || '',
      kind: connection?.kind || 'STORAGE',
      folder: connection?.config.folder || '',
      baseUrl: connection?.config.baseUrl || '',
      authType: connection?.config.authType || 'NONE',
      username: connection?.config.username || '',
      headerName: connection?.config.headerName || '',
      host: connection?.config.host || '',
      port: String(connection?.config.port || 22),
      hostKey: connection?.config.hostKey || '',
      leaveFiles: connection?.config.afterLoad === 'LEAVE',
      secret: '',
      hasSecret: connection?.hasSecret || false,
      isActive: connection?.isActive ?? true,
    });
  };

  const editFeed = (feed?: FeedRow) => {
    setDraftError('');
    setConnectionDraft(null);
    setFeedDraft({
      id: feed?.id || null,
      feedName: feed?.feedName || '',
      connectionId: feed?.connectionId || connections[0]?.id || '',
      path: feed?.path || '',
      filePattern: feed?.filePattern || '*',
      mapCode: feed?.mapCode || maps[0]?.mapCode || '',
      sourceCode: feed?.sourceCode || '',
      pollCron: feed ? feed.pollCron || '' : '*/30 * * * *',
      pollTimezone: feed?.pollTimezone || localZone(),
      expectedCron: feed?.expectedCron || '',
      expectedTimezone: feed?.expectedTimezone || localZone(),
      graceMinutes: feed?.graceMinutes ?? 120,
      isActive: feed?.isActive ?? true,
    });
  };

  const saveConnection = async () => {
    if (!connectionDraft) return;
    const draft = connectionDraft;
    setSaving(true);
    setDraftError('');
    const config =
      draft.kind === 'STORAGE'
        ? { folder: draft.folder }
        : draft.kind === 'SFTP'
          ? {
              host: draft.host,
              port: draft.port,
              username: draft.username,
              folder: draft.folder,
              authType: draft.authType === 'KEY' ? 'KEY' : 'PASSWORD',
              hostKey: draft.hostKey,
              afterLoad: draft.leaveFiles ? 'LEAVE' : 'MOVE',
            }
          : { baseUrl: draft.baseUrl, authType: draft.authType, username: draft.username, headerName: draft.headerName };
    const { data, error } = await graphqlMutation<{ saveFeedConnection: { errors: MutationErrors } }>(SAVE_CONNECTION, {
      input: {
        id: draft.id,
        connectionName: draft.connectionName,
        kind: draft.kind,
        config,
        // Left out keeps the stored credential.
        ...(draft.secret ? { secret: draft.secret } : {}),
        isActive: draft.isActive,
      },
    });
    setSaving(false);
    const problem = error?.message || data?.saveFeedConnection.errors[0]?.message;
    if (problem) {
      setDraftError(problem);
      return;
    }
    setConnectionDraft(null);
    load();
  };

  const saveFeed = async () => {
    if (!feedDraft) return;
    const draft = feedDraft;
    setSaving(true);
    setDraftError('');
    const { data, error } = await graphqlMutation<{ saveFeed: { errors: MutationErrors } }>(SAVE_FEED, {
      input: {
        id: draft.id,
        connectionId: draft.connectionId,
        feedName: draft.feedName,
        path: draft.path,
        filePattern: draft.filePattern,
        mapCode: draft.mapCode,
        sourceCode: draft.sourceCode,
        isActive: draft.isActive,
        pollCron: draft.pollCron,
        pollTimezone: draft.pollTimezone,
        expectedCron: draft.expectedCron,
        expectedTimezone: draft.expectedTimezone,
        graceMinutes: draft.graceMinutes,
      },
    });
    setSaving(false);
    const problem = error?.message || data?.saveFeed.errors[0]?.message;
    if (problem) {
      setDraftError(problem);
      return;
    }
    setFeedDraft(null);
    load();
  };

  /** Runs a mutation that returns { errors }, shows the first error or the notice, and reloads. */
  const act = async (mutation: string, field: string, id: string, done: string) => {
    const { data, error } = await graphqlMutation<Record<string, { errors: MutationErrors }>>(mutation, { id });
    const problem = error?.message || data?.[field]?.errors[0]?.message;
    setMessage(problem || '');
    setNotice(problem ? '' : done);
    load();
  };

  const removeConnection = (connection: Connection) => {
    if (!window.confirm(`Delete the connection "${connection.connectionName}" and its stored credential?`)) return;
    act(DELETE_CONNECTION, 'deleteFeedConnection', connection.id, '');
  };

  const removeFeed = (feed: FeedRow) => {
    if (!window.confirm(`Delete the feed "${feed.feedName}"? Its schedule and file history are deleted too. Loaded data stays.`)) return;
    act(DELETE_FEED, 'deleteFeed', feed.id, '');
  };

  const now = new Date();

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Feeds</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Feeds</div>
            <div className="page-meta">
              Files that arrive on their own and load through a saved map. A file is loaded once, however often it is seen. A file that does not fit its map waits in Load data for a person.
            </div>
          </div>
        </div>
      </div>

      {message && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)', margin: '12px 0' }}>{message}</div>}
      {notice && <div role="status" style={{ color: 'var(--ink-2)', margin: '12px 0' }}>{notice} <Link href="/admin/jobs" className="crumb-link">See it in Jobs</Link></div>}
      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading feeds…</div>}

      <div style={sectionHead}>
        <h2 style={sectionTitle}>Connections</h2>
        <button type="button" className="btn" onClick={() => editConnection()}>New connection</button>
      </div>

      {connectionDraft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveConnection();
          }}
          style={formBox}
        >
          <div style={{ fontWeight: 600 }}>{connectionDraft.id ? 'Edit connection' : 'New connection'}</div>
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Name</span>
              <input className="text-input" value={connectionDraft.connectionName} autoFocus placeholder="Administrator drop folder"
                onChange={(event) => setConnectionDraft({ ...connectionDraft, connectionName: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Files come from</span>
              <select className="text-input" value={connectionDraft.kind} disabled={Boolean(connectionDraft.id)}
                onChange={(event) => {
                  const kind = event.target.value as ConnectionKind;
                  // Each kind has its own sign-in choices.
                  setConnectionDraft({ ...connectionDraft, kind, authType: kind === 'SFTP' ? 'PASSWORD' : 'NONE', username: '', secret: '' });
                }}>
                <option value="STORAGE">A drop folder (feed inbox)</option>
                <option value="SFTP">An SFTP server</option>
                <option value="HTTP">A web address (https)</option>
              </select>
            </label>
          </div>

          {connectionDraft.kind === 'STORAGE' && (
            <>
              <label style={field}>
                <span style={fieldLabel}>Folder</span>
                <input className="text-input" value={connectionDraft.folder} placeholder="administrator" spellCheck={false}
                  onChange={(event) => setConnectionDraft({ ...connectionDraft, folder: event.target.value })} />
              </label>
              <div style={hint}>
                Files go in the private feed-inbox bucket, inside your client&apos;s own folder. After a poll, a loaded file moves to a processed subfolder and one that needs a person moves to review.
              </div>
            </>
          )}

          {connectionDraft.kind === 'SFTP' && (
            <>
              <div style={formRow}>
                <label style={field}>
                  <span style={fieldLabel}>Server</span>
                  <input className="text-input" value={connectionDraft.host} placeholder="sftp.example.com" spellCheck={false}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, host: event.target.value })} />
                </label>
                <label style={field}>
                  <span style={fieldLabel}>Port</span>
                  <input className="text-input" value={connectionDraft.port} inputMode="numeric"
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, port: event.target.value })} />
                </label>
                <label style={field}>
                  <span style={fieldLabel}>Folder on the server</span>
                  <input className="text-input" value={connectionDraft.folder} placeholder="/outbound" spellCheck={false}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, folder: event.target.value })} />
                </label>
              </div>
              <div style={formRow}>
                <label style={field}>
                  <span style={fieldLabel}>User name</span>
                  <input className="text-input" value={connectionDraft.username} autoComplete="off" spellCheck={false}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, username: event.target.value })} />
                </label>
                <label style={field}>
                  <span style={fieldLabel}>Sign-in</span>
                  <select className="text-input" value={connectionDraft.authType === 'KEY' ? 'KEY' : 'PASSWORD'}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, authType: event.target.value, secret: '' })}>
                    <option value="PASSWORD">Password</option>
                    <option value="KEY">Private key</option>
                  </select>
                </label>
              </div>
              <label style={field}>
                <span style={fieldLabel}>{connectionDraft.authType === 'KEY' ? 'Private key' : 'Password'}</span>
                {connectionDraft.authType === 'KEY' ? (
                  <textarea className="text-input" rows={4} value={connectionDraft.secret} spellCheck={false} style={{ ...mono, fontSize: 12 }}
                    placeholder={connectionDraft.hasSecret ? 'Stored. Leave blank to keep it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, secret: event.target.value })} />
                ) : (
                  <input className="text-input" type="password" value={connectionDraft.secret} autoComplete="new-password"
                    placeholder={connectionDraft.hasSecret ? 'Stored. Leave blank to keep it.' : ''}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, secret: event.target.value })} />
                )}
              </label>
              <div style={hint}>Kept encrypted. It is never shown again, here or anywhere else.</div>
              <label style={field}>
                <span style={fieldLabel}>Server host key (recommended)</span>
                <input className="text-input" value={connectionDraft.hostKey} placeholder="SHA256:…" spellCheck={false} style={mono}
                  onChange={(event) => setConnectionDraft({ ...connectionDraft, hostKey: event.target.value })} />
              </label>
              <div style={hint}>
                With a host key saved, the connection refuses any server that presents a different one. Save without it, press Check, and the result shows the server&apos;s key to paste here.
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={connectionDraft.leaveFiles} onChange={(event) => setConnectionDraft({ ...connectionDraft, leaveFiles: event.target.checked })} />
                Leave files where they are (for a server we can only read)
              </label>
              {!connectionDraft.leaveFiles && (
                <div style={hint}>After a poll, a loaded file moves to a processed subfolder on the server and one that needs a person moves to review.</div>
              )}
            </>
          )}

          {connectionDraft.kind === 'HTTP' && (
            <>
              <label style={field}>
                <span style={fieldLabel}>Address</span>
                <input className="text-input" value={connectionDraft.baseUrl} placeholder="https://files.example.com/packs/" spellCheck={false}
                  onChange={(event) => setConnectionDraft({ ...connectionDraft, baseUrl: event.target.value })} />
              </label>
              <div style={formRow}>
                <label style={field}>
                  <span style={fieldLabel}>Sign-in</span>
                  <select className="text-input" value={connectionDraft.authType}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, authType: event.target.value })}>
                    {Object.entries(AUTH_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                {connectionDraft.authType === 'BASIC' && (
                  <label style={field}>
                    <span style={fieldLabel}>User name</span>
                    <input className="text-input" value={connectionDraft.username} autoComplete="off"
                      onChange={(event) => setConnectionDraft({ ...connectionDraft, username: event.target.value })} />
                  </label>
                )}
                {connectionDraft.authType === 'HEADER' && (
                  <label style={field}>
                    <span style={fieldLabel}>Header name</span>
                    <input className="text-input" value={connectionDraft.headerName} placeholder="X-Api-Key" spellCheck={false}
                      onChange={(event) => setConnectionDraft({ ...connectionDraft, headerName: event.target.value })} />
                  </label>
                )}
              </div>
              {connectionDraft.authType !== 'NONE' && (
                <>
                  <label style={field}>
                    <span style={fieldLabel}>{SECRET_LABEL[connectionDraft.authType]}</span>
                    <input className="text-input" type="password" value={connectionDraft.secret} autoComplete="new-password"
                      placeholder={connectionDraft.hasSecret ? 'Stored. Leave blank to keep it.' : ''}
                      onChange={(event) => setConnectionDraft({ ...connectionDraft, secret: event.target.value })} />
                  </label>
                  <div style={hint}>Kept encrypted. It is never shown again, here or anywhere else.</div>
                </>
              )}
            </>
          )}

          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={connectionDraft.isActive} onChange={(event) => setConnectionDraft({ ...connectionDraft, isActive: event.target.checked })} />
            Active
          </label>
          {draftError && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)' }}>{draftError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save connection'}</button>
            <button type="button" className="btn" onClick={() => setConnectionDraft(null)} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      {!loading && connections.length === 0 && !connectionDraft && (
        <div style={{ color: 'var(--ink-3)' }}>No connections yet. Add the place your files arrive from.</div>
      )}
      {connections.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Name</th>
                <th style={cell}>Files come from</th>
                <th style={cell}>Last check</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id} style={bodyRow}>
                  <td style={{ ...cell, fontWeight: 500 }}>
                    {connection.connectionName}
                    {!connection.isActive && <div style={hint}>Paused</div>}
                  </td>
                  <td style={cell}>
                    <code>
                      {connection.kind === 'STORAGE'
                        ? connection.inboxPath
                        : connection.kind === 'SFTP'
                          ? `${connection.config.username}@${connection.config.host}:${connection.config.folder || '.'}`
                          : connection.config.baseUrl}
                    </code>
                    <div style={hint}>
                      {KIND_LABEL[connection.kind]}
                      {connection.kind === 'HTTP' && `, ${(AUTH_LABEL[connection.config.authType] || 'No sign-in').toLowerCase()}`}
                      {connection.kind === 'SFTP' && (connection.config.hostKey ? ', host key pinned' : ', host key not pinned')}
                      {connection.hasSecret ? ', credential stored' : ''}
                    </div>
                  </td>
                  <td style={cell}>
                    {connection.lastCheckedAt ? (
                      <>
                        <span style={{ color: connection.lastCheckOk ? STATUS_COLOR.LOADED : STATUS_COLOR.FAILED }}>{connection.lastCheckOk ? 'Reachable' : 'Not reachable'}</span>
                        <div style={hint}>{when(connection.lastCheckedAt)}</div>
                        {(!connection.lastCheckOk || connection.kind === 'SFTP') && connection.lastCheckMessage && (
                          <div style={{ ...hint, maxWidth: 360, overflowWrap: 'anywhere' }}>{connection.lastCheckMessage}</div>
                        )}
                      </>
                    ) : 'Not checked'}
                  </td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" className="btn" onClick={() => act(CHECK_CONNECTION, 'checkFeedConnection', connection.id, 'The check is queued.')}>Check</button>{' '}
                    <button type="button" className="btn" onClick={() => editConnection(connection)}>Edit</button>{' '}
                    <button type="button" className="btn" onClick={() => removeConnection(connection)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ ...sectionHead, marginTop: 28 }}>
        <h2 style={sectionTitle}>Feeds</h2>
        <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => editFeed()} disabled={connections.length === 0}>New feed</button>
      </div>

      {feedDraft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveFeed();
          }}
          style={formBox}
        >
          <div style={{ fontWeight: 600 }}>{feedDraft.id ? 'Edit feed' : 'New feed'}</div>
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Name</span>
              <input className="text-input" value={feedDraft.feedName} autoFocus placeholder="Administrator NAV pack"
                onChange={(event) => setFeedDraft({ ...feedDraft, feedName: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Connection</span>
              <select className="text-input" value={feedDraft.connectionId} onChange={(event) => setFeedDraft({ ...feedDraft, connectionId: event.target.value })}>
                {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.connectionName}</option>)}
              </select>
            </label>
          </div>
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>{feedConnection?.kind === 'HTTP' ? 'File address, after the connection address' : 'Subfolder (optional)'}</span>
              <input className="text-input" value={feedDraft.path} spellCheck={false}
                placeholder={feedConnection?.kind === 'HTTP' ? 'nav/positions_{YYYY}{MM}{DD}.csv' : 'nav'}
                onChange={(event) => setFeedDraft({ ...feedDraft, path: event.target.value })} />
            </label>
            {feedConnection?.kind !== 'HTTP' && (
              <label style={field}>
                <span style={fieldLabel}>File names to take</span>
                <input className="text-input" value={feedDraft.filePattern} placeholder="NAV_*.xlsx" spellCheck={false}
                  onChange={(event) => setFeedDraft({ ...feedDraft, filePattern: event.target.value })} />
              </label>
            )}
          </div>
          {feedConnection?.kind === 'HTTP' && <div style={hint}>{'{YYYY}'}, {'{MM}'} and {'{DD}'} become the date of the poll.</div>}
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Saved map</span>
              <select className="text-input" value={feedDraft.mapCode} onChange={(event) => setFeedDraft({ ...feedDraft, mapCode: event.target.value })}>
                {maps.length === 0 && <option value="">No saved maps</option>}
                {maps.map((map) => <option key={map.mapCode} value={map.mapCode}>{map.mapName}</option>)}
              </select>
            </label>
            <label style={field}>
              <span style={fieldLabel}>Source (optional)</span>
              <input className="text-input" value={feedDraft.sourceCode} placeholder="The map's own source" spellCheck={false}
                onChange={(event) => setFeedDraft({ ...feedDraft, sourceCode: event.target.value })} />
            </label>
          </div>
          {maps.length === 0 && <div style={hint}>A feed loads through a map saved with its file layout. Load one file of this kind by hand in Load data first.</div>}

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Look for files (minute hour day month weekday)</span>
              <input className="text-input" value={feedDraft.pollCron} placeholder="Only when asked" spellCheck={false} style={mono}
                onChange={(event) => setFeedDraft({ ...feedDraft, pollCron: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Time zone</span>
              <input className="text-input" value={feedDraft.pollTimezone} spellCheck={false}
                onChange={(event) => setFeedDraft({ ...feedDraft, pollTimezone: event.target.value })} />
            </label>
          </div>
          <div style={hint}>{cronHint(feedDraft.pollCron, feedDraft.pollTimezone) || 'Leave blank to look only when you press Poll now.'}</div>

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>A file is expected (optional)</span>
              <input className="text-input" value={feedDraft.expectedCron} placeholder="0 9 * * 1-5" spellCheck={false} style={mono}
                onChange={(event) => setFeedDraft({ ...feedDraft, expectedCron: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Time zone</span>
              <input className="text-input" value={feedDraft.expectedTimezone} spellCheck={false}
                onChange={(event) => setFeedDraft({ ...feedDraft, expectedTimezone: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Late after (minutes)</span>
              <input className="text-input" type="number" min={0} max={10080} value={feedDraft.graceMinutes}
                onChange={(event) => setFeedDraft({ ...feedDraft, graceMinutes: Number(event.target.value) || 0 })} />
            </label>
          </div>
          <div style={hint}>
            {feedDraft.expectedCron.trim()
              ? `${cronHint(feedDraft.expectedCron, feedDraft.expectedTimezone).replace('Next run', 'Next file expected')} A Late file check job in Jobs reports feeds past this time.`
              : 'With a time here, the Late file check job reports the feed when its file has not arrived.'}
          </div>

          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={feedDraft.isActive} onChange={(event) => setFeedDraft({ ...feedDraft, isActive: event.target.checked })} />
            Active
          </label>
          {draftError && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)' }}>{draftError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save feed'}</button>
            <button type="button" className="btn" onClick={() => setFeedDraft(null)} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      {!loading && feeds.length === 0 && !feedDraft && (
        <div style={{ color: 'var(--ink-3)' }}>{connections.length === 0 ? 'Add a connection first.' : 'No feeds yet. Add one for each file that arrives regularly.'}</div>
      )}
      {feeds.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Name</th>
                <th style={cell}>From</th>
                <th style={cell}>Map</th>
                <th style={cell}>Looks for files</th>
                <th style={cell}>Last file</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {feeds.map((feed) => {
                const late = isLate(feed, now);
                return (
                  <tr key={feed.id} style={bodyRow}>
                    <td style={{ ...cell, fontWeight: 500 }}>
                      {feed.feedName}
                      {!feed.isActive && <div style={hint}>Paused</div>}
                      {late && <div style={{ ...hint, color: STATUS_COLOR.FAILED }}>Late</div>}
                    </td>
                    <td style={cell}>
                      {feed.connectionName}
                      <div style={hint}>{[feed.path, feed.connectionKind === 'HTTP' ? '' : feed.filePattern].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td style={cell}>{maps.find((map) => map.mapCode === feed.mapCode)?.mapName || feed.mapCode}</td>
                    <td style={cell}>
                      {feed.pollCron ? <code>{feed.pollCron}</code> : 'Only when asked'}
                      {feed.pollCron && <div style={hint}>{feed.nextPollAt ? `Next ${when(feed.nextPollAt)}` : 'Paused'}</div>}
                    </td>
                    <td style={cell}>
                      {feed.lastFileName ? (
                        <>
                          {feed.lastFileName}
                          <div style={{ ...hint, color: STATUS_COLOR[feed.lastFileStatus || ''] }}>{feedStatusLabel(feed.lastFileStatus)}</div>
                        </>
                      ) : feed.lastPolledAt ? `Nothing yet. Looked ${when(feed.lastPolledAt)}` : 'Never looked'}
                    </td>
                    <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button type="button" className="btn" onClick={() => act(POLL_FEED, 'pollFeedNow', feed.id, 'The poll is queued.')}>Poll now</button>{' '}
                      <button type="button" className="btn" onClick={() => editFeed(feed)}>Edit</button>{' '}
                      <button type="button" className="btn" onClick={() => removeFeed(feed)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ ...sectionHead, marginTop: 28 }}>
        <h2 style={sectionTitle}>Received files</h2>
        <button type="button" className="btn" onClick={load}>Refresh</button>
      </div>
      {!loading && files.length === 0 && <div style={{ color: 'var(--ink-3)' }}>No files have been received.</div>}
      {files.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Received</th>
                <th style={cell}>File</th>
                <th style={cell}>Feed</th>
                <th style={cell}>Status</th>
                <th style={cell}>Rows</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id} style={bodyRow}>
                  <td style={cell}>{when(file.receivedAt)}</td>
                  <td style={cell}>
                    {file.fileName}
                    <div style={hint}>{fileSize(file.sizeBytes)}</div>
                  </td>
                  <td style={cell}>{file.feedName}</td>
                  <td style={cell}>
                    <span style={{ color: STATUS_COLOR[file.status], fontWeight: 500 }}>{feedStatusLabel(file.status)}</span>
                    {file.status === 'FAILED' && <div style={hint}>Attempt {file.attempts} of 3</div>}
                    {file.message && <div style={hint}>{file.message}</div>}
                    {file.status === 'NEEDS_REVIEW' && file.importInstanceId && (
                      <div style={hint}><Link href="/imports" className="crumb-link">Open Load data</Link></div>
                    )}
                  </td>
                  <td style={cell}>
                    {file.status === 'LOADED' ? `${file.rowsCreated ?? 0} new, ${file.rowsMatched ?? 0} matched` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: '8px 8px', verticalAlign: 'top' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const headRow: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
const bodyRow: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)' };
const hint: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12 };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)' };
const sectionHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '24px 0 10px' };
const sectionTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0 };
const formBox: React.CSSProperties = { margin: '0 0 16px', padding: 16, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, display: 'grid', gap: 12, maxWidth: 820 };
const formRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 };
const field: React.CSSProperties = { display: 'grid', gap: 4 };
const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--ink-2)' };
