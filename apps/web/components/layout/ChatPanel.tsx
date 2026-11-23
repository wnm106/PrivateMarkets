'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmHeldAction, sendGeminiMessage, ChatMessage, ChatContext, type HeldActionView } from '@/lib/gemini';
import { followInternalLink, markdownToHtml } from '@/lib/markdown';
import { CHAT_VOICES, readStoredChatVoice } from '@/lib/chat-voice';
import { useTemporalStore } from '@/lib/store';
import {
  ChatConversation,
  deleteConversation,
  fetchConversation,
  listConversations,
  renameConversation,
  uploadAttachment,
  attachmentUrl,
} from '@/lib/chat-history';
import {
  CHAT_ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
  formatBytes,
  isImage,
} from '@/lib/chat-attachments';
import {
  applyProposalToDesigner,
  getDesignerState,
  isDesignerProposal,
  subscribeDesigner,
  type DesignerBridgeState,
} from '@/lib/designer-bridge';
import {
  getViewContext,
  subscribeViewContext,
  type ViewFocus,
} from '@/lib/view-context';
import {
  skillById,
  viewFromStored,
  type SkillState,
  type SkillView,
} from '@tapestrai/mcp-server/src/lib/chat-skills';
import { AttributeInspectPanel, useDetailDrawer } from '@/components/detail/AttributeInspect';

/** A file the user has staged but not yet sent. */
interface StagedAttachment {
  localId: string;
  file: File;
  /** Set once the upload succeeds; null while uploading or if it failed. */
  uploadedId: string | null;
  previewUrl: string | null;
  error: string | null;
  uploading: boolean;
}

interface PanelMessage extends ChatMessage {
  attachments?: Array<{ id?: string; file_name: string; mime_type: string; previewUrl?: string | null }>;
  /** Fenced json proposals parsed from the assistant's reply. */
  proposals?: Array<{ raw: string; value: Record<string, any> }>;
  /** Outside changes the assistant asked for. Each runs only if the person presses Confirm. */
  heldActions?: HeldActionView[];
}

type HeldState = { status: 'running' | 'done' | 'declined' | 'failed'; text?: string };

interface ChatPanelProps {
  context?: ChatContext;
  /**
   * Tool profile to run under. Omit to let the page decide: an open report
   * designer promotes this surface into report-designer mode automatically.
   */
  toolContext?: ChatContext['toolContext'];
}

/** Pulls fenced json blocks that look like designer proposals out of assistant text. */
function extractProposals(text: string): Array<{ raw: string; value: Record<string, any> }> {
  const re = /```json\s*([\s\S]*?)```/g;
  const out: Array<{ raw: string; value: Record<string, any> }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isDesignerProposal(parsed)) out.push({ raw: match[1].trim(), value: parsed });
    } catch {
      // Not valid JSON: leave it in the prose.
    }
  }
  return out;
}

/**
 * The app's single assistant surface: a popout docked to the right edge.
 * It answers general questions, explores data and designs reports, and accepts
 * screenshots or reference documents to design against. A right-click on a
 * value slides that attribute's sources over the conversation, inside this panel.
 */
