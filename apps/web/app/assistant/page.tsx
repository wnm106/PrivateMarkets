'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { entityTypeName, groupRecordsByType } from '@/lib/entity-groups';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { usePublishPageData, usePublishViewContext } from '@/lib/view-context';

/**
 * The assistant page is a guided setup in three steps:
 *   1. What to watch: start from what is registered in the app (each domain with
 *      records, and the incoming file feeds), or search for a record by name.
 *   2. What you follow: everything followed, grouped, with how each one is told.
 *   3. When to tell you: the summary schedule.
 * Records the person is responsible for already reach their summary, so they are
 * offered as suggestions rather than required follows.
 */

const SETTINGS_FIELDS = `enabled preset timezone morningHour nextDeliveryAt followCount`;
const FOLLOW_FIELDS = `id subjectType subjectId subjectCode label delivery includeChildren createdAt`;

const PAGE_QUERY = `
  query AssistantPage {
    assistantSettings { ${SETTINGS_FIELDS} }
    assistantFollows { ${FOLLOW_FIELDS} }
    feeds { id feedName feedCode isActive connectionName lastReceivedAt lastFileStatus expectedCron }
    domainTypes { domainCode domainName description isActive displayOrder enabledForSearch parentDomainCode group { groupName displayOrder } }
    domainRecordCounts { domainCode totalCount }
    responsibilities(mine: true) { id subjectType entityId entityName domainCode includeChildren activityName }
  }
`;
const RECORDS_QUERY = `
  query AssistantRecords($domainCode: String, $search: String, $first: Int) {
    workflowRecordChoices(domainCode: $domainCode, search: $search, first: $first) { id entityCode entityName domainCode }
  }
`;
const SEARCH_QUERY = `
  query AssistantSearch($query: String!) {
    searchEntities(query: $query, limit: 10) { id entityName domainCode domainName }
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
const SET_FOLLOW_CHILDREN = `
  mutation SetAssistantFollowChildren($id: ID!, $includeChildren: Boolean!) {
    setAssistantFollowChildren(id: $id, includeChildren: $includeChildren) {
      follow { ${FOLLOW_FIELDS} }
      errors { message }
    }
  }
