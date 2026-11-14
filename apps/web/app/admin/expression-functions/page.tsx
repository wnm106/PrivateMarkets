'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
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
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return functions.filter((fn) => {
      if (category && fn.category !== category) return false;
      if (!query) return true;
      return [fn.code, fn.name, fn.signature, fn.description, fn.returnType]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }, [functions, category, search]);

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
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Expression functions</div>
            <div className="page-meta">
              Row functions go inside a calculated attribute as <code>{'{"fn":"CONCAT","args":[...]}'}</code>.
              Arithmetic can also be written as <code>{'{"op":"mul","args":[...]}'}</code>.
              Group functions are the aggregate on a relationship. Domain entries are patterns to copy.
              Format stays on the attribute display format.
            </div>
          </div>
        </div>
      </div>

      <div className="filter-bar" style={{ margin: '16px 0', flexWrap: 'wrap' }} role="tablist">
        {CATEGORIES.map((item) => {
          const count = item.id ? functions.filter((fn) => fn.category === item.id).length : functions.length;
          const active = category === item.id;
          return (
            <button
              key={item.id || 'all'}
              type="button"
              role="tab"
              aria-selected={active}
              className="btn"
              onClick={() => setCategory(item.id)}
              style={{
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? 'white' : 'var(--ink-2)',
              }}
            >
              {item.label} ({count})
            </button>
          );
        })}
        <input
          className="text-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, signature, or description"
          style={{ minWidth: 260 }}
        />
        <div className="filter-count">Showing <strong>{visible.length}</strong> of {functions.length}</div>
      </div>

      {message && <div style={{ color: 'var(--danger, #9b2c2c)', marginBottom: 12 }}>{message}</div>}
      {loading && <div style={{ color: 'var(--ink-3)' }}>Loading functions…</div>}
      {!loading && visible.length === 0 && !message && (
        <div style={{ color: 'var(--ink-3)' }}>No functions match this selection.</div>
      )}

      {visible.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' }}>
              <th style={{ width: 28 }} />
              <th style={cell}>Name</th>
              <th style={cell}>Signature</th>
              <th style={cell}>Category</th>
              <th style={cell}>Returns</th>
              <th style={cell}>Use</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((fn) => {
              const open = expanded.has(fn.id);
              return (
                <Fragment key={fn.id}>
                  <tr
                    onClick={() => toggle(fn.id)}
                    style={{ cursor: 'pointer', borderTop: '1px solid var(--line, #e5e5e5)' }}
                    aria-expanded={open}
                  >
                    <td style={{ ...cell, color: 'var(--ink-3)' }}>{open ? '▾' : '▸'}</td>
                    <td style={{ ...cell, fontWeight: 500 }}>{fn.name}</td>
                    <td style={{ ...cell, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{fn.signature}</td>
                    <td style={cell}>{fn.category}</td>
                    <td style={cell}>{fn.returnType}</td>
                    <td style={cell}>{fn.callable ? 'Expression' : 'Pattern'}</td>
                  </tr>
                  {open && (
                    <tr>
                      <td />
                      <td colSpan={5} style={{ padding: '4px 8px 16px' }}>
                        <p style={{ margin: '0 0 10px', color: 'var(--ink-2)' }}>{fn.description}</p>
                        <pre style={{ margin: 0, padding: 12, background: 'var(--bg-alt)', borderRadius: 8, overflow: 'auto', fontSize: 12 }}>
                          {JSON.stringify(fn.example, null, 2)}
                        </pre>
                        <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => copyExample(fn)}>
                          {copiedId === fn.id ? 'Copied' : 'Copy example'}
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: '8px 8px', verticalAlign: 'top' };
