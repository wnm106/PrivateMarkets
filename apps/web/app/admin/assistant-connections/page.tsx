'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import type { ServerView } from '@tapestrai/mcp-server/src/external/rows';
import type { IdentifierHint } from '@tapestrai/mcp-server/src/external/types';

/**
 * Outside MCP servers the chat assistant may call for this client.
 *
 * A server is reached over https and signs in with a token or key kept in
 * Supabase Vault. A server can be tied to a data source, so the assistant
 * knows it is the same system lineage names and which ids it accepts. Tools
 * are offered only once a connection check has listed them and an
 * administrator has turned them on.
 */

interface SourceOption {
  sourceCode: string;
  sourceName: string;
  sourceType: string;
}

interface Draft {
  id: string | null;
  serverName: string;
  serverCode: string;
  url: string;
  authType: 'NONE' | 'BEARER' | 'HEADER';
  headerName: string;
  secret: string;
  hasSecret: boolean;
  sourceCode: string;
  instructions: string;
  identifierHints: IdentifierHint[];
  enabledTools: string[];
  writeTools: string[];
  isActive: boolean;
}

type FieldError = { field: string | null; message: string };

function draftFrom(server?: ServerView): Draft {
  return {
    id: server?.id ?? null,
    serverName: server?.serverName ?? '',
    serverCode: server?.serverCode ?? '',
    url: server?.url ?? '',
    authType: server?.authType ?? 'BEARER',
    headerName: server?.headerName ?? '',
    secret: '',
    hasSecret: server?.hasSecret ?? false,
    sourceCode: server?.sourceCode ?? '',
    instructions: server?.instructions ?? '',
    identifierHints: server?.identifierHints ?? [],
    enabledTools: server?.enabledTools ?? [],
    writeTools: server?.writeTools ?? [],
    isActive: server?.isActive ?? true,
  };
}

function toggle(list: string[], name: string, on: boolean): string[] {
  return on ? [...new Set([...list, name])] : list.filter((item) => item !== name);
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Never';
}

