'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { authHeaders } from '@/lib/reporting';
import { usePublishTabs } from '@/lib/view-context';
import { blueprintMarkdown, type FieldMapping, type SurfaceBlueprint, type SurfaceRequest } from '@/lib/surface-builder/blueprint';
import { BUILDER_TABS, builderTabs, type BuilderTabKey } from '@/lib/surface-builder/tabs';
import type { SavedBlueprint, SavedBlueprintSummary } from '@/lib/surface-builder/records';

interface CatalogInfo {
  domains: Array<{ code: string; name: string }>;
  counts: Record<string, number>;
  skills: string[];
  gaps: string[];
}

type Draft = Omit<SurfaceRequest, 'placement'> & { placement: NonNullable<SurfaceRequest['placement']> };

const DRAFT_KEY = 'tapestr-surface-builder-draft';
const EMPTY: Draft = { name: '', description: '', domainCode: '', audience: '', placement: 'record-tab', html: '' };

const PLACEMENTS: Array<{ value: Draft['placement']; label: string; hint: string }> = [
  { value: 'record-tab', label: 'Tab on a record', hint: 'A tab on an entity\u2019s golden record or surface, chosen by qualification rules.' },
  { value: 'sdk-surface', label: 'Client surface (SDK)', hint: 'A screen under surfaces/<code>/ at /s/<code>, built only on the surface SDK.' },
  { value: 'app-page', label: 'Platform page', hint: 'A core page in the web app, available to every client.' },
];

function readDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return { ...EMPTY, ...parsed };
  } catch {
    return EMPTY;
  }
}

function saveDraft(draft: Draft, blueprint: SurfaceBlueprint | null) {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, html: draft.html.length > 300_000 ? '' : draft.html }));
    if (blueprint) window.localStorage.setItem(`${DRAFT_KEY}-result`, JSON.stringify(blueprint));
  } catch {
    // Storage is a convenience; a full or blocked store loses only the draft.
  }
}

function readOpenId(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('blueprint');
    return fromUrl || window.localStorage.getItem(`${DRAFT_KEY}-id`);
  } catch {
    return null;
  }
}

/** Remember which saved blueprint is open, in the URL (to share) and in storage (to come back to). */
function rememberOpenId(id: string | null) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('blueprint', id);
    else url.searchParams.delete('blueprint');
    window.history.replaceState(window.history.state, '', url.toString());
    if (id) window.localStorage.setItem(`${DRAFT_KEY}-id`, id);
    else window.localStorage.removeItem(`${DRAFT_KEY}-id`);
  } catch {
    // A blocked store only loses the reminder.
  }
}

/** What a save stores, as one string, so the page can tell when there are unsaved changes. */
function snapshotOf(draft: Draft, blueprint: SurfaceBlueprint | null): string {
  return JSON.stringify([draft.name, draft.description, draft.domainCode || '', draft.audience || '', draft.placement, draft.html, blueprint]);
}

function draftFromSaved(saved: SavedBlueprint): Draft {
  return {
    name: saved.name,
    description: saved.description,
    domainCode: saved.domainCode || '',
    audience: saved.audience || '',
    placement: saved.placement || 'record-tab',
    html: saved.html,
  };
}

function readSavedBlueprint(): SurfaceBlueprint | null {
  try {
    const raw = window.localStorage.getItem(`${DRAFT_KEY}-result`);
    return raw ? (JSON.parse(raw) as SurfaceBlueprint) : null;
  } catch {
    return null;
  }
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'surface';
}

const LEVEL_TEXT: Record<string, string> = { meets: 'Meets', todo: 'To build', gap: 'Gap' };
const STATUS_TEXT: Record<string, string> = { exists: 'Exists', extend: 'Extend', new: 'New' };
const DECISIONS: FieldMapping['decision'][] = ['reuse', 'new', 'derived', 'ui'];

