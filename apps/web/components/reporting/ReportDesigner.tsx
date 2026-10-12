'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { graphqlQuery, graphqlMutation, ENTITIES_QUERY, DOMAIN_TYPES_QUERY } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import {
  RUN_DATA_QUERIES_QUERY,
  UPDATE_DASHBOARD_MUTATION,
  UPDATE_NARRATIVE_MUTATION,
  DELETE_DASHBOARD_MUTATION,
  DELETE_NARRATIVE_MUTATION,
  type DashboardTemplate,
  type NarrativeTemplate,
} from '@/lib/reporting';
import { JsonField } from './JsonField';
import { DashboardRunner } from './DashboardRunner';
import { NarrativeRunner } from './NarrativeRunner';
import { setActiveDesigner, subscribeProposals } from '@/lib/designer-bridge';

type Kind = 'dashboard' | 'narrative';
type LeftTab = 'details' | 'data' | 'params' | 'content';
type RightTab = 'preview' | 'code';

interface Draft {
  name: string;
  description: string;
  domainCode: string;
  isActive: boolean;
  dataQueries: any[];
  parameters: any[];
  htmlTemplate: string; // dashboard
  instructions: string; // narrative
  outputBlocks: any[]; // narrative
}

interface ReportDesignerProps {
  kind: Kind;
  initial: DashboardTemplate | NarrativeTemplate;
}

function toDraft(kind: Kind, t: DashboardTemplate | NarrativeTemplate): Draft {
  const isDash = kind === 'dashboard';
  const d = t as DashboardTemplate;
  const n = t as NarrativeTemplate;
  return {
    name: isDash ? d.dashboardName : n.narrativeName,
    description: t.description || '',
    domainCode: t.domainCode,
    isActive: t.isActive,
    dataQueries: t.dataQueries || [],
    parameters: t.parameters || [],
    htmlTemplate: isDash ? d.htmlTemplate || '' : '',
    instructions: isDash ? '' : n.instructions || '',
    outputBlocks: isDash ? [] : n.outputBlocks || [],
  };
}

