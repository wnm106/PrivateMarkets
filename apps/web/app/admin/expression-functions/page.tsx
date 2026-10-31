'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlQuery } from '@/lib/graphql';

const FUNCTIONS_QUERY = `
  query ExpressionFunctions {
    expressionFunctions {
      id
      code
      name
      category
      returnType
      description
      signature
      example
      callable
    }
  }
`;

interface ExpressionFunctionRow {
  id: string;
  code: string;
  name: string;
  category: string;
  returnType: string;
  description: string;
  signature: string;
  example: unknown;
  callable: boolean;
}

const CATEGORIES = [
  { id: '', label: 'All' },
  { id: 'ROW', label: 'Row' },
  { id: 'GROUP', label: 'Group' },
  { id: 'DOMAIN', label: 'Domain' },
  { id: 'DISPLAY', label: 'Display' },
];

export default function ExpressionFunctionsPage() {
  const [functions, setFunctions] = useState<ExpressionFunctionRow[]>([]);
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  usePublishViewContext(
    category
      ? {
          activity: 'viewing',
          kind: 'expression-functions',
          label: CATEGORIES.find((item) => item.id === category)?.label || category,
          summary: 'Expression function catalog',
          snapshot: { category },
        }
      : { activity: 'viewing', kind: 'expression-functions', label: 'Expression functions' }
  );

  useEffect(() => {
    graphqlQuery<{ expressionFunctions: ExpressionFunctionRow[] }, Record<string, never>>(FUNCTIONS_QUERY, {})
      .then((result) => {
        setFunctions(result.data?.expressionFunctions ?? []);
        if (result.error) setMessage(result.error.message);
        setLoading(false);
      });
  }, []);

  const visible = useMemo(
    () => functions.filter((fn) => !category || fn.category === category),
    [functions, category],
  );

  const copyExample = async (fn: ExpressionFunctionRow) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(fn.example, null, 2));
      setCopiedId(fn.id);
    } catch {
      setMessage('Could not copy the example.');
    }
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Expression functions</span>
      </div>
      <h1 style={{ fontSize: 22, margin: '12px 0' }}>Expression functions</h1>
      <p style={{ color: 'var(--ink-3)', maxWidth: 760 }}>
        Row functions go inside a calculated attribute as <code>{'{"fn":"CONCAT","args":[...]}'}</code>.
        Arithmetic can also be written as <code>{'{"op":"mul","args":[...]}'}</code>.
        Group functions are the aggregate on a relationship. Domain entries are patterns to copy.
        Format stays on the attribute display format.
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        {CATEGORIES.map((item) => (
          <button
            key={item.id || 'all'}
            type="button"
            className="btn"
            onClick={() => setCategory(item.id)}
            style={{
              background: category === item.id ? 'var(--accent)' : 'transparent',
              color: category === item.id ? 'white' : 'var(--ink-2)',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {message && <div style={{ color: 'var(--danger, #9b2c2c)', marginBottom: 12 }}>{message}</div>}
      {loading && <div style={{ color: 'var(--ink-3)' }}>Loading functions…</div>}
      {!loading && visible.length === 0 && !message && (
        <div style={{ color: 'var(--ink-3)' }}>No functions in this category.</div>
      )}

      <div style={{ display: 'grid', gap: 12, maxWidth: 880 }}>
        {visible.map((fn) => (
          <section key={fn.id} className="field-section" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <strong>{fn.name}</strong>
              <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                {fn.category} · {fn.callable ? 'Use in an expression' : 'Pattern'} · {fn.returnType}
              </span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13, margin: '6px 0' }}>{fn.signature}</div>
            <p style={{ margin: '6px 0 10px', color: 'var(--ink-2)' }}>{fn.description}</p>
            <pre style={{
              margin: 0,
              padding: 12,
              background: 'var(--bg-alt)',
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 12,
            }}
            >
              {JSON.stringify(fn.example, null, 2)}
            </pre>
            <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => copyExample(fn)}>
              {copiedId === fn.id ? 'Copied' : 'Copy example'}
            </button>
          </section>
        ))}
      </div>
    </div>
  );
}