`;
const BRIEF_NOW = `mutation DeliverAssistantBrief { deliverAssistantBrief { success errors { message } } }`;

const RECORD_PAGE = 50;

const PRESETS = [
  { value: 'WEEKDAY_MORNING', label: 'Every weekday morning', detail: 'One summary at the hour you choose, Monday to Friday.' },
  { value: 'WORKDAY_HOURLY', label: 'Every hour of the workday', detail: 'A short summary each hour while something has changed.' },
  { value: 'URGENT_ONLY', label: 'Only what is urgent', detail: 'No scheduled summary. Only what you mark "right away" is sent.' },
] as const;

const ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Zurich', 'Asia/Singapore', 'Asia/Tokyo'];

const KINDS = [
  { code: 'FEED_LATE', label: 'Files that are late', detail: 'A feed passed the time its file was expected.' },
  { code: 'FEED_FAILED', label: 'Files that failed', detail: 'A file could not be loaded.' },
  { code: 'FEED_NEEDS_REVIEW', label: 'Files waiting for review', detail: 'A file loaded but someone must check it first.' },
  { code: 'FEED_LOADED', label: 'Files that loaded', detail: 'Every file that loaded cleanly.' },
] as const;

const FILE_STATUS: Record<string, string> = {
  LOADED: 'Last file loaded',
  NEEDS_REVIEW: 'Last file is waiting for review',
  FAILED: 'Last file failed',
  GAVE_UP: 'Last file failed',
  RECEIVED: 'Last file received',
  LOADING: 'Loading a file',
};

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
  includeChildren?: boolean;
  createdAt: string;
}

interface FeedOption {
  id: string;
  feedName: string;
  feedCode: string;
  isActive: boolean;
  connectionName: string;
  lastReceivedAt: string | null;
  lastFileStatus: string | null;
  expectedCron: string | null;
}

interface DomainRow {
  domainCode: string;
  domainName: string;
  description: string | null;
  isActive: boolean;
  displayOrder: number;
  enabledForSearch: boolean;
  parentDomainCode: string | null;
  group: { groupName: string; displayOrder: number } | null;
}

interface Responsibility {
  id: string;
  subjectType: string;
  entityId: string | null;
  entityName: string | null;
  domainCode: string | null;
  includeChildren: boolean;
  activityName: string | null;
}

interface RecordChoice {
  id: string;
  entityName: string;
  domainCode: string;
  domainName?: string;
}

interface PathDomain {
  code: string;
  name: string;
  description: string | null;
  count: number;
  groupName: string;
  groupOrder: number;
  displayOrder: number;
  children: string[];
  topLevel: boolean;
}

type Path = { type: 'DOMAIN'; code: string } | { type: 'FILES' } | { type: 'SEARCH' } | null;

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function nextSummary(value: string | null, zone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone || 'UTC' });
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function childText(children: string[]): string {
  const names = children.map((name) => name.toLowerCase());
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

function shortDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function AssistantPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [feeds, setFeeds] = useState<FeedOption[]>([]);
  const [domainRows, setDomainRows] = useState<DomainRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [responsible, setResponsible] = useState<Responsibility[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [preset, setPreset] = useState('WEEKDAY_MORNING');
  const [timezone, setTimezone] = useState(localZone());
  const [morningHour, setMorningHour] = useState(7);
  const [enabled, setEnabled] = useState(false);

  const [path, setPath] = useState<Path>(null);
  const [delivery, setDelivery] = useState<'DIGEST' | 'IMMEDIATE'>('DIGEST');
  const [withChildren, setWithChildren] = useState(true);
  const [filter, setFilter] = useState('');
  const [records, setRecords] = useState<RecordChoice[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RecordChoice[] | null>(null);

  usePublishViewContext({
    activity: 'editing',
    kind: 'assistant',
    label: 'Assistant',
    summary: 'A guided setup of what the assistant watches for this person, and when it sends a summary',
  });

  const apply = useCallback((next: Settings) => {
    setSettings(next);
    setPreset(next.preset);
    setTimezone(next.timezone || localZone());
    setMorningHour(next.morningHour ?? 7);
    setEnabled(next.enabled);
  }, []);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{
      assistantSettings: Settings;
      assistantFollows: Follow[];
      feeds: FeedOption[];
      domainTypes: DomainRow[];
      domainRecordCounts: { domainCode: string; totalCount: number }[];
      responsibilities: Responsibility[];
    }>(PAGE_QUERY, {}, 'network-only');
    if (result.error || !result.data) {
      setMessage(result.error?.message || 'The assistant could not be loaded.');
      setLoading(false);
      return;
    }
    apply(result.data.assistantSettings);
    setFollows(result.data.assistantFollows);
    setFeeds(result.data.feeds || []);
    setDomainRows(result.data.domainTypes || []);
    const tally: Record<string, number> = {};
    for (const row of result.data.domainRecordCounts || []) tally[row.domainCode] = row.totalCount || 0;
    setCounts(tally);
    setResponsible(result.data.responsibilities || []);
    setLoading(false);
  }, [apply]);

  useEffect(() => {
    load();
  }, [load]);

  // Every active domain that is enabled for search and holds records is a path.
  // That is the same set global search can return. Child domains (a fund's
  // positions) are listed under their parent so "and the records under it" reads.
  const domains = useMemo<PathDomain[]>(() => {
    const active = domainRows.filter((row) => row.isActive && row.enabledForSearch !== false);
    const names = new Map(active.map((row) => [row.domainCode, row.domainName]));
    return active
      .map((row) => ({
        code: row.domainCode,
        name: row.domainName,
        description: row.description,
        count: counts[row.domainCode] || 0,
        groupName: row.group?.groupName || 'Other',
        groupOrder: row.group?.displayOrder ?? 9999,
        displayOrder: row.displayOrder || 0,
        children: active.filter((child) => child.parentDomainCode === row.domainCode).map((child) => names.get(child.domainCode) || child.domainCode),
        topLevel: !row.parentDomainCode || !names.has(row.parentDomainCode),
      }))
      .filter((row) => row.count > 0)
      .sort((a, b) => a.groupOrder - b.groupOrder || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  }, [domainRows, counts]);

  const [showAll, setShowAll] = useState(false);
  // The domain of each followed record, so a domain's panel can list every record followed in it.
  const [followDomains, setFollowDomains] = useState<Record<string, string>>({});
  useEffect(() => {
    const missing = follows.filter((f) => f.subjectType === 'ENTITY' && f.subjectId && !(f.subjectId in followDomains)).map((f) => f.subjectId as string);
    if (missing.length === 0) return;
    let stale = false;
    const fields = missing.map((id, index) => `e${index}: entity(id: ${JSON.stringify(id)}) { id domainCode }`).join(' ');
    graphqlQuery<Record<string, { id: string; domainCode: string } | null>>(`query AssistantFollowDomains { ${fields} }`, {}, 'network-only').then((result) => {
      if (stale) return;
      const found: Record<string, string> = {};
      missing.forEach((id, index) => {
        found[id] = result.data?.[`e${index}`]?.domainCode || '';
      });
      setFollowDomains((current) => ({ ...current, ...found }));
    });
    return () => {
      stale = true;
    };
  }, [follows, followDomains]);
  const followingIn = useCallback(
    (code: string) => follows.filter((f) => f.subjectType === 'ENTITY' && f.subjectId && followDomains[f.subjectId] === code),
    [follows, followDomains],
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (path) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [path]);
  const openCode = path?.type === 'DOMAIN' ? path.code : null;
  const hiddenCount = domains.filter((d) => !d.topLevel).length;
  const groups = useMemo(() => {
    const out: { name: string; domains: PathDomain[] }[] = [];
    for (const domain of domains) {
      if (!showAll && !domain.topLevel && domain.code !== openCode) continue;
      const last = out[out.length - 1];
      if (last && last.name === domain.groupName) last.domains.push(domain);
      else out.push({ name: domain.groupName, domains: [domain] });
    }
    return out;
  }, [domains, showAll, openCode]);

  const domainName = useCallback((code: string | null | undefined) => {
    if (!code) return '';
    return domainRows.find((row) => row.domainCode === code)?.domainName || code;
  }, [domainRows]);

  const followedRecord = useMemo(() => new Map(follows.filter((f) => f.subjectType === 'ENTITY' && f.subjectId).map((f) => [f.subjectId as string, f])), [follows]);
  const followedFeed = useMemo(() => new Map(follows.filter((f) => f.subjectType === 'FEED' && f.subjectId).map((f) => [f.subjectId as string, f])), [follows]);
  const followedKind = useMemo(() => new Map(follows.filter((f) => f.subjectType === 'KIND' && f.subjectCode).map((f) => [f.subjectCode as string, f])), [follows]);

  const recordFollows = follows.filter((f) => f.subjectType === 'ENTITY');
  const feedFollows = follows.filter((f) => f.subjectType === 'FEED');
  const kindFollows = follows.filter((f) => f.subjectType === 'KIND');

  const responsibleRecords = responsible.filter((r) => r.subjectType === 'ENTITY' && r.entityId);
  const responsibleDomains = Array.from(new Set(responsible.filter((r) => r.subjectType === 'DOMAIN' && r.domainCode).map((r) => r.domainCode as string)));
  const suggestions = responsibleRecords.filter((r) => !followedRecord.has(r.entityId as string));

  const activeDomain = path?.type === 'DOMAIN' ? domains.find((d) => d.code === path.code) || null : null;

  // Records for the open domain: the first page on open, then as the filter changes.
  useEffect(() => {
    if (path?.type !== 'DOMAIN') return;
    let stale = false;
    setRecordsLoading(true);
    const timer = setTimeout(async () => {
      const result = await graphqlQuery<{ workflowRecordChoices: RecordChoice[] }>(
        RECORDS_QUERY,
        { domainCode: path.code, search: filter.trim() || null, first: RECORD_PAGE },
        'network-only',
      );
      if (stale) return;
      setRecordsLoading(false);
      if (result.error) {
        setMessage(result.error.message || 'The records could not be listed.');
        return;
      }
      setRecords(result.data?.workflowRecordChoices || []);
    }, filter ? 250 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [path, filter]);

  const openPath = (next: Path) => {
    setMessage('');
    setFilter('');
    setRecords(null);
    setPath((current) => (JSON.stringify(current) === JSON.stringify(next) ? null : next));
    if (next?.type === 'DOMAIN') setWithChildren(true);
  };

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

  const addFollow = async (
    key: string,
    input: { subjectType: string; subjectId?: string; subjectCode?: string; delivery: string },
    children = false,
  ): Promise<Follow | null> => {
    setMessage('');
    setBusy(key);
    const result = await graphqlMutation<{ saveAssistantFollow: { follow: Follow | null; errors: { message: string }[] } }>(SAVE_FOLLOW, { input });
    const saved = result.data?.saveAssistantFollow;
    if (result.error || !saved || saved.errors.length > 0 || !saved.follow) {
      setBusy(null);
      setMessage(saved?.errors[0]?.message || result.error?.message || 'That could not be followed.');
      return null;
    }
    let follow = saved.follow;
    if (children && input.subjectType === 'ENTITY') {
      const withKids = await graphqlMutation<{ setAssistantFollowChildren: { follow: Follow | null; errors: { message: string }[] } }>(SET_FOLLOW_CHILDREN, {
        id: follow.id,
        includeChildren: true,
      });
      if (withKids.data?.setAssistantFollowChildren?.follow) follow = withKids.data.setAssistantFollowChildren.follow;
    }
    setFollows((current) => [...current, follow]);
    setBusy(null);
    return follow;
  };

  const removeFollow = async (id: string): Promise<boolean> => {
    setMessage('');
    setBusy(id);
    const result = await graphqlMutation<{ deleteAssistantFollow: { success: boolean; errors: { message: string }[] } }>(DELETE_FOLLOW, { id });
    const removed = result.data?.deleteAssistantFollow;
    setBusy(null);
    if (result.error || !removed?.success) {
      setMessage(removed?.errors[0]?.message || result.error?.message || 'That follow could not be removed.');
      return false;
    }
    setFollows((current) => current.filter((follow) => follow.id !== id));
    return true;
  };

  const setFollowChildren = async (id: string, includeChildren: boolean) => {
    setMessage('');
    const result = await graphqlMutation<{ setAssistantFollowChildren: { follow: Follow | null; errors: { message: string }[] } }>(SET_FOLLOW_CHILDREN, {
      id,
      includeChildren,
    });
    const saved = result.data?.setAssistantFollowChildren;
    if (result.error || !saved || saved.errors.length > 0 || !saved.follow) {
      setMessage(saved?.errors[0]?.message || result.error?.message || 'That could not be changed.');
      return;
    }
    setFollows((current) => current.map((follow) => (follow.id === id ? (saved.follow as Follow) : follow)));
  };

  // There is no edit for how a follow is told, so a change replaces the follow.
  const changeDelivery = async (follow: Follow, next: string) => {
    if (follow.delivery === next) return;
    if (!(await removeFollow(follow.id))) return;
    await addFollow(
      follow.id,
      { subjectType: follow.subjectType, subjectId: follow.subjectId || undefined, subjectCode: follow.subjectCode || undefined, delivery: next },
      follow.includeChildren === true,
    );
  };

  const toggleRecord = (record: { id: string; domainCode?: string }, children: boolean) => {
    const existing = followedRecord.get(record.id);
    if (existing) return removeFollow(existing.id);
    if (record.domainCode) setFollowDomains((current) => ({ ...current, [record.id]: record.domainCode as string }));
    return addFollow(record.id, { subjectType: 'ENTITY', subjectId: record.id, delivery }, children);
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
      setHits(null);
      return;
    }
    const result = await graphqlQuery<{ searchEntities: RecordChoice[] }, { query: string }>(SEARCH_QUERY, { query: text }, 'network-only');
    if (result.error) {
      setMessage(result.error.message || 'The search failed.');
      return;
    }
    setHits(result.data?.searchEntities || []);
  };

  const watching = follows.length + responsibleRecords.length + responsibleDomains.length;
  const step1Done = watching > 0;
  const step3Done = settings?.enabled === true;
  const next = settings ? nextSummary(settings.nextDeliveryAt, settings.timezone) : null;
  const status = !settings
    ? ''
    : !settings.enabled
      ? 'Summaries are off'
      : settings.preset === 'URGENT_ONLY'
        ? 'On: only urgent notes'
        : next
          ? `On: next summary ${next}`
          : 'On';

  usePublishPageData(
    loading || !settings
      ? null
      : {
          howToRead:
            'Step 1 offers paths built from what is registered: each domain with records, and the incoming file feeds. "In my summary" means the change waits for the scheduled summary; "Right away" sends it on its own when it is recorded. Records the person is responsible for already reach the summary without a follow.',
          steps: {
            addSupportingRecords: { openPath: path?.type === 'DOMAIN' ? domainName(path.code) : path?.type === 'FILES' ? 'Incoming files' : path?.type === 'SEARCH' ? 'Search' : null },
            whatYouFollow: { count: follows.length },
            whenToTellYou: { done: step3Done, status },
          },
          paths: {
            domains: domains.map((d) => ({ domain: d.name, records: d.count, recordsUnderEach: d.children })),
            files: { feeds: feeds.length, followedFeeds: feedFollows.length, followedKinds: kindFollows.map((f) => f.label) },
          },
          following: follows.map((f) => ({
            what: f.label,
            type: f.subjectType === 'ENTITY' ? 'record' : f.subjectType === 'FEED' ? 'feed' : 'kind of file change',
            tell: f.delivery === 'IMMEDIATE' ? 'right away' : 'in the summary',
            includesRecordsUnder: f.subjectType === 'ENTITY' ? f.includeChildren === true : undefined,
          })),
          responsibleFor: {
            records: responsibleRecords.map((r) => ({ record: r.entityName, domain: domainName(r.domainCode), followed: followedRecord.has(r.entityId as string) })),
            domains: responsibleDomains.map(domainName),
          },
          schedule: { enabled: settings.enabled, summary: PRESETS.find((p) => p.value === settings.preset)?.label, timezone: settings.timezone, morningHour: settings.morningHour, nextSummary: next },
        },
  );

  const deliveryPicker = (
    <div className="as-seg" role="radiogroup" aria-label="How to tell you">
      <span className="as-seg-label">Tell me</span>
      {(['DIGEST', 'IMMEDIATE'] as const).map((value) => (
        <button key={value} type="button" role="radio" aria-checked={delivery === value} className={`as-seg-btn${delivery === value ? ' on' : ''}`} onClick={() => setDelivery(value)}>
          {value === 'DIGEST' ? 'In my summary' : 'Right away'}
        </button>
      ))}
    </div>
  );

  const recordRow = (record: RecordChoice, children: boolean, extra?: React.ReactNode, href?: string) => {
    const existing = followedRecord.get(record.id);
    return (
      <li key={record.id} className={`as-item${existing ? ' following' : ''}`}>
        <div className="as-item-main">
          {href ? (
            <Link href={href} className="as-item-name entity-link">{record.entityName}</Link>
          ) : (
            <span className="as-item-name">{record.entityName}</span>
          )}
          {extra}
        </div>
        <button
          type="button"
          className={`btn btn-sm${existing ? ' as-following' : ''}`}
          disabled={busy === record.id || (existing ? busy === existing.id : false)}
          onClick={() => toggleRecord(record, children)}
          title={existing ? 'Click to stop following' : undefined}
        >
          {existing ? 'Following' : 'Follow'}
        </button>
      </li>
    );
  };

  const followingGroup = (rows: React.ReactNode[]) =>
    rows.length === 0 ? null : (
      <div className="as-following-group">
        <div className="as-sub as-sub-following">Following ({rows.length})</div>
        <ul className="as-list">{rows}</ul>
      </div>
    );

  const kindRow = (kind: (typeof KINDS)[number]) => {
    const existing = followedKind.get(kind.code);
    return (
      <li key={kind.code} className={`as-item${existing ? ' following' : ''}`}>
        <div className="as-item-main">
          <span className="as-item-name">{kind.label}</span>
          <span className="as-tag">{existing ? 'Every feed · ' : ''}{kind.detail}</span>
        </div>
        <button
          type="button"
          className={`btn btn-sm${existing ? ' as-following' : ''}`}
          disabled={busy === kind.code || (existing ? busy === existing.id : false)}
          onClick={() => (existing ? removeFollow(existing.id) : addFollow(kind.code, { subjectType: 'KIND', subjectCode: kind.code, delivery }))}
          title={existing ? 'Click to stop following' : undefined}
        >
          {existing ? 'Following' : 'Follow'}
        </button>
      </li>
    );
  };

  const feedRow = (feed: FeedOption) => {
    const existing = followedFeed.get(feed.id);
    const state = [feed.connectionName, feed.lastFileStatus ? FILE_STATUS[feed.lastFileStatus] || feed.lastFileStatus : 'No file yet', shortDate(feed.lastReceivedAt), feed.isActive ? '' : 'paused']
      .filter(Boolean)
      .join(' · ');
    return (
      <li key={feed.id} className={`as-item${existing ? ' following' : ''}`}>
        <div className="as-item-main">
          <span className="as-item-name">{feed.feedName}</span>
          <span className="as-tag">{state}</span>
        </div>
        <button
          type="button"
          className={`btn btn-sm${existing ? ' as-following' : ''}`}
          disabled={busy === feed.id || (existing ? busy === existing.id : false)}
          onClick={() => (existing ? removeFollow(existing.id) : addFollow(feed.id, { subjectType: 'FEED', subjectId: feed.id, delivery }))}
          title={existing ? 'Click to stop following' : undefined}
        >
          {existing ? 'Following' : 'Follow'}
        </button>
      </li>
    );
  };

  return (
    <div className="as">
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-title">Assistant</div>
          <div className="page-meta">Tell the assistant what to watch. It stays quiet until something you follow changes, then tells you in a summary or right away.</div>
        </div>
        <div className="page-actions">
          {settings && <span className={`as-status${settings.enabled ? ' on' : ''}`}>{status}</span>}
          <button type="button" className="btn" onClick={summarizeNow} disabled={!step1Done}>
            Summarize now
          </button>
        </div>
      </div>

      {message && <p className="as-message">{message}</p>}
      {loading ? (
        <p className="as-note">Loading&hellip;</p>
      ) : !settings ? null : (
        <>
          <section className="as-step">
            <header className="as-step-head">
              <span className={`as-step-num${follows.length > 0 ? ' done' : ''}`}>{follows.length > 0 ? '✓' : '1'}</span>
              <div>
                <h2 className="as-step-title">What you follow</h2>
                <p className="as-note">
                  {follows.length === 0 ? 'Nothing yet. Add records, feeds, or kinds of file change in step 2.' : 'Change how each one reaches you, or stop following it. Add more in step 2.'}
                </p>
              </div>
            </header>
            {[
              { title: 'Records', rows: recordFollows },
              { title: 'Feeds', rows: feedFollows },
              { title: 'Kinds of file change', rows: kindFollows },
            ]
              .filter((block) => block.rows.length > 0)
              .map((block) => (
                <div key={block.title} className="as-panel">
                  <div className="as-sub">{block.title}</div>
                  <ul className="as-list">
                    {block.rows.map((follow) => (
                      <li key={follow.id} className="as-item following">
                        <div className="as-item-main">
                          <span className="as-item-name">{follow.label}</span>
                          {follow.subjectType === 'ENTITY' && follow.subjectId && followDomains[follow.subjectId] && <span className="as-tag">{domainName(followDomains[follow.subjectId])}</span>}
                          {follow.subjectType === 'ENTITY' && (
                            <label className="as-check small">
                              <input type="checkbox" checked={follow.includeChildren === true} onChange={(event) => setFollowChildren(follow.id, event.target.checked)} />
                              And the records under it, such as a fund&rsquo;s positions (in your summary)
                            </label>
                          )}
                        </div>
                        <div className="as-item-actions">
                          <select
                            className="text-input as-select"
                            value={follow.delivery}
                            disabled={busy === follow.id}
                            onChange={(event) => changeDelivery(follow, event.target.value)}
                            aria-label={`How to tell you about ${follow.label}`}
                          >
                            <option value="DIGEST">In my summary</option>
                            <option value="IMMEDIATE">Right away</option>
                          </select>
                          <button type="button" className="btn btn-sm" disabled={busy === follow.id} onClick={() => removeFollow(follow.id)}>
                            Stop
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            {(responsibleRecords.length > 0 || responsibleDomains.length > 0) && (
              <div className="as-callout as-callout-follow">
                <div className="as-callout-title">Also watched because you are responsible</div>
                <p className="as-note">
                  You are responsible for{' '}
                  {[
                    responsibleRecords.length > 0 ? plural(responsibleRecords.length, 'record') : '',
                    responsibleDomains.length > 0 ? `every record in ${responsibleDomains.map(domainName).join(', ')}` : '',
                  ]
                    .filter(Boolean)
                    .join(' and ')}
                  . Changes to these reach your summary without a follow. Follow one to hear about it right away.
                </p>
                {suggestions.length > 0 && (
                  <ul className="as-list">
                    {suggestions.slice(0, 6).map((r) =>
                      recordRow(
                        { id: r.entityId as string, entityName: r.entityName || 'Record', domainCode: r.domainCode || '' },
                        r.includeChildren,
                        <span className="as-tag">{domainName(r.domainCode)}{r.activityName ? ` · ${r.activityName}` : ''}</span>,
                      ),
                    )}
                  </ul>
                )}
              </div>
            )}

          </section>

          <section className="as-step">
            <header className="as-step-head">
              <span className="as-step-num add">2</span>
              <div>
                <h2 className="as-step-title">Add supporting records</h2>
                <p className="as-note">Pick a starting point. Each one lists what is in the app now, so you choose from real records and feeds.</p>
              </div>
            </header>

            {groups.map((group) => (
              <div key={group.name} className="as-group">
                <div className="as-group-name">{group.name}</div>
                <div className="as-paths">
                  {group.domains.map((d) => (
                    <button
                      key={d.code}
                      type="button"
                      className={`as-path${path?.type === 'DOMAIN' && path.code === d.code ? ' open' : ''}`}
                      onClick={() => openPath({ type: 'DOMAIN', code: d.code })}
                      aria-expanded={path?.type === 'DOMAIN' && path.code === d.code}
                    >
                      <span className="as-path-name">{d.name}</span>
                      <span className="as-path-meta">{plural(d.count, 'record')}{d.children.length > 0 ? ` · with ${childText(d.children)}` : ''}</span>
                      {followingIn(d.code).length > 0 && <span className="as-path-badge">Following {followingIn(d.code).length}</span>}
                    </button>
                  ))}
                </div>
              {activeDomain && group.domains.some((d) => d.code === activeDomain.code) && (
                <div className="as-panel as-panel-inline" ref={panelRef}>
                  <div className="as-panel-head">
                    <div>
                      <div className="as-panel-title">{activeDomain.name}</div>
                      <p className="as-note">
                        You hear when a value on a record you follow changes.
                        {activeDomain.description ? ` ${activeDomain.description}` : ''}
                      </p>
                    </div>
                    {deliveryPicker}
                  </div>
                  {activeDomain.children.length > 0 && (
                    <label className="as-check">
                      <input type="checkbox" checked={withChildren} onChange={(event) => setWithChildren(event.target.checked)} />
                      Also the records under each one ({childText(activeDomain.children)}). Those arrive in your summary.
                    </label>
                  )}
                  <input
                    className="text-input as-filter"
                    value={filter}
                    placeholder={`Filter the ${plural(activeDomain.count, 'record')} by name or code`}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  {followingGroup(
                    followingIn(activeDomain.code)
                      .filter((f) => !filter.trim() || f.label.toLowerCase().includes(filter.trim().toLowerCase()))
                      .map((f) => recordRow({ id: f.subjectId as string, entityName: f.label, domainCode: activeDomain.code }, f.includeChildren === true)),
                  )}
                  {records === null || (recordsLoading && records.length === 0) ? (
                    <p className="as-note">Listing records&hellip;</p>
                  ) : records.filter((record) => !followedRecord.has(record.id)).length === 0 ? (
                    <p className="as-note">{filter ? <>No other record matches &ldquo;{filter}&rdquo;.</> : 'You follow every record listed here.'}</p>
                  ) : (
                    <>
                      {followingIn(activeDomain.code).length > 0 && <div className="as-sub">Not followed</div>}
                      <ul className="as-list">
                        {records.filter((record) => !followedRecord.has(record.id)).map((record) => recordRow(record, activeDomain.children.length > 0 && withChildren))}
                      </ul>
                      {!filter && activeDomain.count > records.length && (
                        <p className="as-note">Showing the first {records.length} of {activeDomain.count}. Type in the filter to find the rest.</p>
                      )}
                    </>
                  )}
                </div>
              )}
              </div>
            ))}

            {hiddenCount > 0 && (
              <div className="as-group">
                <button type="button" className="as-more" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show only the main types of record' : `Show every type of record (${hiddenCount} more, such as ${domains.filter((d) => !d.topLevel).slice(0, 3).map((d) => d.name.toLowerCase()).join(', ')})`}
                </button>
              </div>
            )}

            <div className="as-group">
              <div className="as-group-name">Incoming data</div>
              <div className="as-paths">
                <button type="button" className={`as-path${path?.type === 'FILES' ? ' open' : ''}`} onClick={() => openPath({ type: 'FILES' })} aria-expanded={path?.type === 'FILES'}>
                  <span className="as-path-name">Files and feeds</span>
                  <span className="as-path-meta">{feeds.length === 0 ? 'Late, failed, or waiting files' : `${plural(feeds.length, 'feed')} · late, failed, or waiting files`}</span>
                </button>
                <button type="button" className={`as-path${path?.type === 'SEARCH' ? ' open' : ''}`} onClick={() => openPath({ type: 'SEARCH' })} aria-expanded={path?.type === 'SEARCH'}>
                  <span className="as-path-name">Find a record by name</span>
                  <span className="as-path-meta">When you know what you are looking for</span>
                </button>
              </div>
            </div>

            {path?.type === 'FILES' && (
              <div className="as-panel as-panel-inline" ref={panelRef}>
                <div className="as-panel-head">
                  <div>
                    <div className="as-panel-title">Files and feeds</div>
                    <p className="as-note">Watch every feed for one kind of problem, or follow one feed to hear about everything it receives.</p>
                  </div>
                  {deliveryPicker}
                </div>
                {followingGroup([...KINDS.filter((k) => followedKind.has(k.code)).map(kindRow), ...feeds.filter((f) => followedFeed.has(f.id)).map(feedRow)])}
                {KINDS.some((k) => !followedKind.has(k.code)) && (
                  <>
                    <div className="as-sub">Across every feed</div>
                    <ul className="as-list">{KINDS.filter((k) => !followedKind.has(k.code)).map(kindRow)}</ul>
                  </>
                )}
                {feeds.length === 0 ? (
                  <>
                    <div className="as-sub">One feed</div>
                    <p className="as-note">
                      No feeds are set up yet. <a href="/admin/feeds" className="as-link">Set up a feed</a> to follow its files.
                    </p>
                  </>
                ) : (
                  feeds.some((f) => !followedFeed.has(f.id)) && (
                    <>
                      <div className="as-sub">One feed</div>
                      <ul className="as-list">{feeds.filter((f) => !followedFeed.has(f.id)).map(feedRow)}</ul>
                    </>
                  )
                )}
              </div>
            )}

            {path?.type === 'SEARCH' && (
              <div className="as-panel as-panel-inline" ref={panelRef}>
                <div className="as-panel-head">
                  <div>
                    <div className="as-panel-title">Find a record by name</div>
                    <p className="as-note">Searches record names and the names of the records they belong to.</p>
                  </div>
                  {deliveryPicker}
                </div>
                <form
                  className="as-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    search();
                  }}
                >
                  <input className="text-input" value={query} placeholder="A fund, investor, deal, or security" onChange={(event) => setQuery(event.target.value)} autoFocus />
                  <button type="submit" className="btn">Search</button>
                </form>
                {hits !== null &&
                  (hits.length === 0 ? (
                    <p className="as-note">Nothing matches &ldquo;{query}&rdquo;.</p>
                  ) : (
                    groupRecordsByType(hits, (hit) => entityTypeName(hit.domainCode, domainName(hit.domainCode), hit.domainName)).map((group) => (
                      <section key={group.code || group.name} className="as-type">
                        <Link href={group.href} className="as-type-link">{group.name}</Link>
                        <ul className="as-list">
                          {group.records.map((hit) => recordRow(hit, false, undefined, hit.href))}
                        </ul>
                      </section>
                    ))
                  ))}
              </div>
            )}
          </section>

          <section className="as-step">
            <header className="as-step-head">
              <span className={`as-step-num${step3Done ? ' done' : ''}`}>{step3Done ? '✓' : '3'}</span>
              <div>
                <h2 className="as-step-title">When should it tell you?</h2>
                <p className="as-note">&ldquo;Right away&rdquo; follows are sent as they happen whatever you choose here. Everything else waits for the summary.</p>
              </div>
            </header>
            <div className="as-panel">
              <label className="as-check">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                Send me summaries
              </label>
              <div className={`as-presets${enabled ? '' : ' off'}`} role="radiogroup" aria-label="Summary schedule">
                {PRESETS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={preset === item.value}
                    disabled={!enabled}
                    className={`as-preset${preset === item.value ? ' on' : ''}`}
                    onClick={() => setPreset(item.value)}
                  >
                    <span className="as-path-name">{item.label}</span>
                    <span className="as-path-meta">{item.detail}</span>
                  </button>
                ))}
              </div>
              {enabled && preset !== 'URGENT_ONLY' && (
                <div className="as-row">
                  {preset === 'WEEKDAY_MORNING' && (
                    <label className="as-field">
                      <span className="as-label">At</span>
                      <select className="text-input" value={String(morningHour)} onChange={(event) => setMorningHour(Number(event.target.value))}>
                        {Array.from({ length: 24 }, (_, hour) => (
                          <option key={hour} value={hour}>{`${hour}:00`}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="as-field">
                    <span className="as-label">Time zone</span>
                    <select className="text-input" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                      {zones.map((zone) => (
                        <option key={zone} value={zone}>{zone}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <div className="as-row">
                <button type="button" className="btn btn-primary" onClick={saveSettings} disabled={saving}>
                  {saving ? 'Saving…' : 'Save schedule'}
                </button>
                {!step1Done && enabled && <span className="as-note">Nothing is watched yet, so a summary would be empty. Add something in step 2.</span>}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
