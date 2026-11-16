'use client';

import { useCallback, useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { usePublishViewContext } from '@/lib/view-context';

const SETTINGS_FIELDS = `enabled preset timezone morningHour nextDeliveryAt followCount`;
const FOLLOW_FIELDS = `id subjectType subjectId subjectCode label delivery createdAt`;

const PAGE_QUERY = `
  query AssistantPage {
    assistantSettings { ${SETTINGS_FIELDS} }
    assistantFollows { ${FOLLOW_FIELDS} }
    feeds { id feedName feedCode }
  }
`;
const SEARCH_QUERY = `
  query AssistantSearch($query: String!) {
    searchEntities(query: $query, limit: 8) { id entityName domainName }
  }
`;
const SAVE_SETTINGS = `
  mutation SaveAssistantSettings($input: SaveAssistantSettingsInput!) {
    saveAssistantSettings(input: $input) {
      settings { ${SETTINGS_FIELDS} }
      errors { field message }
    }
  }
`;
const SAVE_FOLLOW = `
  mutation SaveAssistantFollow($input: SaveAssistantFollowInput!) {
    saveAssistantFollow(input: $input) {
      follow { ${FOLLOW_FIELDS} }
      errors { message }
    }
  }
`;
const DELETE_FOLLOW = `mutation DeleteAssistantFollow($id: ID!) { deleteAssistantFollow(id: $id) { success errors { message } } }`;
const BRIEF_NOW = `mutation DeliverAssistantBrief { deliverAssistantBrief { success errors { message } } }`;

const PRESETS = [
  { value: 'WEEKDAY_MORNING', label: 'Weekday morning' },
  { value: 'WORKDAY_HOURLY', label: 'Hourly through the workday' },
  { value: 'URGENT_ONLY', label: 'Only when something is urgent' },
] as const;

const ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Zurich', 'Asia/Singapore', 'Asia/Tokyo'];

const KINDS = [
  { code: 'FEED_LATE', label: 'Files that are late' },
  { code: 'FEED_NEEDS_REVIEW', label: 'Files waiting for review' },
  { code: 'FEED_FAILED', label: 'Files that failed' },
  { code: 'FEED_LOADED', label: 'Files that loaded' },
] as const;

interface Settings {
  enabled: boolean;
  preset: string;
  timezone: string;
  morningHour: number;
  nextDeliveryAt: string | null;
  followCount: number;
}

interface Follow {
  id: string;
  subjectType: string;
  subjectId: string | null;
  subjectCode: string | null;
  label: string;
  delivery: string;
  createdAt: string;
}

interface FeedOption {
  id: string;
  feedName: string;
  feedCode: string;
}

interface Hit {
  id: string;
  entityName: string;
  domainName: string;
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function when(value: string | null, zone: string): string {
  if (!value) return 'No summary is scheduled.';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No summary is scheduled.';
  const text = date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: zone || 'UTC' });
  return `Next summary: ${text} (${zone || 'UTC'}).`;
}

function deliveryLabel(delivery: string): string {
  return delivery === 'IMMEDIATE' ? 'As soon as it happens' : 'In the summary';
}

