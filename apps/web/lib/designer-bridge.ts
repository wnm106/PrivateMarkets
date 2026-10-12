/**
 * Bridge between the primary chat panel and the report designer.
 *
 * The designer publishes its current draft here; the chat panel reads it to give
 * the assistant context and hands proposals back for the designer to merge. This
 * is what lets a single chat surface do design work without the two components
 * knowing about each other.
 *
 * Kept intentionally tiny: one active designer at a time, `version` bumps on every
 * change so the panel can tell when its cached draft is stale.
 */

export interface DesignerDraft {
  kind: 'dashboard' | 'narrative';
  domainCode: string;
  sampleEntityCode?: string;
  /** The fields the assistant is allowed to propose. */
  draft: Record<string, any>;
}

export interface DesignerBridgeState {
  active: DesignerDraft | null;
  version: number;
}

type Listener = (state: DesignerBridgeState) => void;

let state: DesignerBridgeState = { active: null, version: 0 };
const listeners = new Set<Listener>();

/** Payload handed back to the designer when the user applies a proposal. */
export interface PendingProposal {
  proposal: Record<string, any>;
  version: number;
}

let pending: PendingProposal | null = null;
type ProposalListener = (proposal: PendingProposal) => void;
const proposalListeners = new Set<ProposalListener>();

function emit() {
  for (const listener of listeners) listener(state);
}

/** True when a parsed JSON block looks like a designer proposal. */
export function isDesignerProposal(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const known = ['dashboardName', 'narrativeName', 'name', 'description', 'htmlTemplate',
    'instructions', 'dataQueries', 'parameters', 'outputBlocks'];
  return keys.some((k) => known.includes(k));
}

/** Registers the active designer and returns its snapshot. */
export function setActiveDesigner(active: DesignerDraft | null): DesignerBridgeState {
  state = { active, version: state.version + 1 };
  emit();
  return state;
}

export function getDesignerState(): DesignerBridgeState {
  return state;
}

export function subscribeDesigner(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Queues a proposal for the designer to merge into its draft, and notifies any
 * subscribed designer immediately.
 *
 * The designer is subscribed rather than polled: a 400ms interval stalls in a
 * backgrounded tab, which silently stranded the proposal until the user refocused
 * the window.
 */
export function applyProposalToDesigner(proposal: Record<string, any>): PendingProposal {
  pending = { proposal, version: (pending?.version ?? 0) + 1 };
  for (const listener of proposalListeners) listener(pending);
  return pending;
}

/** Subscribes to queued proposals; fires immediately if one is already waiting. */
export function subscribeProposals(listener: ProposalListener): () => void {
  proposalListeners.add(listener);
  if (pending) listener(pending);
  return () => {
    proposalListeners.delete(listener);
  };
}
