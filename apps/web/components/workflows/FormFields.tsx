'use client';

import { useState, type CSSProperties } from 'react';
import { answerProblems, cleanRaw, normalizeAnswers, type FormField } from '@/lib/workflow-forms';

/**
 * Fills in a workflow form. Used in the app for a form someone in the firm
 * answers, and on the portal for someone outside it. Answers are checked here
 * and again by the database.
 */

const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' };
const hint: CSSProperties = { fontSize: 11, color: 'var(--ink-4)' };
const full: CSSProperties = { width: '100%', boxSizing: 'border-box' };

interface Props {
  fields: FormField[];
  /** Sends the answers. Returns a message when they were refused. */
  onSubmit(outcome: 'SUBMITTED' | 'DECLINED', answers: Record<string, unknown>, note: string): Promise<string | null>;
  disabled?: boolean;
}

export function FormFields({ fields, onSubmit, disabled = false }: Props) {
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const send = async (outcome: 'SUBMITTED' | 'DECLINED') => {
    setMessage('');
    if (outcome === 'SUBMITTED') {
      const found = answerProblems(fields, raw);
      setProblems(found);
      if (Object.keys(found).length > 0) return;
    } else if (!note.trim()) {
      setMessage('Say why you are declining, in the note.');
      return;
    }
    setSaving(true);
    const refused = await onSubmit(outcome, outcome === 'SUBMITTED' ? normalizeAnswers(fields, cleanRaw(fields, raw)) : {}, note.trim());
    setSaving(false);
    if (refused) setMessage(refused);
  };

  const set = (key: string, value: string) => setRaw((current) => ({ ...current, [key]: value }));
  const off = disabled || saving;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {fields.map((field) => (
        <div key={field.key} style={{ display: 'grid', gap: 4 }}>
          <label htmlFor={`field-${field.key}`} style={label}>
            {field.label}
            {field.required && <span style={{ color: 'var(--red)' }}> *</span>}
          </label>
          {field.type === 'longtext' ? (
            <textarea id={`field-${field.key}`} className="text-input" rows={4} style={full} disabled={off} value={raw[field.key] || ''} onChange={(event) => set(field.key, event.target.value)} />
          ) : field.type === 'choice' ? (
            <select id={`field-${field.key}`} className="text-input" style={full} disabled={off} value={raw[field.key] || ''} onChange={(event) => set(field.key, event.target.value)}>
              <option value="">Choose…</option>
              {(field.options || []).map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          ) : field.type === 'yesno' ? (
            <select id={`field-${field.key}`} className="text-input" style={full} disabled={off} value={raw[field.key] || ''} onChange={(event) => set(field.key, event.target.value)}>
              <option value="">Choose…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          ) : (
            <input
              id={`field-${field.key}`}
              className="text-input"
              style={full}
              disabled={off}
              type={field.type === 'date' ? 'date' : 'text'}
              inputMode={field.type === 'number' ? 'decimal' : undefined}
              value={raw[field.key] || ''}
              onChange={(event) => set(field.key, event.target.value)}
            />
          )}
          {field.help && <span style={hint}>{field.help}</span>}
          {problems[field.key] && <span role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{problems[field.key]}</span>}
        </div>
      ))}
      <div style={{ display: 'grid', gap: 4 }}>
        <label htmlFor="field-note" style={label}>Note</label>
        <textarea id="field-note" className="text-input" rows={2} style={full} disabled={off} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Anything the firm should know" />
      </div>
      {message && <div role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{message}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={off} onClick={() => void send('SUBMITTED')}>
          {saving ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="btn" disabled={off} onClick={() => void send('DECLINED')}>
          Decline
        </button>
      </div>
    </div>
  );
}