export function ReportDesigner({ kind, initial }: ReportDesignerProps) {
  const router = useRouter();
  const asOfDate = useTemporalStore((s) => s.asOfDate);
  const base = kind === 'dashboard' ? '/admin/dashboards' : '/admin/narratives';
  const label = kind === 'dashboard' ? 'Dashboard' : 'Narrative';
  const code = kind === 'dashboard' ? (initial as DashboardTemplate).dashboardCode : (initial as NarrativeTemplate).narrativeCode;

  const [saved, setSaved] = useState<Draft>(() => toDraft(kind, initial));
  const [draft, setDraft] = useState<Draft>(() => toDraft(kind, initial));
  const [leftTab, setLeftTab] = useState<LeftTab>('content');
  const [rightTab, setRightTab] = useState<RightTab>('preview');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [domains, setDomains] = useState<Array<{ domainCode: string; domainName: string }>>([]);
  const [samples, setSamples] = useState<Array<{ id: string; entityCode: string; entityName: string }>>([]);
  const [sampleId, setSampleId] = useState<string>('');
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const sample = samples.find((s) => s.id === sampleId);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  /** Merges an AI proposal (dashboardName/htmlTemplate/... or narrativeName/instructions/...) into the draft. */
  const applyProposal = useCallback(
    (p: Record<string, any>) => {
      const next: Partial<Draft> = {};
      const name = p.dashboardName ?? p.narrativeName ?? p.name;
      if (typeof name === 'string') next.name = name;
      if (typeof p.description === 'string') next.description = p.description;
      if (kind === 'dashboard' && typeof p.htmlTemplate === 'string') next.htmlTemplate = p.htmlTemplate;
      if (kind === 'narrative' && typeof p.instructions === 'string') next.instructions = p.instructions;
      if (Array.isArray(p.dataQueries)) next.dataQueries = p.dataQueries;
      if (Array.isArray(p.parameters)) next.parameters = p.parameters;
      if (kind === 'narrative' && Array.isArray(p.outputBlocks)) next.outputBlocks = p.outputBlocks;
      patch(next);
      setMessage({ type: 'ok', text: 'Applied assistant changes to the draft. Review the preview, then Save.' });
    },
    [kind]
  );

  // Publish this designer to the chat bridge so the primary chat panel can see
  // (and propose changes to) the draft that is currently open.
  useEffect(() => {
    setActiveDesigner({
      kind,
      domainCode: draft.domainCode,
      sampleEntityCode: sample?.entityCode,
      draft:
        kind === 'dashboard'
          ? {
              dashboardName: draft.name,
              description: draft.description,
              htmlTemplate: draft.htmlTemplate,
              dataQueries: draft.dataQueries,
              parameters: draft.parameters,
            }
          : {
              narrativeName: draft.name,
              description: draft.description,
              instructions: draft.instructions,
              dataQueries: draft.dataQueries,
              parameters: draft.parameters,
              outputBlocks: draft.outputBlocks,
            },
    });
  }, [
    kind,
    draft.domainCode,
    draft.name,
    draft.description,
    draft.htmlTemplate,
    draft.instructions,
    draft.dataQueries,
    draft.parameters,
    draft.outputBlocks,
    sample?.entityCode,
  ]);

  // Clear the registration when leaving the designer.
  useEffect(
    () => () => {
      setActiveDesigner(null);
    },
    []
  );

  // Pick up proposals the chat panel queued for this draft. Subscribed rather
  // than polled so a backgrounded tab cannot strand a proposal.
  useEffect(() => {
    return subscribeProposals((queued) => applyProposal(queued.proposal));
  }, [applyProposal]);

  useEffect(() => {
    graphqlQuery<{ domainTypes: any[] }, any>(DOMAIN_TYPES_QUERY).then(({ data }) => setDomains(data?.domainTypes || []));
  }, []);

  // Sample entities of the anchor type, used to preview / test with.
  useEffect(() => {
    let cancelled = false;
    setSampleId('');
    graphqlQuery<{ entities: { edges: Array<{ node: any }> } }, any>(
      ENTITIES_QUERY,
      { filter: { domainCode: draft.domainCode }, pagination: { first: 50 } },
      'network-only'
    ).then(({ data }) => {
      if (cancelled) return;
      const list = (data?.entities?.edges || []).map((e) => e.node);
      setSamples(list);
      if (list[0]) setSampleId(list[0].id);
    });
    return () => {
      cancelled = true;
    };
  }, [draft.domainCode]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const common = {
        description: draft.description || null,
        domainCode: draft.domainCode,
        dataQueries: draft.dataQueries,
        parameters: draft.parameters,
        isActive: draft.isActive,
      };
      const res =
        kind === 'dashboard'
          ? await graphqlMutation<{ updateDashboard: { errors: any[] } }, any>(UPDATE_DASHBOARD_MUTATION, {
              id: initial.id,
              input: { ...common, dashboardName: draft.name, htmlTemplate: draft.htmlTemplate },
            })
          : await graphqlMutation<{ updateNarrative: { errors: any[] } }, any>(UPDATE_NARRATIVE_MUTATION, {
              id: initial.id,
              input: { ...common, narrativeName: draft.name, instructions: draft.instructions, outputBlocks: draft.outputBlocks },
            });
      const result: any = kind === 'dashboard' ? (res.data as any)?.updateDashboard : (res.data as any)?.updateNarrative;
      const errors = result?.errors || [];
      if (res.error || errors.length) {
        setMessage({ type: 'error', text: res.error?.message || errors.map((e: any) => e.message).join('; ') });
      } else {
        setSaved(draft);
        setMessage({ type: 'ok', text: 'Saved.' });
      }
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete this ${label.toLowerCase()}? This cannot be undone.`)) return;
    const res = await graphqlMutation<any, any>(kind === 'dashboard' ? DELETE_DASHBOARD_MUTATION : DELETE_NARRATIVE_MUTATION, { id: initial.id });
    const out = kind === 'dashboard' ? res.data?.deleteDashboard : res.data?.deleteNarrative;
    if (out?.success) router.push(base);
    else setMessage({ type: 'error', text: out?.errors?.map((e: any) => e.message).join('; ') || res.error?.message || 'Delete failed' });
  };

  const testQueries = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data, error } = await graphqlQuery<{ runDataQueries: any }, any>(
        RUN_DATA_QUERIES_QUERY,
        { queries: draft.dataQueries, entityId: sampleId || null, params: { asOfDate } },
        'network-only'
      );
      setTestResult(error ? { fatal: error.message } : data?.runDataQueries);
    } finally {
      setTesting(false);
    }
  };

  const tabBtn = (active: boolean) => ({
    padding: '8px 14px',
    fontSize: '12px',
    border: 'none',
    borderBottom: `2px solid ${active ? 'var(--ink)' : 'transparent'}`,
    background: 'transparent',
    color: active ? 'var(--ink)' : 'var(--ink-3)',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  });

  const fieldLabel = (text: string) => (
    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--ink-3)', margin: '12px 0 4px' }}>{text}</div>
  );
  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '13px', border: '1px solid var(--line)', background: 'white', fontFamily: 'inherit' } as const;

  const narrativeDraft = {
    instructions: draft.instructions,
    dataQueries: draft.dataQueries,
    outputBlocks: draft.outputBlocks,
    narrativeName: draft.name,
    domainCode: draft.domainCode,
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href={base} className="crumb-link">{label}s</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{draft.name}</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{draft.name}</div>
          <div className="page-meta">
            <span className="mono">{code}</span> · attached to <strong>{draft.domainCode}</strong> entities
            {dirty && <span style={{ color: 'var(--amber)', marginLeft: '10px' }}>● Unsaved changes</span>}
          </div>
        </div>
        <div className="page-actions" style={{ display: 'flex', gap: '8px' }}>
          <button className="btn" onClick={remove}>Delete</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {message && (
        <div
          style={{
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '12px',
            background: message.type === 'ok' ? '#e1f1e7' : '#fdecec',
            color: message.type === 'ok' ? '#047857' : '#b91c1c',
          }}
        >
          {message.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '20px', alignItems: 'start' }}>
        {/* ---------------- Left: editor ---------------- */}
        <div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', marginBottom: '14px' }}>
            <button style={tabBtn(leftTab === 'content')} onClick={() => setLeftTab('content')}>
              {kind === 'dashboard' ? 'HTML' : 'Instructions & output'}
            </button>
            <button style={tabBtn(leftTab === 'data')} onClick={() => setLeftTab('data')}>Data queries ({draft.dataQueries.length})</button>
            <button style={tabBtn(leftTab === 'params')} onClick={() => setLeftTab('params')}>Filter inputs ({draft.parameters.length})</button>
            <button style={tabBtn(leftTab === 'details')} onClick={() => setLeftTab('details')}>Details</button>
          </div>

          {leftTab === 'details' && (
            <div>
              {fieldLabel('Name')}
              <input style={inputStyle} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              {fieldLabel('Description')}
              <textarea style={inputStyle} rows={3} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
              {fieldLabel('Entity type')}
              <select className="select" style={{ width: '100%' }} value={draft.domainCode} onChange={(e) => patch({ domainCode: e.target.value })}>
                {!domains.find((d) => d.domainCode === draft.domainCode) && <option value={draft.domainCode}>{draft.domainCode}</option>}
                {domains.map((d) => (
                  <option key={d.domainCode} value={d.domainCode}>{d.domainName} ({d.domainCode})</option>
                ))}
              </select>
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '16px', fontSize: '13px' }}>
                <input type="checkbox" checked={draft.isActive} onChange={(e) => patch({ isActive: e.target.checked })} />
                Active (shown on {draft.domainCode} pages)
              </label>
            </div>
          )}

          {leftTab === 'content' && kind === 'dashboard' && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginBottom: '6px' }}>
                HTML/CSS/JS fragment, rendered in a sandbox with no network access. Use <code>tapestr.onData(fn)</code> to receive{' '}
                <code>{'{ entity, data, params }'}</code>; helpers: <code>tapestr.fmt</code>, <code>tapestr.charts.bar/line/donut</code>,{' '}
                <code>tapestr.table</code>, <code>tapestr.setParam</code>, <code>tapestr.esc</code>. Ask the assistant
                in the chat panel to write it for you, or attach a screenshot to design against.
              </div>
              <textarea
                className="mono"
                spellCheck={false}
                rows={30}
                value={draft.htmlTemplate}
                onChange={(e) => patch({ htmlTemplate: e.target.value })}
                style={{ ...inputStyle, fontSize: '12px', resize: 'vertical' }}
              />
            </div>
          )}

          {leftTab === 'content' && kind === 'narrative' && (
            <div>
              {fieldLabel('Analysis instructions')}
              <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginBottom: '6px' }}>
                Tell the model exactly what to analyse and how. Refer to data sets by their query key.
              </div>
              <textarea style={{ ...inputStyle, resize: 'vertical' }} rows={10} value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
              <div style={{ height: '14px' }} />
              <JsonField
                label="Output blocks"
                hint='Ordered list of { "type": "markdown" | "table" | "chart" | "insights", "key", "title", "guidance" }.'
                value={draft.outputBlocks}
                onChange={(v) => patch({ outputBlocks: v })}
                rows={14}
              />
            </div>
          )}

          {leftTab === 'data' && (
            <div>
              <JsonField
                label="Data queries"
                hint="What to retrieve. Each query starts at the entity being viewed (CONTEXT) or at all entities of a type (DOMAIN), can traverse relationships, filter (optionally bound to filter inputs), group and aggregate."
                value={draft.dataQueries}
                onChange={(v) => patch({ dataQueries: Array.isArray(v) ? v : [] })}
                rows={22}
              />
              <button className="btn btn-sm" onClick={testQueries} disabled={testing}>
                {testing ? 'Running…' : `Test queries against ${sample?.entityCode || 'sample entity'}`}
              </button>
              {testResult && <TestResults result={testResult} />}
            </div>
          )}

          {leftTab === 'params' && (
            <JsonField
              label="Filter inputs"
              hint='User-facing inputs, e.g. [{ "name": "minValue", "label": "Min value", "type": "number", "default": 0 }]. Bind them in data queries with filter.param = name.'
              value={draft.parameters}
              onChange={(v) => patch({ parameters: Array.isArray(v) ? v : [] })}
              rows={18}
            />
          )}
        </div>

        {/* ---------------- Right: preview / assistant ---------------- */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--line)', marginBottom: '14px' }}>
            <button style={tabBtn(rightTab === 'preview')} onClick={() => setRightTab('preview')}>Preview</button>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--ink-3)' }}>
              Sample {draft.domainCode}
              <select className="select" style={{ padding: '4px 26px 4px 8px', fontSize: '11px', maxWidth: '200px' }} value={sampleId} onChange={(e) => setSampleId(e.target.value)}>
                {samples.length === 0 && <option value="">(none found)</option>}
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>{s.entityName || s.entityCode}</option>
                ))}
              </select>
            </div>
          </div>

          {/* The designer no longer hosts its own assistant: all design chat goes
              through the primary ChatPanel, which receives this draft via the bridge. */}

          {rightTab === 'preview' &&
            (!sampleId ? (
              <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>No {draft.domainCode} entities available to preview with.</div>
            ) : kind === 'dashboard' ? (
              <DashboardRunner
                key={sampleId}
                htmlTemplate={draft.htmlTemplate}
                dataQueries={draft.dataQueries}
                parameters={draft.parameters}
                entityId={sampleId}
                asOfDate={asOfDate}
              />
            ) : (
              <NarrativeRunner key={sampleId} draft={narrativeDraft} parameters={draft.parameters} entityId={sampleId} asOfDate={asOfDate} />
            ))}
        </div>
      </div>
    </div>
  );
}

function TestResults({ result }: { result: any }) {
  if (result.fatal) return <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '10px' }}>{result.fatal}</div>;
  if (result.validationErrors?.length) {
    return (
      <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '10px' }}>
        {result.validationErrors.map((e: string, i: number) => <div key={i}>• {e}</div>)}
      </div>
    );
  }
  const entries = Object.entries(result.results || {}) as Array<[string, any]>;
  return (
    <div style={{ marginTop: '12px', display: 'grid', gap: '10px' }}>
      {result.warnings?.map((w: string, i: number) => <div key={i} style={{ color: 'var(--amber)', fontSize: '12px' }}>{w}</div>)}
      {entries.map(([key, r]) => (
        <div key={key} style={{ border: '1px solid var(--line)', background: 'white' }}>
          <div style={{ padding: '6px 10px', fontSize: '12px', background: 'var(--bg)', display: 'flex', justifyContent: 'space-between' }}>
            <strong className="mono">{key}</strong>
            <span style={{ color: r.error ? 'var(--red)' : 'var(--ink-3)' }}>
              {r.error ? r.error : `${r.rows.length} of ${r.total ?? r.rows.length} rows · ${r.matched} entities matched${r.truncated ? ' · paged' : ''}`}
            </span>
          </div>
          {!r.error && r.rows.length > 0 && (
            <div style={{ overflowX: 'auto', maxHeight: '180px' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '11px', width: '100%' }}>
                <thead>
                  <tr>{r.columns.slice(0, 8).map((c: any) => <th key={c.name} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--line)' }}>{c.name}</th>)}</tr>
                </thead>
                <tbody>
                  {r.rows.slice(0, 5).map((row: any, i: number) => (
                    <tr key={i}>{r.columns.slice(0, 8).map((c: any) => <td key={c.name} style={{ padding: '4px 8px', borderBottom: '1px solid var(--line)' }}>{String(row[c.name] ?? '')}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