export function SurfaceBuilder() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [blueprint, setBlueprint] = useState<SurfaceBlueprint | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<BuilderTabKey>('overview');
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [useModel, setUseModel] = useState(true);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedList, setSavedList] = useState<SavedBlueprintSummary[]>([]);
  const [savedUnavailable, setSavedUnavailable] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loaded = useRef(false);

  async function refreshList() {
    try {
      const res = await fetch('/api/surface-builder/blueprints', { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSavedUnavailable(body.error || `Saved blueprints could not be read (${res.status}).`);
        return;
      }
      setSavedUnavailable(body.unavailable || null);
      setSavedList((body.blueprints || []) as SavedBlueprintSummary[]);
    } catch {
      setSavedUnavailable('Saved blueprints could not be read.');
    }
  }

  async function openSaved(id: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/surface-builder/blueprints/${encodeURIComponent(id)}`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.blueprint) {
      setError(body.error || `The blueprint could not be opened (${res.status}).`);
      if (res.status === 404) rememberOpenId(null);
      return;
    }
    const saved = body.blueprint as SavedBlueprint;
    const nextDraft = draftFromSaved(saved);
    setDraft(nextDraft);
    setBlueprint(saved.blueprint);
    setSavedId(saved.id);
    setSavedSnapshot(snapshotOf(nextDraft, saved.blueprint));
    setShowPreview(false);
    setTab('overview');
    rememberOpenId(saved.id);
  }

  function startNew() {
    setDraft(EMPTY);
    setBlueprint(null);
    setSavedId(null);
    setSavedSnapshot(null);
    setError(null);
    setNotice(null);
    rememberOpenId(null);
  }

  async function save(asNew: boolean) {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/surface-builder/blueprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ ...draft, id: asNew ? undefined : savedId || undefined, blueprint }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.blueprint) {
        setError(body.error || `The blueprint could not be saved (${res.status}).`);
        return;
      }
      const saved = body.blueprint as SavedBlueprint;
      setSavedId(saved.id);
      setSavedSnapshot(snapshotOf(draft, blueprint));
      rememberOpenId(saved.id);
      setNotice(`Saved as revision ${saved.revision}.`);
      void refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The blueprint could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function removeSaved() {
    if (!savedId) return;
    const name = savedList.find((item) => item.id === savedId)?.name || draft.name || 'this blueprint';
    if (!window.confirm(`Delete the saved blueprint "${name}"? This cannot be undone. The draft on screen is kept.`)) return;
    const res = await fetch(`/api/surface-builder/blueprints/${encodeURIComponent(savedId)}`, { method: 'DELETE', headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || `The blueprint could not be deleted (${res.status}).`);
      return;
    }
    setSavedId(null);
    setSavedSnapshot(null);
    rememberOpenId(null);
    setNotice(`Deleted "${name}". The draft is still on screen; Save to keep it.`);
    void refreshList();
  }

  useEffect(() => {
    const openId = readOpenId();
    if (openId) {
      void openSaved(openId);
    } else {
      setDraft(readDraft());
      setBlueprint(readSavedBlueprint());
    }
    loaded.current = true;
    void refreshList();
    let cancelled = false;
    fetch('/api/surface-builder/catalog', { headers: authHeaders() })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setCatalogError(body.error || `The catalog could not be read (${res.status}).`);
        else setCatalog(body as CatalogInfo);
      })
      .catch(() => { if (!cancelled) setCatalogError('The catalog could not be read.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => saveDraft(draft, blueprint), 400);
    return () => clearTimeout(timer);
  }, [draft, blueprint]);

  usePublishTabs(builderTabs(blueprint));

  const markdown = useMemo(() => (blueprint ? blueprintMarkdown(blueprint) : ''), [blueprint]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const ready = draft.name.trim() && draft.description.trim() && draft.html.trim();
  const currentSnapshot = useMemo(() => snapshotOf(draft, blueprint), [draft, blueprint]);
  const dirty = savedId ? currentSnapshot !== savedSnapshot : Boolean(draft.name || draft.html || blueprint);
  const openSummary = savedList.find((item) => item.id === savedId);

  async function analyze() {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/surface-builder/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ ...draft, domainCode: draft.domainCode || null, useModel }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.blueprint) {
        setError(body.error || `The analysis failed (${res.status}).`);
        return;
      }
      setBlueprint(body.blueprint as SurfaceBlueprint);
      setTab('overview');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The analysis failed.');
    } finally {
      setRunning(false);
    }
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 400_000) {
      setError(`${file.name} is ${Math.round(file.size / 1000)}KB; the limit is 400KB.`);
      return;
    }
    const text = await file.text();
    setDraft((current) => ({ ...current, html: text, name: current.name || file.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ') }));
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setError('The clipboard is not available here; use Download instead.');
    }
  }

  function updateField(index: number, patch: Partial<FieldMapping>) {
    setBlueprint((current) => {
      if (!current) return current;
      const fields = current.fields.map((field, i) => (i === index ? { ...field, ...patch } : field));
      return { ...current, fields };
    });
  }

  return (
    <div className="view-fade sb">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Surface Builder</span>
      </div>
      <div className="page-header">
        <div>
          <div className="page-title">Surface Builder</div>
          <div className="page-meta">
            Give a prototype and what the surface is for. The builder reads it against the entity model, tools, skills and house standards and writes the instructions to build it.
          </div>
        </div>
        {catalog && (
          <div className="sb-counts" aria-label="Catalog analyzed">
            <span><b>{catalog.counts.attributes}</b> attributes</span>
            <span><b>{catalog.counts.domains}</b> entity types</span>
            <span><b>{catalog.counts.tools}</b> tools</span>
            <span><b>{catalog.counts.skills}</b> skills</span>
            <span><b>{catalog.counts.surfaces}</b> surfaces</span>
          </div>
        )}
      </div>
      {catalogError && <div className="sb-alert">{catalogError}</div>}
      {catalog && catalog.gaps.length > 0 && <div className="sb-alert warn">Some of the catalog could not be read: {catalog.gaps.join(' \u00b7 ')}</div>}

      <div className="sb-saved" aria-label="Saved blueprints">
        <label>
          <span>Saved blueprints</span>
          <select
            value={savedId || ''}
            disabled={Boolean(savedUnavailable) && savedList.length === 0}
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              if (dirty && !window.confirm('Open another blueprint? Unsaved changes on screen will be lost.')) return;
              void openSaved(id);
            }}
          >
            <option value="">{savedList.length ? 'Open a saved blueprint\u2026' : 'None saved yet'}</option>
            {savedId && !openSummary && <option value={savedId}>{draft.name || 'Open blueprint'}</option>}
            {savedList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} {'\u00b7'} rev {item.revision} {'\u00b7'} {new Date(item.updatedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
        <span className="sb-saved-state">
          {savedId
            ? <>{dirty ? <b>Unsaved changes</b> : 'Saved'}{openSummary ? ` \u00b7 revision ${openSummary.revision}, ${new Date(openSummary.updatedAt).toLocaleString()}` : ''}</>
            : (dirty ? <b>Not saved</b> : 'New blueprint')}
        </span>
        <span className="sb-html-tools">
          <button type="button" className="btn btn-sm" onClick={() => { if (!dirty || window.confirm('Start a new blueprint? Unsaved changes on screen will be lost.')) startNew(); }}>New</button>
          {savedId && <button type="button" className="btn btn-sm" onClick={() => void removeSaved()}>Delete</button>}
        </span>
      </div>
      {savedUnavailable && <div className="sb-alert warn">{savedUnavailable}</div>}

      <section className="sb-inputs">
        <div className="sb-grid">
          <label>
            <span>Surface name</span>
            <input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Credit watchlist" />
          </label>
          <label>
            <span>Anchored on entity type</span>
            <select value={draft.domainCode || ''} onChange={(event) => set('domainCode', event.target.value)}>
              <option value="">None (spans records)</option>
              {(catalog?.domains || []).map((domain) => <option key={domain.code} value={domain.code}>{domain.name}</option>)}
            </select>
          </label>
          <label>
            <span>Placement</span>
            <select value={draft.placement} onChange={(event) => set('placement', event.target.value as Draft['placement'])} title={PLACEMENTS.find((p) => p.value === draft.placement)?.hint}>
              {PLACEMENTS.map((placement) => <option key={placement.value} value={placement.value}>{placement.label}</option>)}
            </select>
          </label>
          <label className="wide">
            <span>What the surface is for</span>
            <textarea rows={4} value={draft.description} onChange={(event) => set('description', event.target.value)} placeholder="What question it answers, what the user decides, what they change, what should happen automatically." />
          </label>
          <label className="wide">
            <span>Who uses it (optional)</span>
            <input value={draft.audience || ''} onChange={(event) => set('audience', event.target.value)} placeholder="e.g. Portfolio managers reviewing exceptions before IC" />
          </label>
          <div className="wide">
            <div className="sb-html-head">
              <span>Prototype HTML</span>
              <span className="sb-html-tools">
                <label className="btn btn-sm">
                  Upload .html
                  <input type="file" accept=".html,.htm,text/html" hidden onChange={(event) => { void loadFile(event.target.files?.[0]); event.target.value = ''; }} />
                </label>
                <button type="button" className="btn btn-sm" disabled={!draft.html} onClick={() => setShowPreview((value) => !value)}>{showPreview ? 'Hide preview' : 'Preview'}</button>
                {draft.html && <span className="sb-muted">{Math.round(draft.html.length / 1000)}KB</span>}
              </span>
            </div>
            {showPreview && draft.html
              ? <iframe className="sb-frame" title="Prototype preview" sandbox="allow-scripts" srcDoc={draft.html} />
              : <textarea className="sb-code" rows={10} value={draft.html} onChange={(event) => set('html', event.target.value)} placeholder="Paste the prototype page here." spellCheck={false} />}
          </div>
        </div>
        <div className="sb-actions">
          <label className="sb-check">
            <input type="checkbox" checked={useModel} onChange={(event) => setUseModel(event.target.checked)} />
            Refine with the model
          </label>
          {blueprint && <button type="button" className="btn" onClick={() => { setBlueprint(null); saveDraft(draft, null); try { window.localStorage.removeItem(`${DRAFT_KEY}-result`); } catch { /* ignore */ } }}>Clear result</button>}
          {savedId && <button type="button" className="btn" disabled={!draft.name.trim() || saving || Boolean(savedUnavailable)} onClick={() => void save(true)}>Save as new</button>}
          <button type="button" className="btn" disabled={!draft.name.trim() || saving || Boolean(savedUnavailable) || (Boolean(savedId) && !dirty)} onClick={() => void save(false)}>
            {saving ? 'Saving\u2026' : savedId ? 'Save changes' : 'Save'}
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready || running} onClick={() => void analyze()}>
            {running ? 'Analyzing\u2026' : blueprint ? 'Analyze again' : 'Analyze'}
          </button>
        </div>
        {error && <div className="sb-alert">{error}</div>}
        {notice && <div className="sb-notice">{notice}</div>}
      </section>

      {running && !blueprint && <div className="sb-empty">Reading the prototype against the catalog. A model-refined analysis takes up to a minute.</div>}
      {!running && !blueprint && <div className="sb-empty">No analysis yet. Fill in the name, purpose and prototype, then Analyze.</div>}

      {blueprint && (
        <section className="sb-result">
          <div className="sb-result-head">
            <div>
              <div className="sb-result-title">{blueprint.request.name}</div>
              <div className="sb-muted">
                {blueprint.source === 'model' ? 'Model-refined' : 'Baseline (no model)'}{' \u00b7 '}{new Date(blueprint.generatedAt).toLocaleString()}
              </div>
            </div>
            <div className="sb-html-tools">
              <button type="button" className="btn btn-sm" onClick={() => void copy(markdown, 'md')}>{copied === 'md' ? 'Copied' : 'Copy instructions'}</button>
              <button type="button" className="btn btn-sm" onClick={() => download(`${slug(blueprint.request.name)}-build.md`, markdown, 'text/markdown')}>Download .md</button>
              <button type="button" className="btn btn-sm" onClick={() => download(`${slug(blueprint.request.name)}-blueprint.json`, JSON.stringify(blueprint, null, 2), 'application/json')}>Download .json</button>
            </div>
          </div>

          <div className="sb-tabs" role="tablist">
            {BUILDER_TABS.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'on' : ''} onClick={() => setTab(item.key)}>
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <Overview blueprint={blueprint} />}
          {tab === 'entities' && <Entities blueprint={blueprint} onChange={updateField} />}
          {tab === 'capabilities' && <Capabilities blueprint={blueprint} />}
          {tab === 'workflows' && <Workflows blueprint={blueprint} />}
          {tab === 'standards' && <Standards blueprint={blueprint} />}
          {tab === 'build' && <Build blueprint={blueprint} />}
          {tab === 'artifacts' && <Artifacts blueprint={blueprint} onCopy={copy} copied={copied} />}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="sb-stat">
      <span className="sb-stat-label">{label}</span>
      <span className="sb-stat-value">{value}</span>
      {note && <span className="sb-stat-note">{note}</span>}
    </div>
  );
}

function Overview({ blueprint }: { blueprint: SurfaceBlueprint }) {
  const reuse = blueprint.fields.filter((field) => field.decision === 'reuse').length;
  const gaps = blueprint.standards.filter((finding) => finding.level === 'gap').length;
  const newCaps = blueprint.capabilities.filter((capability) => capability.status !== 'exists').length;
  return (
    <div className="sb-pane">
      <p className="sb-summary">{blueprint.summary}</p>
      <div className="sb-stats">
        <Stat label="Values mapped" value={`${reuse} / ${blueprint.fields.length}`} note="to existing attributes" />
        <Stat label="New attributes" value={blueprint.newAttributes.length} note="as seed records" />
        <Stat label="Capabilities to build" value={newCaps} note={`of ${blueprint.capabilities.length}`} />
        <Stat label="Workflows" value={blueprint.workflows.length} note="agentic" />
        <Stat label="Standard gaps" value={gaps} note={`${blueprint.standards.length} standards`} />
      </div>
      <div className="sb-two">
        <div>
          <h4>Prototype</h4>
          <dl className="sb-dl">
            <dt>Title</dt><dd>{blueprint.outline.title}</dd>
            <dt>Tabs</dt><dd>{blueprint.outline.tabs.join(', ') || 'None'}</dd>
            <dt>Tables</dt><dd>{blueprint.outline.tables.map((table) => `${table.title || 'Table'} (${table.columns.length} cols)`).join(', ') || 'None'}</dd>
            <dt>Charts</dt><dd>{blueprint.outline.charts.map((chart) => chart.title ? `${chart.kind} \u00b7 ${chart.title}` : chart.kind).join(', ') || 'None'}</dd>
            <dt>Actions</dt><dd>{blueprint.outline.actions.join(', ') || 'None'}</dd>
          </dl>
        </div>
        <div>
          <h4>Open questions</h4>
          {blueprint.openQuestions.length ? <ul>{blueprint.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul> : <p className="sb-muted">None raised.</p>}
          {blueprint.warnings.length > 0 && (
            <>
              <h4>Warnings</h4>
              <ul className="sb-warn">{blueprint.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </>
          )}
        </div>
      </div>
      <h4>Planned tabs</h4>
      <table className="sb-table">
        <thead><tr><th>Tab</th><th>Purpose</th><th>Publishes to the assistant</th></tr></thead>
        <tbody>
          {blueprint.tabs.map((tabPlan) => (
            <tr key={tabPlan.label}><td className="strong">{tabPlan.label}</td><td>{tabPlan.purpose}{tabPlan.howToRead && <div className="sb-muted">{tabPlan.howToRead}</div>}</td><td>{tabPlan.publishes}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Entities({ blueprint, onChange }: { blueprint: SurfaceBlueprint; onChange: (index: number, patch: Partial<FieldMapping>) => void }) {
  const candidates = new Map(blueprint.matches.map((match) => [match.label.toLowerCase(), match]));
  return (
    <div className="sb-pane">
      <p className="sb-muted">Change a decision here and the exported instructions follow it. Only codes marked reuse exist today.</p>
      <table className="sb-table">
        <thead><tr><th>Prototype value</th><th>Tab</th><th>Decision</th><th>Attribute</th><th>Entity type</th><th>Type</th><th>Editable</th><th>Note / other matches</th></tr></thead>
        <tbody>
          {blueprint.fields.map((field, index) => {
            const match = candidates.get(field.label.toLowerCase());
            const others = match?.candidates.filter((candidate) => candidate.code !== field.attributeCode) || [];
            return (
              <tr key={`${field.label}-${index}`}>
                <td className="strong">{field.label}</td>
                <td>{field.where || ''}</td>
                <td>
                  <select value={field.decision} aria-label={`Decision for ${field.label}`} onChange={(event) => onChange(index, { decision: event.target.value as FieldMapping['decision'] })}>
                    {DECISIONS.map((decision) => <option key={decision} value={decision}>{decision}</option>)}
                  </select>
                </td>
                <td className="mono">{field.attributeCode || ''}</td>
                <td>{field.domainCode || ''}</td>
                <td>{field.dataType || ''}</td>
                <td><input type="checkbox" aria-label={`${field.label} editable`} checked={field.editable === true} disabled={field.decision === 'derived' || field.decision === 'ui'} onChange={(event) => onChange(index, { editable: event.target.checked })} /></td>
                <td>
                  {field.note}
                  {others.length > 0 && (
                    <div className="sb-muted">
                      Also: {others.map((candidate) => (
                        <button key={candidate.code} type="button" className="sb-link" onClick={() => onChange(index, { decision: 'reuse', attributeCode: candidate.code, domainCode: candidate.domainCode, dataType: candidate.dataType })}>
                          {candidate.code} ({candidate.score})
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {blueprint.fields.length === 0 && <tr><td colSpan={8} className="sb-muted">The prototype shows no labelled values.</td></tr>}
        </tbody>
      </table>
      <h4>New attributes to add</h4>
      {blueprint.newAttributes.length ? (
        <table className="sb-table">
          <thead><tr><th>Code</th><th>Name</th><th>Entity type</th><th>Type</th><th>Time-varying</th><th>Why</th></tr></thead>
          <tbody>
            {blueprint.newAttributes.map((attribute) => (
              <tr key={attribute.code}><td className="mono">{attribute.code}</td><td>{attribute.name}</td><td>{attribute.domainCode || ''}</td><td>{attribute.dataType}{attribute.listValues?.length ? ` (${attribute.listValues.join(', ')})` : ''}</td><td>{attribute.isTimeVarying ? 'Yes' : ''}</td><td>{attribute.reason}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p className="sb-muted">Every value maps to an existing or derived attribute.</p>}
      {blueprint.relationships.length > 0 && (
        <>
          <h4>Relationships</h4>
          <ul>{blueprint.relationships.map((item) => <li key={item}>{item}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function Capabilities({ blueprint }: { blueprint: SurfaceBlueprint }) {
  return (
    <div className="sb-pane">
      <table className="sb-table">
        <thead><tr><th>Capability</th><th>Status</th><th>Kind</th><th>What it needs</th><th>Tools</th></tr></thead>
        <tbody>
          {blueprint.capabilities.map((capability, index) => (
            <tr key={`${capability.title}-${index}`}>
              <td className="strong">{capability.title}</td>
              <td><span className={`sb-pill ${capability.status}`}>{STATUS_TEXT[capability.status]}</span></td>
              <td>{capability.kind}</td>
              <td>{capability.detail}</td>
              <td className="mono">{capability.tools.join(', ')}</td>
            </tr>
          ))}
          {blueprint.capabilities.length === 0 && <tr><td colSpan={5} className="sb-muted">No capabilities identified.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Workflows({ blueprint }: { blueprint: SurfaceBlueprint }) {
  if (blueprint.workflows.length === 0) {
    return <div className="sb-pane"><p className="sb-muted">No agentic workflow is needed{blueprint.source === 'baseline' ? ' yet. Workflows are proposed when the model refines the analysis.' : '.'}</p></div>;
  }
  return (
    <div className="sb-pane">
      <p className="sb-muted">An agent proposes, a person approves, a fixed step applies.</p>
      {blueprint.workflows.map((workflow) => (
        <div key={workflow.name} className="sb-card">
          <div className="strong">{workflow.name}</div>
          <div className="sb-muted">Trigger: {workflow.trigger}{' \u00b7 '}Outcome: {workflow.outcome}</div>
          <ol className="sb-steps">
            {workflow.steps.map((step, index) => (
              <li key={`${step.title}-${index}`}>
                <span className={`sb-kind ${step.kind}`}>{step.kind}</span>
                <b>{step.title}</b> {step.detail}
                {step.tools && step.tools.length > 0 && <span className="mono sb-muted"> ({step.tools.join(', ')})</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function Standards({ blueprint }: { blueprint: SurfaceBlueprint }) {
  return (
    <div className="sb-pane">
      <table className="sb-table">
        <thead><tr><th>Standard</th><th>Area</th><th>Status</th><th>What this surface must do</th></tr></thead>
        <tbody>
          {blueprint.standards.map((finding) => (
            <tr key={finding.id}>
              <td className="strong">{finding.title}</td>
              <td>{finding.area}</td>
              <td><span className={`sb-pill ${finding.level}`}>{LEVEL_TEXT[finding.level]}</span></td>
              <td>{finding.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {blueprint.uxNotes.length > 0 && (
        <>
          <h4>UX standardization</h4>
          <ul>{blueprint.uxNotes.map((note) => <li key={note}>{note}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function Build({ blueprint }: { blueprint: SurfaceBlueprint }) {
  return (
    <div className="sb-pane">
      <ol className="sb-build">
        {blueprint.buildSteps.map((step, index) => (
          <li key={`${step.title}-${index}`}>
            <div className="strong">{step.title}</div>
            <div>{step.detail}</div>
            {step.files.length > 0 && <div className="mono sb-muted">{step.files.join(' \u00b7 ')}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Artifacts({ blueprint, onCopy, copied }: { blueprint: SurfaceBlueprint; onCopy: (text: string, what: string) => void; copied: string | null }) {
  const [open, setOpen] = useState(0);
  if (blueprint.artifacts.length === 0) {
    return <div className="sb-pane"><p className="sb-muted">No HTML artifacts{blueprint.source === 'baseline' ? ' yet. Refined HTML is written when the model refines the analysis.' : '.'}</p></div>;
  }
  const current = blueprint.artifacts[Math.min(open, blueprint.artifacts.length - 1)];
  return (
    <div className="sb-pane">
      <div className="sb-chips">
        {blueprint.artifacts.map((artifact, index) => (
          <button key={`${artifact.title}-${index}`} type="button" className={index === open ? 'on' : ''} onClick={() => setOpen(index)}>{artifact.title}</button>
        ))}
      </div>
      <p>{current.purpose}</p>
      {current.html ? (
        <>
          <div className="sb-html-tools">
            <button type="button" className="btn btn-sm" onClick={() => onCopy(current.html!, `html-${open}`)}>{copied === `html-${open}` ? 'Copied' : 'Copy HTML'}</button>
            <button type="button" className="btn btn-sm" onClick={() => download(`${slug(current.title)}.html`, current.html!, 'text/html')}>Download .html</button>
          </div>
          <iframe className="sb-frame" title={current.title} sandbox="allow-scripts" srcDoc={current.html} />
        </>
      ) : <p className="sb-muted">Described only; no HTML was written for this artifact.</p>}
    </div>
  );
}