export default function AssistantPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [feeds, setFeeds] = useState<FeedOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const [preset, setPreset] = useState('WEEKDAY_MORNING');
  const [timezone, setTimezone] = useState(localZone());
  const [morningHour, setMorningHour] = useState(7);
  const [enabled, setEnabled] = useState(false);

  const [kind, setKind] = useState<string>(KINDS[0].code);
  const [kindDelivery, setKindDelivery] = useState('DIGEST');
  const [feedId, setFeedId] = useState('');
  const [feedDelivery, setFeedDelivery] = useState('DIGEST');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [recordDelivery, setRecordDelivery] = useState('DIGEST');

  usePublishViewContext({
    activity: 'editing',
    kind: 'assistant',
    label: 'Assistant',
    summary: 'What the assistant follows, and when it sends a summary',
  });

  const apply = useCallback((next: Settings) => {
    setSettings(next);
    setPreset(next.preset);
    setTimezone(next.timezone || localZone());
    setMorningHour(next.morningHour ?? 7);
    setEnabled(next.enabled);
  }, []);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ assistantSettings: Settings; assistantFollows: Follow[]; feeds: FeedOption[] }>(
      PAGE_QUERY,
      {},
      'network-only',
    );
    if (result.error) {
      setMessage(result.error.message || 'The assistant could not be loaded.');
      setLoading(false);
      return;
    }
    if (result.data) {
      apply(result.data.assistantSettings);
      setFollows(result.data.assistantFollows);
      setFeeds(result.data.feeds);
      setFeedId((current) => current || result.data?.feeds[0]?.id || '');
    }
    setLoading(false);
  }, [apply]);

  useEffect(() => {
    load();
  }, [load]);

  const zones = timezone && !ZONES.includes(timezone) ? [timezone, ...ZONES] : ZONES;

  const saveSettings = async () => {
    setSaving(true);
    setMessage('');
    const result = await graphqlMutation<{ saveAssistantSettings: { settings: Settings | null; errors: { message: string }[] } }>(
      SAVE_SETTINGS,
      { input: { enabled, preset, timezone, morningHour } },
    );
    setSaving(false);
    const saved = result.data?.saveAssistantSettings;
    if (result.error || !saved || saved.errors.length > 0) {
      setMessage(saved?.errors[0]?.message || result.error?.message || 'The settings could not be saved.');
      return;
    }
    if (saved.settings) apply(saved.settings);
    setMessage(enabled ? 'Saved. Summaries run when the job worker is up.' : 'Saved. Automatic summaries are off.');
  };

  const addFollow = async (input: { subjectType: string; subjectId?: string; subjectCode?: string; delivery: string }) => {
    setMessage('');
    const result = await graphqlMutation<{ saveAssistantFollow: { follow: Follow | null; errors: { message: string }[] } }>(
      SAVE_FOLLOW,
      { input },
    );
    const saved = result.data?.saveAssistantFollow;
    if (result.error || !saved || saved.errors.length > 0 || !saved.follow) {
      setMessage(saved?.errors[0]?.message || result.error?.message || 'That could not be followed.');
      return;
    }
    setFollows((current) => [...current, saved.follow as Follow]);
  };

  const removeFollow = async (id: string) => {
    setMessage('');
    const result = await graphqlMutation<{ deleteAssistantFollow: { success: boolean; errors: { message: string }[] } }>(
      DELETE_FOLLOW,
      { id },
    );
    const removed = result.data?.deleteAssistantFollow;
    if (result.error || !removed?.success) {
      setMessage(removed?.errors[0]?.message || result.error?.message || 'That follow could not be removed.');
      return;
    }
    setFollows((current) => current.filter((follow) => follow.id !== id));
  };

  const summarizeNow = async () => {
    setMessage('');
    const result = await graphqlMutation<{ deliverAssistantBrief: { success: boolean; errors: { message: string }[] } }>(BRIEF_NOW);
    const queued = result.data?.deliverAssistantBrief;
    if (result.error || !queued?.success) {
      setMessage(queued?.errors[0]?.message || result.error?.message || 'The summary could not be queued.');
      return;
    }
    setMessage('A summary is queued. It shows up in your briefing chat when the worker runs. Nothing is sent when nothing you follow has changed.');
  };

  const search = async () => {
    const text = query.trim();
    if (!text) {
      setHits([]);
      return;
    }
    const result = await graphqlQuery<{ searchEntities: Hit[] }, { query: string }>(SEARCH_QUERY, { query: text }, 'network-only');
    if (result.error) {
      setMessage(result.error.message || 'The search failed.');
      return;
    }
    setHits(result.data?.searchEntities || []);
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-title">Assistant</div>
          <div className="page-meta">
            Follow the records, feeds, and changes you want watched. Choose when a summary arrives. The check itself stays on the job worker.
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={summarizeNow} disabled={follows.length === 0}>
            Summarize now
          </button>
        </div>
      </div>

      {message && <p style={note}>{message}</p>}
      {loading || !settings ? (
        loading ? <p style={note}>Loading…</p> : null
      ) : (
        <>
          <section style={section}>
            <h2 style={heading}>When to summarize</h2>
            <p style={note}>
              {settings.preset === 'URGENT_ONLY' || preset === 'URGENT_ONLY'
                ? 'Urgent follows are sent when the change is recorded. Nothing else is scheduled.'
                : when(settings.nextDeliveryAt, settings.timezone)}
            </p>
            <div style={row}>
              <label style={field}>
                <span style={label}>Assistant</span>
                <select className="text-input" value={enabled ? 'on' : 'off'} onChange={(event) => setEnabled(event.target.value === 'on')}>
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </select>
              </label>
              <label style={field}>
                <span style={label}>Summary</span>
                <select className="text-input" value={preset} onChange={(event) => setPreset(event.target.value)}>
                  {PRESETS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label style={field}>
                <span style={label}>Time zone</span>
                <select className="text-input" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>{zone}</option>
                  ))}
                </select>
              </label>
              {preset === 'WEEKDAY_MORNING' && (
                <label style={field}>
                  <span style={label}>Morning hour</span>
                  <select className="text-input" value={String(morningHour)} onChange={(event) => setMorningHour(Number(event.target.value))}>
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>{`${hour}:00`}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button type="button" className="btn btn-primary" onClick={saveSettings} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </section>

          <section style={section}>
            <h2 style={heading}>What to follow</h2>
            <p style={note}>A summary stays quiet until something you follow changes. As soon as it happens skips the digest and sends that change on its own.</p>

            <div style={row}>
              <label style={field}>
                <span style={label}>A kind of change</span>
                <select className="text-input" value={kind} onChange={(event) => setKind(event.target.value)}>
                  {KINDS.map((item) => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label style={field}>
                <span style={label}>Tell me</span>
                <select className="text-input" value={kindDelivery} onChange={(event) => setKindDelivery(event.target.value)}>
                  <option value="DIGEST">In the summary</option>
                  <option value="IMMEDIATE">As soon as it happens</option>
                </select>
              </label>
              <div style={fieldEnd}>
                <button type="button" className="btn" onClick={() => addFollow({ subjectType: 'KIND', subjectCode: kind, delivery: kindDelivery })}>
                  Follow
                </button>
              </div>
            </div>

            <div style={row}>
              <label style={field}>
                <span style={label}>A feed</span>
                <select className="text-input" value={feedId} onChange={(event) => setFeedId(event.target.value)}>
                  {feeds.length === 0 && <option value="">No feeds yet</option>}
                  {feeds.map((feed) => (
                    <option key={feed.id} value={feed.id}>{feed.feedName}</option>
                  ))}
                </select>
              </label>
              <label style={field}>
                <span style={label}>Tell me</span>
                <select className="text-input" value={feedDelivery} onChange={(event) => setFeedDelivery(event.target.value)}>
                  <option value="DIGEST">In the summary</option>
                  <option value="IMMEDIATE">As soon as it happens</option>
                </select>
              </label>
              <div style={fieldEnd}>
                <button type="button" className="btn" disabled={!feedId} onClick={() => addFollow({ subjectType: 'FEED', subjectId: feedId, delivery: feedDelivery })}>
                  Follow
                </button>
              </div>
            </div>

            <div style={row}>
              <label style={field}>
                <span style={label}>A record</span>
                <input
                  className="text-input"
                  value={query}
                  placeholder="Search by name"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') search();
                  }}
                />
              </label>
              <label style={field}>
                <span style={label}>Tell me</span>
                <select className="text-input" value={recordDelivery} onChange={(event) => setRecordDelivery(event.target.value)}>
                  <option value="DIGEST">In the summary</option>
                  <option value="IMMEDIATE">As soon as it happens</option>
                </select>
              </label>
              <div style={fieldEnd}>
                <button type="button" className="btn" onClick={search}>Find</button>
              </div>
            </div>
            {hits.length > 0 && (
              <ul style={hitsList}>
                {hits.map((hit) => (
                  <li key={hit.id} style={hitRow}>
                    <span>{hit.entityName} <span style={quiet}>{hit.domainName}</span></span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => addFollow({ subjectType: 'ENTITY', subjectId: hit.id, delivery: recordDelivery })}
                    >
                      Follow
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {follows.length === 0 ? (
              <p style={note}>Nothing is followed yet.</p>
            ) : (
              <table style={table}>
                <thead>
                  <tr style={head}>
                    <th>Following</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {follows.map((follow) => (
                    <tr key={follow.id} style={body}>
                      <td style={cell}>{follow.label}</td>
                      <td style={cell}>{deliveryLabel(follow.delivery)}</td>
                      <td style={cell}>
                        <button type="button" className="btn btn-sm" onClick={() => removeFollow(follow.id)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const section: React.CSSProperties = { marginTop: 28 };
const heading: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: '0 0 8px' };
const note: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 13, margin: '0 0 14px' };
const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', marginBottom: 16 };
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220, flex: '1 1 220px' };
const fieldEnd: React.CSSProperties = { display: 'flex', alignItems: 'end' };
const label: React.CSSProperties = { fontSize: 11, textTransform: 'uppercase', color: 'var(--ink-3)' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 };
const head: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
const body: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)' };
const cell: React.CSSProperties = { padding: '8px 8px 8px 0', verticalAlign: 'middle' };
const hitsList: React.CSSProperties = { listStyle: 'none', margin: '0 0 16px', padding: 0 };
const hitRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid var(--line, #e5e5e5)' };
const quiet: React.CSSProperties = { color: 'var(--ink-3)' };
