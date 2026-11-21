import { create } from 'zustand';
import type { TaskList, WorkflowTask } from '@tapestrai/graphql/src/lib/workflow-tasks';
import { graphqlQuery } from '@/lib/graphql';

/**
 * The person's tasks, as the top bar, the sidebar, the browser tab and the
 * toasts show them. One store, refreshed every minute, when the tab comes back
 * into view, and as soon as the person finishes a task, so every place in the
 * app shows the same count.
 */

export type { TaskList, WorkflowTask };

const TASK_FIELDS = 'id kind runId nodeId title workflowName about detail createdAt dueAt overdue canAct blocker waitingOn place placeOf approveAll approvalsLeft';
export const MY_TASKS_QUERY = `
  query MyTasks($withPlace: Boolean) {
    myTasks(withPlace: $withPlace) { total overdue dueSoon waitingOnOthers tasks { ${TASK_FIELDS} } waiting { ${TASK_FIELDS} } }
  }
`;

/** How often the count is read while the app is open. */
export const TASK_POLL_MS = 60_000;

interface TaskState {
  list: TaskList | null;
  /** Ids of the tasks seen on the last read, to tell which are new. */
  known: Set<string> | null;
  /** Tasks that arrived since the last read, for a toast. */
  arrived: WorkflowTask[];
  refresh(options?: { withPlace?: boolean }): Promise<void>;
  dismissArrived(id: string): void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  list: null,
  known: null,
  arrived: [],
  refresh: async (options) => {
    const result = await graphqlQuery<{ myTasks: TaskList }>(MY_TASKS_QUERY, { withPlace: options?.withPlace === true }, 'network-only');
    if (result.aborted || result.error || !result.data?.myTasks) return;
    const list = result.data.myTasks;
    const { known, arrived } = get();
    const fresh = known ? newTasks(known, list.tasks) : [];
    set({ list, known: new Set(list.tasks.map((task) => task.id)), arrived: [...arrived.filter((task) => list.tasks.some((entry) => entry.id === task.id)), ...fresh].slice(-3) });
  },
  dismissArrived: (id) => set({ arrived: get().arrived.filter((task) => task.id !== id) }),
}));

/** Ask every place that shows tasks to read them again, after a task is done. */
export function refreshTasks() {
  void useTaskStore.getState().refresh();
}

/** Tasks in this read that were not in the last one. */
export function newTasks(known: ReadonlySet<string>, tasks: readonly WorkflowTask[]): WorkflowTask[] {
  return tasks.filter((task) => !known.has(task.id));
}

/** The page title with the count in front: "(3) Fund reconciliation". */
export function titleWithCount(title: string, count: number): string {
  const bare = title.replace(/^\(\d+\+?\)\s+/, '');
  return count > 0 ? `(${count > 99 ? '99+' : count}) ${bare}` : bare;
}

/** What the count says to someone who cannot see the badge. */
export function countLabel(list: Pick<TaskList, 'total' | 'overdue'> | null): string {
  if (!list || list.total === 0) return 'Tasks: nothing waiting for you';
  return `Tasks: ${list.total} waiting for you${list.overdue > 0 ? `, ${list.overdue} overdue` : ''}`;
}

/** Where a task opens: its run, on that decision. */
export function taskHref(task: Pick<WorkflowTask, 'runId' | 'nodeId'>): string {
  return `/workflows/runs/${task.runId}?decision=${encodeURIComponent(task.nodeId)}`;
}

/** "Decision 2 of 4", or nothing when the run has one decision or its place is not known. */
export function placeText(task: Pick<WorkflowTask, 'place' | 'placeOf'>): string | null {
  return task.place && task.placeOf && task.placeOf > 1 ? `Decision ${task.place} of ${task.placeOf}` : null;
}

const KIND: Record<WorkflowTask['kind'], string> = { review: 'Review', form: 'Form', stage: 'Screen' };

export function kindLabel(kind: WorkflowTask['kind']): string {
  return KIND[kind] || 'Task';
}

/** "due in 3 hours", "2 hours overdue", "waiting 2 days". */
export function whenText(task: Pick<WorkflowTask, 'dueAt' | 'createdAt'>, now = Date.now()): string {
  const span = (ms: number) => {
    const hours = Math.abs(ms) / 3_600_000;
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
    return `${Math.round(hours / 24)} days`;
  };
  if (task.dueAt) {
    const ms = Date.parse(task.dueAt) - now;
    if (Number.isFinite(ms)) return ms >= 0 ? `due in ${span(ms)}` : `${span(ms)} overdue`;
  }
  const waited = now - Date.parse(task.createdAt);
  return Number.isFinite(waited) ? `waiting ${span(waited)}` : '';
}