export function ChatPanel({ context, toolContext }: ChatPanelProps) {
  const isOpen = useTemporalStore((state) => state.chatOpen);
  const setChatOpen = useTemporalStore((state) => state.setChatOpen);
  const chatDraft = useTemporalStore((state) => state.chatDraft);
  const clearChatDraft = useTemporalStore((state) => state.clearChatDraft);
  const inspect = useDetailDrawer();
  const inspectOpen = inspect.view != null;
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  // A certified surface reads at its own dates. The assistant reads at the same ones.
  const pinnedDates = useTemporalStore((state) => state.pinnedDates);
  const chatVoice = useTemporalStore((state) => state.chatVoice);
  const setChatVoice = useTemporalStore((state) => state.setChatVoice);

  const router = useRouter();
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [designer, setDesigner] = useState<DesignerBridgeState>(() => getDesignerState());
  const [viewFocus, setViewFocus] = useState<ViewFocus | null>(() => getViewContext().focus);
  const [pageData, setPageData] = useState<Record<string, unknown> | null>(() => getViewContext().pageData);
  const [appliedProposals, setAppliedProposals] = useState<Record<string, boolean>>({});
  const [heldStates, setHeldStates] = useState<Record<string, HeldState>>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [skillView, setSkillView] = useState<SkillView | null>(null);
  const skillStateRef = useRef<SkillState | null>(null);

  const messagesBoxRef = useRef<HTMLDivElement>(null);
  const responseRowRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
  }, []);
  // Mirrors conversationId for the upload closures, so every file in a batch
  // lands in the same thread.
  const conversationIdRef = useRef<string | null>(null);

  // Track whether a report designer is open, so this one surface can also serve
  // as the design assistant and proposals have somewhere to land.
  useEffect(() => {
    const unsubscribe = subscribeDesigner(setDesigner);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeViewContext((next) => {
      setViewFocus(next.focus);
      setPageData(next.pageData);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Closing the assistant from anywhere else dismisses details too. Only the
  // open-to-closed edge counts, so a right-click cannot clear the view it just set.
  const assistantWasOpen = useRef(isOpen);
  useEffect(() => {
    if (assistantWasOpen.current && !isOpen) inspect.close();
    assistantWasOpen.current = isOpen;
  }, [isOpen, inspect.close]);

  // The stored choice is read after mount so the server render stays on the default.
  useEffect(() => {
    setChatVoice(readStoredChatVoice());
  }, [setChatVoice]);

  const activeDesigner = designer.active;
  // An explicit profile wins; otherwise a designer on the page promotes the
  // default chat into report-designer mode.
  const effectiveToolContext = toolContext ?? (activeDesigner ? 'report-designer' : context?.toolContext);
  const designerSkill =
    activeDesigner?.kind === 'narrative'
      ? 'design-narrative'
      : activeDesigner?.kind === 'dashboard'
        ? 'design-dashboard'
        : undefined;
  const guidedSkill = skillById(designerSkill) ?? (skillView ? skillById(skillView.id) : null);

  const screenLabel = activeDesigner
    ? `Designing a ${activeDesigner.kind}`
    : viewFocus
      ? `${viewFocus.activity === 'editing' ? 'Editing' : viewFocus.activity === 'creating' ? 'Creating' : 'Viewing'} ${viewFocus.label}${viewFocus.summary ? ` · ${viewFocus.summary}` : ''}`
      : context?.page || 'Contextual MDM copilot';
  const livePage = useMemo(() => {
    if (!viewFocus && !pageData) return null;
    const deal = viewFocus?.snapshot && typeof viewFocus.snapshot === 'object' ? viewFocus.snapshot : {};
    return {
      ...(viewFocus ? {
        page: viewFocus.label,
        section: viewFocus.summary,
        kind: viewFocus.kind,
        activity: viewFocus.activity || 'viewing',
      } : {}),
      ...deal,
      ...(pageData || {}),
    };
  }, [pageData, viewFocus]);

  const requestContext: ChatContext = useMemo(
    () => ({
      ...context,
      asOfDate: pinnedDates?.asOfDate ?? asOfDate,
      knowledgeDate: pinnedDates?.knowledgeDate ?? knowledgeDate,
      ...(pinnedDates ? { datesPinnedBy: pinnedDates.label } : {}),
      toolContext: effectiveToolContext,
      skill: designerSkill,
      ...(viewFocus
        ? {
            domainCode: viewFocus.domainCode || context?.domainCode,
            entityCode: viewFocus.entityCode || context?.entityCode,
            entityId: viewFocus.entityId || context?.entityId,
            view: {
              activity: viewFocus.activity,
              kind: viewFocus.kind,
              label: viewFocus.label,
              summary: viewFocus.summary,
              id: viewFocus.id,
              snapshot: livePage || viewFocus.snapshot,
            },
          }
        : livePage
          ? {
              view: {
                kind: 'page',
                label: context?.page || 'Page',
                snapshot: livePage,
              },
            }
          : {}),
      ...(activeDesigner
        ? {
            page: context?.page ?? `${activeDesigner.kind} designer`,
            domainCode: activeDesigner.domainCode,
            entityCode: activeDesigner.sampleEntityCode,
          }
        : viewFocus
          ? { page: [viewFocus.label, viewFocus.summary].filter(Boolean).join(' · ') }
          : {}),
    }),
    [context, effectiveToolContext, activeDesigner, viewFocus, livePage, asOfDate, knowledgeDate, pinnedDates, designerSkill]
  );

  /** Draft the assistant should iterate on, when a designer is open. */
  const designerDraft = activeDesigner?.draft;

  // A reply is aligned to the top of the thread so the answer can be read from
  // its first line. Sending still moves to the bottom, where the question and
  // the typing indicator are.
  const messageCountRef = useRef(0);
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    const box = messagesBoxRef.current;
    const count = messages.length;
    const grewByOne = count === messageCountRef.current + 1;
    const finished = wasLoadingRef.current && !isLoading;
    messageCountRef.current = count;
    wasLoadingRef.current = isLoading;
    if (!box) return;

    const last = messages[count - 1];
    const row = responseRowRef.current;
    if (finished && grewByOne && last?.role === 'model' && row) {
      const boxRect = box.getBoundingClientRect();
      const style = getComputedStyle(box);
      const inset = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
      const top = box.scrollTop + (row.getBoundingClientRect().top - boxRect.top) - inset;
      box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      return;
    }

    if (isLoading || finished) {
      box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, setChatOpen]);

  // Put the caret in the box as soon as the conversation is on screen, so typing
  // starts immediately. Skip when sources cover the conversation.
  useEffect(() => {
    if (!isOpen || inspectOpen) {
      const field = inputRef.current;
      if (inspectOpen && field && field === document.activeElement) field.blur();
      return;
    }
    const field = inputRef.current;
    if (!field || field.disabled) return;
    const placeCaret = () => {
      const end = field.value.length;
      field.focus({ preventScroll: true });
      field.setSelectionRange(end, end);
    };
    const opener = document.activeElement;
    placeCaret();
    // The dock animates open from zero width. If the first focus did not take,
    // try again once the box has width, unless focus has moved on purpose.
    const dock = field.closest('.chat-popout');
    const onDone = (event: Event) => {
      const transition = event as TransitionEvent;
      if (transition.target !== dock || transition.propertyName !== 'width') return;
      if (document.activeElement === field) return;
      if (document.activeElement !== opener && document.activeElement !== document.body) return;
      placeCaret();
    };
    dock?.addEventListener('transitionend', onDone);
    return () => dock?.removeEventListener('transitionend', onDone);
  }, [isOpen, inspectOpen]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not load history');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    refreshConversations();
  }, [isOpen, refreshConversations]);

  const patchStaged = (localId: string, update: Partial<StagedAttachment>) =>
    setStaged((prev) => prev.map((s) => (s.localId === localId ? { ...s, ...update } : s)));

  /** Sets the active thread and keeps the ref that uploads read in sync. */
  const setThreadId = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  /** Accepts files from the picker, drag/drop or paste and uploads them immediately. */
  const acceptFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const room = MAX_ATTACHMENTS_PER_TURN - staged.length;
      if (room <= 0) {
        setHistoryError(`A message can carry at most ${MAX_ATTACHMENTS_PER_TURN} attachments`);
        return;
      }

      const accepted = files.slice(0, room);
      const skipped: string[] = files
        .slice(room)
        .map((f) => `"${f.name}" (over the per-message limit)`);

      const fresh: StagedAttachment[] = [];
      for (const file of accepted) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          skipped.push(`"${file.name}" (larger than ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
          continue;
        }
        fresh.push({
          localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          uploadedId: null,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
          error: null,
          uploading: true,
        });
      }

      setHistoryError(skipped.length ? `Skipped ${skipped.join(', ')}` : null);
      if (!fresh.length) return;

      setStaged((prev) => [...prev, ...fresh]);

      // Upload the first file on its own so it can establish the thread, then run
      // the remainder in parallel against that same thread. Firing the whole batch
      // at once used to create a second thread and silently strand half the files:
      // the send only carries the ids staged on the thread it knows about.
      let threadId = conversationIdRef.current;
      try {
        const first = await uploadAttachment(fresh[0].file, threadId);
        threadId = first.conversationId;
        if (threadId !== conversationIdRef.current) setThreadId(threadId);
        patchStaged(fresh[0].localId, { uploadedId: first.attachment.id, uploading: false });
      } catch (error) {
        patchStaged(fresh[0].localId, {
          uploading: false,
          error: error instanceof Error ? error.message : 'Upload failed',
        });
      }

      await Promise.all(
        fresh.slice(1).map(async (item) => {
          try {
            const { attachment } = await uploadAttachment(item.file, threadId);
            patchStaged(item.localId, { uploadedId: attachment.id, uploading: false });
          } catch (error) {
            patchStaged(item.localId, {
              uploading: false,
              error: error instanceof Error ? error.message : 'Upload failed',
            });
          }
        })
      );
    },
    [staged.length, setThreadId]
  );

  const removeStaged = (localId: string) => {
    setStaged((prev) => {
      const target = prev.find((s) => s.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.localId !== localId);
    });
  };

  const handleSend = async () => {
    const ready = staged.filter((s) => s.uploadedId);
    if ((!input.trim() && !ready.length) || isLoading || staged.some((s) => s.uploading)) return;

    const userMessage: PanelMessage = {
      role: 'user',
      text: input,
      timestamp: Date.now(),
      attachments: ready.map((s) => ({
        id: s.uploadedId ?? undefined,
        file_name: s.file.name,
        mime_type: s.file.type,
        previewUrl: s.previewUrl,
      })),
    };

    const sentAttachmentIds = ready.map((s) => s.uploadedId!).filter(Boolean);

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    // Hand ownership of the previews to the message list; don't revoke them.
    setStaged([]);
    setIsLoading(true);

    try {
      const response = await sendGeminiMessage([...messages, userMessage], {
        ...requestContext,
        conversationId: conversationId ?? undefined,
        attachmentIds: sentAttachmentIds,
        designerDraft,
        voice: chatVoice,
        skill: designerSkill,
        skillState: skillStateRef.current,
      });

      skillStateRef.current = response.skillState ?? null;
      setSkillView(response.skill ?? null);

      setMessages((prev) => [
        ...prev,
        {
          role: 'model',
          text: response.text,
          timestamp: Date.now(),
          proposals: extractProposals(response.text),
          usage: response.usage,
          heldActions: response.heldActions,
        },
      ]);

      if (response.conversationId) {
        setThreadId(response.conversationId);
        await refreshConversations();
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'model',
          text: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const openConversation = async (id: string) => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const { conversation, messages: stored } = await fetchConversation(id);
      setThreadId(conversation.id);
      setMessages(
        stored.map((m) => ({
          role: m.role,
          text: m.content,
          timestamp: new Date(m.created_at).getTime(),
          attachments: (m.attachments ?? []).map((a) => ({
            id: a.id,
            file_name: a.file_name,
            mime_type: a.mime_type,
          })),
          proposals: m.role === 'model' ? extractProposals(m.content) : undefined,
        }))
      );
      setShowHistory(false);
      setHistoryError(null);
      setSkillView(viewFromStored(conversation.skill_state));
      skillStateRef.current = conversation.skill_state ?? null;
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not open conversation');
    } finally {
      setIsLoading(false);
    }
  };

  const startNewChat = () => {
    if (isLoading) return;
    setThreadId(null);
    setMessages([]);
    setShowHistory(false);
    setHistoryError(null);
    setEditingId(null);
    setConfirmingDeleteId(null);
    setStaged([]);
    setInput('');
    setSkillView(null);
    skillStateRef.current = null;
  };

  // A question asked from elsewhere in the app (the home page composer) is put
  // in the box and sent once, as if it had been typed here.
  const sendDraftRef = useRef(false);
  useEffect(() => {
    if (!isOpen || !chatDraft) return;
    setInput(chatDraft);
    sendDraftRef.current = true;
    clearChatDraft();
  }, [isOpen, chatDraft, clearChatDraft]);
  useEffect(() => {
    if (!sendDraftRef.current || !input.trim() || isLoading) return;
    sendDraftRef.current = false;
    void handleSend();
    // handleSend reads the input this effect waits for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isLoading]);

  const beginRename = (conversation: ChatConversation) => {
    setConfirmingDeleteId(null);
    setEditingId(conversation.id);
    setEditingTitle(conversation.title);
  };

  const commitRename = async () => {
    const id = editingId;
    const title = editingTitle.trim();
    setEditingId(null);
    if (!id || !title) return;
    const current = conversations.find((c) => c.id === id);
    if (current && current.title === title) return;
    try {
      await renameConversation(id, title);
      await refreshConversations();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not rename chat');
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmingDeleteId(null);
    try {
      await deleteConversation(id);
      if (id === conversationId) {
        setThreadId(null);
        setMessages([]);
      }
      await refreshConversations();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not delete chat');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyMessage = async (index: number, text: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopiedIndex(index);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopiedIndex((current) => (current === index ? null : current));
    }, 1500);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      void acceptFiles(files);
    }
  };

  /** Hands a proposal to the open designer and marks it applied in the thread. */
  const applyProposal = (key: string, proposal: Record<string, any>) => {
    if (!activeDesigner) return;
    applyProposalToDesigner(proposal);
    setAppliedProposals((prev) => ({ ...prev, [key]: true }));
  };

  /** Runs an outside change the person confirmed. Once started it cannot be pressed again. */
  const confirmHeld = async (held: HeldActionView) => {
    if (heldStates[held.id]) return;
    setHeldStates((prev) => ({ ...prev, [held.id]: { status: 'running' } }));
    try {
      const result = await confirmHeldAction(held.token, conversationId);
      setHeldStates((prev) => ({ ...prev, [held.id]: { status: result.ok ? 'done' : 'failed', text: result.text } }));
    } catch (error) {
      setHeldStates((prev) => ({ ...prev, [held.id]: { status: 'failed', text: error instanceof Error ? error.message : 'The change could not be run.' } }));
    }
  };

  const clearChat = () => setMessages([]);

  const readyAttachments = staged.filter((s) => s.uploadedId);
  const canSend =
    (input.trim().length > 0 || readyAttachments.length > 0) &&
    !isLoading &&
    !staged.some((s) => s.uploading);

  return (
    <aside
      className={`chat-popout ${isOpen ? 'open' : ''}${inspectOpen ? ' has-inspect' : ''}`}
      aria-hidden={!isOpen}
      inert={!isOpen}
      aria-label="tapestr.ai assistant"
    >
      <div className="chat-pane" inert={inspectOpen ? true : undefined} aria-hidden={inspectOpen}>
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-title">
          <Image
            className="chat-header-avatar"
            src="/tapestraichat-icon.png"
            alt=""
            width={36}
            height={36}
            unoptimized
          />
          <div className="chat-header-copy">
            <div className="chat-header-name">tapestr.ai Assistant</div>
            <div className="chat-header-sub" title={screenLabel}>
              {screenLabel}
            </div>
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            className="chat-icon-btn"
            onClick={() => setShowHistory((v) => !v)}
            title="Chat history"
            aria-label="Chat history"
            aria-expanded={showHistory}
          >
            🕘
          </button>
          <button className="chat-icon-btn" onClick={startNewChat} title="New chat" aria-label="New chat">
            ＋
          </button>
          <button className="chat-icon-btn" onClick={clearChat} title="Clear view" aria-label="Clear view">
            🗑️
          </button>
          <button
            className="chat-icon-btn"
            onClick={() => setChatOpen(false)}
            title="Close"
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="chat-voice">
        <div className="chat-voice-kicker">Voice</div>
        <div className="chat-voice-switch" role="radiogroup" aria-label="Assistant voice">
          {CHAT_VOICES.map((voice) => {
            const selected = chatVoice === voice.id;
            return (
              <button
                key={voice.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`chat-voice-option${selected ? ' is-on' : ''}`}
                title={voice.hint}
                onClick={() => setChatVoice(voice.id)}
              >
                {voice.label}
              </button>
            );
          })}
        </div>
        <p className="chat-voice-hint">{CHAT_VOICES.find((voice) => voice.id === chatVoice)?.hint}</p>
      </div>

      {livePage && (
        <details className="chat-page-json">
          <summary>
            <span>Page data</span>
            <small>{[viewFocus?.label, viewFocus?.summary].filter(Boolean).join(' · ') || context?.page}</small>
          </summary>
          <pre>{JSON.stringify(livePage, null, 2)}</pre>
        </details>
      )}

      {skillView && (
        <div className="chat-skill" aria-live="polite">
          <div className="chat-skill-kicker">
            {skillView.name} · {skillView.phaseLabel} · {skillView.decidedCount}/{skillView.requiredCount}
          </div>
          {skillView.open && (
            <div className="chat-skill-open">
              {skillView.open.status === 'ambiguous' ? 'Needs a choice' : 'Still open'}: {skillView.open.label}
            </div>
          )}
          {skillView.decided.length > 0 && (
            <div className="chat-skill-decided">
              {skillView.decided.map((item) => (
                <span key={item.label} title={item.value}>{item.label}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {showHistory && (
        <div className="chat-history">
          <div className="chat-history-head">
            <span>Your chats</span>
            <button className="chat-history-close" onClick={() => setShowHistory(false)} aria-label="Hide history">
              ✕
            </button>
          </div>
          {historyError && <div className="chat-history-error">{historyError}</div>}
          {conversations.length === 0 && !historyError && (
            <div className="chat-history-empty">No saved chats yet. Ask something to start one.</div>
          )}
          <ul className="chat-history-list">
            {conversations.map((c) => (
              <li key={c.id} className={`chat-history-item ${c.id === conversationId ? 'active' : ''}`}>
                {editingId === c.id ? (
                  <form
                    className="chat-history-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitRename();
                    }}
                  >
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      aria-label="Chat title"
                      maxLength={200}
                    />
                    <button type="submit" title="Save" aria-label="Save title">✓</button>
                    <button type="button" onClick={() => setEditingId(null)} title="Cancel" aria-label="Cancel rename">✕</button>
                  </form>
                ) : confirmingDeleteId === c.id ? (
                  <div className="chat-history-confirm">
                    <span>Delete this chat?</span>
                    <button type="button" className="danger" onClick={() => handleDelete(c.id)}>Delete</button>
                    <button type="button" onClick={() => setConfirmingDeleteId(null)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <button className="chat-history-open" onClick={() => openConversation(c.id)}>
                      <span className="chat-history-title">{c.title}</span>
                      <span className="chat-history-meta">
                        {c.message_count} {c.message_count === 1 ? 'message' : 'messages'}
                        {c.last_message_at ? ` · ${new Date(c.last_message_at).toLocaleDateString()}` : ''}
                      </span>
                    </button>
                    <div className="chat-history-tools">
                      <button onClick={() => beginRename(c)} title="Rename" aria-label={`Rename ${c.title}`}>✎</button>
                      <button
                        onClick={() => {
                          setEditingId(null);
                          setConfirmingDeleteId(c.id);
                        }}
                        title="Delete"
                        aria-label={`Delete ${c.title}`}
                      >
                        🗑️
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Messages */}
      <div
        ref={messagesBoxRef}
        className={`chat-messages ${dragActive ? 'drag-active' : ''}`}
        // A citation or record link in an answer opens in the app; the chat stays open.
        onClick={(e) => followInternalLink(e, (href) => router.push(href))}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          void acceptFiles(Array.from(e.dataTransfer?.files || []));
        }}
      >
        {dragActive && <div className="chat-dropzone">Drop files to attach</div>}
        {messages.length === 0 && (
          <div className="chat-empty">
            <Image src="/tapestraichat.png" alt="" width={96} height={96} unoptimized />
            <p>
              {activeDesigner ? (
                <>
                  {guidedSkill?.intro} I will check the real data model before proposing anything you can apply.
                </>
              ) : skillView && guidedSkill ? (
                <>{guidedSkill.intro}</>
              ) : viewFocus ? (
                <>
                  You&apos;re {viewFocus.activity === 'editing' ? 'editing' : viewFocus.activity === 'creating' ? 'creating' : 'viewing'}{' '}
                  {viewFocus.label}
                  {viewFocus.summary ? `, ${viewFocus.summary}` : ''}. The data on this page is under Page data, and I can use it when you ask.
                </>
              ) : (
                <>
                  Hi! I&apos;m your tapestr.ai MDM assistant
                  {context?.page ? `, and I can see you're on ${context.page}` : ''}. Ask about entities,
                  data quality, lineage — or attach a screenshot for me to work from.
                </>
              )}
            </p>
            {conversations.length > 0 && (
              <button className="btn btn-sm" onClick={() => setShowHistory(true)}>
                Review previous chats ({conversations.length})
              </button>
            )}
          </div>
        )}
        {messages.map((msg, idx) => {
          const structured = msg.role === 'model' && msg.text.includes('```answer');
          const latestResponse = msg.role === 'model' && idx === messages.length - 1;
          return (
          <div
            key={idx}
            ref={latestResponse ? responseRowRef : undefined}
            className={`chat-row ${msg.role === 'user' ? 'user' : 'model'}${structured ? ' has-answer' : ''}`}
          >
            {msg.role === 'user' ? (
              <div style={{ fontSize: '22px', flexShrink: 0 }} aria-hidden>👤</div>
            ) : (
              <Image
                className="chat-row-avatar"
                src="/tapestraichat-icon.png"
                alt=""
                width={30}
                height={30}
                unoptimized
              />
            )}
            <div className="chat-row-body">
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="chat-bubble-attachments">
                  {msg.attachments.map((a, ai) => (
                    <a
                      key={ai}
                      className="chat-attachment-chip"
                      href={a.id ? attachmentUrl(a.id) : a.previewUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.previewUrl || isImage(a.mime_type) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.previewUrl ?? attachmentUrl(a.id!)} alt={a.file_name} />
                      ) : (
                        <span aria-hidden>📄</span>
                      )}
                      <span className="chat-attachment-name">{a.file_name}</span>
                    </a>
                  ))}
                </div>
              )}
              {(msg.text || !msg.attachments?.length) && (
                <div className="chat-bubble">
                  {msg.text.trim() && (
                    <button
                      type="button"
                      className="btn btn-sm chat-copy"
                      aria-label={copiedIndex === idx ? 'Copied' : 'Copy message'}
                      onClick={() => { void copyMessage(idx, msg.text); }}
                    >
                      {copiedIndex === idx ? 'Copied' : 'Copy'}
                    </button>
                  )}
                  {msg.role === 'user' ? (
                    msg.text
                  ) : (
                    <div
                      className="markdown-content"
                      dangerouslySetInnerHTML={{ __html: markdownToHtml(msg.text) }}
                    />
                  )}
                </div>
              )}
              {msg.role === 'model' && msg.usage && msg.usage.calls > 0 && (
                <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
                  {msg.usage.totalTokens.toLocaleString('en-US')} tokens
                  {msg.usage.thinkingTokens > 0 ? ` · ${msg.usage.thinkingTokens.toLocaleString('en-US')} thinking` : ''}
                  {' · '}
                  {msg.usage.costUsd > 0 && msg.usage.costUsd < 0.01
                    ? `$${msg.usage.costUsd.toFixed(4)}`
                    : msg.usage.costUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                  {msg.usage.audits.some((audit) => audit.thinking) && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer' }}>Thinking</summary>
                      {msg.usage.audits.filter((audit) => audit.thinking).map((audit, auditIndex) => (
                        <pre key={audit.id ?? auditIndex} style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', fontSize: 11, color: 'var(--ink-3)' }}>{audit.thinking}</pre>
                      ))}
                    </details>
                  )}
                </div>
              )}
              {msg.proposals?.map((p, pi) => (
                <div key={pi} className="chat-proposal">
                  <div className="chat-proposal-head">
                    Proposed changes: {Object.keys(p.value).join(', ')}
                  </div>
                  <details>
                    <summary>View</summary>
                    <pre>{p.raw}</pre>
                  </details>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={appliedProposals[`${idx}-${pi}`] || !activeDesigner}
                    title={activeDesigner ? 'Apply to the open draft' : 'Open a report designer to apply this'}
                    onClick={() => applyProposal(`${idx}-${pi}`, p.value)}
                  >
                    {appliedProposals[`${idx}-${pi}`] ? 'Applied ✓' : 'Apply to draft'}
                  </button>
                  {!activeDesigner && (
                    <div className="chat-proposal-hint">
                      Open a dashboard or narrative to apply this proposal.
                    </div>
                  )}
                </div>
              ))}
              {msg.heldActions?.map((held) => {
                const state = heldStates[held.id];
                return (
                  <div key={held.id} className="chat-proposal">
                    <div className="chat-proposal-head">
                      Change in {held.serverName}: {held.tool}
                    </div>
                    <details open>
                      <summary>Exactly what will be sent</summary>
                      <pre>{JSON.stringify(held.args, null, 2)}</pre>
                    </details>
                    {!state && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => { void confirmHeld(held); }}>
                          Confirm
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => setHeldStates((prev) => ({ ...prev, [held.id]: { status: 'declined' } }))}
                        >
                          Decline
                        </button>
                      </div>
                    )}
                    {state?.status === 'running' && <div className="chat-proposal-hint">Running…</div>}
                    {state?.status === 'declined' && <div className="chat-proposal-hint">Declined. Nothing was sent.</div>}
                    {(state?.status === 'done' || state?.status === 'failed') && (
                      <div className="chat-proposal-hint" style={state.status === 'failed' ? { color: 'var(--badge-bad-fg)' } : undefined}>
                        {state.text}
                      </div>
                    )}
                    {!state && (
                      <div className="chat-proposal-hint">
                        The assistant cannot run this itself. It runs only if you press Confirm, before{' '}
                        {new Date(held.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="chat-timestamp">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
          );
        })}
        {isLoading && (
          <div className="chat-row model">
            <Image
              className="chat-row-avatar"
              src="/tapestraichat-icon.png"
              alt=""
              width={30}
              height={30}
              unoptimized
            />
            <div className="chat-row-body">
              <div className="chat-typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Staged attachments */}
      {staged.length > 0 && (
        <div className="chat-staged">
          {staged.map((s) => (
            <div key={s.localId} className={`chat-staged-item ${s.error ? 'error' : ''}`}>
              {s.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.previewUrl} alt="" />
              ) : (
                <span aria-hidden>📄</span>
              )}
              <div className="chat-staged-meta">
                <span className="chat-staged-name" title={s.file.name}>{s.file.name}</span>
                <span className="chat-staged-sub">
                  {s.uploading ? 'Uploading…' : s.error ? s.error : formatBytes(s.file.size)}
                </span>
              </div>
              <button onClick={() => removeStaged(s.localId)} title="Remove" aria-label={`Remove ${s.file.name}`}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {historyError && staged.length === 0 && <div className="chat-inline-error">{historyError}</div>}

      {/* Input Area */}
      <div className="chat-input-area">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={CHAT_ATTACHMENT_ACCEPT}
          hidden
          onChange={(e) => {
            void acceptFiles(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
        <button
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Attach a screenshot or document"
          aria-label="Attach a file"
          disabled={isLoading || staged.length >= MAX_ATTACHMENTS_PER_TURN}
        >
          📎
        </button>
        <textarea
          ref={inputRef}
          className="chat-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyPress}
          onPaste={handlePaste}
          placeholder={
            guidedSkill?.placeholder ??
            (activeDesigner ? 'Describe the design, or attach a reference…' : 'Ask me anything...')
          }
          rows={2}
          disabled={isLoading}
        />
        <button
          className="chat-send"
          onClick={handleSend}
          disabled={!canSend}
          title="Send"
          aria-label="Send message"
        >
          {isLoading ? '⏳' : '➤'}
        </button>
      </div>
      </div>
      <AttributeInspectPanel />
    </aside>
  );
}
