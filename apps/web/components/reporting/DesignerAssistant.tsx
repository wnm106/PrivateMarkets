'use client';

import { useEffect, useRef, useState } from 'react';
import { markdownToHtml } from '@/lib/markdown';
import { authHeaders, sanitizeHtmlLinks } from '@/lib/reporting';

interface Message {
  role: 'user' | 'model';
  text: string;
  toolCalls?: Array<{ name: string }>;
}

interface DesignerAssistantProps {
  kind: 'dashboard' | 'narrative';
  domainCode: string;
  /** Current designer state, sent as context so the assistant can iterate on it. */
  draft: Record<string, any>;
  /** Called with the fields the assistant proposed; the designer merges them into its draft. */
  onApply: (patch: Record<string, any>) => void;
  /** A sample entity code for the assistant to test queries against. */
  sampleEntityCode?: string;
}

const SUGGESTIONS: Record<'dashboard' | 'narrative', string[]> = {
  dashboard: [
    'Design a dashboard summarising everything related to this entity, with KPI tiles and a chart.',
    'Add a filter input and make the table respond to it.',
    'Make the layout more compact and add totals.',
  ],
  narrative: [
    'Create a review that summarises this entity, its related data and flags anything unusual.',
    'Add a table of the top 10 related items and a chart.',
    'Focus the analysis on concentration and data gaps.',
  ],
};

/** Splits assistant text into prose and fenced ```json proposals. */
function splitProposals(text: string): Array<{ type: 'text'; value: string } | { type: 'proposal'; value: Record<string, any>; raw: string }> {
  const out: Array<any> = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push({ type: 'proposal', value: parsed, raw: m[1].trim() });
      else out.push({ type: 'text', value: m[0] });
    } catch {
      out.push({ type: 'text', value: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

export function DesignerAssistant({ kind, domainCode, draft, onApply, sampleEntityCode }: DesignerAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text: string) => {
    if (!text.trim() || loading) return;
    const next: Message[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.text })),
          toolContext: 'report-designer',
          context: {
            page: `${kind} designer`,
            domainCode,
            entityCode: sampleEntityCode,
            kind,
            draft,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Assistant error (${res.status})`);
      setMessages([...next, { role: 'model', text: body.text || '(no response)', toolCalls: body.toolCalls }]);
    } catch (e: any) {
      setMessages([...next, { role: 'model', text: `Sorry, something went wrong: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '640px', border: '1px solid var(--line)', background: 'white' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>
            <div style={{ marginBottom: '10px' }}>
              Describe what you want. The assistant inspects your real entity model, drafts the data queries and {kind === 'dashboard' ? 'HTML' : 'instructions'}, tests them against live data, and proposes changes you can apply to the draft.
            </div>
            {SUGGESTIONS[kind].map((s) => (
              <button
                key={s}
                className="btn btn-sm"
                style={{ display: 'block', marginBottom: '6px', textAlign: 'left', whiteSpace: 'normal' }}
                onClick={() => send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, mi) => (
          <div key={mi} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '92%' }}>
            <div
              style={{
                background: m.role === 'user' ? 'var(--accent-2)' : 'var(--bg-alt)',
                color: m.role === 'user' ? 'white' : 'inherit',
                padding: '10px 14px',
                fontSize: '13px',
                lineHeight: 1.5,
              }}
            >
              {m.role === 'user'
                ? m.text
                : splitProposals(m.text).map((seg, si) =>
                    seg.type === 'text' ? (
                      <div key={si} dangerouslySetInnerHTML={{ __html: sanitizeHtmlLinks(markdownToHtml(seg.value)) }} />
                    ) : (
                      <div key={si} style={{ border: '1px solid var(--line)', background: 'white', margin: '8px 0', padding: '10px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>
                          Proposed changes: {Object.keys(seg.value).join(', ')}
                        </div>
                        <details>
                          <summary style={{ fontSize: '11px', cursor: 'pointer', color: 'var(--ink-3)' }}>View</summary>
                          <pre style={{ fontSize: '11px', maxHeight: '220px', overflow: 'auto', margin: '6px 0' }}>{seg.raw}</pre>
                        </details>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: '6px' }}
                          disabled={applied[`${mi}-${si}`]}
                          onClick={() => {
                            onApply(seg.value);
                            setApplied((a) => ({ ...a, [`${mi}-${si}`]: true }));
                          }}
                        >
                          {applied[`${mi}-${si}`] ? 'Applied ✓' : 'Apply to draft'}
                        </button>
                      </div>
                    )
                  )}
            </div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div style={{ fontSize: '10px', color: 'var(--ink-3)', marginTop: '3px' }}>
                Checked: {Array.from(new Set(m.toolCalls.map((t) => t.name))).join(', ')}
              </div>
            )}
          </div>
        ))}
        {loading && <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>Inspecting the data model and testing queries…</div>}
        <div ref={endRef} />
      </div>

      <div style={{ borderTop: '1px solid var(--line)', padding: '10px', display: 'flex', gap: '8px', background: 'var(--bg)' }}>
        <textarea
          value={input}
          rows={2}
          placeholder={`Ask for a ${kind}, or describe a change…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          disabled={loading}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', fontSize: '13px', border: '1px solid var(--line)', fontFamily: 'inherit' }}
        />
        <button className="btn btn-primary" onClick={() => send(input)} disabled={loading || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
