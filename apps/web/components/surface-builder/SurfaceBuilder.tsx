'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { authHeaders } from '@/lib/reporting';
import { usePublishTabs } from '@/lib/view-context';
import { HandoffBlocked, handoffFiles, handoffFolder, handoffSlug } from '@/lib/surface-builder/handoff';
import { styleBlocks } from '@/lib/surface-builder/redesign';
import { zipFiles } from '@/lib/zip';
import { blueprintMarkdown, normalizeBlueprint, type FieldMapping, type PrototypeUnderstanding, type SurfaceBlueprint, type SurfaceRequest } from '@/lib/surface-builder/blueprint';
import { captureViews, type CapturedView } from '@/lib/surface-builder/capture';
import { houseDocument } from '@/lib/surface-builder/house-kit';
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
    return raw ? normalizeBlueprint(JSON.parse(raw) as SurfaceBlueprint) : null;
  } catch {
    return null;
  }
}

function download(name: string, content: string | Uint8Array<ArrayBuffer>, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'surface';
}

interface RedesignStatus {
  status: 'queued' | 'designing' | 'rendering' | 'checking' | 'done' | 'failed';
  note?: string;
}

const REDESIGN_TEXT: Record<RedesignStatus['status'], string> = {
  queued: 'Waiting',
  designing: 'Designing',
  rendering: 'Rendering for the check',
  checking: 'Checking against the original',
  done: 'Done',
  failed: 'Failed',
};