export default function AssistantConnectionsPage() {
  const [servers, setServers] = useState<ServerView[]>([]);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [manage, setManage] = useState(false);
  const [hasClient, setHasClient] = useState(true);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  usePublishViewContext({
    activity: draft ? (draft.id ? 'editing' : 'creating') : 'viewing',
    kind: 'assistant-connections',
    label: 'Assistant connections',
    summary: servers.length
      ? `${servers.length} outside server${servers.length === 1 ? '' : 's'}: ${servers
          .map((s) => `${s.serverName} (${s.enabledTools.length} of ${s.tools.length} tools on${s.sourceCode ? `, source ${s.sourceCode}` : ''}${s.lastCheckOk === false ? ', last check failed' : ''})`)
          .join('; ')}`
      : 'No outside servers connected',
  });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/assistant/connections', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Assistant connections could not be loaded.');
      setServers(body.servers || []);
      setSources(body.sources || []);
      setManage(body.canManage === true);
      setHasClient(body.hasClient !== false);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Assistant connections could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const editing = useMemo(() => (draft?.id ? servers.find((s) => s.id === draft.id) ?? null : null), [draft, servers]);
  const errorFor = (fieldName: string) => errors.find((e) => e.field === fieldName)?.message;

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setErrors([]);
    try {
      const response = await fetch('/api/assistant/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          // A blank secret keeps the stored one.
          secret: draft.secret ? draft.secret : null,
          identifierHints: draft.identifierHints.filter((h) => h.identifier.trim()),
        }),
      });
      const body = await response.json();
      if (!response.ok || body.errors?.length) {
        setErrors(body.errors || [{ field: null, message: body.error || 'The server could not be saved.' }]);
        return;
      }
      const saved = body.server as ServerView;
      setNotice(draft.id ? `Saved ${saved.serverName}.` : `Added ${saved.serverName}. Check the connection to list its tools.`);
      await load();
      setDraft(draftFrom(saved));
    } finally {
      setBusy(null);
    }
  };

  const check = async (server: ServerView) => {
    setBusy(`check:${server.id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/assistant/connections/${server.id}/check`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error || 'The connection could not be checked.');
        return;
      }
      setMessage(body.ok ? null : `${server.serverName}: ${body.message}`);
      setNotice(body.ok ? `${server.serverName}: ${body.message}` : null);
      await load();
      if (draft?.id === server.id && body.server) {
        // Keep what is being typed; take the new tool list and what is still on.
        const checked = body.server as ServerView;
        setDraft({ ...draft, enabledTools: checked.enabledTools, writeTools: draft.writeTools.filter((t) => checked.tools.some((x) => x.name === t)) });
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: ServerView) => {
    if (!window.confirm(`Remove ${server.serverName}? The assistant stops calling it and its stored credential is deleted. Ids saved for its source stay.`)) return;
    setBusy(`delete:${server.id}`);
    try {
      const response = await fetch(`/api/assistant/connections/${server.id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error || 'The server could not be removed.');
        return;
      }
      if (draft?.id === server.id) setDraft(null);
      setNotice(`Removed ${server.serverName}.`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const setHint = (index: number, patch: Partial<IdentifierHint>) => {
    if (!draft) return;
    setDraft({ ...draft, identifierHints: draft.identifierHints.map((h, i) => (i === index ? { ...h, ...patch } : h)) });
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Assistant connections</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Assistant connections</div>
            <div className="page-meta">
              Your own MCP servers that the assistant may call: a CRM, a fund administrator, a portfolio monitoring system. Tie a server to the data source it is, and the assistant asks it by that system&apos;s own ids.
            </div>
          </div>
        </div>
      </div>

      {message && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)', margin: '12px 0' }}>{message}</div>}
      {notice && <div role="status" style={{ color: 'var(--ink-2)', margin: '12px 0' }}>{notice}</div>}
      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading connections…</div>}
      {!loading && !hasClient && <div style={hint}>Choose a client to see its connections.</div>}

      <div style={sectionHead}>
        <h2 style={sectionTitle}>Servers</h2>
        {manage && <button type="button" className="btn" onClick={() => { setErrors([]); setDraft(draftFrom()); }}>Add server</button>}
      </div>

      {!loading && servers.length === 0 && (
        <div style={hint}>No servers yet. The assistant uses Tapestry&apos;s own data only.</div>
      )}

      {servers.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Server</th>
              <th style={cell}>Source</th>
              <th style={cell}>Tools on</th>
              <th style={cell}>Last check</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr key={server.id} style={bodyRow}>
                <td style={cell}>
                  <div style={{ fontWeight: 600 }}>{server.serverName}{!server.isActive && <span style={hint}> (off)</span>}</div>
                  <div style={{ ...hint, ...mono }}>{server.url}</div>
                </td>
                <td style={cell}>{server.sourceCode ? `${server.sourceName || server.sourceCode}` : <span style={hint}>Not a data source</span>}</td>
                <td style={cell}>
                  {server.enabledTools.length} of {server.tools.length}
                  {server.writeTools.some((t) => server.enabledTools.includes(t)) && <div style={hint}>Some change data</div>}
                </td>
                <td style={cell}>
                  <div>{server.lastCheckOk === null ? 'Not checked' : server.lastCheckOk ? 'Connected' : 'Failed'}</div>
                  <div style={hint}>{when(server.lastCheckedAt)}</div>
                  {server.lastCheckOk === false && server.lastCheckMessage && <div style={{ ...hint, color: 'var(--danger, #9b2c2c)' }}>{server.lastCheckMessage}</div>}
                </td>
                <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {server.canManage && (
                    <>
                      <button type="button" className="btn" disabled={busy !== null} onClick={() => check(server)}>
                        {busy === `check:${server.id}` ? 'Checking…' : 'Check'}
                      </button>{' '}
                      <button type="button" className="btn" disabled={busy !== null} onClick={() => { setErrors([]); setDraft(draftFrom(server)); }}>Edit</button>{' '}
                      <button type="button" className="btn" disabled={busy !== null} onClick={() => remove(server)}>Remove</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          style={{ ...formBox, marginTop: 16 }}
        >
          <div style={{ fontWeight: 600 }}>{draft.id ? `Edit ${editing?.serverName || 'server'}` : 'Add server'}</div>
          {errors.filter((e) => !e.field).map((e) => <div key={e.message} role="alert" style={errorText}>{e.message}</div>)}

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Name</span>
              <input className="text-input" value={draft.serverName} autoFocus placeholder="DealCloud CRM"
                onChange={(event) => setDraft({ ...draft, serverName: event.target.value })} />
              {errorFor('serverName') && <span style={errorText}>{errorFor('serverName')}</span>}
            </label>
            <label style={field}>
              <span style={fieldLabel}>Code</span>
              <input className="text-input" value={draft.serverCode} placeholder="Made from the name" spellCheck={false} style={mono}
                onChange={(event) => setDraft({ ...draft, serverCode: event.target.value })} />
              {errorFor('serverCode') && <span style={errorText}>{errorFor('serverCode')}</span>}
            </label>
          </div>

          <label style={field}>
            <span style={fieldLabel}>Address</span>
            <input className="text-input" value={draft.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} style={mono}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
            {errorFor('url') && <span style={errorText}>{errorFor('url')}</span>}
            <span style={hint}>A remote MCP server on the public internet, over https.</span>
          </label>

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Sign-in</span>
              <select className="text-input" value={draft.authType}
                onChange={(event) => setDraft({ ...draft, authType: event.target.value as Draft['authType'], secret: '' })}>
                <option value="BEARER">Bearer token</option>
                <option value="HEADER">API key in a header</option>
                <option value="NONE">None</option>
              </select>
            </label>
            {draft.authType === 'HEADER' && (
              <label style={field}>
                <span style={fieldLabel}>Header</span>
                <input className="text-input" value={draft.headerName} placeholder="X-Api-Key" spellCheck={false} style={mono}
                  onChange={(event) => setDraft({ ...draft, headerName: event.target.value })} />
                {errorFor('headerName') && <span style={errorText}>{errorFor('headerName')}</span>}
              </label>
            )}
            {draft.authType !== 'NONE' && (
              <label style={field}>
                <span style={fieldLabel}>{draft.authType === 'BEARER' ? 'Token' : 'Key'}</span>
                <input className="text-input" type="password" value={draft.secret} autoComplete="new-password"
                  placeholder={draft.hasSecret ? 'Stored. Leave blank to keep it.' : ''}
                  onChange={(event) => setDraft({ ...draft, secret: event.target.value })} />
                {errorFor('secret') && <span style={errorText}>{errorFor('secret')}</span>}
              </label>
            )}
          </div>
          <div style={hint}>
            The credential is kept in Supabase Vault and is never shown again. Every user&apos;s questions reach the server with it, so give it only the access every assistant user may have.
          </div>

          <label style={field}>
            <span style={fieldLabel}>Data source</span>
            <select className="text-input" value={draft.sourceCode} onChange={(event) => setDraft({ ...draft, sourceCode: event.target.value })}>
              <option value="">Not a data source</option>
              {sources.map((source) => (
                <option key={source.sourceCode} value={source.sourceCode}>{source.sourceName} ({source.sourceCode})</option>
              ))}
            </select>
            <span style={hint}>
              The system this server reaches, as lineage names it. Ids saved for this source are passed to this server, and values that came from this source can be looked into here.
            </span>
          </label>

          <label style={field}>
            <span style={fieldLabel}>What it is for</span>
            <textarea className="text-input" rows={3} value={draft.instructions}
              placeholder="Our CRM. Ask it for relationship history, meeting notes and pipeline stage of a company or fund."
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
            <span style={hint}>The assistant reads this to decide when to ask the server.</span>
          </label>

          <div style={field}>
            <span style={fieldLabel}>Identifiers it accepts</span>
            {draft.identifierHints.map((hintRow, index) => (
              <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr auto', gap: 8 }}>
                <input className="text-input" value={hintRow.identifier} placeholder="LEI or a source code" aria-label="Identifier" style={mono}
                  onChange={(event) => setHint(index, { identifier: event.target.value })} />
                <input className="text-input" value={hintRow.argument || ''} placeholder="Argument, e.g. company_id" aria-label="Argument" style={mono}
                  onChange={(event) => setHint(index, { argument: event.target.value })} />
                <select className="text-input" value={hintRow.tool || ''} aria-label="Tool" onChange={(event) => setHint(index, { tool: event.target.value })}>
                  <option value="">Any tool</option>
                  {(editing?.tools || []).map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
                </select>
                <input className="text-input" value={hintRow.note || ''} placeholder="Note" aria-label="Note"
                  onChange={(event) => setHint(index, { note: event.target.value })} />
                <button type="button" className="btn" onClick={() => setDraft({ ...draft, identifierHints: draft.identifierHints.filter((_, i) => i !== index) })}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" className="btn" onClick={() => setDraft({ ...draft, identifierHints: [...draft.identifierHints, { identifier: draft.sourceCode || '' }] })}>
                Add identifier
              </button>
            </div>
            <span style={hint}>
              Use the data source&apos;s code for the server&apos;s own ids, or a Tapestry identifier such as LEI, ISIN or CUSIP.
            </span>
          </div>

          <div style={field}>
            <span style={fieldLabel}>Tools</span>
            {!editing || editing.tools.length === 0 ? (
              <span style={hint}>{draft.id ? 'Check the connection to list the server’s tools.' : 'Save, then check the connection to list the server’s tools.'}</span>
            ) : (
              <>
                <div>
                  <button type="button" className="btn"
                    onClick={() => setDraft({ ...draft, enabledTools: editing.tools.filter((t) => t.readOnly === true).map((t) => t.name) })}>
                    Turn on the read-only tools
                  </button>
                </div>
                <table style={table}>
                  <thead>
                    <tr style={headRow}>
                      <th style={cell}>On</th>
                      <th style={cell}>Tool</th>
                      <th style={cell}>Changes data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editing.tools.map((tool) => {
                      const forcedWrite = tool.destructive === true;
                      return (
                        <tr key={tool.name} style={bodyRow}>
                          <td style={cell}>
                            <input type="checkbox" aria-label={`Turn on ${tool.name}`} checked={draft.enabledTools.includes(tool.name)}
                              onChange={(event) => setDraft({ ...draft, enabledTools: toggle(draft.enabledTools, tool.name, event.target.checked) })} />
                          </td>
                          <td style={cell}>
                            <div style={mono}>{tool.name}</div>
                            {tool.description && <div style={hint}>{tool.description.length > 240 ? `${tool.description.slice(0, 239)}…` : tool.description}</div>}
                            <div style={hint}>
                              {tool.readOnly === true ? 'The server says it only reads.' : tool.destructive === true ? 'The server says it can delete or overwrite data.' : 'The server does not say whether it changes data.'}
                            </div>
                          </td>
                          <td style={cell}>
                            <input type="checkbox" aria-label={`${tool.name} changes data`} disabled={forcedWrite}
                              checked={forcedWrite || draft.writeTools.includes(tool.name)}
                              onChange={(event) => setDraft({ ...draft, writeTools: toggle(draft.writeTools, tool.name, event.target.checked) })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <span style={hint}>
                  The assistant calls a tool that changes data only after the user agrees to that change in the conversation.
                </span>
              </>
            )}
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
            <span>The assistant may use this server</span>
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" onClick={() => { setDraft(null); setErrors([]); }}>Close</button>
          </div>
        </form>
      )}

      <div style={sectionHead}>
        <h2 style={sectionTitle}>How the assistant finds the same record in another system</h2>
      </div>
      <div style={{ ...hint, maxWidth: 820, display: 'grid', gap: 6 }}>
        <div>
          Tapestry keeps each record&apos;s id in other systems, by data source. The assistant looks these up first and passes the server its own id, so it does not guess from names.
        </div>
        <div>
          When no id is stored, the assistant searches the other system by name and identifiers, tells the user what it matched, and offers to remember the id once the user confirms. Ids are dated, so questions asked with an earlier As Of or Knowledge date see the ids known then.
        </div>
      </div>
    </div>
  );
}

const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const headRow: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
const bodyRow: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)', verticalAlign: 'top' };
const cell: React.CSSProperties = { padding: '8px 8px 8px 0' };
const hint: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12 };
const errorText: React.CSSProperties = { color: 'var(--danger, #9b2c2c)', fontSize: 12 };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)' };
const sectionHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '24px 0 10px' };
const sectionTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0 };
const formBox: React.CSSProperties = { margin: '0 0 16px', padding: 16, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, display: 'grid', gap: 12, maxWidth: 820 };
const formRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 };
const field: React.CSSProperties = { display: 'grid', gap: 4 };
const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--ink-2)' };
