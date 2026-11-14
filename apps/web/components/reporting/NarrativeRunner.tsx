'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import {
  NARRATIVE_RUNS_QUERY,
  NARRATIVE_RUN_QUERY,
  PUBLISH_NARRATIVE_RUN_MUTATION,
  UNPUBLISH_NARRATIVE_RUN_MUTATION,
  ageOf,
  chooseRun,
  defaultParams,
  finishNarrativeRun,
  reviewNarrativeRun,
  runNarrative,
  runNarrativeSection,
  startNarrativeRun,
  type NarrativeBlock,
  type NarrativeRunRecord,
  type NarrativeRunSectionRecord,
  type NarrativeRunSummary,
  type NarrativeTemplate,
  type ReportParameter,
  type RunReview,
} from '@/lib/reporting';
import { reviewNotesFor, reviewSummary } from '@tapestrai/graphql/src/lib/narrative-review';
import {
  blocksToMarkdown,
  mergeBatchBlocks,
  narrativeSections,
  sectionRunOrder,
  type NarrativeSpec,
} from '@tapestrai/graphql/src/lib/narrative-spec';
import { NarrativeBlocks } from './NarrativeBlocks';
import { ParameterBar } from './ParameterBar';

interface NarrativeRunnerProps {
  /** Saved narrative id (enables stored-run history). Omit when previewing an unsaved draft. */
  narrativeId?: string;
  /** Unsaved designer draft to run instead of the stored template. */
  draft?: Partial<NarrativeTemplate>;
  parameters: ReportParameter[];
  entityId?: string | null;
  asOfDate?: string;
  /** Run automatically when there is no stored run yet. */
  autoRunIfEmpty?: boolean;
}

const CHIP: Record<string, { bg: string; fg: string; label: string }> = {
  PENDING: { bg: '#eef0f2', fg: '#667085', label: 'Waiting' },
  RUNNING: { bg: '#e8eef2', fg: '#1b3a4b', label: 'Writing' },
  COMPLETED: { bg: '#e1f1e7', fg: '#047857', label: 'Done' },
  FAILED: { bg: '#fdecec', fg: '#b91c1c', label: 'Failed' },
};

/** A report older than this is flagged, because the data behind it may have changed. */
const STALE_DAYS = 7;