/** The captured views worth redesigning: one per distinct screen, in capture order. */
function distinctViews(views: CapturedView[]): string[] {
  const seen = new Set<string>();
  const keep = new Set<string>();
  // A named view wins over "Initial view" when they show the same screen.
  for (const view of [...views.filter((item) => item.label !== 'Initial view'), ...views.filter((item) => item.label === 'Initial view')]) {
    if (seen.has(view.html)) continue;
    seen.add(view.html);
    keep.add(view.label);
  }
  return views.map((view) => view.label).filter((label) => keep.has(label));
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
  const [tab, setTab] = useState<BuilderTabKey>('details');
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [useModel, setUseModel] = useState(true);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedList, setSavedList] = useState<SavedBlueprintSummary[]>([]);
  const [savedUnavailable, setSavedUnavailable] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [views, setViews] = useState<CapturedView[]>([]);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [captureHtml, setCaptureHtml] = useState<string | null>(null);
  const [understanding, setUnderstanding] = useState<PrototypeUnderstanding | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState<string | null>(null);
  const [kitCss, setKitCss] = useState<string | null>(null);
  const captureFrame = useRef<HTMLIFrameElement | null>(null);
  const kitLoad = useRef<Promise<string> | null>(null);
  const frameQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [redesigns, setRedesigns] = useState<Record<string, RedesignStatus>>({});
  const [redesigning, setRedesigning] = useState(false);
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
    const opened = saved.blueprint ? normalizeBlueprint(saved.blueprint) : null;
    setDraft(nextDraft);
    setBlueprint(opened);
    setUnderstanding(null);
    setViews([]);
    setSavedId(saved.id);
    setSavedSnapshot(snapshotOf(nextDraft, opened));
    setShowPreview(false);
    setTab(opened ? 'overview' : 'details');
    rememberOpenId(saved.id);
  }

  function startNew() {
    setDraft(EMPTY);
    setBlueprint(null);
    setUnderstanding(null);
    setViews([]);
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

  

  const markdown = useMemo(() => (blueprint ? blueprintMarkdown(blueprint) : ''), [blueprint]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const ready = draft.name.trim() && draft.description.trim() && draft.html.trim();
  const currentSnapshot = useMemo(() => snapshotOf(draft, blueprint), [draft, blueprint]);
  const dirty = savedId ? currentSnapshot !== savedSnapshot : Boolean(draft.name || draft.html || blueprint);
  const openSummary = savedList.find((item) => item.id === savedId);
  const details = useMemo(() => ({
    name: draft.name,
    description: draft.description,
    domainCode: draft.domainCode || null,
    audience: draft.audience,
    placement: draft.placement,
    prototypeKb: Math.round(draft.html.length / 1000),
    saved: savedId ? (dirty ? 'unsaved' as const : 'saved' as const) : 'new' as const,
    revision: openSummary?.revision,
  }), [draft, savedId, dirty, openSummary]);
  usePublishTabs(builderTabs(blueprint, details));

  /** Run the prototype in a sandboxed frame and capture each view and tab it reaches. */
  async function capture(): Promise<CapturedView[]> {
    const result = await captureIn(draft.html, 24, 'Opening the prototype\u2026');
    if (result.notes.length) setNotice(result.notes.join(' '));
    setViews(result.views);
    return result.views;
  }

  /**
   * Run a page in the sandboxed capture frame; with maxViews 1 it only
   * screenshots the page as it opens. There is one frame, so captures queue.
   */
  function captureIn(html: string, maxViews: number, opening: string): Promise<{ views: CapturedView[]; notes: string[] }> {
    const run = frameQueue.current.then(async () => {
      setCapturing(opening);
      setCaptureHtml(html);
      // Let the frame mount before the capture drives it.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const frame = captureFrame.current;
      if (!frame) {
        setCaptureHtml(null);
        setCapturing(null);
        return { views: [] as CapturedView[], notes: ['The capture frame could not be opened.'] };
      }
      const result = await captureViews(frame, html, {
        maxViews,
        onView: (label, count) => setCapturing(`Captured ${count} view${count === 1 ? '' : 's'}: ${label}`),
      });
      setCaptureHtml(null);
      setCapturing(null);
      return result;
    });
    frameQueue.current = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The house kit stylesheet, loaded once and shared by every preview and redesign. */
  function houseKit(): Promise<string> {
    if (!kitLoad.current) {
      kitLoad.current = fetch('/api/surface-builder/house-kit').then((res) => (res.ok ? res.text() : '')).catch(() => '');
      void kitLoad.current.then(setKitCss);
    }
    return kitLoad.current;
  }

  /** Download the handoff bundle: the brief, blueprint, prototype and redesigned views as one zip. */
  async function exportHandoff() {
    if (!blueprint) return;
    const kit = await houseKit();
    const originals = Object.fromEntries(views.filter((view) => view.image).map((view) => [view.label, view.image!]));
    let files;
    try {
      files = handoffFiles({ blueprint, kit, prototypeHtml: draft.html, originals });
    } catch (cause) {
      // A blueprint with a document attribute, or one reviewed before the entity model, is not handed off.
      if (cause instanceof HandoffBlocked) { setError(cause.message); return; }
      throw cause;
    }
    const folder = handoffFolder(blueprint);
    download(`${handoffSlug(blueprint.request.name)}-handoff.zip`, zipFiles(files) as Uint8Array<ArrayBuffer>, 'application/zip');
    const redesigned = blueprint.artifacts.filter((artifact) => artifact.html).length;
    setNotice(`Unzip it at the repo root, then ask Claude Code: "Build the surface in ${folder}/README.md".${redesigned ? '' : ' No views are redesigned yet, so the bundle has the blueprint only.'}${kit ? '' : ' The house kit could not be loaded, so the view previews are unstyled.'}`);
  }

  const markView = (label: string, status: RedesignStatus['status'], note?: string) =>
    setRedesigns((current) => ({ ...current, [label]: { status, note } }));

  /**
   * Redesign views in the house design, three at a time: the model writes each
   * from the view's markup and screenshot, then sees its own version rendered
   * next to the original and corrects what differs. Each finished view appears
   * in the HTML artifacts tab as it lands.
   */
  async function redesignViews(labels: string[], source: SurfaceBlueprint | null = blueprint, captured: CapturedView[] = views) {
    if (!source || redesigning) return;
    if (!captured.length && !draft.html.trim()) {
      setError('The prototype HTML is not loaded, so there is nothing to capture. Upload it on the Request tab first.');
      return;
    }
    setRedesigning(true);
    setRedesigns(Object.fromEntries(labels.map((label) => [label, { status: 'queued' as const }])));
    try {
      const pool = captured.length ? captured : await capture();
      // With no views known yet (an older blueprint), redesign every distinct view the capture found.
      if (!labels.length) {
        labels = distinctViews(pool);
        setRedesigns(Object.fromEntries(labels.map((label) => [label, { status: 'queued' as const }])));
        if (!labels.length) {
          setError('The capture found no views in the prototype.');
          return;
        }
      }
      const kit = await houseKit();
      if (!kit) {
        for (const label of labels) markView(label, 'failed', 'The house kit could not be loaded.');
        return;
      }
      // The first view goes alone: its x- classes (shell, rail, ribbon, tabs) become the shared
      // set every later view is told to reuse, so one class name never means two things.
      const queue = [...labels];
      const shared: string[] = source.artifacts.filter((item) => item.html && item.view && !labels.includes(item.view)).map((item) => styleBlocks(item.html!));
      const first = queue.shift();
      if (first) {
        const css = await redesignOne(first, source, pool, kit, shared.join('\n'));
        if (css) shared.push(css);
      }
      const worker = async () => {
        for (let label = queue.shift(); label; label = queue.shift()) {
          const css = await redesignOne(label, source, pool, kit, shared.join('\n'));
          if (css) shared.push(css);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } finally {
      setRedesigning(false);
    }
  }

  /** Redesign one view. Returns the x- rules it defined, for the views after it. */
  async function redesignOne(label: string, source: SurfaceBlueprint, pool: CapturedView[], kit: string, shared = ''): Promise<string | null> {
    const view = pool.find((item) => item.label === label);
    if (!view) {
      markView(label, 'failed', 'This view was not captured this time. Analyze again to capture it.');
      return null;
    }
    const segment = label.split(' \u203a ').pop() || label;
    const here = source.fields.filter((field) => field.where === label || field.where === segment);
    const payload = {
      name: source.request.name,
      view,
      purpose: source.tabs.find((tabPlan) => tabPlan.label === label || tabPlan.label === segment)?.purpose,
      bindings: (here.length ? here : source.fields).map((field) => ({ label: field.label, attributeCode: field.attributeCode, decision: field.decision, editable: field.editable })),
      shared: shared.slice(0, 30_000),
    };
    markView(label, 'designing');
    const first = await postRedesign(payload);
    if ('error' in first) {
      markView(label, 'failed', first.error);
      return null;
    }
    let final = { ...first, checked: false };
    let note: string | undefined;
    markView(label, 'rendering');
    const shot = await captureIn(houseDocument(first.html, kit), 1, `Rendering the redesign of "${label}"\u2026`);
    const image = shot.views[0]?.image;
    if (image) {
      markView(label, 'checking');
      const second = await postRedesign({ ...payload, check: { html: first.html, image } });
      if ('error' in second) note = `The check round failed (${second.error}); this is the first draft.`;
      else final = { ...second, checked: true };
    } else {
      note = 'The redesign could not be screenshotted, so it was not checked against the original.';
    }
    const artifact = {
      title: `${label} (house design)`,
      purpose: `${label}, redesigned in the house kit from the captured view${final.checked ? ' and checked against it' : ''}.`,
      html: final.html,
      view: label,
      notes: final.notes,
      checked: final.checked,
    };
    setBlueprint((current) => (current ? { ...current, artifacts: [...current.artifacts.filter((item) => item.view !== label), artifact] } : current));
    markView(label, 'done', note);
    return styleBlocks(final.html);
  }

  async function postRedesign(payload: Record<string, unknown>): Promise<{ html: string; notes: string[] } | { error: string }> {
    try {
      const res = await fetch('/api/surface-builder/redesign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.html !== 'string') return { error: body.error || `The redesign failed (${res.status}).` };
      return { html: body.html, notes: Array.isArray(body.notes) ? body.notes : [] };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : 'The redesign request failed.' };
    }
  }

  async function post(payload: Record<string, unknown>): Promise<any | null> {
    const res = await fetch('/api/surface-builder/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...draft, domainCode: draft.domainCode || null, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || `The analysis failed (${res.status}).`);
      return null;
    }
    return body;
  }

  /** Pass 1: capture, then ask the model what it understood and what it needs to know. */
  async function analyze() {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    setUnderstanding(null);
    setAnswers({});
    try {
      const captured = await capture();
      if (!useModel) {
        setStep('Reading the prototype against the catalog\u2026');
        const body = await post({ useModel: false, stage: 'blueprint', views: captured });
        if (body?.blueprint) {
          setBlueprint(normalizeBlueprint(body.blueprint as SurfaceBlueprint));
          setTab('overview');
        }
        return;
      }
      setStep(`Reviewing ${captured.length} view${captured.length === 1 ? '' : 's'} and the source against the catalog. This takes a few minutes.`);
      const body = await post({ useModel: true, stage: 'understand', views: captured });
      if (!body) return;
      if (body.stage !== 'understand' || !body.understanding) {
        // No model is configured: the baseline came back.
        if (body.blueprint) setBlueprint(normalizeBlueprint(body.blueprint as SurfaceBlueprint));
        return;
      }
      const read = body.understanding as PrototypeUnderstanding;
      setUnderstanding(read);
      if (read.questions.length === 0) await writeBlueprint(read, {}, captured);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The analysis failed.');
    } finally {
      setStep(null);
      setRunning(false);
    }
  }

  /** Pass 2: write the blueprint with the admin's answers (blank answers take the model's recommendation). */
  async function writeBlueprint(read: PrototypeUnderstanding | null = understanding, given: Record<string, string> = answers, captured: CapturedView[] = views) {
    setRunning(true);
    setError(null);
    setStep('Writing the blueprint: entity model, compliance mapping, calculations, tabs and build steps. This takes a few minutes.');
    try {
      const body = await post({ useModel: true, stage: 'blueprint', views: captured, understanding: read, answers: given });
      if (body?.blueprint) {
        const written = normalizeBlueprint(body.blueprint as SurfaceBlueprint);
        setBlueprint(written);
        setUnderstanding(null);
        setTab('artifacts');
        // The blueprint is done; redesign every distinct view in the house design next.
        const labels = distinctViews(captured);
        if (labels.length) void redesignViews(labels, written, captured);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The blueprint could not be written.');
    } finally {
      setStep(null);
      setRunning(false);
    }
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setError(`${file.name} is ${Math.round(file.size / 1000)}KB; the limit is 1,000KB.`);
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

      {savedUnavailable && <div className="sb-alert warn">{savedUnavailable}</div>}

      <div className="sb-layout">
        <SurfaceTree
          items={savedList}
          openId={savedId}
          draftName={draft.name}
          dirty={dirty}
          onOpen={(id) => {
            if (id === savedId) return;
            if (dirty && !window.confirm('Open another blueprint? Unsaved changes on screen will be lost.')) return;
            void openSaved(id);
          }}
          onNew={() => { if (!dirty || window.confirm('Start a new blueprint? Unsaved changes on screen will be lost.')) { startNew(); setTab('details'); } }}
        />

        <section className="sb-main sb-result">
          <div className="sb-result-head">
            <div>
              <div className="sb-result-title">{draft.name || blueprint?.request.name || 'New surface'}</div>
              <div className="sb-muted">
                {savedId
                  ? <>{dirty ? <b className="sb-unsaved">Unsaved changes</b> : 'Saved'}{openSummary ? <> &middot; revision {openSummary.revision}, {new Date(openSummary.updatedAt).toLocaleString()}</> : null}</>
                  : (dirty ? <b className="sb-unsaved">Not saved</b> : 'New blueprint')}
                {blueprint
                  ? <> &middot; {blueprint.source === 'model' ? `Model-reviewed${blueprint.model ? ` by ${blueprint.model}` : ''}` : 'Baseline (no model)'} &middot; {new Date(blueprint.generatedAt).toLocaleString()}{blueprint.outline.views?.length ? <> &middot; {blueprint.outline.views.length} views captured</> : null}</>
                  : <> &middot; Not analyzed yet</>}
              </div>
            </div>
            <div className="sb-html-tools">
              {blueprint && (
                <>
                  <button type="button" className="btn btn-primary btn-sm" disabled={redesigning} title="One .zip to unzip at the repo root: a brief for Claude Code, the blueprint, the prototype and every redesigned view" onClick={() => void exportHandoff()}>Build in Claude Code (.zip)</button>
                  <button type="button" className="btn btn-sm" onClick={() => void copy(markdown, 'md')}>{copied === 'md' ? 'Copied' : 'Copy instructions'}</button>
                  <button type="button" className="btn btn-sm" onClick={() => download(`${slug(blueprint.request.name)}-build.md`, markdown, 'text/markdown')}>Download .md</button>
                  <button type="button" className="btn btn-sm" onClick={() => download(`${slug(blueprint.request.name)}-blueprint.json`, JSON.stringify(blueprint, null, 2), 'application/json')}>Download .json</button>
                </>
              )}
              {savedId && <button type="button" className="btn btn-sm" onClick={() => void removeSaved()}>Delete</button>}
            </div>
          </div>

          <div className="sb-tabs" role="tablist">
            {BUILDER_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={tab === item.key ? 'on' : ''}
                disabled={item.key !== 'details' && !blueprint}
                title={item.key !== 'details' && !blueprint ? 'Analyze the prototype first' : undefined}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {error && <div className="sb-alert">{error}</div>}
          {notice && <div className="sb-notice">{notice}</div>}
          {captureHtml !== null && (
            <section className="sb-capture" aria-label="Capturing the prototype">
              <div className="sb-muted">{capturing || 'Capturing\u2026'} The builder clicks through each view and tab and takes a screenshot of each.</div>
              <div className="sb-capture-frame">
                <iframe ref={captureFrame} title="Prototype capture" sandbox="allow-scripts" width={1440} height={900} />
              </div>
            </section>
          )}
          {step && <div className="sb-empty">{step}</div>}
          {understanding && !running && (
            <Questions
              understanding={understanding}
              views={views}
              answers={answers}
              onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
              onWrite={() => void writeBlueprint()}
              onSkip={() => void writeBlueprint(understanding, {})}
            />
          )}

          {(tab === 'details' || !blueprint) && (
            <div className="sb-inputs">
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
                  <textarea rows={8} value={draft.description} onChange={(event) => set('description', event.target.value)} placeholder="What question it answers, what the user decides, what they change, what should happen automatically." />
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
                    : <textarea className="sb-code" rows={14} value={draft.html} onChange={(event) => set('html', event.target.value)} placeholder="Paste the prototype page here." spellCheck={false} />}
                </div>
              </div>
              <div className="sb-actions">
                <label className="sb-check">
                  <input type="checkbox" checked={useModel} onChange={(event) => setUseModel(event.target.checked)} />
                  Review with the model (asks you questions before it writes the blueprint)
                </label>
                {blueprint && <button type="button" className="btn" onClick={() => { setBlueprint(null); setTab('details'); saveDraft(draft, null); try { window.localStorage.removeItem(`${DRAFT_KEY}-result`); } catch { /* ignore */ } }}>Clear result</button>}
                {savedId && <button type="button" className="btn" disabled={!draft.name.trim() || saving || Boolean(savedUnavailable)} onClick={() => void save(true)}>Save as new</button>}
                <button type="button" className="btn" disabled={!draft.name.trim() || saving || Boolean(savedUnavailable) || (Boolean(savedId) && !dirty)} onClick={() => void save(false)}>
                  {saving ? 'Saving\u2026' : savedId ? 'Save changes' : 'Save'}
                </button>
                <button type="button" className="btn btn-primary" disabled={!ready || running} onClick={() => void analyze()}>
                  {running ? 'Analyzing\u2026' : blueprint || understanding ? 'Analyze again' : 'Analyze'}
                </button>
              </div>
              {!running && !blueprint && !understanding && <div className="sb-empty">No analysis yet. Fill in the name, purpose and prototype, then Analyze.</div>}
            </div>
          )}

          {blueprint && tab === 'overview' && <Overview blueprint={blueprint} />}
          {blueprint && tab === 'entities' && <Entities blueprint={blueprint} onChange={updateField} />}
          {blueprint && tab === 'capabilities' && <Capabilities blueprint={blueprint} />}
          {blueprint && tab === 'workflows' && <Workflows blueprint={blueprint} />}
          {blueprint && tab === 'standards' && <Standards blueprint={blueprint} />}
          {blueprint && tab === 'build' && <Build blueprint={blueprint} />}
          {blueprint && tab === 'artifacts' && (
            <Artifacts
              blueprint={blueprint}
              views={views}
              kit={kitCss}
              onLoadKit={() => void houseKit()}
              running={running || redesigning}
              statuses={redesigns}
              onRedesign={(labels) => void redesignViews(labels)}
              onCopy={copy}
              copied={copied}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Saved blueprints as a tree: one node per surface name, its saved copies
 * underneath, newest first. A surface saved once is a single row.
 */
function SurfaceTree({ items, openId, draftName, dirty, onOpen, onNew }: {
  items: SavedBlueprintSummary[];
  openId: string | null;
  draftName: string;
  dirty: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const groups = useMemo(() => {
    const byName = new Map<string, SavedBlueprintSummary[]>();
    for (const item of items) {
      const key = item.name.trim() || 'Untitled';
      byName.set(key, [...(byName.get(key) || []), item]);
    }
    return [...byName.entries()]
      .map(([name, list]) => ({ name, list: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
      .sort((a, b) => b.list[0].updatedAt.localeCompare(a.list[0].updatedAt));
  }, [items]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (name: string) => setClosed((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const meta = (item: SavedBlueprintSummary) => `rev ${item.revision} \u00b7 ${new Date(item.updatedAt).toLocaleDateString()}${item.source ? '' : ' \u00b7 not analyzed'}`;

  return (
    <aside className="sb-tree" aria-label="Surfaces">
      <div className="sb-tree-head">
        <span>Surfaces</span>
        <button type="button" className="btn btn-sm" onClick={onNew}>New</button>
      </div>
      <ul role="tree" aria-label="Saved surfaces">
        {!openId && (
          <li role="treeitem" aria-selected="true">
            <span className="sb-tree-row on">
              {draftName || 'New surface'}
              <span className="sb-tree-meta">{dirty ? 'Not saved' : 'New'}</span>
            </span>
          </li>
        )}
        {groups.map((group) => {
          if (group.list.length === 1) {
            const item = group.list[0];
            return (
              <li key={item.id} role="treeitem" aria-selected={item.id === openId}>
                <button type="button" className={`sb-tree-row${item.id === openId ? ' on' : ''}`} onClick={() => onOpen(item.id)}>
                  {group.name}
                  <span className="sb-tree-meta">{meta(item)}</span>
                </button>
              </li>
            );
          }
          const holdsOpen = group.list.some((item) => item.id === openId);
          const expanded = holdsOpen || !closed.has(group.name);
          return (
            <li key={group.name} role="treeitem" aria-expanded={expanded} aria-selected={false}>
              <button type="button" className={`sb-tree-row sb-tree-group${holdsOpen ? ' holds' : ''}`} onClick={() => toggle(group.name)}>
                <span className="sb-tree-caret" aria-hidden="true">{expanded ? '\u25be' : '\u25b8'}</span>
                {group.name}
                <span className="sb-tree-count">{group.list.length}</span>
              </button>
              {expanded && (
                <ul role="group">
                  {group.list.map((item) => (
                    <li key={item.id} role="treeitem" aria-selected={item.id === openId}>
                      <button type="button" className={`sb-tree-row${item.id === openId ? ' on' : ''}`} onClick={() => onOpen(item.id)}>
                        {meta(item)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {groups.length === 0 && openId === null && <li className="sb-tree-empty">Nothing saved yet. Save a blueprint to list it here.</li>}
      </ul>
    </aside>
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

function Questions({ understanding, views, answers, onAnswer, onWrite, onSkip }: {
  understanding: PrototypeUnderstanding;
  views: CapturedView[];
  answers: Record<string, string>;
  onAnswer: (id: string, value: string) => void;
  onWrite: () => void;
  onSkip: () => void;
}) {
  const [shown, setShown] = useState<number | null>(null);
  return (
    <section className="sb-result" aria-label="What the model understood">
      <div className="sb-result-head">
        <div>
          <div className="sb-result-title">What the model understood</div>
          <div className="sb-muted">Answer what you can, then write the blueprint. A question left blank takes the model&rsquo;s recommendation, and the blueprint says so.</div>
        </div>
        <div className="sb-html-tools">
          <button type="button" className="btn btn-sm" onClick={onSkip}>Skip questions</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onWrite}>Write blueprint</button>
        </div>
      </div>
      <div className="sb-pane">
        <p className="sb-summary">{understanding.summary}</p>
        {views.length > 0 && (
          <>
            <h4>Views reviewed ({views.length})</h4>
            <div className="sb-chips">
              {views.map((view, index) => (
                <button key={`${view.label}-${index}`} type="button" className={shown === index ? 'on' : ''} onClick={() => setShown(shown === index ? null : index)}>
                  {view.label}{view.image ? '' : ' (no screenshot)'}
                </button>
              ))}
            </div>
            {shown !== null && views[shown]?.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="sb-shot" alt={`Screenshot of ${views[shown].label}`} src={`data:image/jpeg;base64,${views[shown].image}`} />
            )}
          </>
        )}
        {understanding.questions.length > 0 && <h4>Questions</h4>}
        {understanding.questions.map((question) => {
          const value = answers[question.id] || '';
          const custom = value && !question.options.includes(value);
          return (
            <div key={question.id} className="sb-card">
              <div className="strong">{question.question}</div>
              {question.why && <div className="sb-muted">{question.why}</div>}
              <div className="sb-options" role="radiogroup" aria-label={question.question}>
                {question.options.map((option) => (
                  <label key={option} className="sb-check">
                    <input type="radio" name={question.id} checked={value === option} onChange={() => onAnswer(question.id, option)} />
                    {option}{option === question.recommended ? ' (recommended)' : ''}
                  </label>
                ))}
                <input
                  type="text"
                  aria-label={`Other answer to: ${question.question}`}
                  placeholder="Or write your own answer"
                  value={custom ? value : ''}
                  onChange={(event) => onAnswer(question.id, event.target.value)}
                />
              </div>
            </div>
          );
        })}
        <div className="sb-two">
          <div>
            <h4>Concepts</h4>
            <table className="sb-table">
              <thead><tr><th>Concept</th><th>Model as</th><th>How</th></tr></thead>
              <tbody>
                {understanding.concepts.map((concept) => (
                  <tr key={concept.name}><td className="strong">{concept.name}<div className="sb-muted">{concept.meaning}</div></td><td>{concept.model}</td><td>{concept.detail}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h4>Views</h4>
            <ul>{understanding.views.map((view) => <li key={view.name}><b>{view.name}</b>: {view.shows}</li>)}</ul>
            {understanding.computations.length > 0 && (
              <>
                <h4>Calculations</h4>
                <ul>{understanding.computations.map((computation) => <li key={computation.name}><b>{computation.name}</b>: {computation.detail}</li>)}</ul>
              </>
            )}
            {understanding.assumptions.length > 0 && (
              <>
                <h4>Assumptions</h4>
                <ul>{understanding.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
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
        <Stat label="Entity types" value={blueprint.entityTypes.length} note={`${blueprint.entityTypes.filter((plan) => plan.status === 'new').length} new`} />
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
            <dt>Views captured</dt><dd>{blueprint.outline.views?.join(', ') || 'None (source only)'}</dd>
          </dl>
        </div>
        <div>
          {blueprint.decisions.length > 0 && (
            <>
              <h4>Design decisions</h4>
              <ul>{blueprint.decisions.map((decision) => <li key={decision.question}><b>{decision.question}</b> {decision.answer}{decision.source === 'assumed' ? <span className="sb-muted"> (assumed: the model&rsquo;s recommendation)</span> : null}</li>)}</ul>
            </>
          )}
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
      <h4>Entity model</h4>
      {blueprint.entityTypes.length ? (
        <table className="sb-table">
          <thead><tr><th>Entity type</th><th>Status</th><th>One record is</th><th>Attributes</th><th>Purpose</th></tr></thead>
          <tbody>
            {blueprint.entityTypes.map((plan) => (
              <tr key={plan.code}>
                <td className="strong"><span className="mono">{plan.code}</span><div className="sb-muted">{plan.name}{plan.parentCode ? ` \u00b7 under ${plan.parentCode}` : ''}</div></td>
                <td><span className={`sb-pill ${plan.status === 'reuse' ? 'exists' : 'new'}`}>{plan.status === 'reuse' ? 'Exists' : 'New'}</span></td>
                <td>{plan.identity || ''}</td>
                <td className="mono">{plan.attributes.join(', ')}</td>
                <td>{plan.purpose}{plan.reason && <div className="sb-muted">{plan.reason}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="sb-muted">No entity model yet{blueprint.source === 'baseline' ? '; the model review proposes one.' : '.'}</p>}
      {blueprint.relationshipTypes.length > 0 && (
        <>
          <h4>Relationship types</h4>
          <table className="sb-table">
            <thead><tr><th>Code</th><th>Status</th><th>From</th><th>To</th><th>Cardinality</th><th>Why</th></tr></thead>
            <tbody>
              {blueprint.relationshipTypes.map((plan) => (
                <tr key={plan.code}><td className="mono">{plan.code}</td><td><span className={`sb-pill ${plan.status === 'reuse' ? 'exists' : 'new'}`}>{plan.status === 'reuse' ? 'Exists' : 'New'}</span></td><td>{plan.fromDomain || ''}</td><td>{plan.toDomain || ''}</td><td>{plan.cardinality || ''}</td><td>{plan.reason || ''}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {blueprint.taxonomies.length > 0 && (
        <>
          <h4>Taxonomies</h4>
          <ul>{blueprint.taxonomies.map((plan) => <li key={plan.name}><b>{plan.name}</b> ({plan.levels.join(' \u203a ')}): {plan.storage}{plan.source ? ` Source: ${plan.source}.` : ''}</li>)}</ul>
        </>
      )}
      <h4>Values on screen</h4>
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
      {blueprint.compliance.length > 0 && (
        <>
          <h4>Compliance mapping</h4>
          <p className="sb-muted">Rules are interpreted by compliance.evaluate_rule; fund limits and Hard/Soft severity live in compliance.rule_thresholds; which funds a rule covers is compliance.rule_scope_assignments.</p>
          <table className="sb-table">
            <thead><tr><th>Prototype rule</th><th>Maps to</th><th>Detail</th><th>Tables</th></tr></thead>
            <tbody>
              {blueprint.compliance.map((plan, index) => (
                <tr key={`${plan.prototypeRule}-${index}`}><td className="strong">{plan.prototypeRule}</td><td>{plan.mapsTo}</td><td>{plan.detail}</td><td className="mono">{plan.tables.join(', ')}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {blueprint.computations.length > 0 && (
        <>
          <h4>Calculations and where each runs</h4>
          <table className="sb-table">
            <thead><tr><th>Calculation</th><th>Inputs</th><th>Output</th><th>Runs in</th><th>Status</th></tr></thead>
            <tbody>
              {blueprint.computations.map((plan, index) => (
                <tr key={`${plan.name}-${index}`}><td className="strong">{plan.name}{plan.detail && <div className="sb-muted">{plan.detail}</div>}</td><td>{plan.inputs.join(', ')}</td><td>{plan.output}</td><td className="mono">{plan.runsIn}</td><td><span className={`sb-pill ${plan.status}`}>{STATUS_TEXT[plan.status]}</span></td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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

function Artifacts({ blueprint, views, kit, onLoadKit, running, statuses, onRedesign, onCopy, copied }: {
  blueprint: SurfaceBlueprint;
  views: CapturedView[];
  kit: string | null;
  onLoadKit: () => void;
  running: boolean;
  statuses: Record<string, RedesignStatus>;
  onRedesign: (labels: string[]) => void;
  onCopy: (text: string, what: string) => void;
  copied: string | null;
}) {
  const [open, setOpen] = useState(0);
  const [showing, setShowing] = useState<'redesign' | 'original'>('redesign');
  // Views captured now, else those the blueprint recorded, else those its redesigns came from.
  const redesignedViews = [...new Set(blueprint.artifacts.map((artifact) => artifact.view).filter((view): view is string => Boolean(view)))];
  const available = views.length ? views.map((view) => view.label) : blueprint.outline.views?.length ? blueprint.outline.views : redesignedViews;
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const selected = chosen ?? new Set(views.length ? distinctViews(views) : available.filter((label) => label !== 'Initial view'));
  const progress = Object.entries(statuses);
  useEffect(() => { if (kit === null) onLoadKit(); }, [kit, onLoadKit]);

  const toggle = (label: string) => setChosen(() => {
    const next = new Set(selected);
    if (next.has(label)) next.delete(label); else next.add(label);
    return next;
  });
  const current = blueprint.artifacts.length ? blueprint.artifacts[Math.min(open, blueprint.artifacts.length - 1)] : null;
  const original = current?.view ? views.find((view) => view.label === current.view) : undefined;
  const preview = (html: string) => (kit ? houseDocument(html, kit) : html);

  return (
    <div className="sb-pane">
      <div className="sb-card">
        <div className="strong">Redesign views in the house design</div>
        <div className="sb-muted">
          Each chosen view is rewritten from its captured markup and screenshot with the app&rsquo;s own surface classes, then rendered and compared with the original for one round of corrections. {views.length ? `${views.length} views are captured.` : 'The prototype is captured again first.'} Each view takes a few minutes and two model calls.
        </div>
        {available.length > 0 ? (
          <div className="sb-chips" role="group" aria-label="Views to redesign">
            {available.map((label) => (
              <button key={label} type="button" className={selected.has(label) ? 'on' : ''} aria-pressed={selected.has(label)} onClick={() => toggle(label)}>{label}</button>
            ))}
          </div>
        ) : <p className="sb-muted">This blueprint has no captured views yet. The prototype will be opened, each of its views captured, and every distinct view redesigned.</p>}
        <div className="sb-html-tools">
          <button type="button" className="btn btn-primary btn-sm" disabled={running || (available.length > 0 && selected.size === 0)} onClick={() => onRedesign(available.filter((label) => selected.has(label)))}>
            {running ? 'Working\u2026' : available.length ? `Redesign ${selected.size} view${selected.size === 1 ? '' : 's'}` : 'Capture and redesign all views'}
          </button>
          {kit === '' && <span className="sb-muted">The house kit could not be loaded; previews show unstyled HTML.</span>}
        </div>
        {progress.length > 0 && (
          <table className="sb-table" aria-label="Redesign progress">
            <thead><tr><th>View</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>
              {progress.map(([label, state]) => (
                <tr key={label}>
                  <td className="strong">{label}</td>
                  <td><span className={`sb-pill ${state.status === 'done' ? 'exists' : state.status === 'failed' ? 'gap' : 'todo'}`}>{REDESIGN_TEXT[state.status]}</span></td>
                  <td>{state.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {current ? (
        <>
          <div className="sb-chips">
            {blueprint.artifacts.map((artifact, index) => (
              <button key={`${artifact.title}-${index}`} type="button" className={index === open ? 'on' : ''} onClick={() => setOpen(index)}>
                {artifact.title}{artifact.view && !artifact.checked ? ' (not checked)' : ''}
              </button>
            ))}
          </div>
          <p>{current.purpose}</p>
          {current.html ? (
            <>
              <div className="sb-html-tools">
                <button type="button" className="btn btn-sm" onClick={() => onCopy(current.html!, `html-${open}`)}>{copied === `html-${open}` ? 'Copied' : 'Copy HTML'}</button>
                <button type="button" className="btn btn-sm" onClick={() => download(`${slug(current.title)}.html`, preview(current.html!), 'text/html')}>Download .html</button>
              </div>
              {original?.image && (
                <div className="sb-tabs sb-compare-tabs" role="tablist" aria-label="Compare with the original">
                  <button type="button" role="tab" aria-selected={showing === 'redesign'} className={showing === 'redesign' ? 'on' : ''} onClick={() => setShowing('redesign')}>House design</button>
                  <button type="button" role="tab" aria-selected={showing === 'original'} className={showing === 'original' ? 'on' : ''} onClick={() => setShowing('original')}>Original prototype</button>
                </div>
              )}
              {original?.image && showing === 'original' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="sb-shot sb-full" alt={`Screenshot of ${original.label}`} src={`data:image/jpeg;base64,${original.image}`} />
              ) : (
                <iframe className="sb-frame sb-full" title={current.title} sandbox="allow-scripts" srcDoc={preview(current.html)} />
              )}
              {current.notes && current.notes.length > 0 && (
                <>
                  <h4>Designer notes</h4>
                  <ul>{current.notes.map((note) => <li key={note}>{note}</li>)}</ul>
                </>
              )}
            </>
          ) : <p className="sb-muted">Described only; no HTML was written for this artifact.</p>}
        </>
      ) : <p className="sb-muted">{progress.length ? 'Each redesigned view appears here as it finishes.' : 'No HTML artifacts yet. Redesign views above.'}</p>}
    </div>
  );
}
