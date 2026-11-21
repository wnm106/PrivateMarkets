'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { graphqlMutation } from '@/lib/graphql';
import { TASK_POLL_MS, countLabel, kindLabel, placeText, refreshTasks, taskHref, titleWithCount, useTaskStore, whenText, type WorkflowTask } from '@/lib/tasks';
import { DECIDE_REVIEW } from '@/lib/workflows';

/**
 * Telling a person there is work waiting for them: the count in the top bar
 * and the browser tab, the inbox it opens, and a short note when a new task
 * arrives while they are in the app. Everything reads one store, so every
 * place shows the same number.
 */

const SEEN_KEY = 'tapestrai.tasks.seenAt';

function readSeen(): number {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(at: number) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // Not remembered: every task just looks seen next time.
  }
}

/**
 * Keeps the count fresh: every minute while the tab is in view, when the
 * person comes back to it, and on every page. Puts the count in the tab's
 * title and shows a note for each task that arrives.
 */
export function TaskWatcher() {
  const pathname = usePathname() || '/';
  const list = useTaskStore((state) => state.list);
  const arrived = useTaskStore((state) => state.arrived);
  const dismiss = useTaskStore((state) => state.dismissArrived);

  useEffect(() => {
    refreshTasks();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshTasks();
    }, TASK_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshTasks();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Each page sets its own title; the count goes back in front whenever it does.
  const total = list?.total ?? 0;
  useEffect(() => {
    const apply = () => {
      const next = titleWithCount(document.title, total);
      if (next !== document.title) document.title = next;
    };
    apply();
    const head = document.querySelector('head');
    if (!head) return;
    const observer = new MutationObserver(apply);
    observer.observe(head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [total, pathname]);

  // A note for a new task, unless the person is already on its run.
  const shown = arrived.filter((task) => !pathname.startsWith(`/workflows/runs/${task.runId}`));
  const shownKey = shown.map((task) => task.id).join(',');
  useEffect(() => {
    if (!shownKey) return;
    const timer = setTimeout(() => shownKey.split(',').forEach((id) => dismiss(id)), 10_000);
    return () => clearTimeout(timer);
  }, [shownKey, dismiss]);
  useEffect(() => {
    for (const task of arrived) if (pathname.startsWith(`/workflows/runs/${task.runId}`)) dismiss(task.id);
  }, [arrived, pathname, dismiss]);

  if (shown.length === 0) return null;
  return (
    <div className="tasks-toasts" role="status" aria-live="polite">
      {shown.map((task) => (
        <div key={task.id} className={`tasks-toast${task.overdue ? ' is-overdue' : ''}`}>
          <div className="tasks-toast-text">
            <span className="tasks-toast-kicker">New task for you</span>
            <span className="tasks-toast-title">{task.title}</span>
            <span className="tasks-toast-sub">{[task.workflowName, task.about].filter(Boolean).join(' · ')}</span>
          </div>
          <Link className="btn btn-sm btn-primary" href={taskHref(task)} onClick={() => dismiss(task.id)}>
            Open
          </Link>
          <button type="button" className="tasks-toast-close" aria-label="Dismiss" onClick={() => dismiss(task.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function TaskRow({ task, isNew, onOpen }: { task: WorkflowTask; isNew: boolean; onOpen: () => void }) {
  const [state, setState] = useState<{ status: 'idle' | 'saving' | 'done' | 'failed'; message?: string }>({ status: 'idle' });
  const place = placeText(task);

  async function approve() {
    if (!task.approveAll || state.status === 'saving') return;
    setState({ status: 'saving' });
    const result = await graphqlMutation<{ decideWorkflowReview: { errors: Array<{ message: string }> } }>(DECIDE_REVIEW, {
      input: { reviewId: task.id, outcome: 'APPROVED', decision: task.approveAll },
    });
    const errors = result.data?.decideWorkflowReview.errors || [];
    if (result.error || errors.length > 0) {
      setState({ status: 'failed', message: errors.map((error) => error.message).join(' ') || result.error?.message || 'The approval could not be recorded.' });
      return;
    }
    setState({ status: 'done', message: task.approvalsLeft > 0 ? `Your approval is recorded. ${task.approvalsLeft} more needed.` : 'Approved. The changes are being made.' });
    refreshTasks();
  }

  if (state.status === 'done') {
    return (
      <li className="tasks-row is-done">
        <span className="tasks-mark is-done" aria-hidden>✓</span>
        <span className="tasks-row-main">
          <span className="tasks-row-title">{task.title}</span>
          <span className="tasks-row-sub">{state.message}</span>
        </span>
      </li>
    );
  }

  return (
    <li className={`tasks-row${task.overdue ? ' is-overdue' : ''}`}>
      <span className={`tasks-mark${task.overdue ? ' is-overdue' : isNew ? ' is-new' : ''}`} aria-hidden>
        {task.overdue ? '!' : ''}
      </span>
      <Link className="tasks-row-main" href={taskHref(task)} onClick={onOpen}>
        <span className="tasks-row-title">
          {task.title}
          {task.about && <span className="tasks-row-about"> · {task.about}</span>}
          {isNew && <span className="tasks-new">New</span>}
        </span>
        <span className="tasks-row-sub">{[kindLabel(task.kind), task.workflowName, place, task.detail].filter(Boolean).join(' · ')}</span>
        {state.status === 'failed' && <span className="tasks-row-error">{state.message}</span>}
      </Link>
      <span className="tasks-row-side">
        <span className={`tasks-when${task.overdue ? ' is-overdue' : ''}`}>{whenText(task)}</span>
        {task.approveAll && (
          <button type="button" className="btn btn-sm" disabled={state.status === 'saving'} onClick={approve} title="Every change is one the agent was confident of, and none waits on an answer.">
            {state.status === 'saving' ? 'Approving…' : Object.keys((task.approveAll as { items?: object }).items || {}).length > 1 ? 'Approve all' : 'Approve'}
          </button>
        )}
      </span>
    </li>
  );
}

/** The Tasks button in the top bar, with its count, and the inbox it opens. */
export function TasksButton() {
  const list = useTaskStore((state) => state.list);
  const refresh = useTaskStore((state) => state.refresh);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(0);
  const [showWaiting, setShowWaiting] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const total = list?.total ?? 0;
  const overdue = list?.overdue ?? 0;

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // What was new is judged against the last time the inbox was opened; opening it marks everything seen.
    setSeenAt(readSeen());
    writeSeen(Date.now());
    setOpen(true);
    void refresh({ withPlace: true });
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    const onClick = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div className="tasks-anchor" ref={box}>
      <button
        type="button"
        className={`tasks-launcher${open ? ' active' : ''}${total > 0 ? ' has-tasks' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={countLabel(list)}
        title={countLabel(list)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 11l3 3 8-8" />
          <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />
        </svg>
        <span className="tasks-launcher-label">Tasks</span>
        {total > 0 && <span className={`tasks-count${overdue > 0 ? ' is-overdue' : ''}`}>{total > 99 ? '99+' : total}</span>}
      </button>

      {open && (
        <div className="tasks-panel" role="dialog" aria-label="Your tasks">
          <div className="tasks-panel-head">
            <span className="tasks-panel-title">Tasks</span>
            <span className="tasks-panel-sum">
              {list === null ? 'Reading…' : total === 0 ? 'Nothing is waiting for you.' : `${total} waiting for you${overdue > 0 ? ` · ${overdue} overdue` : ''}${list.dueSoon > 0 ? ` · ${list.dueSoon} due within a day` : ''}`}
            </span>
          </div>
          {list && list.tasks.length > 0 && (
            <ul className="tasks-list">
              {list.tasks.map((task) => (
                <TaskRow key={task.id} task={task} isNew={seenAt > 0 && Date.parse(task.createdAt) > seenAt} onOpen={() => setOpen(false)} />
              ))}
            </ul>
          )}
          {list && list.total === 0 && <div className="tasks-empty">When a workflow needs a decision from you, it shows here and on the run’s checklist.</div>}
          {list && list.waitingOnOthers > 0 && (
            <div className="tasks-waiting">
              <button type="button" className="tasks-waiting-toggle" aria-expanded={showWaiting} onClick={() => setShowWaiting(!showWaiting)}>
                {showWaiting ? '▾' : '▸'} Waiting on someone else: {list.waitingOnOthers}
              </button>
              {showWaiting && (
                <ul className="tasks-list is-others">
                  {list.waiting.map((task) => (
                    <li key={task.id} className="tasks-row">
                      <span className="tasks-mark is-others" aria-hidden />
                      <Link className="tasks-row-main" href={taskHref(task)} onClick={() => setOpen(false)}>
                        <span className="tasks-row-title">{task.title}</span>
                        <span className="tasks-row-sub">{[kindLabel(task.kind), task.workflowName, `with ${task.waitingOn}`].filter(Boolean).join(' · ')}</span>
                      </Link>
                      <span className="tasks-row-side"><span className="tasks-when">{whenText(task)}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="tasks-panel-foot">
            <Link href="/workflows" onClick={() => setOpen(false)}>Everything on Workflows</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/** The count beside a link in the sidebar. */
export function TaskBadge({ collapsed }: { collapsed: boolean }) {
  const list = useTaskStore((state) => state.list);
  const total = list?.total ?? 0;
  if (total === 0) return null;
  return collapsed ? (
    <span className="sidebar-dot" aria-label={countLabel(list)} />
  ) : (
    <span className={`sidebar-task-badge${list?.overdue ? ' is-overdue' : ''}`} aria-label={countLabel(list)}>
      {total > 99 ? '99+' : total}
    </span>
  );
}