interface Progress {
  key: string;
  title: string;
  index: number;
  total: number;
  batch?: { index: number; count: number };
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function runLabel(r: NarrativeRunSummary): string {
  const when = `${shortDate(r.createdAt)} ${new Date(r.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const parts = [r.publishedAt ? '★ Published' : null, `as of ${(r.asOfDate ?? '').slice(0, 10) || 'n/a'}`, r.createdByLabel || 'unknown', when];
  return parts.filter(Boolean).join(' · ');
}

export function NarrativeRunner({ narrativeId, draft, parameters, entityId, asOfDate, autoRunIfEmpty }: NarrativeRunnerProps) {
  const [values, setValues] = useState<Record<string, any>>(() => defaultParams(parameters));
  const [run, setRun] = useState<NarrativeRunRecord | null>(null);
  const [sections, setSections] = useState<NarrativeRunSectionRecord[]>([]);
  const [runs, setRuns] = useState<NarrativeRunSummary[]>([]);
  const [sameDate, setSameDate] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [reviewing, setReviewing] = useState(false);
  /** A review that could not be stored with the run (someone else's run), kept for this view only. */
  const [localReview, setLocalReview] = useState<RunReview | null>(null);
  const cancelled = useRef(false);

  const params = useMemo(() => ({ ...values, ...(asOfDate ? { asOfDate } : {}) }), [values, asOfDate]);
  const targetAsOf = (asOfDate || localToday()).slice(0, 10);

  const patchSection = useCallback((next: NarrativeRunSectionRecord) => {
    setSections((list) => {
      const at = list.findIndex((s) => s.sectionKey === next.sectionKey);
      if (at < 0) return [...list, next].sort((a, b) => a.ord - b.ord);
      const copy = [...list];
      copy[at] = { ...copy[at], ...next, ord: copy[at].ord, title: next.title ?? copy[at].title };
      return copy;
    });
  }, []);

  /** Loads one finished run, with its sections, into view. */
  const openRun = useCallback(async (id: string) => {
    const { data } = await graphqlQuery<{ narrativeRun: NarrativeRunRecord | null }, any>(NARRATIVE_RUN_QUERY, { id }, 'network-only');
    const detail = data?.narrativeRun ?? null;
    setRun(detail);
    setSections([...(detail?.sections ?? [])].sort((a, b) => a.ord - b.ord));
  }, []);

  /**
   * Lists the finished runs for this record and opens the one a reader should see: published for the
   * date, else newest for the date, else the nearest other date (flagged). `prefer` opens a given run.
   */
  const reload = useCallback(async (prefer?: string): Promise<NarrativeRunSummary | null> => {
    if (!narrativeId) return null;
    const { data } = await graphqlQuery<{ narrativeRuns: NarrativeRunSummary[] }, any>(
      NARRATIVE_RUNS_QUERY,
      { narrativeId, entityId: entityId || null, first: 25, statuses: ['COMPLETED', 'PARTIAL'] },
      'network-only'
    );
    const list = data?.narrativeRuns ?? [];
    setRuns(list);
    const chosen = prefer ? { run: list.find((r) => r.id === prefer) ?? null, sameDate: true } : chooseRun(list, targetAsOf);
    const target = chosen.run ?? chooseRun(list, targetAsOf).run;
    setSameDate(prefer && target ? (target.asOfDate ?? '').slice(0, 10) === targetAsOf : chosen.sameDate);
    if (target?.id) await openRun(target.id);
    else {
      setRun(null);
      setSections([]);
    }
    return target;
  }, [narrativeId, entityId, targetAsOf, openRun]);

  /** Composes one section, batch by batch, and returns it. Saved runs persist server-side. */
  const composeSection = useCallback(async (
    key: string,
    ctx: { runId?: string; index: number; total: number; title: string; prior: Array<{ key: string; title: string; markdown: string }>; reviewNotes?: string },
  ): Promise<NarrativeRunSectionRecord> => {
    let batchIndex = 0;
    const draftBatches: NarrativeBlock[][] = [];
    for (;;) {
      if (cancelled.current) throw new Error('Stopped');
      setProgress({ key, title: ctx.title, index: ctx.index, total: ctx.total });
      patchSection({ sectionKey: key, ord: ctx.index, title: ctx.title, status: 'RUNNING', blocks: [] });
      const response = await runNarrativeSection({
        runId: ctx.runId,
        draft: ctx.runId ? undefined : draft,
        sectionKey: key,
        batchIndex,
        entityId: entityId || undefined,
        asOfDate: asOfDate || undefined,
        params,
        prior: ctx.runId ? undefined : ctx.prior,
        reviewNotes: ctx.reviewNotes,
      });
      let section = response.section;
      if (!ctx.runId && response.batchBlocks) {
        draftBatches[batchIndex] = response.batchBlocks;
        section = { ...section, blocks: mergeBatchBlocks(draftBatches.filter(Boolean)) };
      }
      patchSection({ ...section, ord: ctx.index });
      if (section.status === 'FAILED') return section;
      if (response.batch && !response.batch.done) {
        batchIndex = response.batch.index + 1;
        setProgress({ key, title: ctx.title, index: ctx.index, total: ctx.total, batch: { index: batchIndex, count: response.batch.count } });
        continue;
      }
      return section;
    }
  }, [draft, entityId, asOfDate, params, patchSection]);

  const execute = useCallback(async () => {
    // A finished report for this date already exists, and a run takes minutes and costs model spend.
    if (!draft && run?.id && sameDate && run.status !== 'FAILED') {
      const by = run.createdByLabel ? ` by ${run.createdByLabel}` : '';
      const ok = window.confirm(`A report for this date already exists${by} (${ageOf(run.createdAt).text}). Running again takes several minutes and uses model credits. Run again?`);
      if (!ok) return;
    }
    cancelled.current = false;
    setRunning(true);
    setError(null);
    setCopied(false);
    try {
      // An unsaved draft, or a one-section template, runs as before.
      const spec = (draft ?? {}) as NarrativeSpec;
      const draftSections = narrativeSections(spec);
      if (draft && draftSections.length <= 1 && !draftSections[0]?.batch) {
        const result = await runNarrative({ draft, entityId: entityId || undefined, params });
        setRun(result);
        setSections([]);
        return;
      }

      if (draft) {
        // Draft preview: the browser holds the results and passes finished sections along.
        const order = sectionRunOrder(draftSections);
        const byKey = new Map(draftSections.map((s, i) => [s.key, { s, i }]));
        const done = new Map<string, NarrativeRunSectionRecord>();
        setSections(draftSections.map((s, i) => ({ sectionKey: s.key, ord: i, title: s.title, status: 'PENDING', blocks: [] })));
        setRun(null);
        for (const key of order) {
          const { s, i } = byKey.get(key)!;
          const prior = (s.dependsOn ?? []).flatMap((k) => {
            const p = done.get(k);
            return p ? [{ key: k, title: p.title ?? k, markdown: blocksToMarkdown(p.blocks) }] : [];
          });
          const section = await composeSection(key, { index: i, total: order.length, title: s.title, prior });
          done.set(key, section);
        }
        return;
      }

      if (!narrativeId) throw new Error('Nothing to run');
      const started = await startNarrativeRun({ narrativeId, entityId: entityId || undefined, asOfDate, params });
      setRun(started.run);
      setSections(started.run.sections ?? []);
      setSameDate(true);
      for (const [n, key] of started.order.entries()) {
        const brief = started.sections.find((s) => s.key === key)!;
        const ord = (started.run.sections ?? []).find((s) => s.sectionKey === key)?.ord ?? n;
        await composeSection(key, { runId: started.run.id ?? undefined, index: ord, total: started.order.length, title: brief.title, prior: [] });
      }
      const finished = await finishNarrativeRun(started.run.id as string);
      setRun(finished.run);
      setSections(finished.run.sections ?? []);
      setProgress({ key: 'review', title: 'Checking the report against its evidence', index: started.order.length, total: started.order.length });
      await runReview(finished.run.id as string);
      await reload(finished.run.id ?? undefined);
    } catch (e: any) {
      setError(e.message || 'Run failed');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [draft, narrativeId, entityId, asOfDate, params, composeSection, run, sameDate, reload]);

  const rerunSection = useCallback(async (key: string, reviewNotes?: string) => {
    if (!run?.id) return;
    cancelled.current = false;
    setRunning(true);
    setError(null);
    setLocalReview(null);
    try {
      const target = sections.find((s) => s.sectionKey === key);
      await composeSection(key, { runId: run.id, index: target?.ord ?? 0, total: sections.length, title: target?.title ?? key, prior: [], reviewNotes });
      const finished = await finishNarrativeRun(run.id);
      setRun(finished.run);
      setSections(finished.run.sections ?? []);
      await reload(run.id);
    } catch (e: any) {
      setError(e.message || 'Run failed');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [run, sections, composeSection, reload]);

  /** Runs the consistency review on the open run and shows what it found. */
  async function runReview(runId: string): Promise<void> {
    setReviewing(true);
    try {
      const { review, saved } = await reviewNarrativeRun(runId);
      setLocalReview(saved ? null : review);
    } catch (e: any) {
      // A failed review must not hide a finished report.
      setError(`The consistency review could not run: ${e.message || 'unknown error'}`);
    } finally {
      setReviewing(false);
    }
  }

  const reviewNow = async () => {
    if (!run?.id) return;
    setError(null);
    await runReview(run.id);
    await reload(run.id);
  };

  const publish = async () => {
    if (!run?.id) return;
    setPublishing(true);
    setError(null);
    try {
      const res = await graphqlMutation<any, any>(PUBLISH_NARRATIVE_RUN_MUTATION, { id: run.id, label: label.trim() || null });
      if (res.error) throw new Error(res.error.message);
      setLabelOpen(false);
      setLabel('');
      await reload(run.id);
    } catch (e: any) {
      setError(e.message || 'Could not publish');
    } finally {
      setPublishing(false);
    }
  };

  const unpublish = async () => {
    if (!run?.id) return;
    setPublishing(true);
    setError(null);
    try {
      const res = await graphqlMutation<any, any>(UNPUBLISH_NARRATIVE_RUN_MUTATION, { id: run.id });
      if (res.error) throw new Error(res.error.message);
      await reload(run.id);
    } catch (e: any) {
      setError(e.message || 'Could not unpublish');
    } finally {
      setPublishing(false);
    }
  };

  // Open the shared report for this record: published for the date, else the newest finished run.
  useEffect(() => {
    if (!narrativeId || draft) return;
    let stale = false;
    (async () => {
      setLoadingLatest(true);
      setRun(null);
      setSections([]);
      setRuns([]);
      try {
        const chosen = await reload();
        if (stale) return;
        if (!chosen && autoRunIfEmpty) execute();
      } finally {
        if (!stale) setLoadingLatest(false);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrativeId, entityId, targetAsOf]);

  const hasSections = sections.length > 0;
  const completed = sections.filter((s) => s.status === 'COMPLETED');
  const checked = completed.reduce((n, s) => n + (s.verification?.checked ?? 0), 0);
  const matched = completed.reduce((n, s) => n + (s.verification?.matched ?? 0), 0);
  const untraced = completed.flatMap((s) => (s.verification?.unmatched ?? []).map((u) => ({ section: s.title ?? s.sectionKey, ...u })));
  const sources = (run?.sources ?? []) as Array<{ title: string; url?: string; publisher?: string; date?: string }>;
  const age = run ? ageOf(run.createdAt) : null;
  const viewing = !running && run?.id && (run.status === 'COMPLETED' || run.status === 'PARTIAL');
  const published = !!run?.publishedAt;
  const review: RunReview | null = (run?.verification?.review as RunReview | undefined) ?? localReview;
  const titleOf = (key: string) => sections.find((s) => s.sectionKey === key)?.title ?? key;

  const copyMarkdown = async () => {
    const parts = hasSections
      ? sections.filter((s) => s.status === 'COMPLETED').map((s) => `## ${s.title ?? s.sectionKey}\n\n${blocksToMarkdown(s.blocks)}`)
      : [blocksToMarkdown(run?.blocks ?? [])];
    try {
      await navigator.clipboard.writeText(parts.join('\n\n'));
      setCopied(true);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  };

  const bar = (bg: string, fg: string) => ({ padding: '8px 12px', background: bg, color: fg, fontSize: '12px', marginBottom: '8px' } as const);

  return (
    <div>
      <ParameterBar parameters={parameters} values={values} onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '10px 0 12px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={execute} disabled={running}>
          {running ? 'Generating…' : run || hasSections ? 'Run again' : 'Generate'}
        </button>
        {running && (
          <button className="btn btn-sm" onClick={() => { cancelled.current = true; }}>Stop</button>
        )}
        {viewing && (
          <>
            {published ? (
              <button className="btn btn-sm" onClick={unpublish} disabled={publishing}>Unpublish</button>
            ) : (
              <button className="btn btn-sm" onClick={() => setLabelOpen((o) => !o)} disabled={publishing}>Publish</button>
            )}
            <button className="btn btn-sm" onClick={copyMarkdown}>{copied ? 'Copied' : 'Copy as markdown'}</button>
            <button className="btn btn-sm" onClick={reviewNow} disabled={reviewing}>
              {reviewing ? 'Reviewing…' : review ? 'Review again' : 'Check consistency'}
            </button>
          </>
        )}
        {runs.length > 1 && !running && (
          <select
            className="select"
            style={{ fontSize: '11px', padding: '4px 26px 4px 8px', maxWidth: '360px' }}
            value={run?.id ?? ''}
            onChange={async (e) => { setSameDate(true); await reload(e.target.value); }}
            aria-label="Earlier runs"
          >
            {runs.map((r) => <option key={r.id as string} value={r.id as string}>{runLabel(r)}</option>)}
          </select>
        )}
      </div>

      {labelOpen && viewing && !published && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name this version (optional), e.g. Q3 LP review"
            style={{ flex: 1, maxWidth: '380px', padding: '6px 10px', fontSize: '12px', border: '1px solid var(--line)' }}
            onKeyDown={(e) => { if (e.key === 'Enter') publish(); }}
          />
          <button className="btn btn-primary btn-sm" onClick={publish} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish'}</button>
          <button className="btn btn-sm" onClick={() => setLabelOpen(false)}>Cancel</button>
        </div>
      )}

      {viewing && run && age && (
        <div style={bar(published ? '#e1f1e7' : '#f3f5f7', published ? '#047857' : 'var(--ink-2)')}>
          {published && (
            <strong style={{ marginRight: '8px' }}>
              ★ Published{run.publishedLabel ? `: ${run.publishedLabel}` : ''}
              {run.publishedByLabel ? ` by ${run.publishedByLabel}` : ''}{run.publishedAt ? ` on ${shortDate(run.publishedAt)}` : ''}
              {' · '}
            </strong>
          )}
          Run by {run.createdByLabel || 'unknown'} {age.text}
          {run.asOfDate ? ` · as of ${run.asOfDate.slice(0, 10)}` : ''}
          {run.origin === 'MCP' ? ' · composed by an external assistant' : ''}
          {run.model && run.origin !== 'MCP' ? ` · ${run.model}` : ''}
          {run.status === 'PARTIAL' ? ' · some sections incomplete' : ''}
        </div>
      )}
      {viewing && run && !sameDate && (
        <div style={bar('#fdf3d7', '#a16207')}>
          This report is as of {(run.asOfDate ?? '').slice(0, 10) || 'an unknown date'}, but {targetAsOf} is selected. Use Run again for the selected date.
        </div>
      )}
      {viewing && age && age.days >= STALE_DAYS && (
        <div style={bar('#fdf3d7', '#a16207')}>
          This report is {age.days} days old. The data behind it may have changed since.
        </div>
      )}
      {run && !viewing && !running && run.id && (
        <div style={bar('#f3f5f7', 'var(--ink-2)')}>Previewing a run that is not finished.</div>
      )}
      {run && !run.id && !running && (
        <div style={{ ...bar('#f3f5f7', 'var(--ink-2)'), color: 'var(--ink-3)' }}>
          Preview, not saved · {new Date(run.createdAt).toLocaleString()}
        </div>
      )}

      {progress && (
        <div style={{ fontSize: '12px', color: 'var(--ink-2)', marginBottom: '12px' }}>
          Section {Math.min(progress.index + 1, progress.total)} of {progress.total}: {progress.title}
          {progress.batch ? ` (group ${progress.batch.index + 1} of ${progress.batch.count})` : ''}
        </div>
      )}

      {error && <div style={{ padding: '10px 14px', background: '#fdecec', color: '#b91c1c', fontSize: '12px', marginBottom: '8px' }}>{error}</div>}
      {loadingLatest && !run && <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>Loading the latest report…</div>}
      {run?.status === 'FAILED' && (
        <div style={{ padding: '10px 14px', background: '#fdecec', color: '#b91c1c', fontSize: '12px', marginBottom: '8px' }}>
          The last run failed: {run.errorMessage || 'unknown error'}
        </div>
      )}
      {run?.status === 'PARTIAL' && (
        <div style={{ padding: '10px 14px', background: '#fdf3d7', color: '#a16207', fontSize: '12px', marginBottom: '8px' }}>
          {run.errorMessage || 'Some sections were not completed.'} Re-run a section below, or run the whole narrative again.
        </div>
      )}

      {viewing && review && (
        <details
          open={review.issues.some((i) => i.severity === 'high')}
          style={{ marginBottom: '14px', border: '1px solid var(--line)', background: 'white' }}
        >
          <summary
            style={{
              cursor: 'pointer', padding: '8px 12px', fontSize: '12px', fontWeight: 600,
              color: review.issues.some((i) => i.severity === 'high') ? '#b91c1c' : review.issues.length ? '#a16207' : '#047857',
            }}
          >
            Consistency review: {reviewSummary(review)}
            <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}> · {review.sectionsReviewed} sections checked {ageOf(review.reviewedAt).text}</span>
          </summary>
          <div style={{ padding: '0 12px 10px' }}>
            {review.issues.length === 0 && (
              <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>The reviewer found nothing that contradicts the evidence or another section.</div>
            )}
            {review.issues.map((issue, i) => {
              const tone = issue.severity === 'high' ? { bg: '#fdecec', fg: '#b91c1c' } : issue.severity === 'medium' ? { bg: '#fdf3d7', fg: '#a16207' } : { bg: '#e8eef2', fg: '#1b3a4b' };
              return (
                <div key={i} style={{ borderLeft: `3px solid ${tone.fg}`, background: tone.bg, padding: '8px 12px', margin: '8px 0', fontSize: '12px' }}>
                  <div style={{ fontWeight: 600, color: tone.fg }}>
                    {issue.severity.toUpperCase()} · {issue.kind.replace(/-/g, ' ')} · {issue.sections.map(titleOf).join(', ')}
                  </div>
                  <div style={{ margin: '4px 0', fontStyle: 'italic', color: 'var(--ink-2)' }}>"{issue.quote}"</div>
                  <div>{issue.problem}</div>
                  {issue.suggestion && <div style={{ color: 'var(--ink-3)', marginTop: '2px' }}>Suggested: {issue.suggestion}</div>}
                  {run?.id && !running && (
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                      {issue.sections.filter((k) => sections.some((s) => s.sectionKey === k)).map((k) => (
                        <button key={k} className="btn btn-sm" onClick={() => rerunSection(k, reviewNotesFor(k, review.issues))}>
                          Fix {titleOf(k)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {review.discarded > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                {review.discarded} suggested issue{review.discarded === 1 ? ' was' : 's were'} left out because the reviewer could not point to the words in the report.
              </div>
            )}
          </div>
        </details>
      )}

      {hasSections && checked > 0 && (
        <details style={{ marginBottom: '14px', fontSize: '12px', color: untraced.length ? '#a16207' : '#047857' }}>
          <summary style={{ cursor: 'pointer' }}>
            {matched} of {checked} figures traced to the data{untraced.length ? `; ${untraced.length} could not be traced. Check them before sharing.` : '.'}
          </summary>
          {untraced.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px', color: 'var(--ink-2)' }}>
              {untraced.slice(0, 40).map((u, i) => <li key={i}>{u.section}: {u.figure}</li>)}
            </ul>
          )}
        </details>
      )}

      {hasSections ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
          {sections.map((s) => {
            const chip = CHIP[s.status] ?? CHIP.PENDING;
            return (
              <section key={s.sectionKey}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid var(--line)', paddingBottom: '6px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '15px', fontWeight: 600 }}>{s.title ?? s.sectionKey}</div>
                  <span style={{ fontSize: '10px', padding: '2px 8px', background: chip.bg, color: chip.fg }}>{chip.label}</span>
                  {run?.id && !running && s.status !== 'RUNNING' && (
                    <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => rerunSection(s.sectionKey)}>Re-run section</button>
                  )}
                </div>
                {s.status === 'FAILED' && (
                  <div style={{ padding: '8px 12px', background: '#fdecec', color: '#b91c1c', fontSize: '12px', marginBottom: '8px' }}>
                    {s.errorMessage || 'This section failed.'}
                  </div>
                )}
                {s.status === 'COMPLETED' && <NarrativeBlocks blocks={s.blocks} />}
                {s.status === 'COMPLETED' && (s.notes?.length ?? 0) > 0 && (
                  <details style={{ marginTop: '10px', fontSize: '12px', color: 'var(--ink-3)' }}>
                    <summary style={{ cursor: 'pointer' }}>Data gaps and caveats ({s.notes!.length})</summary>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                      {s.notes!.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  </details>
                )}
              </section>
            );
          })}
          {sources.length > 0 && (
            <section>
              <div style={{ fontSize: '15px', fontWeight: 600, borderBottom: '1px solid var(--line)', paddingBottom: '6px', marginBottom: '12px' }}>All sources</div>
              <NarrativeBlocks blocks={[{ type: 'sources', key: 'all_sources', items: sources }]} />
            </section>
          )}
        </div>
      ) : (
        run && run.status !== 'FAILED' && <NarrativeBlocks blocks={run.blocks} />
      )}

      {!run && !hasSections && !loadingLatest && !running && !error && (
        <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>No report yet for this record. Click Generate to produce it; everyone who can see this record will then be able to open it.</div>
      )}
    </div>
  );
}
