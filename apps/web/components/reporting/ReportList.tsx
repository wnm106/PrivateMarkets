'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { graphqlQuery, graphqlMutation, DOMAIN_TYPES_QUERY } from '@/lib/graphql';
import {
  DASHBOARDS_QUERY,
  NARRATIVES_QUERY,
  CREATE_DASHBOARD_MUTATION,
  CREATE_NARRATIVE_MUTATION,
  slugCode,
} from '@/lib/reporting';

interface Row {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  domainCode: string;
  isActive: boolean;
  queries: number;
}

const STARTER_HTML = `<div class="wrap">
  <h2 id="title">Loading…</h2>
  <div id="body"></div>
</div>
<style>
  .wrap { padding: 16px; }
  h2 { margin: 0 0 12px; font-size: 18px; }
</style>
<script>
  tapestr.onData(function (d) {
    var e = d.entity || {};
    document.getElementById('title').textContent = e.entityName || 'Dashboard';
    document.getElementById('body').innerHTML =
      '<p>Ask the AI assistant to design this dashboard, or edit the HTML directly.</p>';
  });
</script>`;

const STARTER_BLOCKS = [
  { type: 'markdown', key: 'summary', title: 'Summary', guidance: 'Short executive summary.' },
  { type: 'insights', key: 'findings', title: 'Key findings', guidance: 'Up to 5 concise findings.' },
];

export function ReportList({ kind }: { kind: 'dashboard' | 'narrative' }) {
  const router = useRouter();
  const isDash = kind === 'dashboard';
  const base = isDash ? '/admin/dashboards' : '/admin/narratives';
  const label = isDash ? 'Dashboard' : 'Narrative';

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [domains, setDomains] = useState<Array<{ domainCode: string; domainName: string }>>([]);
  const [filterDomain, setFilterDomain] = useState('all');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', domainCode: '', description: '' });
  const [codeTouched, setCodeTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await graphqlQuery<any, any>(isDash ? DASHBOARDS_QUERY : NARRATIVES_QUERY, {}, 'network-only');
    const list: any[] = (isDash ? data?.dashboards : data?.narratives) || [];
    setRows(
      list.map((r) => ({
        id: r.id,
        code: isDash ? r.dashboardCode : r.narrativeCode,
        name: isDash ? r.dashboardName : r.narrativeName,
        description: r.description,
        domainCode: r.domainCode,
        isActive: r.isActive,
        queries: (r.dataQueries || []).length,
      }))
    );
    setLoading(false);
  };

  useEffect(() => {
    load();
    graphqlQuery<{ domainTypes: any[] }, any>(DOMAIN_TYPES_QUERY).then(({ data }) => {
      const d = data?.domainTypes || [];
      setDomains(d);
      setForm((f) => ({ ...f, domainCode: f.domainCode || d[0]?.domainCode || '' }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const common = {
        description: form.description || undefined,
        domainCode: form.domainCode,
        dataQueries: [],
        parameters: [],
      };
      const res = isDash
        ? await graphqlMutation<any, any>(CREATE_DASHBOARD_MUTATION, {
            input: { ...common, dashboardCode: form.code, dashboardName: form.name, htmlTemplate: STARTER_HTML },
          })
        : await graphqlMutation<any, any>(CREATE_NARRATIVE_MUTATION, {
            input: { ...common, narrativeCode: form.code, narrativeName: form.name, instructions: '', outputBlocks: STARTER_BLOCKS },
          });
      const out = isDash ? res.data?.createDashboard : res.data?.createNarrative;
      if (res.error || out?.errors?.length || !(out?.dashboard || out?.narrative)) {
        setError(res.error?.message || out?.errors?.map((e: any) => e.message).join('; ') || 'Could not create');
        return;
      }
      router.push(`${base}/${form.code}`);
    } finally {
      setSubmitting(false);
    }
  };

  const shown = rows.filter((r) => filterDomain === 'all' || r.domainCode === filterDomain);
  const input = { width: '100%', padding: '8px 10px', fontSize: '13px', border: '1px solid var(--line)', background: 'white' } as const;
  const lbl = { fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--ink-3)', margin: '12px 0 4px' } as const;

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{label}s</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{label}s</div>
          <div className="page-meta">
            {isDash
              ? 'Custom HTML dashboards fed by declarative data queries, shown on entity pages.'
              : 'Templated AI reviews that retrieve data, analyse it and return text, tables, charts and insights.'}
            {!loading && ` · ${rows.length} defined`}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New {label}</button>
        </div>
      </div>

      {creating && (
        <div style={{ border: '1px solid var(--line)', background: 'white', padding: '16px 20px', marginBottom: '18px', maxWidth: '560px' }}>
          <div style={lbl}>Name</div>
          <input
            style={input}
            value={form.name}
            autoFocus
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, code: codeTouched ? f.code : slugCode(e.target.value) }))}
          />
          <div style={lbl}>Code</div>
          <input
            className="mono"
            style={input}
            value={form.code}
            onChange={(e) => {
              setCodeTouched(true);
              setForm((f) => ({ ...f, code: slugCode(e.target.value) }));
            }}
          />
          <div style={lbl}>Entity type</div>
          <select className="select" style={{ width: '100%' }} value={form.domainCode} onChange={(e) => setForm((f) => ({ ...f, domainCode: e.target.value }))}>
            {domains.map((d) => (
              <option key={d.domainCode} value={d.domainCode}>{d.domainName} ({d.domainCode})</option>
            ))}
          </select>
          <div style={lbl}>Description</div>
          <textarea style={input} rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          {error && <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '10px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
            <button className="btn btn-primary" onClick={create} disabled={submitting || !form.name || !form.code || !form.domainCode}>
              {submitting ? 'Creating…' : 'Create & design'}
            </button>
            <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <select className="select" style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }} value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}>
          <option value="all">All entity types</option>
          {domains.map((d) => (
            <option key={d.domainCode} value={d.domainCode}>{d.domainName}</option>
          ))}
        </select>
        <div className="filter-count">Showing <strong>{shown.length}</strong> of {rows.length}</div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}><div className="loader">Loading…</div></div>
      ) : shown.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: '13px' }}>
          Nothing here yet. Create your first {label.toLowerCase()} and let the AI assistant help you design it.
        </div>
      ) : (
        <div className="data-table">
          {shown.map((r) => (
            <div
              key={r.id}
              onClick={() => router.push(`${base}/${r.code}`)}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.8fr 140px 110px 90px',
                gap: '14px',
                padding: '14px 18px',
                borderBottom: '1px solid var(--line)',
                fontSize: '12px',
                alignItems: 'center',
                cursor: 'pointer',
                opacity: r.isActive ? 1 : 0.6,
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div>
                <div style={{ fontWeight: 500, color: 'var(--ink)' }}>{r.name}</div>
                <div className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{r.code}</div>
                {r.description && <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '2px' }}>{r.description}</div>}
              </div>
              <div>{r.domainCode}</div>
              <div style={{ color: 'var(--ink-3)' }}>{r.queries} data {r.queries === 1 ? 'query' : 'queries'}</div>
              <div style={{ textAlign: 'center' }}>{r.isActive ? 'Active' : 'Disabled'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
