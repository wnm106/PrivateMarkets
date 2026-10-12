'use client';

import { useEffect, useRef, useState } from 'react';

interface JsonFieldProps {
  label: string;
  hint?: string;
  value: any;
  onChange: (value: any) => void;
  rows?: number;
}

/** A JSON textarea that only commits valid JSON and keeps in sync with external updates (e.g. AI "apply"). */
export function JsonField({ label, hint, value, onChange, rows = 16 }: JsonFieldProps) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const committed = useRef(JSON.stringify(value));

  useEffect(() => {
    const s = JSON.stringify(value);
    if (s !== committed.current) {
      committed.current = s;
      setText(JSON.stringify(value, null, 2));
      setError(null);
    }
  }, [value]);

  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--ink-3)', marginBottom: '4px' }}>{label}</div>
      {hint && <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginBottom: '6px' }}>{hint}</div>}
      <textarea
        className="mono"
        value={text}
        rows={rows}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          try {
            const v = JSON.parse(t);
            committed.current = JSON.stringify(v);
            setError(null);
            onChange(v);
          } catch (err: any) {
            setError(err.message);
          }
        }}
        style={{
          width: '100%',
          fontSize: '12px',
          padding: '10px',
          border: `1px solid ${error ? 'var(--red)' : 'var(--line)'}`,
          background: 'white',
          resize: 'vertical',
        }}
      />
      {error && <div style={{ color: 'var(--red)', fontSize: '11px', marginTop: '4px' }}>Invalid JSON: {error}</div>}
    </div>
  );
}
